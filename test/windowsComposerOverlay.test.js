'use strict';

const fs = require('fs');
const path = require('path');
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

test('overlay disables WinForms autoscaling and anchors above Send', () => {
  const script = fs.readFileSync(
    path.join(__dirname, '..', 'resources', 'codex-scheduler-overlay.ps1'),
    'utf8',
  );

  assert.match(script, /AutoScaleMode\]::None/);
  assert.match(script, /\$send\.centerX - \(\$form\.ClientSize\.Width \/ 2\)/);
  assert.match(script, /\$send\.y - \$form\.ClientSize\.Height - \$gap/);
  assert.match(script, /AddEllipse/);
  assert.doesNotMatch(script, /\$send\.x - \$form\.Width/);
});
