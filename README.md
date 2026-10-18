# Next Prompt for bb

A [bb](https://getbb.app) plugin that predicts the instruction you are likely to
type next, after each finished turn in a thread, and shows it in one line above
the composer:

```text
↳ next: run the focused tests  Tab ↹
```

or, with the `display` setting set to `ghost`, as grey text inside the empty
composer, where bb's placeholder usually is.

Click the line, press **Tab** or **→** in the empty composer, or swipe right in
it on a touch screen, to put the text in the draft. It is not sent: you edit or
send it yourself. Typing hides the suggestion, and clearing the draft back to
empty brings it back after 1.5 seconds, without a new model request. To
dismiss it, hover the line and click **×**, or press **Esc** on the grey text.

Suggestions are display-only. The plugin writes nothing into the thread or the
agent's context, and a new turn, a failure, archiving or deleting the thread
discards the current suggestion. Until then it survives a plugin reload or a bb
restart, and so does a dismissal: an unchanged conversation gets neither a new
request nor the dismissed suggestion back.

It is the bb counterpart of the next-prompt extensions for
[pi](https://github.com/CrazyCoder/next-prompt-extension) and
[Oh My Pi](https://github.com/CrazyCoder/omp-next-prompt-extension). Its
system prompt is based on the Oh My Pi extension's, with rules for staying
silent, listed below.

## When a suggestion is made

When a visible thread goes idle, the plugin reads its timeline and sends one
request with:

- the first user request, cut to 2,500 characters;
- the newest user and assistant messages, up to the transcript budget (10,000
  characters by default).

Tool calls, commands and their output are never sent. Hidden threads, child
threads (their parent agent writes the next message), threads with queued
messages, threads whose last turn failed, and parents with child threads that
are queued, starting or running (a parent usually runs again when its children
report back, and gets a suggestion then) get no suggestion; `bb next-prompt
suggest` still works on any idle thread.

The prompt asks the model to tell what the assistant already did, is doing or
promised from what is still the user's to decide, and to answer
`{"suggestion": null}` when the user can just wait, the task is finished, the
only reply would be an acknowledgment, the options left have no stated
preference, or the assistant asks for a fact only the user knows. It never
offers to push, deploy or publish unless the user asked for it. A reply is
dropped unless it is a 2–12 word instruction under 100 characters in the
user's voice; "Let me…", "looks good", questions, and multi-sentence replies
are filtered out.

Each thread's last result, the suggestion, a dismissal or the model's
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
| Claude Code, Haiku 4.5, low | 0.8 s | the cheapest option; more replies in the assistant's voice (filtered out) and occasional notes-to-self such as "wait for their reply" |
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
| `display` | `banner` | `banner`: a line above the composer. `ghost`: grey text inside the empty composer, dismissed with Esc. Applies at once. |
| `apiFormat` | `off` | `anthropic` or `openai` sends every request to the HTTP API below instead of the picked model. |
| `apiBaseUrl` | empty | Empty means `https://api.anthropic.com` for `anthropic`; required for `openai`. |
| `apiModel` | empty | Model for the HTTP API. |
| `apiKey` | unset | Secret. `x-api-key` for `anthropic`, Bearer token for `openai`. |
| `claudePath`, `codexPath` | `claude`, `codex` | Executables, resolved on the bb server's `PATH`. |
| `timeoutSeconds` | `60` | Per request, including a worker thread's start. |
| `maxContextChars` | `10000` | Transcript budget. |

## CLI

```sh
bb next-prompt show [thread-id] [--json]      # current suggestion
bb next-prompt suggest [thread-id] [--json]   # generate now for an idle thread
bb next-prompt context [thread-id]            # the transcript a request would send
bb next-prompt status [--json]                # model route and the last outcomes
bb next-prompt model [<provider>/<model>[@<reasoning>] | reset]
```

`model` with no argument prints the route, such as
`claude-code/claude-sonnet-5-5 @ low via claude -p (default)`. Set one with,
for example, `bb next-prompt model codex/gpt-6-luna@low`; the reasoning level
defaults to `low`. `reset` returns to the default.

Inside a bb thread the thread id defaults to the current thread.
`status` lists why recent requests showed nothing: `filtered` (including the
model's `null`), `timed out`, `cancelled` (the thread moved on first),
`skipped: queued messages`, `skipped: child threads running`, `unchanged:
dismissed earlier` or `unchanged: silent earlier` (the stored result for the
same conversation), or `failed` with the error. `suggest` ignores the stored
result and always asks the model.

## Install

Requires bb 0.45 or later.

```sh
bb plugin install git:https://github.com/CrazyCoder/bb-plugin-next-prompt.git@^0.3.0
```

bb installs the newest `0.3.x` release, and `bb plugin update next-prompt`
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
npm run eval -- --baseline HEAD --repeats 2
```

`npm run eval` sends the labelled conversations in `eval/cases.json` to the
suggestion model through `claude -p` and scores each reply: silence where the
user should be left alone, a matching suggestion where one next step is
grounded. `--baseline <rev>` runs that revision's prompt on the same cases, so
a prompt change is compared with the one it replaces; `--model`,
`--reasoning`, `--repeats`, `--concurrency` (4 requests at once by default)
and `--output <file>` are optional. Each request bills like a real
suggestion.

## License

MIT
