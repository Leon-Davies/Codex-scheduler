'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { looksLikeUsageLimitError } = require('../src/scheduler/scheduler');

test('recognizes Codex usage-limit failures for safe retry', () => {
  assert.equal(looksLikeUsageLimitError(new Error('Usage limit exceeded. Try again later.')), true);
  assert.equal(looksLikeUsageLimitError({ data: { codexErrorInfo: 'usageLimitExceeded' } }), true);
  assert.equal(looksLikeUsageLimitError(new Error('Git repository not found')), false);
});
