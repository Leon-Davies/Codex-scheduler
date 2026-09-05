'use strict';

const vscode = require('vscode');
const { CodexService } = require('./codex/service');
const { discoverCodexCandidates, discoverCodexExecutable } = require('./codex/executableDiscovery');
const { summarizeRateLimits } = require('./codex/rateLimits');
const { captureFocusedText } = require('./platform/windowsDraftCapture');
const { ComposerOverlay, canUseComposerOverlay } = require('./platform/windowsComposerOverlay');
const { JobStore } = require('./scheduler/jobStore');
const { isPending } = require('./scheduler/jobs');
const { Scheduler } = require('./scheduler/scheduler');
const { formatLocalDateTime } = require('./scheduler/time');
const {
  preview,
  rateLimitSummaryText,
  scheduleCurrentDraft,
  schedulePrompt,
} = require('./ui/scheduleFlow');

async function recoverInterruptedJobs(store, output) {
  const jobs = store.all();
  let changed = false;
  const recovered = jobs.map((job) => {
    if (job.status === 'checking') {
      changed = true;
      output.appendLine(`[recovery] re-queued job ${job.id} interrupted while checking.`);
      return {
        ...job,
        status: 'queued',
        nextAttemptAt: Date.now() + 15_000,
        lastError: 'VS Code restarted while this job was checking; safely re-queued.',
      };
    }
    if (job.status === 'submitting') {
      changed = true;
      output.appendLine(`[recovery] job ${job.id} was interrupted during submission; refusing automatic retry.`);
      return {
        ...job,
        status: 'failed',
        lastError: 'VS Code restarted while adding this prompt to the Codex queue. Automatic retry was suppressed to avoid a duplicate queued message; inspect the target Codex thread/queue before retrying manually.',
      };
    }
    return job;
  });
  if (changed) {
    await store.replace(recovered);
  }
}

function activate(context) {
  const output = vscode.window.createOutputChannel('Codex Scheduler');
  const store = new JobStore(context.globalState);
  const codex = new CodexService({ vscode, output });
  let statusBar;
  let composerOverlay = null;

  const updateStatusBar = () => {
    if (!statusBar) return;
    const jobs = store.all();
    const pending = jobs.filter(isPending);
    if (pending.length === 0) {
      statusBar.text = '$(clock) Codex Schedule';
      statusBar.tooltip = 'Schedule a prompt for Codex';
    } else {
      statusBar.text = `$(clock) ${pending.length} Codex scheduled`;
      const next = [...pending]
        .filter((job) => Number.isFinite(job.nextAttemptAt))
        .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)[0];
      statusBar.tooltip = next
        ? `${pending.length} pending Codex prompt(s). Next check: ${formatLocalDateTime(next.nextAttemptAt)}`
        : `${pending.length} pending Codex prompt(s)`;
    }
  };

  const scheduler = new Scheduler({
    vscode,
    store,
    codex,
    output,
    onJobsChanged: updateStatusBar,
  });

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusBar.name = 'Codex Scheduler';
  statusBar.command = 'codexScheduler.scheduleCurrentDraft';
  context.subscriptions.push(statusBar, output);

  const commonScheduleArgs = {
    vscode,
    codex,
    store,
    workspaceState: context.workspaceState,
    onJobsChanged: updateStatusBar,
  };

  const runTitleSchedule = async (triggerType) => {
    try {
      await scheduleCurrentDraft({
        ...commonScheduleArgs,
        triggerType,
        allowClipboardFallback: false,
        confirmCapturedPrompt: true,
      });
    } catch (error) {
      output.appendLine(`[schedule title/${triggerType}] ${error.stack || error.message}`);
      if (error.captureDiagnostics) {
        output.appendLine('[schedule title] accessibility diagnostics:');
        output.appendLine(JSON.stringify(error.captureDiagnostics, null, 2));
        output.show(true);
      }
      vscode.window.showErrorMessage(`Codex Scheduler: ${error.message}`);
    }
  };

  const runOverlaySchedule = async (event) => {
    const triggerType = event?.action;
    if (!['usageReset', 'atTime'].includes(triggerType)) {
      output.appendLine(`[overlay] ignored unknown action ${JSON.stringify(triggerType)}`);
      return;
    }

    try {
      const prompt = String(event?.prompt || '');
      if (!prompt.trim()) {
        vscode.window.showWarningMessage('Codex Scheduler found the composer but it was empty. Type a prompt first, then use the schedule button.');
        return;
      }
      await schedulePrompt({
        ...commonScheduleArgs,
        prompt,
        triggerType,
        confirmCapturedPrompt: true,
      });
    } catch (error) {
      output.appendLine(`[schedule overlay/${triggerType}] ${error.stack || error.message}`);
      vscode.window.showErrorMessage(`Codex Scheduler: ${error.message}`);
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('codexScheduler.scheduleCurrentDraft', async () => {
      try {
        await scheduleCurrentDraft(commonScheduleArgs);
      } catch (error) {
        output.appendLine(`[schedule] ${error.stack || error.message}`);
        vscode.window.showErrorMessage(`Codex Scheduler: ${error.message}`);
      }
    }),

    vscode.commands.registerCommand('codexScheduler.scheduleAtReset', async () => {
      await runTitleSchedule('usageReset');
    }),

    vscode.commands.registerCommand('codexScheduler.scheduleAtTime', async () => {
      await runTitleSchedule('atTime');
    }),

    vscode.commands.registerCommand('codexScheduler.scheduleClipboard', async () => {
      try {
        const prompt = await vscode.env.clipboard.readText();
        await schedulePrompt({ ...commonScheduleArgs, prompt });
      } catch (error) {
        output.appendLine(`[schedule clipboard] ${error.stack || error.message}`);
        vscode.window.showErrorMessage(`Codex Scheduler: ${error.message}`);
      }
    }),

    vscode.commands.registerCommand('codexScheduler.testDraftCapture', async () => {
      await testDraftCapture({ vscode, output });
    }),

    vscode.commands.registerCommand('codexScheduler.manageScheduled', async () => {
      await manageScheduled({ vscode, store, scheduler, updateStatusBar });
    }),

    vscode.commands.registerCommand('codexScheduler.showUsage', async () => {
      try {
        const limits = await codex.getRateLimits();
        vscode.window.showInformationMessage(rateLimitSummaryText(limits));
      } catch (error) {
        output.appendLine(`[usage] ${error.stack || error.message}`);
        vscode.window.showErrorMessage(`Could not read Codex usage: ${error.message}`);
      }
    }),

    vscode.commands.registerCommand('codexScheduler.diagnose', async () => {
      await diagnose({ vscode, codex, output, composerOverlay });
    }),
  );

  const overlayEnabled = vscode.workspace
    .getConfiguration('codexScheduler')
    .get('composerOverlay.enabled', true);
  let overlayStarted = false;
  if (overlayEnabled && canUseComposerOverlay()) {
    try {
      composerOverlay = new ComposerOverlay({
        context,
        output,
        onAction: runOverlaySchedule,
      });
      overlayStarted = composerOverlay.start();
      context.subscriptions.push(composerOverlay);
    } catch (error) {
      output.appendLine(`[overlay] failed to start: ${error.stack || error.message}`);
    }
  }

  if (!overlayStarted) {
    statusBar.show();
  } else {
    statusBar.hide();
    output.appendLine('[overlay] composer-adjacent schedule button enabled; status-bar fallback hidden.');
  }

  void recoverInterruptedJobs(store, output).then(() => {
    updateStatusBar();
    scheduler.start();
  });

  context.subscriptions.push({ dispose: () => scheduler.stop() });
  context.subscriptions.push({ dispose: () => codex.dispose() });

  output.appendLine('[extension] Codex Scheduler activated.');
}

