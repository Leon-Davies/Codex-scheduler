'use strict';

const { captureFocusedText } = require('../platform/windowsDraftCapture');
const { createJob } = require('../scheduler/jobs');
const { formatLocalDateTime, parseLocalScheduleTime } = require('../scheduler/time');
const { getNextResetMs, summarizeRateLimits } = require('../codex/rateLimits');

const OVERLAY_CONTEXT_KEY = 'codexScheduler.pendingOverlayContext';

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

function normalizeThreadTitle(value) {
  return String(value || '')
    .normalize('NFKD')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleMatchScore(threadTitle, candidateTitle) {
  const thread = normalizeThreadTitle(threadTitle);
  const candidate = normalizeThreadTitle(candidateTitle);
  if (!thread || !candidate) return 0;
  if (thread === candidate) return 1000;

  const shorter = Math.min(thread.length, candidate.length);
  if (shorter >= 8 && (candidate.includes(thread) || thread.includes(candidate))) {
    return 850 - Math.min(120, Math.abs(thread.length - candidate.length));
  }

  const threadTokens = new Set(thread.split(' ').filter((token) => token.length > 1));
  const candidateTokens = new Set(candidate.split(' ').filter((token) => token.length > 1));
  if (threadTokens.size < 2 || candidateTokens.size < 2) return 0;

  let intersection = 0;
  for (const token of threadTokens) {
    if (candidateTokens.has(token)) intersection += 1;
  }
  const union = new Set([...threadTokens, ...candidateTokens]).size;
  const similarity = union ? intersection / union : 0;
  return similarity >= 0.8 ? Math.round(650 + (similarity * 100)) : 0;
}

function findPreferredThread(threads, preferredThreadTitles = []) {
  const candidates = (Array.isArray(preferredThreadTitles) ? preferredThreadTitles : [preferredThreadTitles])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  if (candidates.length === 0) return null;

  const scored = threads
    .map((thread) => ({
      thread,
      score: Math.max(0, ...candidates.map((candidate) => titleMatchScore(thread.name, candidate))),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0 || scored[0].score < 700) return null;
  if (scored.length > 1 && scored[0].score === scored[1].score) return null;
  return scored[0].thread;
}

async function chooseThread(
  vscode,
  codex,
  workspaceState,
  preferredThreadTitles = [],
  { allowPicker = true } = {},
) {
  const cwd = codex.getWorkspaceCwd();
  let threads = await codex.listVscodeThreads(cwd, 30);
  if (threads.length === 0 && cwd) {
    threads = await codex.listVscodeThreads(null, 30);
  }
  if (threads.length === 0) {
    throw new Error('No stored Codex VS Code conversations were found. Start or resume a Codex conversation first, then try again.');
  }

  const preferred = findPreferredThread(threads, preferredThreadTitles);
  if (preferred) {
    await workspaceState.update('codexScheduler.lastThreadId', preferred.id);
    return preferred;
  }

  if (threads.length === 1) {
    await workspaceState.update('codexScheduler.lastThreadId', threads[0].id);
    return threads[0];
  }

  if (!allowPicker) {
    const error = new Error('Could not identify the visible Codex conversation automatically. Keep that conversation visible and try again.');
    error.code = 'CODEX_SCHEDULER_THREAD_NOT_IDENTIFIED';
    error.threadTitleCandidates = preferredThreadTitles;
    throw error;
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

async function buildUsageResetTiming(vscode, codex, suppliedLimits = null) {
  let rateLimits = suppliedLimits;
  if (!rateLimits) {
    try {
      rateLimits = await codex.getRateLimits();
    } catch {
      rateLimits = null;
    }
  }

  const safetySeconds = vscode.workspace
    .getConfiguration('codexScheduler')
    .get('resetSafetySeconds', 30);
  const resetMs = getNextResetMs(rateLimits);

  return {
    trigger: { type: 'usageReset' },
    nextAttemptAt: resetMs
      ? Math.max(Date.now() + 15_000, resetMs + Math.max(0, safetySeconds) * 1000)
      : Date.now() + 30_000,
  };
}

async function buildAtTimeTiming(vscode) {
  const entered = await vscode.window.showInputBox({
    title: 'Codex Scheduler — Send at time',
    prompt: 'Enter HH:mm, or a delay such as “in 20m” / “in 2h”.',
    placeHolder: '14:30   or   in 20m',
    validateInput: (value) => {
      const parsed = parseLocalScheduleTime(value);
      if (!parsed) return 'Use HH:mm, YYYY-MM-DD HH:mm, in 20m, or in 2h.';
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
      description: 'Enter a clock time or relative delay',
      detail: 'Examples: 14:30, in 20m, in 2h',
      value: 'atTime',
    },
  ], {
    title: 'Codex Scheduler — When should it send?',
  });

  if (!choice) {
    return null;
  }
  if (choice.value === 'usageReset') {
    return buildUsageResetTiming(vscode, codex, choice.rateLimits);
  }
  return buildAtTimeTiming(vscode);
}

async function timingForTrigger(vscode, codex, triggerType) {
  if (triggerType === 'usageReset') {
    return buildUsageResetTiming(vscode, codex);
  }
  if (triggerType === 'atTime') {
    return buildAtTimeTiming(vscode);
  }
  return chooseTrigger(vscode, codex);
}

async function schedulePrompt({
  vscode,
  prompt,
  codex,
  store,
  workspaceState,
  onJobsChanged,
  triggerType = null,
  confirmCapturedPrompt = true,
  preferredThreadTitles = [],
  allowThreadPicker = true,
  toggleUsageReset = false,
}) {
  let finalPrompt = String(prompt || '');
  if (!finalPrompt.trim()) {
    vscode.window.showWarningMessage('Codex Scheduler did not find any prompt text to schedule.');
    return null;
  }

  const overlayContext = workspaceState?.get?.(OVERLAY_CONTEXT_KEY);
  const overlayContextIsCurrent = Boolean(
    overlayContext
    && overlayContext.action === triggerType
    && Number.isFinite(Number(overlayContext.capturedAt))
    && Math.abs(Date.now() - Number(overlayContext.capturedAt)) < 30_000,
  );
  const effectivePreferredThreadTitles = preferredThreadTitles.length > 0
    ? preferredThreadTitles
    : (overlayContextIsCurrent && Array.isArray(overlayContext.threadTitleCandidates)
      ? overlayContext.threadTitleCandidates
      : []);

  if (confirmCapturedPrompt && !overlayContextIsCurrent) {
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
  }

  // For explicit time scheduling, the first thing the user sees after choosing
  // the menu item is the compact time input. Thread resolution stays behind it.
  const timing = await timingForTrigger(vscode, codex, triggerType);
  if (!timing) {
    return null;
  }

  const thread = await chooseThread(
    vscode,
    codex,
    workspaceState,
    effectivePreferredThreadTitles,
    { allowPicker: allowThreadPicker },
  );
  if (!thread) {
    return null;
  }

  if (toggleUsageReset && timing.trigger.type === 'usageReset') {
    const existing = store.all().filter((job) => (
      job.threadId === thread.id
      && job.trigger?.type === 'usageReset'
      && ['queued', 'checking'].includes(job.status)
    ));
    if (existing.length > 0) {
      for (const job of existing) {
        await store.update(job.id, {
          status: 'cancelled',
          lastError: 'Disabled from the Codex composer.',
        });
      }
      onJobsChanged?.();
      vscode.window.showInformationMessage('Send when quota resets disabled.');
      return { toggledOff: true, thread };
    }
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

  if (timing.trigger.type === 'usageReset' && toggleUsageReset) {
    vscode.window.showInformationMessage('Send when quota resets enabled.');
  } else {
    vscode.window.showInformationMessage(`Codex prompt scheduled for ${formatLocalDateTime(job.nextAttemptAt)}.`);
  }
  return job;
}

async function scheduleCurrentDraft(args) {
  let prompt;
  try {
    prompt = await captureFocusedText(args.vscode);
  } catch (error) {
    if (args.allowClipboardFallback === false) {
      throw error;
    }
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
  buildAtTimeTiming,
  buildUsageResetTiming,
  chooseThread,
  chooseTrigger,
  findPreferredThread,
  normalizeThreadTitle,
  preview,
  rateLimitSummaryText,
  scheduleCurrentDraft,
  schedulePrompt,
  timingForTrigger,
  titleMatchScore,
};
