# What `/btw` sends to the model

Each submitted question is one non-streaming completion. `/btw` opens a
centered popup, but the popup does not own model or history state.

## The request

The effective model and reasoning level are `ctx.model` and
`pi.getThinkingLevel()` by default. `/btw-settings` can override both. A
configured model is resolved explicitly through `ctx.modelRegistry.find`; if it
is unavailable, `/btw` fails instead of silently substituting the session model.
The picker uses scoped models when the host exposes a non-empty scope, and falls
back to all available models on empty or older-host scopes.

Custom providers use Pi's auth-aware `ModelRuntime.completeSimple()` when
available. Older hosts retain the legacy `completeSimple()` fallback.

| Part | Value |
| --- | --- |
| Model | Session model or the validated `/btw-settings` override |
| System prompt | Bundled `prompts/btw-system.txt` plus the cross-session hint |
| Messages | `[...branch clone, ...successful BTW turns, your question]` |
| Tools | `[]` — always none |
| Abort signal | A fresh popup-owned `AbortController` per submission |

## The branch clone

The first messages are a read-only clone of the current session branch. The
`message_end` hook snapshots `ctx.sessionManager.getBranch()` after completed
assistant messages whose `stopReason` is not `toolUse`.

Snapshots are cached per session-file key, with `memory:<sessionId>` as the
fallback. A cold `/btw` reads the branch live. Cached snapshots are invalidated on
`session_compact` and `session_tree`; `/btw` never invokes or mutates main-session
compaction.

## Context fitting and provider-cap recovery

The budget engine preserves compacted branch summaries and fits the branch plus
BTW history without changing the main session. If the provider returns an error
such as:

- `maximum prompt length is 500000`
- `maximum prompt length is 500,000`

`/btw` parses the numeric cap, applies a 10% safety margin, creates a temporary
model copy whose context window targets that prompt limit, rebuilds from the
unchanged snapshot/history, and retries exactly once.

When the error also reports its own token count (`the request contains 1047984
tokens`), that count is the provider tokenizer's measurement of the exact prompt
that was just rejected. `/btw` compares it against its own chars/4 estimate of the
same prompt and scales the branch budget by the difference. This matters because a
provider may advertise a 2M window while enforcing 500k: scaling only the advertised
window can leave a budget that still sits above the internal estimate, so the branch
keeps "fitting", nothing is trimmed, and the retry resends a byte-identical request.

When no numeric cap is available but the host recognizes context overflow, the
existing conservative half-budget fallback is used. A second overflow is returned as
an error; there is no third call. A successful response is never retried merely
because it has an `errorMessage` field.

## BTW history

Only successful results append history. The command layer stores the actual
`UserMessage` and `AssistantMessage` objects returned by the completion exactly
once. Each later follow-up replays those turns between the branch clone and the
new question. This history is process-scoped and non-persistent.

Inside the popup:

- Enter submits a question and clears only the submitted input.
- Enter during a pending request is ignored.
- PageUp/PageDown scroll transcript rows from the bottom and clamp at both ends.
- Ctrl+L clears the local transcript and this session's process history.
- Escape aborts the active request and closes; late provider results are ignored.

Successful assistant text is rendered with native Markdown and the current
Pi Markdown theme. Pending, error, and context-trimmed states remain visible in
the transcript. Ordinary arrows and editing keys are delegated to native Input.

## Cross-session hint

The system prompt appends the last 10 question strings from all process-scoped
BTW histories, oldest first. Questions are whitespace-collapsed and truncated to
200 characters. Answers and branch content never cross sessions. Clearing one
session removes its questions from this hint.

## What never happens

- No answer enters the main transcript.
- No side answer or history is written to disk.
- No tools are available to the side call.
- No main-session signal is aborted by Escape.
- No `/btw` command triggers compaction.
