'use strict';

const { execFile } = require('child_process');
const crypto = require('crypto');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

async function captureFocusedText(vscode) {
  if (process.platform !== 'win32') {
    throw new Error('Automatic Codex draft capture is currently Windows-only. Use “Schedule Prompt from Clipboard” on this platform.');
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
    await execFileAsync('powershell.exe', [
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
};
