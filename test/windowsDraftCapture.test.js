'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isWslEnvironment,
  parseUiaInspection,
  summarizeElement,
} = require('../src/platform/windowsDraftCapture');

test('detects WSL from environment variables', () => {
  assert.equal(isWslEnvironment({
    platform: 'linux',
    env: { WSL_DISTRO_NAME: 'Ubuntu' },
    procVersion: '',
  }), true);
});

test('detects WSL from proc version', () => {
  assert.equal(isWslEnvironment({
    platform: 'linux',
    env: {},
    procVersion: 'Linux version 6.6.87.2-microsoft-standard-WSL2',
  }), true);
});

test('does not treat ordinary Linux as WSL', () => {
  assert.equal(isWslEnvironment({
    platform: 'linux',
    env: {},
    procVersion: 'Linux version 6.8.0-generic',
  }), false);
});

test('parses UI Automation capture results without changing the text', () => {
  const result = parseUiaInspection(JSON.stringify({
    ok: true,
    text: 'line one\nline two',
    pattern: 'TextPattern',
  }));
  assert.equal(result.ok, true);
  assert.equal(result.text, 'line one\nline two');
  assert.equal(result.pattern, 'TextPattern');
});

test('summarizes the focused accessibility control for diagnostics', () => {
  const text = summarizeElement({
    controlType: 'ControlType.Edit',
    className: 'CodexComposer',
    automationId: 'prompt-input',
    name: 'Message Codex',
  });
  assert.match(text, /ControlType\.Edit/);
  assert.match(text, /CodexComposer/);
  assert.match(text, /prompt-input/);
  assert.match(text, /Message Codex/);
});
