'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { looksLikeUsageLimitError } = require('../src/scheduler/scheduler');
const { createJob, isPending, isRunnable } = require('../src/scheduler/jobs');

test('recognizes Codex usage-limit failures for safe retry', () => {
  assert.equal(looksLikeUsageLimitError(new Error('Usage limit exceeded. Try again later.')), true);
  assert.equal(looksLikeUsageLimitError({ data: { codexErrorInfo: 'usageLimitExceeded' } }), true);
  assert.equal(looksLikeUsageLimitError(new Error('Git repository not found')), false);
});

test('submitted quota-reset job is terminal and cannot fire again', () => {
  const job = createJob({
    prompt: 'continue',
    thread: { id: 'thread-1', name: 'Existing Codex thread' },
    workspace: '/workspace',
    trigger: { type: 'usageReset' },
    nextAttemptAt: Date.now() - 1000,
  });

  assert.equal(isPending(job), true);
  assert.equal(isRunnable(job), true);

  const submitted = {
    ...job,
    status: 'submitted',
    submittedAt: Date.now(),
    queuedSubmissionId: 'queued-1',
  };

  assert.equal(isPending(submitted), false);
  assert.equal(isRunnable(submitted), false);
});
