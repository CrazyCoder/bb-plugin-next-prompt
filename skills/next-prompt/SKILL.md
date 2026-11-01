---
name: next-prompt
description: Show, generate, or debug the Next Prompt plugin's suggestions for a BB thread with the bb next-prompt CLI. Use when the user asks why no next-prompt suggestion appeared, wants one generated now, or wants to see what transcript the suggestion model receives.
---

# Next Prompt

The Next Prompt plugin shows up to three predicted next instructions after each
finished turn, as numbered cards above a thread's composer, the best one as grey
text inside it, or both (the `display` setting). Suggestions are display-only.
They are never part of the agent's reply, and an agent must not imitate them by
adding prompt-shaped lines to its own messages.

```sh
bb next-prompt show [thread-id] [--json]      # current suggestions, exit 1 when none
bb next-prompt suggest [thread-id] [--json]   # generate now; the thread must be idle
bb next-prompt context [thread-id]            # the transcript a request sends
bb next-prompt status [--json]                # model route, last 10 outcomes
bb next-prompt model [<provider>/<model>[@<reasoning>] | reset]
```

Inside a thread, the thread id defaults to the current thread. The current
thread is busy while you run, so `suggest` on it fails; use it on another
thread.

To diagnose a missing suggestion, run `bb next-prompt status` and read the
outcome for the thread:

- `none: the model had nothing to suggest`: the model chose silence: the user
  can wait, the task is done, or no next step was obvious.
- `filtered: "<raw>"`: the reply failed the checks: it is not JSON, or no
  suggestion is a single line under 100 characters.
- `skipped: short answer`: the answer is under 20 characters. `suggest` asks
  regardless.
- `unchanged: dismissed earlier` / `unchanged: silent earlier`: the stored
  result for the same conversation answered; the user dismissed it, or the
  model was silent. `suggest` asks again regardless.
- `skipped: child threads running`: the thread has children queued, starting
  or running; it gets a suggestion after they report back and it finishes
  again.
- `timed out`: raise `timeoutSeconds`, or check the route with `bb next-prompt model`.
- `failed: …`: the error from the CLI, API or worker thread, such as a CLI
  that is not logged in on the bb server, a missing `apiBaseUrl`, or a worker
  that failed to start (`bb thread show <worker-id>` explains it).
- `skipped: queued messages`: the thread had queued messages when it went idle.

Hidden threads and child threads get no automatic suggestion and no outcome
line; run `bb next-prompt suggest <thread-id>` to get one for them.

The model comes from the picker in the plugin's settings or from
`bb next-prompt model`, for example `bb next-prompt model claude-code/claude-haiku-4-5-20251001@low`.
Claude Code and Codex models run as a lean CLI call with no tools; any other
provider runs as a hidden worker thread, which is slower. With no saved
choice it is `claude-code/claude-sonnet-5-5` at low reasoning.
`bb plugin config next-prompt` lists the other settings, including an HTTP API
override (`apiFormat`). The model receives the thread's recent user and
assistant text, never tool output.
