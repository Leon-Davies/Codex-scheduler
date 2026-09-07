'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createJob, isPending, isRunnable } = require('../src/scheduler/jobs');

const thread = { id: 'thr_123', name: 'Existing Codex chat' };

test('creates a queued job tied to an existing thread', () => {
  const job = createJob({
    prompt: 'Continue the implementation.',
    thread,
    workspace: 'C:\\repo',
    trigger: { type: 'atTime', at: 1234 },
    nextAttemptAt: 1234,
  });
  assert.equal(job.threadId, 'thr_123');
  assert.equal(job.status, 'queued');
  assert.equal(isPending(job), true);
  assert.equal(isRunnable(job, 1234), true);
});

test('submitted jobs are not runnable or pending', () => {
  const job = {
    status: 'submitted',
    nextAttemptAt: 0,
  };
  assert.equal(isRunnable(job, Date.now()), false);
  assert.equal(isPending(job), false);
});
