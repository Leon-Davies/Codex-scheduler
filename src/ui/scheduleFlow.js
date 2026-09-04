'use strict';

const { captureFocusedText } = require('../platform/windowsDraftCapture');
const { createJob } = require('../scheduler/jobs');
const { formatLocalDateTime, parseLocalScheduleTime } = require('../scheduler/time');
const { getNextResetMs, summarizeRateLimits } = require('../codex/rateLimits');

function preview(text, max = 180) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

function formatThreadTime(epochSeconds) {
  if (!Number.isFinite(epochSeconds)) {
    return '';
  }
  return new Date(epochSeconds * 1000).toLocaleString();
}

async function chooseThread(vscode, codex, workspaceState) {
  const cwd = codex.getWorkspaceCwd();
  let threads = await codex.listVscodeThreads(cwd, 30);
  if (threads.length === 0 && cwd) {
    threads = await codex.listVscodeThreads(null, 30);
  }
  if (threads.length === 0) {
    throw new Error('No stored Codex VS Code conversations were found. Start or resume a Codex conversation first, then try again.');
  }

  const lastThreadId = workspaceState.get('codexScheduler.lastThreadId');
  threads.sort((a, b) => {
    if (a.id === lastThreadId) return -1;
    if (b.id === lastThreadId) return 1;
    return Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0);
  });

  const items = threads.map((thread) => ({
    label: `${thread.id === lastThreadId ? '$(star-full) ' : '$(comment-discussion) '}${thread.name || preview(thread.preview, 70) || 'Codex conversation'}`,
    description: formatThreadTime(thread.updatedAt || thread.createdAt),
    detail: `${thread.id}\n${preview(thread.preview, 200)}`,
    thread,
  }));

  const choice = await vscode.window.showQuickPick(items, {
    title: 'Codex Scheduler — Target conversation',
    placeHolder: 'Choose the existing Codex conversation that should receive this prompt',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!choice) {
    return null;
  }
  await workspaceState.update('codexScheduler.lastThreadId', choice.thread.id);
  return choice.thread;
}

async function confirmPrompt(vscode, prompt) {
  const choice = await vscode.window.showQuickPick([
    {
      label: '$(check) Use captured prompt',
      description: `${prompt.length.toLocaleString()} characters`,
      detail: preview(prompt, 500),
      value: 'use',
    },
    {
      label: '$(clippy) Use clipboard instead',
      detail: 'Useful if automatic draft capture selected the wrong text.',
      value: 'clipboard',
    },
  ], {
    title: 'Codex Scheduler — Confirm prompt',
    placeHolder: 'Check that the scheduler captured the prompt you intended',
  });
  return choice?.value || null;
}

async function chooseTrigger(vscode, codex) {
  let resetDetail = 'Codex usage will be checked before sending.';
  let rateLimits = null;
  try {
    rateLimits = await codex.getRateLimits();
    const resetMs = getNextResetMs(rateLimits);
    if (resetMs) {
      resetDetail = `Current reported reset: ${formatLocalDateTime(resetMs)}. Availability is rechecked before sending.`;
    }
  } catch (error) {
    resetDetail = `Reset time unavailable right now (${error.message}). The scheduler can keep checking while VS Code is running.`;
  }

  const choice = await vscode.window.showQuickPick([
    {
      label: '$(sync) Send when usage resets',
      description: rateLimits ? 'Uses Codex account rate-limit state' : 'Will retry until usage state is available',
      detail: resetDetail,
      value: 'usageReset',
      rateLimits,
    },
    {
      label: '$(clock) Send at a specific time',
      description: 'Choose a local date/time',
      detail: 'Examples: 03:15 or 2026-09-05 03:15',
      value: 'atTime',
    },
  ], {
    title: 'Codex Scheduler — When should it send?',
  });

  if (!choice) {
    return null;
  }

  if (choice.value === 'usageReset') {
    const safetySeconds = vscode.workspace
      .getConfiguration('codexScheduler')
      .get('resetSafetySeconds', 30);
    const resetMs = getNextResetMs(choice.rateLimits);
    return {
      trigger: { type: 'usageReset' },
      nextAttemptAt: resetMs
        ? Math.max(Date.now() + 15_000, resetMs + Math.max(0, safetySeconds) * 1000)
        : Date.now() + 30_000,
    };
  }

  const entered = await vscode.window.showInputBox({
    title: 'Codex Scheduler — Send at a specific time',
    prompt: 'Enter local time (HH:mm) or local date/time (YYYY-MM-DD HH:mm)',
    placeHolder: '03:15',
    validateInput: (value) => {
      const parsed = parseLocalScheduleTime(value);
      if (!parsed) return 'Enter a valid time such as 03:15 or 2026-09-05 03:15.';
      if (parsed.getTime() <= Date.now()) return 'The selected date/time is in the past.';
      return null;
    },
  });
  if (!entered) {
    return null;
  }
  const when = parseLocalScheduleTime(entered);
  if (!when || when.getTime() <= Date.now()) {
    return null;
  }
  return {
    trigger: { type: 'atTime', at: when.getTime() },
    nextAttemptAt: when.getTime(),
  };
}

