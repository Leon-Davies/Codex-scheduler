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
- add the prompt to Codex's own durable queued-turn mechanism at the scheduled time.

The scheduler does **not** resume or take write ownership of the existing thread. Recent Codex builds watch their durable queue for messages written by another local process and dispatch the queued message when the owning thread is idle.

The only experimental UI bridge is capturing text that is still unsent in Codex's private prompt box, because the official extension does not currently expose a public `getDraft` command.

## Requirements

- VS Code on Windows
- the official OpenAI Codex extension (`openai.chatgpt`)
- a recent Codex build that supports the experimental native queued-turn API
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
5. existing VS Code Codex threads can be listed;
6. the installed Codex build exposes the native queued-turn API.

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

## How delivery works

At the scheduled time, Codex Scheduler adds the prompt to Codex's native durable user-message queue for the selected existing thread.

It does not call `thread/resume` and does not use a background `turn/start` against the thread owned by the official VS Code extension. Codex itself starts the queued message when that thread is idle.

For **Send when usage resets**, Codex Scheduler reads the actual Codex quota windows and their `resetsAt` timestamps. It does not blindly submit at the displayed clock time: it rechecks the account state first and waits if Codex still reports the usage window as blocked.

A fixed-time job means **not before this time**. If Codex is still usage-blocked at that point, the scheduler waits for the reported reset instead of intentionally starting a turn that is expected to fail.

## Safety behaviour

- A scheduled job receives a unique ID that is also used as its stable Codex client-message ID.
- Once `thread/queue/add` returns a queued-submission ID, the scheduler never automatically enqueues that job again.
- If VS Code crashes during the ambiguous queue-add boundary, automatic retry is suppressed to avoid a duplicate message.
- Active Codex turns are not steered or interrupted. The native queue waits for the thread to become idle.
- The extension does **not** auto-approve Codex permission requests.
- It does not change your model, sandbox, approval policy, or thread configuration.
- Older Codex builds without the queued-turn API fail closed rather than falling back to the racy cross-client `turn/start` path.

## Current V0 limitation

VS Code and the machine must remain running for the local scheduler timer to fire. Windows Task Scheduler / wake-from-sleep support is planned only after the core Codex integration is verified on a real installation.

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
