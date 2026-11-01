# Next Prompt for bb

A [bb](https://getbb.app) plugin that predicts the instructions you are likely
to type next, after each finished turn in a thread, and shows up to three of
them, best first, as numbered cards above the composer:

```text
[1. run the focused tests  Tab ↹]  [2. show me the diff first]        ×
```

With the `display` setting set to `ghost`, the best one appears as grey text
inside the empty composer, where bb's placeholder usually is; `both` shows the
cards and the grey text.

Click a card to put its text in the draft, or press **Tab** or **→** in the
empty composer, or swipe right in it on a touch screen, to do that with the best
one. Nothing is sent: you edit or send the draft yourself. Set `cardClick` to
`send` to make a click send the card at once; Tab, → and the swipe still only
insert.

The cards take one row. When some do not fit, a chevron expands the list, and the
browser remembers that choice. Typing hides the suggestions, and clearing the
draft back to empty brings them back, without a new model request. To dismiss them, click **×**, or press **Esc** on the grey text.

With `display` set to `both` and `prefillBest` on, the best suggestion goes into
the empty composer as real text instead of grey text. The cards stay until you
edit the draft or pick one, and a click replaces the text with the card's.
Dismissing them, or a new turn, takes the unedited text out again.

Suggestions are display-only. The plugin writes nothing into the thread or the
agent's context, and a new turn, a failure, archiving or deleting the thread
discards the current suggestions. Until then they survive a plugin reload or a
bb restart, and so does a dismissal: an unchanged conversation gets neither a
new request nor the dismissed suggestions back.

The prompt, the transcript excerpt and the reply checks come from
[next-prompt-core](https://github.com/CrazyCoder/next-prompt-core), shared with
[claude-next-prompt](https://github.com/CrazyCoder/claude-next-prompt). This
plugin holds the generated copy in `vendor/`.

## When suggestions are made

When a visible thread goes idle after an answer of 20 characters or more, the
plugin reads its timeline and sends one request with:

- the first user request, cut to 2,500 characters;
- the newest user and assistant messages, up to the transcript budget (10,000
  characters by default).

Tool calls, commands and their output are never sent. Hidden threads, child
threads (their parent agent writes the next message), threads with queued
messages, threads whose last turn failed, and parents with child threads that
are queued, starting or running (a parent usually runs again when its children
report back, and gets a suggestion then) get no suggestion; `bb next-prompt
suggest` still works on any idle thread.

What to suggest is the prompt's decision. The model answers with JSON,
`{"suggestions": [...]}`, best first, and an empty list when the user can just
wait. The code checks only the form: a reply that is not JSON shows nothing, and
a suggestion must be a single line under 100 characters and must differ from the
ones before it. Every backend is asked for this JSON.

Each thread's last result, the suggestions, a dismissal or the model's
silence, is stored with a fingerprint of the prompt, the model route and the
transcript. A matching fingerprint answers the next idle event without a
request; any change makes a new one.

## Model

Pick the provider and model under Settings → Plugins → Next Prompt with bb's
own provider/model picker, or with `bb next-prompt model`. With no saved
choice, suggestions use Claude Code's `claude-sonnet-5-5` at low reasoning; bb's
own default model is usually too heavy to run after every turn.

The picked provider decides how a request runs:

| Provider | What runs |
| --- | --- |
| Claude Code | `claude -p` on the bb server with the picked model, and no tools, MCP servers, setting sources, skills or session file. At low reasoning thinking is off; a higher level passes `--effort` and lets the model think. |
| Codex | `codex exec` with the picked model and reasoning effort, in an empty temporary directory, ignoring user config and rules, in a read-only sandbox. |
| Any other (pi, ACP agents) | A hidden bb worker thread in the source thread's project and environment, with the least permissive permission mode the provider supports. It is archived and stopped after each attempt. It carries the provider's full agent setup, so it is slower and larger. |

The Claude Code and Codex paths use the CLI's own login, so they bill to the
Claude or ChatGPT subscription and need no API key. The CLI must be logged in
on the machine that runs the bb server.

To send every request to an HTTP API instead, set `apiFormat` to `anthropic`
(`POST <base>/v1/messages`) or `openai` (`POST <base>/chat/completions`), with
`apiModel`, `apiBaseUrl` and `apiKey`.

Measured on one host, 2026-10-05. The first four rows cover six real thread
transcripts (90 B to 9 KB), two runs each, in model time without the 1.3 s of
CLI startup; the rest are single end-to-end runs:

| Provider and model | Time | Notes |
| --- | --- | --- |
| Claude Code, Sonnet 5.5, low (default) | 1.5 s | right answer to yes/no offers ("yes, delete them too"), silent on threads with no obvious next step; about 5× Haiku's usage per request |
| Claude Code, Sonnet 5.5, `--effort low` with thinking on | 1.5 s | same answers as thinking off: Sonnet did not think on these prompts |
| Claude Code, Haiku 4.5, low | 0.8 s | the cheapest option; more replies in the assistant's voice and occasional notes-to-self such as "wait for their reply" |
| Claude Code, Haiku 4.5, thinking on | 8–20 s | 700–1,800 output tokens for a four-word reply, which is why low reasoning turns thinking off |
| Codex, `gpt-6-luna`, low | 3–5 s | about 6k tokens; often returns nothing, which shows no suggestion |
| omp (ACP), `deepseek/deepseek-v4-flash`, low | 6 s end to end | worker thread |
| pi, any model | failed | the pi thread did not start within the timeout ("pi extension did not report ready in time") |
| `anthropic` API through a Claude Agent SDK proxy | about 30 s | the proxy's own overhead |

## Settings

Change them under Settings → Plugins → Next Prompt, or with
`bb plugin config next-prompt set <key> <value>`. The model is set with the
picker above it, not here.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Suggest automatically after each turn. `bb next-prompt suggest` works either way. |
| `display` | `cards` | `cards`: numbered cards above the composer. `ghost`: the best suggestion as grey text inside the empty composer, dismissed with Esc. `both`: cards and grey text. Applies at once. |
| `cardClick` | `insert` | `insert` puts a clicked card's text in the draft. `send` sends it at once. |
| `prefillBest` | `false` | With `display` set to `both`, puts the best suggestion in the empty composer as real text. Nothing is sent. |
| `apiFormat` | `off` | `anthropic` or `openai` sends every request to the HTTP API below instead of the picked model. |
| `apiBaseUrl` | empty | Empty means `https://api.anthropic.com` for `anthropic`; required for `openai`. |
| `apiModel` | empty | Model for the HTTP API. |
| `apiKey` | unset | Secret. `x-api-key` for `anthropic`, Bearer token for `openai`. |
| `claudePath`, `codexPath` | `claude`, `codex` | Executables, resolved on the bb server's `PATH`. |
| `timeoutSeconds` | `60` | Per request, including a worker thread's start. |
| `maxContextChars` | `10000` | Transcript budget. |

## CLI

```sh
bb next-prompt show [thread-id] [--json]      # current suggestions, one per line
bb next-prompt suggest [thread-id] [--json]   # generate now for an idle thread
bb next-prompt context [thread-id]            # the transcript a request would send
bb next-prompt status [--json]                # model route and the last outcomes
bb next-prompt model [<provider>/<model>[@<reasoning>] | reset]
```

`model` with no argument prints the route, such as
`claude-code/claude-sonnet-5-5 @ low via claude -p (default)`. Set one with,
for example, `bb next-prompt model codex/gpt-6-luna@low`; the reasoning level
defaults to `low`. `reset` returns to the default.

Inside a bb thread the thread id defaults to the current thread. With `--json`,
`show` and `suggest` give the list as `texts`.
`status` lists why recent requests showed nothing: `none` (the model chose
silence), `filtered` (a reply that failed the checks, with its text), `timed
out`, `cancelled` (the thread moved on first), `skipped: short answer`,
`skipped: queued messages`, `skipped: child threads running`, `unchanged:
dismissed earlier` or `unchanged: silent earlier` (the stored result for the
same conversation), or `failed` with the error. `suggest` ignores the stored
result and the answer's length, and always asks the model.

## Install

Requires bb 0.45 or later.

```sh
bb plugin install git:https://github.com/CrazyCoder/bb-plugin-next-prompt.git@^0.4.0
```

bb installs the newest `0.4.x` release, and `bb plugin update next-prompt`
moves to newer releases in that range. The first suggestion appears after the
next turn that finishes in a visible thread.

From a clone, for development:

```sh
npm install
bb plugin build
bb plugin install .
```

After editing the source, run `bb plugin build && bb plugin reload next-prompt`.

## Develop

```sh
npm test            # node --test tests/*.test.ts
npm run typecheck
```

`vendor/next-prompt-core.ts` is generated: change the library, not this copy.
To update it, with a checkout of the library beside this one at the wanted tag:

```sh
node ../next-prompt-core/scripts/vendor.mjs vendor          # write the copy
node ../next-prompt-core/scripts/vendor.mjs vendor --check  # check it matches
```

The prompt's eval lives in the library. To run it through this plugin's default
route, from this directory:

```sh
node ../next-prompt-core/scripts/eval.ts --complete ./backend.ts --model claude-sonnet-5-5
```

Each request bills like a real suggestion.

## License

MIT