async function testDraftCapture({ vscode, output }) {
  try {
    const prompt = await captureFocusedText(vscode);
    output.appendLine(`[draft capture] SUCCESS — ${prompt.length} characters captured; nothing was scheduled or sent.`);
    await vscode.window.showQuickPick([
      {
        label: '$(check) Draft capture succeeded',
        description: `${prompt.length.toLocaleString()} characters`,
        detail: preview(prompt, 800),
      },
    ], {
      title: 'Codex Scheduler — Draft capture test (nothing will be sent)',
      placeHolder: 'Captured prompt preview. Press Escape or Enter to close.',
    });
  } catch (error) {
    output.appendLine(`[draft capture] FAILED — ${error.stack || error.message}`);
    if (error.captureDiagnostics) {
      output.appendLine('[draft capture] accessibility diagnostics:');
      output.appendLine(JSON.stringify(error.captureDiagnostics, null, 2));
      output.show(true);
    }
    vscode.window.showErrorMessage(`Codex Scheduler draft capture failed: ${error.message}`);
  }
}

async function manageScheduled({ vscode, store, scheduler, updateStatusBar }) {
  const jobs = [...store.all()].sort((a, b) => b.createdAt - a.createdAt);
  if (jobs.length === 0) {
    vscode.window.showInformationMessage('Codex Scheduler has no saved jobs.');
    return;
  }

  const selected = await vscode.window.showQuickPick(jobs.map((job) => ({
    label: `${statusIcon(job.status)} ${job.threadLabel || job.threadId}`,
    description: `${job.status} · ${job.trigger?.type === 'usageReset' ? 'usage reset' : formatLocalDateTime(job.nextAttemptAt)}`,
    detail: `${preview(job.prompt, 300)}${job.lastError ? `\nLast note: ${job.lastError}` : ''}`,
    job,
  })), {
    title: 'Codex Scheduler — Saved prompts',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!selected) return;

  const actions = [];
  if (['queued', 'checking'].includes(selected.job.status)) {
    actions.push({ label: '$(play) Check / send now', value: 'run' });
    actions.push({ label: '$(close) Cancel', value: 'cancel' });
  }
  if (selected.job.status === 'failed') {
    actions.push({ label: '$(debug-restart) Retry after review', value: 'run' });
  }
  actions.push({ label: '$(clippy) Copy prompt', value: 'copy' });
  actions.push({ label: '$(trash) Delete saved job', value: 'delete' });

  const action = await vscode.window.showQuickPick(actions, {
    title: `Codex Scheduler — ${selected.job.threadLabel || selected.job.threadId}`,
  });
  if (!action) return;

  if (action.value === 'run') {
    await scheduler.runNow(selected.job.id);
  } else if (action.value === 'cancel') {
    await store.update(selected.job.id, { status: 'cancelled' });
    updateStatusBar();
  } else if (action.value === 'copy') {
    await vscode.env.clipboard.writeText(selected.job.prompt);
    vscode.window.showInformationMessage('Scheduled prompt copied to clipboard.');
  } else if (action.value === 'delete') {
    await store.remove(selected.job.id);
    updateStatusBar();
  }
}

function statusIcon(status) {
  switch (status) {
    case 'queued': return '$(clock)';
    case 'checking': return '$(sync~spin)';
    case 'submitting': return '$(send)';
    case 'submitted': return '$(check)';
    case 'failed': return '$(error)';
    case 'cancelled': return '$(circle-slash)';
    default: return '$(question)';
  }
}

async function diagnose({ vscode, codex, output, composerOverlay }) {
  output.clear();
  output.show(true);
  output.appendLine('Codex Scheduler diagnostics');
  output.appendLine(`Time: ${new Date().toISOString()}`);
  output.appendLine(`Platform: ${process.platform} ${process.arch}`);
  output.appendLine(`VS Code: ${vscode.version}`);
  output.appendLine(`Workspace: ${codex.getWorkspaceCwd() || '(none)'}`);
  output.appendLine(`Composer overlay supported: ${canUseComposerOverlay() ? 'yes' : 'no'}`);
  output.appendLine(`Composer overlay process: ${composerOverlay?.child ? 'running' : 'not running'}`);

  const official = vscode.extensions.getExtension('openai.chatgpt');
  output.appendLine(`Official Codex extension: ${official ? `${official.packageJSON.version || 'installed'} at ${official.extensionPath}` : 'not found'}`);

  const candidates = discoverCodexCandidates(vscode);
  if (candidates.length === 0) {
    output.appendLine('Codex executable: NOT FOUND');
    vscode.window.showErrorMessage('Codex Scheduler diagnostics: Codex executable was not found. See the output panel.');
    return;
  }
  output.appendLine('Codex runtime candidates (in preference order):');
  for (const [index, candidate] of candidates.entries()) {
    output.appendLine(`  ${index + 1}. ${candidate.command} (${candidate.source})`);
  }
  const executable = discoverCodexExecutable(vscode);
  output.appendLine(`Selected Codex executable: ${executable.command}`);
  output.appendLine(`Discovery source: ${executable.source}`);

  try {
    output.appendLine('Starting app-server handshake…');
    await codex.ensureClient();
    output.appendLine('App-server handshake: OK');
  } catch (error) {
    output.appendLine(`App-server handshake: FAILED — ${error.stack || error.message}`);
    vscode.window.showErrorMessage('Codex Scheduler diagnostics: app-server handshake failed. See the output panel.');
    return;
  }

  try {
    const limits = await codex.getRateLimits();
    const summary = summarizeRateLimits(limits);
    output.appendLine(`Rate limits: ${rateLimitSummaryText(limits)}`);
    output.appendLine(`Rate-limit reached type: ${summary.reachedType || '(none)'}`);
  } catch (error) {
    output.appendLine(`Rate limits: FAILED — ${error.stack || error.message}`);
  }

  try {
    const cwd = codex.getWorkspaceCwd();
    let threads = await codex.listVscodeThreads(cwd, 10);
    if (threads.length === 0 && cwd) {
      output.appendLine('No cwd-matched VS Code threads; retrying without cwd filter…');
      threads = await codex.listVscodeThreads(null, 10);
    }
    output.appendLine(`VS Code Codex threads found: ${threads.length}`);
    for (const thread of threads.slice(0, 10)) {
      output.appendLine(`  - ${thread.id} | ${thread.status?.type || 'unknown'} | ${thread.name || preview(thread.preview, 100)}`);
    }

    if (threads.length > 0) {
      const queueSupport = await codex.checkQueueSupport(threads[0].id);
      if (queueSupport.supported) {
        output.appendLine('Native queued-turn API: OK');
      } else {
        const prefix = queueSupport.definitivelyUnsupported ? 'UNSUPPORTED' : 'FAILED';
        output.appendLine(`Native queued-turn API: ${prefix} — ${queueSupport.error?.message || 'unknown error'}`);
      }
    } else {
      output.appendLine('Native queued-turn API: NOT CHECKED (no VS Code thread available)');
    }
  } catch (error) {
    output.appendLine(`Thread listing: FAILED — ${error.stack || error.message}`);
  }

  output.appendLine('Diagnostics complete.');
  vscode.window.showInformationMessage('Codex Scheduler diagnostics finished. See the “Codex Scheduler” output panel.');
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
  recoverInterruptedJobs,
  testDraftCapture,
};
