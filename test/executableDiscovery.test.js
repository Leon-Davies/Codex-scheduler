'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { orderCodexCandidates } = require('../src/codex/executableDiscovery');

test('prefers the official extension bundle over PATH', () => {
  assert.deepEqual(
    orderCodexCandidates({
      configured: '',
      bundled: '/extensions/openai.chatgpt/bin/codex',
      pathCommand: '/home/user/.local/bin/codex',
    }),
    [
      { command: '/extensions/openai.chatgpt/bin/codex', source: 'openai.chatgpt bundle' },
      { command: '/home/user/.local/bin/codex', source: 'PATH' },
    ],
  );
});

test('explicit codexCommand remains authoritative', () => {
  assert.deepEqual(
    orderCodexCandidates({
      configured: '/custom/codex',
      bundled: '/extensions/openai.chatgpt/bin/codex',
      pathCommand: '/home/user/.local/bin/codex',
    }),
    [{ command: '/custom/codex', source: 'setting' }],
  );
});

test('deduplicates PATH when it resolves to the bundled runtime', () => {
  assert.deepEqual(
    orderCodexCandidates({
      configured: '',
      bundled: '/same/codex',
      pathCommand: '/same/codex',
    }),
    [{ command: '/same/codex', source: 'openai.chatgpt bundle' }],
  );
});
