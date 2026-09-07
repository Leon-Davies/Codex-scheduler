'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  chooseThread,
  findPreferredThread,
  normalizeThreadTitle,
  titleMatchScore,
} = require('../src/ui/scheduleFlow');

test('normalizeThreadTitle removes whitespace, case, and UI punctuation', () => {
  assert.equal(
    normalizeThreadTitle('  ← Orient   Geospatial MVP Agent  '),
    'orient geospatial mvp agent',
  );
});

test('chooseThread auto-resolves one visible title match without opening picker', async () => {
  const updates = [];
  const workspaceState = {
    get() { return undefined; },
    async update(key, value) { updates.push([key, value]); },
  };
  const vscode = {
    window: {
      async showQuickPick() {
        throw new Error('thread picker should not open for a unique visible-title match');
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
    ['Codex', '← ORIENT GEOSPATIAL MVP AGENT'],
    { allowPicker: false },
  );

  assert.equal(result.id, 'thread-a');
  assert.deepEqual(updates, [['codexScheduler.lastThreadId', 'thread-a']]);
});

test('visible title embedded in surrounding UI text still resolves safely', () => {
  const threads = [
    { id: 'a', name: 'Run B1a+B1b live smoke' },
    { id: 'b', name: 'Orient Geospatial MVP agent' },
    { id: 'c', name: 'Inspect repository with MCP tools' },
  ];
  const match = findPreferredThread(threads, [
    'Back Orient Geospatial MVP agent More actions',
    'GPT-5.6 Terra Light',
  ]);
  assert.equal(match.id, 'b');
  assert.ok(titleMatchScore('Orient Geospatial MVP agent', 'Back Orient Geospatial MVP agent More actions') >= 700);
});

test('ambiguous equal-scoring thread names are not guessed', () => {
  const threads = [
    { id: 'a', name: 'Alpha Beta' },
    { id: 'b', name: 'Alpha Beta' },
  ];
  assert.equal(findPreferredThread(threads, ['Alpha Beta']), null);
});
