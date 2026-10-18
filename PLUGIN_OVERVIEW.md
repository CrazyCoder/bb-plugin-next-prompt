See the instruction you were about to type before you type it.

## What you get

- One suggestion after each finished turn: a line above the composer,
  `↳ next: run the tests`, or grey text inside the empty composer.
- Click it, press Tab or → in the empty composer, or swipe right on a touch
  screen, to put it in the draft. It is never sent for you.
- Silence when there is nothing to suggest: no "push it" after a commit, no
  "check the build" while the agent says it is running.
- `bb next-prompt` to show, generate, and debug suggestions.

## How it works

When a visible top-level thread goes idle, the plugin sends the first request
and the newest user and assistant messages (no tool output) to a model, Sonnet
by default. It filters the reply to one short instruction in your voice and
keeps it until the thread moves on, across reloads and restarts.
Nothing is written to the thread or the agent's context.

## Requirements

Pick the model with bb's provider/model picker. Claude Code and Codex models
run as a lean CLI call (`claude` or `codex` logged in on the bb server) and use
your existing subscription; other providers run as a hidden worker thread. An
Anthropic- or OpenAI-compatible HTTP API can replace either.
