'use strict';

const { AppServerError } = require('../codex/appServer');
const { isQueueUnsupportedError } = require('../codex/service');
const { getNextResetMs, isUsageClearlyBlocked } = require('../codex/rateLimits');
const { isRunnable } = require('./jobs');

function looksLikeUsageLimitError(error) {
  const text = [
    error?.message,
    error?.code,
    JSON.stringify(error?.data || ''),
    JSON.stringify(error?.payload || ''),
  ].filter(Boolean).join(' ').toLowerCase();
  return text.includes('usagelimit') || text.includes('usage limit') || text.includes('rate limit');
}

class Scheduler {
  constructor({ vscode, store, codex, output, onJobsChanged }) {
    this.vscode = vscode;
    this.store = store;
    this.codex = codex;
    this.output = output;
    this.onJobsChanged = onJobsChanged;
    this.timer = null;
    this.running = new Set();
  }

  start() {
    this.stop();
    const seconds = this.vscode.workspace
      .getConfiguration('codexScheduler')
      .get('pollIntervalSeconds', 30);
    this.timer = setInterval(() => void this.tick(), Math.max(10, seconds) * 1000);
    void this.tick();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(now = Date.now()) {
    const due = this.store.all().filter((job) => isRunnable(job, now));
    for (const job of due) {
      if (!this.running.has(job.id)) {
        void this.#runJob(job);
      }
    }
  }

  async runNow(jobId) {
    const job = this.store.all().find((candidate) => candidate.id === jobId);
    if (!job) {
      throw new Error('Scheduled job no longer exists.');
    }
    await this.store.update(job.id, { status: 'queued', nextAttemptAt: Date.now() });
    await this.#runJob({ ...job, status: 'queued', nextAttemptAt: Date.now() });
  }

  async #runJob(job) {
    this.running.add(job.id);
    try {
      const current = this.store.all().find((candidate) => candidate.id === job.id);
      if (!current || current.status !== 'queued') {
        return;
      }

      await this.store.update(job.id, {
        status: 'checking',
        attempts: Number(job.attempts || 0) + 1,
        lastError: null,
      });
      this.onJobsChanged?.();

      // A fixed-time job means "not before this time". If Codex is still usage-
      // blocked at that point, waiting for the actual reset is safer than starting
      // a turn that the provider will immediately reject.
      const limits = await this.codex.getRateLimits();
      if (isUsageClearlyBlocked(limits)) {
        await this.#rescheduleForLimits(job, limits, 'Codex still reports the usage limit as active.');
        return;
      }

      await this.store.update(job.id, { status: 'submitting' });
      this.onJobsChanged?.();

      // The job ID is also the stable client message ID. The Codex native queue is
      // durable and cross-process aware, so we do not resume or take ownership of
      // the thread. The official VS Code Codex process can dispatch this queued
      // message once its existing thread is idle.
      const queuedSubmission = await this.codex.queueTurn(job.threadId, job.prompt, job.id);

      // Once thread/queue/add returns an ID, never automatically enqueue this job
      // again. The native Codex queue now owns delivery to the existing thread.
      // This terminal transition is also what makes reset scheduling one-shot:
      // submitted reset jobs are no longer considered armed/pending.
      await this.store.update(job.id, {
        status: 'submitted',
        queuedSubmissionId: queuedSubmission.id,
        clientUserMessageId: queuedSubmission.clientUserMessageId || job.id,
        submittedAt: Date.now(),
        lastError: null,
      });
      this.onJobsChanged?.();
      this.output.appendLine(
        `[scheduler] queued ${job.id} for ${job.threadId} as ${queuedSubmission.id}`,
      );

      const resetOneShot = job.trigger?.type === 'usageReset';
      void this.vscode.window.showInformationMessage(
        resetOneShot
          ? `Codex Scheduler queued your reset prompt for ${job.threadLabel}. Reset scheduling is now off.`
          : `Codex Scheduler queued your prompt for ${job.threadLabel}. Codex will start it when that thread is idle.`,
      );
    } catch (error) {
      if (isQueueUnsupportedError(error)) {
        const message = 'This Codex build does not expose the native queued-turn API required for safe scheduling. Update the official OpenAI Codex extension, then run Codex Scheduler diagnostics again.';
        await this.store.update(job.id, { status: 'failed', lastError: message });
        this.onJobsChanged?.();
        this.output.appendLine(`[scheduler] job ${job.id} failed: ${message} (${error.message})`);
        void this.vscode.window.showErrorMessage(`Codex Scheduler: ${message}`);
      } else if (looksLikeUsageLimitError(error)) {
        try {
          const limits = await this.codex.getRateLimits();
          await this.#rescheduleForLimits(job, limits, error.message);
        } catch (limitError) {
          await this.#defer(job, 60_000, `${error.message}; rate-limit refresh failed: ${limitError.message}`);
        }
      } else {
        const message = error instanceof AppServerError
          ? `${error.message}${error.code ? ` (code ${error.code})` : ''}`
          : error.message;
        await this.store.update(job.id, { status: 'failed', lastError: message });
        this.onJobsChanged?.();
        this.output.appendLine(`[scheduler] job ${job.id} failed: ${message}`);
        void this.vscode.window.showErrorMessage(`Codex Scheduler failed: ${message}`);
      }
    } finally {
      this.running.delete(job.id);
    }
  }

  async #rescheduleForLimits(job, limits, reason) {
    const safetySeconds = this.vscode.workspace
      .getConfiguration('codexScheduler')
      .get('resetSafetySeconds', 30);
    const resetMs = getNextResetMs(limits);
    const nextAttemptAt = resetMs
      ? Math.max(Date.now() + 15_000, resetMs + Math.max(0, safetySeconds) * 1000)
      : Date.now() + 60_000;
    await this.store.update(job.id, {
      status: 'queued',
      nextAttemptAt,
      lastError: reason,
    });
    this.onJobsChanged?.();
    this.output.appendLine(`[scheduler] ${job.id} waiting until ${new Date(nextAttemptAt).toISOString()}: ${reason}`);
  }

  async #defer(job, delayMs, reason) {
    await this.store.update(job.id, {
      status: 'queued',
      nextAttemptAt: Date.now() + delayMs,
      lastError: reason,
    });
    this.onJobsChanged?.();
    this.output.appendLine(`[scheduler] deferred ${job.id}: ${reason}`);
  }
}

module.exports = {
  Scheduler,
  looksLikeUsageLimitError,
};
