'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { getPowerShellCommand, isWslEnvironment } = require('./windowsDraftCapture');

const OVERLAY_CONTEXT_KEY = 'codexScheduler.pendingOverlayContext';

function toWindowsPath(filePath) {
  if (process.platform === 'win32') {
    return filePath;
  }
  if (!isWslEnvironment()) {
    return filePath;
  }
  return execFileSync('wslpath', ['-w', filePath], {
    encoding: 'utf8',
    timeout: 3000,
  }).trim();
}

function canUseComposerOverlay() {
  return process.platform === 'win32' || isWslEnvironment();
}

class ComposerOverlay {
  constructor({ context, output, onAction }) {
    this.context = context;
    this.output = output;
    this.onAction = onAction;
    this.child = null;
    this.poller = null;
    this.eventDir = null;
    this.eventPath = null;
    this.offset = 0;
    this.pending = '';
  }

  start() {
    if (!canUseComposerOverlay()) {
      this.output.appendLine('[overlay] unavailable: Windows UI is required.');
      return false;
    }
    if (this.child) {
      return true;
    }

    const powershell = getPowerShellCommand();
    if (!powershell) {
      this.output.appendLine('[overlay] unavailable: Windows PowerShell was not found.');
      return false;
    }

    this.eventDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-scheduler-overlay-'));
    this.eventPath = path.join(this.eventDir, 'events.jsonl');
    fs.writeFileSync(this.eventPath, '', 'utf8');

    const scriptPath = this.context.asAbsolutePath('resources/codex-scheduler-overlay.ps1');
    const windowsScriptPath = toWindowsPath(scriptPath);
    const windowsEventPath = toWindowsPath(this.eventPath);

    this.output.appendLine(`[overlay] starting helper with ${powershell}`);
    this.child = spawn(powershell, [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden',
      '-File', windowsScriptPath,
      '-EventPath', windowsEventPath,
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.child.stdout?.on('data', (chunk) => {
      const text = String(chunk || '').trim();
      if (text) this.output.appendLine(`[overlay stdout] ${text}`);
    });
    this.child.stderr?.on('data', (chunk) => {
      const text = String(chunk || '').trim();
      if (text) this.output.appendLine(`[overlay stderr] ${text}`);
    });
    this.child.on('exit', (code, signal) => {
      this.output.appendLine(`[overlay] helper exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      this.child = null;
    });
    this.child.on('error', (error) => {
      this.output.appendLine(`[overlay] helper error: ${error.stack || error.message}`);
    });

    this.poller = setInterval(() => this.#pollEvents(), 200);
    this.output.appendLine('[overlay] helper started.');
    return true;
  }

  #pollEvents() {
    if (!this.eventPath) return;
    let stat;
    try {
      stat = fs.statSync(this.eventPath);
    } catch {
      return;
    }
    if (stat.size <= this.offset) {
      return;
    }

    try {
      const fd = fs.openSync(this.eventPath, 'r');
      const length = stat.size - this.offset;
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, this.offset);
      fs.closeSync(fd);
      this.offset = stat.size;
      this.pending += buffer.toString('utf8');
    } catch (error) {
      this.output.appendLine(`[overlay] event read failed: ${error.message}`);
      return;
    }

    const lines = this.pending.split(/\r?\n/);
    this.pending = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        this.output.appendLine(
          `[overlay] ${event.action || 'unknown'} captured ${String(event.prompt || '').length} character(s); `
          + `${Array.isArray(event.threadTitleCandidates) ? event.threadTitleCandidates.length : 0} thread-title candidate(s)`,
        );

        const dispatch = async () => {
          await this.context.workspaceState.update(OVERLAY_CONTEXT_KEY, {
            action: event.action || null,
            capturedAt: Number(event.capturedAt || Date.now()),
            threadTitleCandidates: Array.isArray(event.threadTitleCandidates)
              ? event.threadTitleCandidates
              : [],
          });
          try {
            await this.onAction?.(event);
          } finally {
            await this.context.workspaceState.update(OVERLAY_CONTEXT_KEY, undefined);
          }
        };

        Promise.resolve(dispatch()).catch((error) => {
          this.output.appendLine(`[overlay] action failed: ${error.stack || error.message}`);
        });
      } catch (error) {
        this.output.appendLine(`[overlay] invalid event JSON: ${error.message}`);
      }
    }
  }

  dispose() {
    if (this.poller) {
      clearInterval(this.poller);
      this.poller = null;
    }
    if (this.child) {
      try {
        this.child.kill();
      } catch {}
      this.child = null;
    }
    if (this.eventDir) {
      try {
        fs.rmSync(this.eventDir, { recursive: true, force: true });
      } catch {}
      this.eventDir = null;
      this.eventPath = null;
    }
    void this.context.workspaceState.update(OVERLAY_CONTEXT_KEY, undefined);
  }
}

module.exports = {
  ComposerOverlay,
  OVERLAY_CONTEXT_KEY,
  canUseComposerOverlay,
  toWindowsPath,
};
