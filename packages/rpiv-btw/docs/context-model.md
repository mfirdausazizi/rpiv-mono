# What `/btw` sends to the model

Exactly what every `/btw` call puts in front of its effective model, where each
piece comes from, and what is guaranteed never to leave the panel.

## The request

Each `/btw` call is a single non-streaming completion. By default, the effective
model and reasoning level are `ctx.model` and `pi.getThinkingLevel()`. A global
override selected through `/btw-settings` is resolved on every call through
`ctx.modelRegistry.find(provider, modelId)` and supplies its persisted reasoning
level. If that model is unavailable, the call fails explicitly rather than silently
falling back to the session model.

Custom extension providers dispatch through Pi's auth-aware `ModelRuntime`
facade, which resolves credentials and provider-specific endpoint data. Older Pi
hosts retain the legacy global `completeSimple()` fallback.

| Part | Value |
| --- | --- |
| Model | Session model/reasoning, or the global `/btw-settings` override |
| System prompt | the bundled `prompts/btw-system.txt`, plus the cross-session hint appendix |
| Messages | `[...branch clone, ...this-session /btw turns, your question]` |
| Tools | `[]` — none, always |
| Abort signal | a fresh `AbortController` owned by `/btw`, never `ctx.signal` |

## The branch clone

The first block of messages is a read-only clone of your current session branch,
so you do not have to re-explain what you have been working on.

- The `message_end` hook takes the snapshot: it reads `ctx.sessionManager.getBranch()`
  and converts it with `convertToLlm`.
- It snapshots **only** on `role === "assistant"` messages, and **only** when
  `stopReason !== "toolUse"` — so mid-tool-call states never become the context.
- Snapshots are cached per session, keyed by `ctx.sessionManager.getSessionFile()`,
  falling back to `memory:<sessionId>` when there is no session file.
- Cold start: if no `message_end` has fired yet, `/btw` reads the branch live
  instead of using a cache.

### Invalidation

The cached snapshot is deleted on both `session_compact` and `session_tree`, so a
`/btw` issued after compaction or a branch switch never answers off a stale view
of the conversation.

Auto-compaction races session disposal in pi-core: `session_compact` can fire
with an already-invalidated `ctx` proxy. `/btw` swallows only that specific stale
error (`stale after session replacement`) — the session being compacted has no
snapshot worth invalidating. Every other error propagates, because it is a bug.

## The `/btw` history

After a successful answer, the turn is appended to this session's `/btw` history,
and every later `/btw` call in the same session replays that history between the
branch clone and your new question. Follow-ups therefore work: the side thread
has its own memory.

History stores the **actual** `UserMessage` and `AssistantMessage` object
references returned by the call — nothing is reconstructed or re-serialised.
Concatenated in a fixed order, this keeps the prompt prefix byte-identical
across calls, so provider-side prompt caching keeps hitting.

Press `x` in the overlay to clear this session's history. It is also dropped when
the Pi process exits.

## The cross-session hint

The system prompt gets an appendix listing the last **10** `/btw` *question
strings* from **all** sessions in the current Pi process, oldest first, under the
heading `## Recent /btw questions across sessions (oldest first)`. Each is
whitespace-collapsed and truncated to 200 characters.

- Only your question text crosses sessions — never answers, never branch content.
- The system prompt tells the model to treat it as a pattern hint, useful only
  when the side question is itself about recent topics or trends.
- Clearing a session's history with `x` removes its contributions to the hint.
- It lives on the same process-scoped state, so it is gone when Pi exits.

## The system prompt

`prompts/btw-system.txt` tells the side call to:

- treat the primary conversation as background, not as work to continue — the
  side question is self-contained, and it must not pick up a tool call mid-flight;
- answer directly and concisely, in compact bullets or short paragraphs;
- cite files, functions, and line numbers when grounding a claim in the context;
- say so briefly when the context is insufficient, rather than guessing;
- use no tools and reply in plain text only, even if prior assistant turns in the
  context demonstrate tool use.

## What never happens

- **No transcript entry.** The answer is rendered through `ctx.ui.custom` as an
  overlay component. It is never emitted as an agent message.
- **No answer/history disk writes.** History and snapshots live on
  `globalThis[Symbol.for("rpiv-btw")]`. Only `/btw-settings` writes its global
  model configuration; side questions and answers remain memory-only.
- **No tool use.** The call runs with `tools: []`, so a side question cannot edit
  a file or run a command even if it wanted to.
- **No effect on the main session.** `Esc` aborts the `/btw` controller only; the
  main agent's signal is never touched.
