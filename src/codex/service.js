'use strict';

const path = require('path');
const { CodexAppServer } = require('./appServer');
const { discoverCodexExecutable } = require('./executableDiscovery');

class CodexService {
  constructor({ vscode, output }) {
    this.vscode = vscode;
    this.output = output;
    this.client = null;
    this.executable = null;
  }

  async ensureClient() {
    if (this.client && !this.client.closed) return this.client;

    this.executable = discoverCodexExecutable(this.vscode);
    if (!this.executable) {
      throw new Error('Could not find the Codex executable. Install/enable the official OpenAI Codex extension, add Codex to PATH, or set codexScheduler.codexCommand.');
    }

    const workspace = this.vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    this.output.appendLine(`[codex] using ${this.executable.command} (${this.executable.source})`);
    this.client = new CodexAppServer({
      command: this.executable.command,
      cwd: workspace || process.cwd(),
      output: this.output,
    });
    this.client.on('serverRequest', (request) => {
      this.output.appendLine(`[codex] turn needs client interaction: ${request.method}. Codex Scheduler does not auto-approve requests.`);
    });
    await this.client.start();
    return this.client;
  }

  async getRateLimits() {
    const client = await this.ensureClient();
    return client.request('account/rateLimits/read');
  }

  async listVscodeThreads(cwd, limit = 20) {
    const client = await this.ensureClient();
    const params = {
      cursor: null,
      limit,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      sourceKinds: ['vscode'],
      archived: false,
    };
    if (cwd) params.cwd = cwd;
    const response = await client.request('thread/list', params);
    return Array.isArray(response?.data) ? response.data : [];
  }

  async readThread(threadId) {
    const client = await this.ensureClient();
    const response = await client.request('thread/read', { threadId, includeTurns: false });
    return response?.thread || null;
  }

  async submitTurn(threadId, prompt) {
    const client = await this.ensureClient();
    const resumed = await client.request('thread/resume', { threadId });
    const thread = resumed?.thread;
    if (!thread?.id) throw new Error(`Codex did not resume thread ${threadId}.`);

    if (thread.status?.type === 'active') {
      const flags = Array.isArray(thread.status.activeFlags) ? ` (${thread.status.activeFlags.join(', ')})` : '';
      const error = new Error(`Target Codex thread is active${flags}; scheduled prompt was not injected.`);
      error.code = 'THREAD_ACTIVE';
      throw error;
    }

    const response = await client.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: prompt }],
    });
    const turn = response?.turn;
    if (!turn?.id) throw new Error('Codex accepted turn/start without returning a turn id.');

    return {
      thread,
      turn,
      completion: client.waitForNotification(
        'turn/completed',
        (params) => params.threadId === threadId && params.turn?.id === turn.id,
      ),
    };
  }

  getWorkspaceCwd() {
    const folders = this.vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;
    return path.normalize(folders[0].uri.fsPath);
  }

  dispose() {
    this.client?.dispose();
    this.client = null;
  }
}

module.exports = { CodexService };
