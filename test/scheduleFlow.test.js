'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  chooseThread,
  normalizeThreadTitle,
} = require('../src/ui/scheduleFlow');

test('normalizeThreadTitle normalizes whitespace and case', () => {
  assert.equal(
    normalizeThreadTitle('  Orient   Geospatial MVP Agent  '),
    'orient geospatial mvp agent',
  );
});

test('chooseThread auto-resolves one exact visible title match without opening picker', async () => {
  const updates = [];
  const workspaceState = {
    get() { return undefined; },
    async update(key, value) { updates.push([key, value]); },
  };
  const vscode = {
    window: {
      async showQuickPick() {
        throw new Error('thread picker should not open for a unique exact title match');
      },
    },
  };
  const threads = [
    { id: 'thread-a', name: 'Orient Geospatial MVP agent', updatedAt: 10 },
    { id: 'thread-b', name: 'Plan developer workflow improvements', updatedAt: 20 },
  ];
  const codex = {
    getWorkspaceCwd() { return '/home/leonm/heimdall-pov'; },
    async listVscodeThreads() { return threads; },
  };

  const result = await chooseThread(
    vscode,
    codex,
    workspaceState,
    ['Codex', 'ORIENT GEOSPATIAL MVP AGENT'],
  );

  assert.equal(result.id, 'thread-a');
  assert.deepEqual(updates, [['codexScheduler.lastThreadId', 'thread-a']]);
});
