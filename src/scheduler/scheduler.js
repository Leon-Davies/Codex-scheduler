'use strict';

const { AppServerError } = require('../codex/appServer');
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

      if (job.trigger?.type === 'usageReset') {
        const limits = await this.codex.getRateLimits();
        if (isUsageClearlyBlocked(limits)) {
          await this.#rescheduleForLimits(job, limits, 'Codex still reports the usage limit as active.');
          return;
        }
      }

      // Best-effort safety check. App-server status is useful but is not an atomic
      // cross-client lock, so we still avoid sending if our connection sees activity.
      const thread = await this.codex.readThread(job.threadId);
      if (thread?.status?.type === 'active') {
        await this.#defer(job, 60_000, 'Target thread is currently active; deferred rather than steering it.');
        return;
      }

      await this.store.update(job.id, { status: 'submitting' });
      this.onJobsChanged?.();
      const submission = await this.codex.submitTurn(job.threadId, job.prompt);

      // Once turn/start returns a turn id, never automatically submit this job again.
      await this.store.update(job.id, {
        status: 'submitted',
        submittedTurnId: submission.turn.id,
        submittedAt: Date.now(),
        lastError: null,
      });
      this.onJobsChanged?.();
      this.output.appendLine(`[scheduler] submitted ${job.id} to ${job.threadId} as ${submission.turn.id}`);
      void this.vscode.window.showInformationMessage(
        `Codex Scheduler sent a prompt to ${job.threadLabel}.`,
      );

      submission.completion
        .then(async (params) => {
          const completedTurn = params.turn || {};
          await this.store.update(job.id, {
            status: 'completed',
            completedAt: Date.now(),
            completionStatus: completedTurn.status || 'completed',
          });
          this.onJobsChanged?.();
          this.output.appendLine(`[scheduler] turn ${submission.turn.id} completed (${completedTurn.status || 'unknown'}).`);
        })
        .catch((error) => {
          this.output.appendLine(`[scheduler] completion watch ended: ${error.message}`);
        });
    } catch (error) {
      if (error?.code === 'THREAD_ACTIVE') {
        await this.#defer(job, 60_000, error.message);
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
