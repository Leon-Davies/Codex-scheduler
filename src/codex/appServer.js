'use strict';

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const readline = require('readline');

class AppServerError extends Error {
  constructor(message, payload) {
    super(message);
    this.name = 'AppServerError';
    this.payload = payload;
    this.code = payload?.code;
    this.data = payload?.data;
  }
}

class CodexAppServer extends EventEmitter {
  constructor({ command, cwd, output }) {
    super();
    this.command = command;
    this.cwd = cwd;
    this.output = output;
    this.child = null;
    this.pending = new Map();
    this.nextRequestId = 1;
    this.initialized = false;
    this.closed = false;
  }

  async start() {
    if (this.child && !this.closed) {
      return;
    }

    this.closed = false;
    this.child = spawn(this.command, ['app-server'], {
      cwd: this.cwd || undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: process.env,
    });

    this.child.on('error', (error) => this.#handleProcessError(error));
    this.child.on('exit', (code, signal) => this.#handleExit(code, signal));

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      const text = String(chunk).trimEnd();
      if (text) {
        this.output?.appendLine(`[codex stderr] ${text}`);
      }
    });

    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on('line', (line) => this.#handleLine(line));

    await this.request('initialize', {
      clientInfo: {
        name: 'codex_scheduler',
        title: 'Codex Scheduler VS Code Extension',
        version: '0.0.1',
      },
    });
    this.notify('initialized', {});
    this.initialized = true;
  }

  async request(method, params) {
    if (!this.child || this.closed) {
      if (method !== 'initialize') {
        throw new Error('Codex app-server is not running.');
      }
    }

    const id = this.nextRequestId++;
    const message = { method, id };
    if (params !== undefined) {
      message.params = params;
    }

    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
    });

    this.#write(message);
    return promise;
  }

  notify(method, params) {
    const message = { method };
    if (params !== undefined) {
      message.params = params;
    }
    this.#write(message);
  }

  waitForNotification(method, predicate = () => true, timeoutMs = 0) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const handler = (message) => {
        if (message.method === method && predicate(message.params || {})) {
          cleanup();
          resolve(message.params || {});
        }
      };
      const cleanup = () => {
        this.off('notification', handler);
        if (timer) {
          clearTimeout(timer);
        }
      };

      this.on('notification', handler);
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          cleanup();
          reject(new Error(`Timed out waiting for ${method}.`));
        }, timeoutMs);
      }
    });
  }

  dispose() {
    this.closed = true;
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
    this.#rejectPending(new Error('Codex app-server disposed.'));
    this.child = null;
  }

  #write(message) {
    if (!this.child?.stdin || this.child.stdin.destroyed) {
      throw new Error('Codex app-server stdin is unavailable.');
    }
    this.output?.appendLine(`[rpc ->] ${message.method}${message.id !== undefined ? ` #${message.id}` : ''}`);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.output?.appendLine(`[rpc parse error] ${error.message}: ${line.slice(0, 500)}`);
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, 'id') && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new AppServerError(
          message.error.message || `${pending.method} failed.`,
          message.error,
        ));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method && Object.prototype.hasOwnProperty.call(message, 'id')) {
      this.output?.appendLine(`[rpc server request] ${message.method} #${message.id}`);
      this.emit('serverRequest', message);
      return;
    }

    if (message.method) {
      this.emit('notification', message);
      this.emit(message.method, message.params || {});
    }
  }

  #handleProcessError(error) {
    this.output?.appendLine(`[codex process error] ${error.message}`);
    this.#rejectPending(error);
    this.emit('processError', error);
  }

  #handleExit(code, signal) {
    this.closed = true;
    const error = new Error(`Codex app-server exited (code=${code}, signal=${signal || 'none'}).`);
    this.output?.appendLine(`[codex exit] ${error.message}`);
    this.#rejectPending(error);
    this.emit('exit', { code, signal });
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

module.exports = {
  AppServerError,
  CodexAppServer,
};
