# @juicesharp/rpiv-btw

[![npm version](https://img.shields.io/npm/v/@juicesharp/rpiv-btw.svg)](https://www.npmjs.com/package/@juicesharp/rpiv-btw)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Ask side questions without polluting the main conversation. `rpiv-btw` adds
`/btw` to [Pi Agent](https://github.com/badlogic/pi-mono); answers use a
read-only clone of the current conversation and never enter the transcript.

## Install

```sh
pi install npm:@juicesharp/rpiv-btw
```

Restart Pi after installing.

## Quick start

- `/btw` opens an empty, focused centered popup.
- `/btw why did we switch from sockets to SSE?` opens the same popup and submits immediately.
- Press Enter for follow-ups. Successful turns remain in the popup and are replayed to the next side call.

Answers render as Markdown. Controls:

| Key | Action |
| --- | --- |
| `Enter` | Submit the current question |
| `PageUp` / `PageDown` | Scroll the transcript by one viewport |
| `Ctrl+L` | Clear the popup and this process's `/btw` history |
| `Esc` | Abort the active side request and close |

The popup is centered and responsive. Its input owns ordinary editing, arrows,
paste, and IME behavior. Side calls are non-streaming and one request at a time.

By default, `/btw` follows the current session model and reasoning level. Run
`/btw-settings` to choose a global model and reasoning override, or reset to
“Follow current session.” The picker searches model name, provider, and model ID,
and uses the current host's scoped models when available. An empty scope and older
hosts fall back to all available models.

Settings are stored at `~/.config/rpiv-btw/config.json` (or
`$XDG_CONFIG_HOME/rpiv-btw/config.json`). Popup history is process-scoped and is
not written to disk.

## What you get

- **No main-chat pollution** — the popup never emits an agent message.
- **Branch context** — the side request sees a read-only branch snapshot.
- **Follow-up context** — only successful turns are added to process-scoped BTW history, exactly once.
- **Safe cancellation** — Escape aborts only the active BTW request.
- **Compaction-safe context** — branch snapshots are invalidated after compaction or tree changes, but `/btw` never triggers or mutates main-session compaction.
- **Provider-cap recovery** — a numeric provider prompt limit is parsed, a 10%-safe temporary context window is rebuilt, and exactly one retry is attempted. When the provider also reports its own token count, that count calibrates the retry against `/btw`'s internal estimate so the rebuilt request actually shrinks. Unrecognized host-reported overflow retains the conservative half-budget fallback.
- **No tools** — side calls always use `tools: []`.

## Reference

- [Context model](docs/context-model.md) — request contents, budgeting, history, and invalidation.
- [Architecture](docs/architecture.md) — popup ownership, command flow, lifecycle hooks, and compatibility.

## Requirements

- An interactive Pi terminal; RPC and `pi --print` do not have a popup UI.
- A resolvable model with working credentials, either from the active session or `/btw-settings`.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `/btw requires interactive mode` | Running without a UI | Run Pi interactively |
| `/btw requires an active model` | Follow-session mode has no model | Configure `/login` or `/btw-settings` |
| `Configured /btw model … is no longer available` | Persisted model is not registered | Run `/btw-settings` |
| `/btw model (…) has no API key available.` | Credentials do not resolve | Re-authenticate that provider |
| History disappears after restarting Pi | History is intentionally process-scoped | Nothing to fix; the main session is unaffected |

## Related

- [`@juicesharp/rpiv-pi`](https://www.npmjs.com/package/@juicesharp/rpiv-pi) — umbrella package.
- [juicesharp/rpiv-mono](https://github.com/juicesharp/rpiv-mono#readme) — the rpiv family.

## License

MIT — see [LICENSE](LICENSE).
