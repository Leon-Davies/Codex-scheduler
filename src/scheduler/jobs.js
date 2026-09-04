'use strict';

const crypto = require('crypto');

const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'failed', 'submitted']);

function createJob({ prompt, thread, workspace, trigger, nextAttemptAt }) {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    prompt,
    threadId: thread.id,
    threadLabel: thread.name || thread.preview || thread.id,
    workspace: workspace || null,
    trigger,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    nextAttemptAt: nextAttemptAt ?? now,
    attempts: 0,
    lastError: null,
    submittedTurnId: null,
    submittedAt: null,
    completedAt: null,
  };
}

function isRunnable(job, now = Date.now()) {
  return job.status === 'queued' && Number(job.nextAttemptAt || 0) <= now;
}

function isPending(job) {
  return !TERMINAL_STATUSES.has(job.status);
}

module.exports = {
  createJob,
  isPending,
  isRunnable,
};
