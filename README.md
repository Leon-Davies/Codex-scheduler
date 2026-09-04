# Codex Scheduler

A small companion extension for the official OpenAI Codex VS Code extension.

Codex Scheduler lets you prepare a prompt for an **existing Codex conversation** and schedule it to be submitted later:

- **when your Codex usage window resets**; or
- **at a specific local date/time**.

It does not replace the Codex UI or create a separate chat frontend.

## Current status

Early Windows-first proof of concept.

The scheduler uses Codex's local `app-server` interface to:

- discover existing VS Code Codex threads;
- read the account's reported rate-limit/reset state;
- resume the selected existing thread;
- append a scheduled turn to that thread.

The only experimental UI bridge is capturing text that is still unsent in Codex's private prompt box, because the official extension does not currently expose a public `getDraft` command.

## Requirements

- VS Code on Windows
- the official OpenAI Codex extension (`openai.chatgpt`)
- a working Codex login

Codex Scheduler first looks for `codex` on PATH, then searches the installed official extension for its bundled `codex.exe`. You can override this with `codexScheduler.codexCommand`.

## First-run diagnostic

After installing the extension, run:

**Command Palette → `Codex Scheduler: Diagnose Codex Integration`**

The diagnostic checks:

1. the official Codex extension is installed;
2. a Codex executable can be found;
3. the `app-server` handshake succeeds;
4. account rate-limit state can be read;
5. existing VS Code Codex threads can be listed.

The results appear in the **Codex Scheduler** Output panel.

## Scheduling a prompt

### From the Codex prompt box

Keep the cursor in the Codex prompt box and press:

`Ctrl+Alt+S`

Codex Scheduler attempts to copy the current draft, restores your previous clipboard contents, and shows a preview before anything is scheduled.

You then choose:

1. the existing Codex conversation to receive the prompt;
2. **Send when usage resets** or **Send at a specific time**.

There is also a `Codex Schedule` status-bar button. Draft capture from a mouse click is intentionally treated as experimental because focus behaviour can vary between VS Code builds; if capture fails, the extension offers the clipboard workflow.

### From the clipboard

Copy any prompt and run:

**`Codex Scheduler: Schedule Prompt from Clipboard`**

This avoids the experimental prompt-box capture entirely.

## Reset-aware scheduling

For **Send when usage resets**, Codex Scheduler reads the actual Codex quota windows and their `resetsAt` timestamps. It does not blindly send at the displayed clock time: it rechecks the account state before submission and retries if Codex still reports the usage window as blocked.

If both reported quota windows are exhausted, it waits until all blocking windows should have cleared.

## Safety behaviour

- A scheduled job receives a unique ID and is not automatically submitted twice after `turn/start` returns a Codex turn ID.
- If VS Code crashes during the ambiguous submission boundary, automatic retry is suppressed and the job is marked for manual review.
- The scheduler checks thread status before submission and defers when its app-server connection sees an active turn.
- The extension does **not** auto-approve Codex permission requests.
- It does not change your model, sandbox, approval policy, or thread configuration.

Cross-client thread activity is not currently protected by an atomic upstream lock, so V0 is intended for the stated overnight use case where the target conversation is otherwise idle.

## Current V0 limitation

VS Code and the machine must remain running for scheduled jobs to fire. Windows Task Scheduler / wake-from-sleep support is planned only after the core Codex integration is verified on a real installation.

## Commands

- `Codex Scheduler: Schedule Current Draft`
- `Codex Scheduler: Schedule Prompt from Clipboard`
- `Codex Scheduler: Manage Scheduled Prompts`
- `Codex Scheduler: Show Codex Usage`
- `Codex Scheduler: Diagnose Codex Integration`

## Development

No runtime npm dependencies are used.

```bash
npm test
npm run package
```

`npm run package` creates `codex-scheduler.vsix` using `@vscode/vsce`.
