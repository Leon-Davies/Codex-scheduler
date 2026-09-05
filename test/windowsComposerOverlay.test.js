'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canUseComposerOverlay,
  toWindowsPath,
} = require('../src/platform/windowsComposerOverlay');
const { isWslEnvironment } = require('../src/platform/windowsDraftCapture');

test('composer overlay platform helpers are available', () => {
  assert.equal(typeof canUseComposerOverlay, 'function');
  assert.equal(typeof toWindowsPath, 'function');
});

test('non-Windows non-WSL hosts pass paths through unchanged', () => {
  if (process.platform === 'win32' || isWslEnvironment()) {
    return;
  }
  assert.equal(canUseComposerOverlay(), false);
  assert.equal(toWindowsPath('/tmp/codex-scheduler-test'), '/tmp/codex-scheduler-test');
});
