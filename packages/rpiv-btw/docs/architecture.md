# rpiv-btw architecture

`rpiv-btw` registers a focused, centered conversational popup for side questions.
The popup owns presentation and input; `btw.ts` owns model execution and
process-scoped history.

## Modules

```
rpiv-btw/
├── index.ts             — extension entry; registers commands + lifecycle hooks
├── btw.ts               — state, snapshots, model resolution, execution, history
├── btw-messages.ts      — BtwTurn and message-text helpers
├── btw-budget.ts        — pure context fitting and token budgets
├── btw-settings.ts      — global model/reasoning picker
├── config.ts            — validated XDG-aware settings persistence
├── btw-ui.ts            — centered persistent popup, Input, Markdown, scrolling
├── pi-compat.ts         — host-version-tolerant completion/runtime bridge
└── prompts/
    └── btw-system.txt   — system prompt for the side call
```

The package ships raw TypeScript through the manifest:

```json
"pi": { "extensions": ["./index.ts"] }
```

No skills, agents, CLI flags, or tools are registered.

## Commands and hooks

| Command | Behavior |
| --- | --- |
| `/btw` | Opens an empty focused popup after model validation |
| `/btw <question>` | Opens the popup and submits the initial question |
| `/btw-settings` | Configures the global model and reasoning level |

| Event | Behavior |
| --- | --- |
| `message_end` | Snapshots the branch after completed assistant messages |
| `session_compact` | Invalidates the cached branch snapshot |
| `session_tree` | Invalidates the cached branch snapshot |

`/btw` never calls or mutates main-session compaction.

## Popup ownership

`showBtwPopup` mounts `BtwPopupController` through `ctx.ui.custom` with:

| Option | Value |
| --- | --- |
| `anchor` | `center` |
| `width` | `75%` |
| `maxHeight` | `80%` |
| `margin` | `1` |

The controller implements `Component` and `Focusable`. It owns one native
`Input`, propagates focus to it, and delegates arrows, editing, paste, Enter,
and IME input to that Input. It intercepts only:

| Key | Action |
| --- | --- |
| `Escape` | Abort the active request and close |
| `PageUp` / `PageDown` | Move transcript by one viewport, clamped |
| `Ctrl+L` | Clear local transcript and process-scoped history |

The transcript is rendered with native `Markdown` and `getMarkdownTheme()`. Each
submitted question gets a pending row; the same row becomes an answer or error.
Only one request may be active. Every submission receives a fresh
`AbortController`, and a late result after close is ignored. The footer is:

`Enter send · PgUp/PgDn scroll · Ctrl+L clear · Esc close`

Scroll is stored as rows from the bottom: zero is newest. New submissions and
completed requests return to the newest content. The popup's height follows its
content: it grows only as far as the transcript needs, up to the terminal cap, so a
short answer draws a short popup instead of an empty full-height frame. Fixed
title-border/input/footer rows are excluded from the transcript viewport, including
on short terminals.

## Command and execution flow

1. Validate interactive UI and resolve the effective model/reasoning.
2. Snapshot existing successful BTW history once.
3. Mount one popup, passing its model label, snapshot, callbacks, and optional initial question.
4. For each submission, call `executeBtw` with the popup's controller.
5. On success, append the returned real `UserMessage` and `AssistantMessage` exactly once.
6. Return the answer/error to the popup; errors keep it open and aborts do not persist.

The popup does not know about models, credentials, branch snapshots, or history
storage. History is process-scoped and non-persistent.

## Context fitting and retry

The request contains the branch snapshot, successful BTW turns, and the new
question. `btw-budget.ts` preserves the compacted branch summary and fits older
content without triggering compaction.

CLIProxyAPI Codex Responses calls receive an immutable payload rewrite that sets
`max_output_tokens: 8192`. This is a `/btw`-appropriate answer ceiling and prevents
large provider defaults from consuming the whole request limit before prompt tokens
are considered.

If the first provider response is an error reporting `maximum prompt length is
500000` or `500,000`, the numeric cap is parsed, reduced by 10%, and used to
build a temporary model context window targeting that prompt limit. When the error
also reports its own token count (`the request contains 1047984 tokens`), that
count is compared against `/btw`'s own chars/4 estimate of the same prompt and the
branch budget is scaled by the difference — the provider's tokenizer is the only
ground truth for how far the estimate diverges, and without it an undercounting
estimate keeps "fitting" its budget and the retry resends an identical request. The
request is rebuilt from the unchanged source snapshot and retried once. If no
numeric cap is available but the host overflow helper recognizes the error, the
existing half-budget fallback is used. A second overflow is returned as an error;
there is never a third completion call.

## Host compatibility

`pi-compat.ts` lazily prefers the auth-aware runtime facade and preserves the
legacy `completeSimple()` fallback for older Pi hosts. Pi 0.80.5 peer APIs are
the compile target; live Pi 0.83 adds scoped model selection without changing the
fallback behavior. No private selector or session-manager API is imported.

## User-visible errors

| String | When |
| --- | --- |
| `/btw requires interactive mode` | No popup UI is available |
| `/btw requires an active model` | Follow-session mode has no model |
| `Configured /btw model <key> is no longer available; run /btw-settings` | Persisted model lookup failed |
| `/btw model (<provider>:<id>) is misconfigured: <err>` | Credential lookup failed |
| `/btw model (<provider>:<id>) has no API key available.` | Credential lookup returned no key |
| `/btw call failed: <err>` | Completion returned an error |
| `/btw call threw: <message>` | Completion threw without abort |
| `/btw returned no text content.` | Response contained no text parts |
