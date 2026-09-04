'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function isFile(candidate) {
  try {
    return Boolean(candidate) && fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function findOnPath(platform = process.platform) {
  const command = platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(command, ['codex'], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0 || !result.stdout) {
    return null;
  }

  const candidates = result.stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);

  return candidates.find(isFile) || candidates[0] || null;
}

function scanForCodexExecutable(root, platform = process.platform, maxDepth = 5) {
  if (!root || !fs.existsSync(root)) {
    return null;
  }

  const expectedName = platform === 'win32' ? 'codex.exe' : 'codex';
  const preferredSegments = ['bin', 'vendor', 'resources', 'dist'];
  const queue = [{ dir: root, depth: 0 }];
  const matches = [];

  while (queue.length > 0) {
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === expectedName) {
        matches.push(full);
      } else if (entry.isDirectory() && depth < maxDepth) {
        if (!['node_modules', '.git'].includes(entry.name)) {
          queue.push({ dir: full, depth: depth + 1 });
        }
      }
    }
  }

  matches.sort((a, b) => {
    const score = (value) => preferredSegments.reduce(
      (total, segment) => total + (value.toLowerCase().includes(`${path.sep}${segment}${path.sep}`) ? 1 : 0),
      0,
    );
    return score(b) - score(a) || a.length - b.length;
  });

  return matches[0] || null;
}

function discoverCodexExecutable(vscode) {
  const configured = vscode.workspace
    .getConfiguration('codexScheduler')
    .get('codexCommand', '')
    .trim();

  if (configured) {
    return { command: configured, source: 'setting' };
  }

  const fromPath = findOnPath();
  if (fromPath) {
    return { command: fromPath, source: 'PATH' };
  }

  const officialExtension = vscode.extensions.getExtension('openai.chatgpt');
  if (officialExtension) {
    const bundled = scanForCodexExecutable(officialExtension.extensionPath);
    if (bundled) {
      return { command: bundled, source: 'openai.chatgpt bundle' };
    }
  }

  return null;
}

module.exports = {
  discoverCodexExecutable,
  findOnPath,
  scanForCodexExecutable,
};
