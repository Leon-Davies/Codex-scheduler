# Codex Scheduler

A small companion extension for the official OpenAI Codex VS Code extension.

## Goal

Leave a prompt typed in the normal Codex composer, choose **Codex Schedule**, then select either:

- **Send when quota resets**
- **Send at a specific time**

The scheduled prompt should be delivered into the same existing Codex conversation without replacing the Codex UI.

## Current status

This repository is an early proof of concept.

Confirmed on VS Code Remote/WSL with the official Codex extension:

- discovers the Codex runtime bundled with `openai.chatgpt`;
- reads real Codex rate-limit/reset state;
- lists existing VS Code Codex threads;
- supports Codex's native durable queued-turn API;
- persists scheduled jobs across VS Code restarts;
- supports fixed-time and quota-reset scheduling logic.

The remaining integration work is reliably reading the unsent draft from the private Codex composer and automatically identifying the currently visible Codex thread. The current test builds use Windows UI Automation only for draft inspection. They do not synthesize keys or mutate the clipboard.

## Test commands

Open the VS Code Command Palette and search for `Codex Scheduler`.

Useful commands include:

- `Codex Scheduler: Diagnose Codex Integration`
- `Codex Scheduler: Test Draft Capture (No Send)`
- `Codex Scheduler: Manage Scheduled Prompts`
- `Codex Scheduler: Show Codex Usage`

The draft-capture test is non-destructive and never schedules or sends a prompt.

## Development

```bash
npm test
npm run package
```

`npm run package` produces `codex-scheduler.vsix`.

## Important limitation

V0 scheduling timers run in the VS Code extension host, so VS Code and the machine currently need to remain running. Wake-from-sleep support can be added later once the core same-thread workflow is qualified.
