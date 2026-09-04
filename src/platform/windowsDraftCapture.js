'use strict';

const fs = require('fs');
const { execFile } = require('child_process');
const crypto = require('crypto');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

function isWslEnvironment({ platform = process.platform, env = process.env, procVersion } = {}) {
  if (platform !== 'linux') {
    return false;
  }
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) {
    return true;
  }
  let version = procVersion;
  if (version === undefined) {
    try {
      version = fs.readFileSync('/proc/version', 'utf8');
    } catch {
      version = '';
    }
  }
  return /microsoft|wsl/i.test(version || '');
}

function getPowerShellCommand() {
  if (process.platform === 'win32') {
    return 'powershell.exe';
  }
  if (isWslEnvironment()) {
    const systemPowerShell = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
    return fs.existsSync(systemPowerShell) ? systemPowerShell : 'powershell.exe';
  }
  return null;
}

async function captureFocusedText(vscode) {
  const powershell = getPowerShellCommand();
  if (!powershell) {
    throw new Error('Automatic Codex draft capture currently requires a Windows VS Code UI (native Windows or WSL Remote). Use “Schedule Prompt from Clipboard” on this platform.');
  }

  const previousClipboard = await vscode.env.clipboard.readText();
  const sentinel = `__CODEX_SCHEDULER_${crypto.randomUUID()}__`;
  await vscode.env.clipboard.writeText(sentinel);

  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Start-Sleep -Milliseconds 80',
    "[System.Windows.Forms.SendKeys]::SendWait('^a')",
    'Start-Sleep -Milliseconds 80',
    "[System.Windows.Forms.SendKeys]::SendWait('^c')",
    'Start-Sleep -Milliseconds 120',
    "[System.Windows.Forms.SendKeys]::SendWait('{RIGHT}')",
  ].join('; ');

  try {
    await execFileAsync(powershell, [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-Command',
      script,
    ], {
      windowsHide: true,
      timeout: 5000,
    });

    const captured = await vscode.env.clipboard.readText();
    if (!captured || captured === sentinel) {
      throw new Error('No text was captured. Keep the cursor inside the Codex prompt box and use Ctrl+Alt+S, or copy the prompt and use the clipboard command.');
    }
    return captured;
  } finally {
    await vscode.env.clipboard.writeText(previousClipboard);
  }
}

module.exports = {
  captureFocusedText,
  getPowerShellCommand,
  isWslEnvironment,
};
