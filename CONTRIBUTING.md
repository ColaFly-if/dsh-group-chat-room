# Contributing

Thanks for taking a look at `dsh-group-chat-room`.

## Before you open an issue

- Run the tests: `npm test` (or `node tests/run-tests.mjs`).
- Run the release gate: `npm run check:publish` — it fails on absolute paths, local user names, host names and API keys.
- Include the DSH version, your OS, and the exact command or HTTP call that failed.

## Pull requests

1. Keep the change focused; one behaviour per PR.
2. If you add behaviour, add an assertion for it in `tests/` — a fix without a failing-then-passing check is not reviewable.
3. Do not commit generated artifacts: `ACCEPTANCE.md`, `acceptance.json`, `data/`, chat history, credentials. They are git-ignored; keep it that way.
4. State in the PR description what you ran and what it printed.

## Scope

This is a local-first DSH plugin. Features that phone home, collect telemetry, or require a hosted service are out of scope.
