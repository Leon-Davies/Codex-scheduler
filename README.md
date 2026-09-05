# Codex Scheduler

A small Windows/WSL companion extension for the official OpenAI Codex VS Code extension.

It lets you leave a prompt typed in the existing Codex composer and schedule that exact prompt for later without replacing the Codex UI or conversation history.

## Intended workflow

1. Type the prompt normally in Codex.
2. Click the small clock button above Codex's Send button.
3. Choose either:
   - **Send when quota resets**
   - **Send at specific time...**
4. The scheduler later adds the prompt to the same Codex conversation through Codex's native queued-turn API.

## Current status

This repository is still under active qualification against the current OpenAI Codex VS Code extension. Windows + VS Code Remote/WSL is the primary tested environment.

Current capabilities include:

- real Codex quota/reset reads;
- existing Codex thread discovery;
- native durable queued-turn delivery;
- fixed-time and quota-reset jobs;
- persistent jobs across VS Code restarts;
- duplicate-send protection;
- UI Automation draft capture;
- a composer-adjacent Schedule button for Windows/WSL.

V0 currently requires VS Code and the machine to remain running for timers to fire.