async function schedulePrompt({ vscode, prompt, codex, store, workspaceState, onJobsChanged }) {
  let finalPrompt = String(prompt || '');
  if (!finalPrompt.trim()) {
    vscode.window.showWarningMessage('Codex Scheduler did not find any prompt text to schedule.');
    return null;
  }

  const confirmation = await confirmPrompt(vscode, finalPrompt);
  if (!confirmation) {
    return null;
  }
  if (confirmation === 'clipboard') {
    finalPrompt = await vscode.env.clipboard.readText();
    if (!finalPrompt.trim()) {
      vscode.window.showWarningMessage('The clipboard is empty.');
      return null;
    }
  }

  const thread = await chooseThread(vscode, codex, workspaceState);
  if (!thread) {
    return null;
  }
  const timing = await chooseTrigger(vscode, codex);
  if (!timing) {
    return null;
  }

  const workspace = codex.getWorkspaceCwd();
  const job = createJob({
    prompt: finalPrompt,
    thread,
    workspace,
    trigger: timing.trigger,
    nextAttemptAt: timing.nextAttemptAt,
  });
  await store.add(job);
  onJobsChanged?.();

  const whenLabel = timing.trigger.type === 'usageReset'
    ? `after Codex usage becomes available (first check ${formatLocalDateTime(job.nextAttemptAt)})`
    : formatLocalDateTime(job.nextAttemptAt);
  vscode.window.showInformationMessage(`Scheduled for ${whenLabel}.`);
  return job;
}

async function scheduleCurrentDraft(args) {
  let prompt;
  try {
    prompt = await captureFocusedText(args.vscode);
  } catch (error) {
    const fallback = await args.vscode.window.showWarningMessage(
      error.message,
      'Schedule Clipboard',
    );
    if (fallback !== 'Schedule Clipboard') {
      return null;
    }
    prompt = await args.vscode.env.clipboard.readText();
  }
  return schedulePrompt({ ...args, prompt });
}

function rateLimitSummaryText(response) {
  const summary = summarizeRateLimits(response);
  const parts = [];
  if (summary.planType) {
    parts.push(`Plan: ${summary.planType}`);
  }
  for (const window of summary.windows) {
    const remaining = window.remainingPercent === null ? '?' : `${Math.round(window.remainingPercent)}%`;
    const reset = window.resetsAt ? formatLocalDateTime(window.resetsAt * 1000) : 'unknown';
    parts.push(`${window.label}: ${remaining} left · resets ${reset}`);
  }
  if (summary.reachedType) {
    parts.push(`Reached state: ${summary.reachedType}`);
  }
  return parts.join(' | ') || 'Codex did not return a rate-limit window.';
}

module.exports = {
  chooseThread,
  chooseTrigger,
  preview,
  rateLimitSummaryText,
  scheduleCurrentDraft,
  schedulePrompt,
};
