# Contributing to Codex Town

Thanks for improving Codex Town. Keep changes focused, local-first, and honest about what the application can observe.

## Setup and validation

Use macOS 13+ on Apple Silicon with Python 3.9+, Node.js, and Xcode Command Line Tools.

```zsh
npm ci --ignore-scripts
npm run prepare:vendor
python3 -B -m unittest discover -s tests -v
node --test tests/test_schedule_village.mjs
```

The current baseline is 47 Python tests and 6 Node tests. Run `zsh desktop/build-app.sh` when changing Swift, packaging, or front-end resources.

## Privacy and data rules

Do not commit personal task logs, databases, cloud snapshots, screenshots, credentials, exported conversations, or local application data. Do not add personal character models, textures, GLB, FBX, or WebP assets. Keep generated bundles, dependency folders, and local runtime files out of commits.

Treat cloud data as a timestamped manual snapshot. Do not present it as real-time activity, complete synchronization, or proof that an automation is running. Never expose model reasoning, prompts, command arguments, or tool output through the progress UI.

## Changes

Add focused tests for behavior changes. Preserve the distinction between reading and accepting a result: no UI or service change may mark a result as accepted without an explicit user action. Keep user-facing copy clear about unavailable and stale data.

The repository source license has not yet been specified. Contributions do not change that status.
