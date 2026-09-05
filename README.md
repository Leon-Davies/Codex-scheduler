# Codex Scheduler

A small companion extension for the official OpenAI Codex VS Code extension.

It is designed for one narrow workflow:

1. type a prompt in the normal Codex composer;
2. choose **Schedule**;
3. choose **Send when quota resets** or **Send at a specific time**;
4. leave the prompt queued for that existing Codex conversation.

## Current development status

This repository is still in active V0 qualification.

Confirmed on VS Code Remote/WSL with the official Codex extension:

- Codex app-server discovery and handshake;
- account usage/reset reads;
- existing VS Code thread discovery;
- native durable `thread/queue/*` support;
- non-destructive Codex composer text capture through Windows UI Automation.

The current Windows/WSL build places a compact circular companion Schedule control directly above Codex's Send button. It does not patch the OpenAI extension or inject JavaScript into its webview.

## Development

```bash
npm test
npm run package
```

`npm run package` creates `codex-scheduler.vsix`.
