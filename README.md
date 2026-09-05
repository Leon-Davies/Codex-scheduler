# Codex Scheduler

A small Windows/WSL companion extension for the official OpenAI Codex VS Code extension.

It lets you leave a prompt typed in the existing Codex composer and schedule that exact prompt for later without replacing the Codex UI or conversation history.

## Intended workflow

1. Type the prompt normally in Codex.
2. Click the small clock button above Codex's Send button.
3. Choose either:
   - **Send when quota resets** to arm a one-shot reset send.
   - **Send at specific time...** to enter `HH:MM` or a short delay such as `in 20m` / `in 2h`.
4. The scheduler later adds the prompt to the same Codex conversation through Codex's native queued-turn API.

## Current behavior

- **Send when quota resets** is one-shot: disabled → enabled → prompt queued once after the reset/availability check → disabled again automatically.
- **Send at specific time...** supports clock times and relative delays.
- Existing Codex conversations are targeted through Codex's native queued-turn API.
- A brand-new unsent Codex chat may not yet have a persisted thread target. Send one normal message first, then schedule subsequent prompts.
- The scheduler fails closed if it cannot identify the visible Codex conversation safely.

## Development status

Windows + VS Code Remote/WSL is the primary tested environment.

Confirmed so far:

- real Codex quota/reset reads;
- existing Codex thread discovery;
- native durable queued-turn delivery;
- exact draft capture from the visible Codex composer;
- automatic current-thread matching for established chats;
- owner-tested end-to-end timed delivery into the same existing Codex conversation;
- one-shot reset jobs become terminal immediately after successful queue submission;
- persistent jobs across VS Code restarts;
- duplicate-send protection;
- composer-adjacent Schedule button for Windows/WSL;
- cached geometry tracking across resize/fullscreen transitions;
- automatic hiding while VS Code is not foreground.

V0 currently requires VS Code and the machine to remain running/awake for timers to fire.
