'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isQueueUnsupportedError } = require('../src/codex/service');

test('recognizes Codex builds without the native queued-turn API', () => {
  assert.equal(isQueueUnsupportedError({ code: -32601, message: 'Method not found' }), true);
  assert.equal(isQueueUnsupportedError({
    code: -32600,
    message: 'Invalid request: unknown variant `thread/queue/add`, expected `thread/list`',
  }), true);
  assert.equal(isQueueUnsupportedError({
    code: -32600,
    message: 'thread/queue/add requires experimental API capability',
  }), true);
  assert.equal(isQueueUnsupportedError({ code: -32600, message: 'queue cannot contain more than 100 submissions' }), false);
});
