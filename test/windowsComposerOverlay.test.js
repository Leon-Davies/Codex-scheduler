'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  OVERLAY_CONTEXT_KEY,
  canUseComposerOverlay,
  toWindowsPath,
} = require('../src/platform/windowsComposerOverlay');
const { isWslEnvironment } = require('../src/platform/windowsDraftCapture');

test('composer overlay platform helpers are available', () => {
  assert.equal(typeof canUseComposerOverlay, 'function');
  assert.equal(typeof toWindowsPath, 'function');
  assert.equal(OVERLAY_CONTEXT_KEY, 'codexScheduler.pendingOverlayContext');
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

test('overlay supports fullscreen composers and opens menu on mouse-down', () => {
  const script = fs.readFileSync(
    path.join(__dirname, '..', 'resources', 'codex-scheduler-overlay.ps1'),
    'utf8',
  );

  assert.match(script, /Add_MouseDown/);
  assert.match(script, /Cursor\]::Position/);
  assert.doesNotMatch(script, /\$rect\.width -gt \(\$windowRect\.width \* 0\.75\)/);
  assert.match(script, /MouseOverBackColor/);
});

test('overlay uses cached geometry for smooth resize tracking and hides outside VS Code', () => {
  const script = fs.readFileSync(
    path.join(__dirname, '..', 'resources', 'codex-scheduler-overlay.ps1'),
    'utf8',
  );

  assert.match(script, /function Refresh-CachedAnchor/);
  assert.match(script, /\$timer\.Interval = 90/);
  assert.match(script, /\$script:scanCounter -ge 7/);
  assert.match(script, /TopMost, so hide it whenever VS Code is not the/);
});

test('overlay captures thread-title candidates for automatic current-thread matching', () => {
  const script = fs.readFileSync(
    path.join(__dirname, '..', 'resources', 'codex-scheduler-overlay.ps1'),
    'utf8',
  );

  assert.match(script, /function Get-ThreadTitleCandidates/);
  assert.match(script, /threadTitleCandidates = \$threadTitleCandidates/);
  assert.match(script, /Select-Object -First 12/);
});
