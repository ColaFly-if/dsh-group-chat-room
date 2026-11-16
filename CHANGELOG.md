# Changelog

## 0.3.0

- Sticker packs: `/api/stickers` proxied from the host meme service, picker in the composer, `sticker` field persisted on messages, `[STICKER:st_xxx]` parsed from persona replies.
- `POST /api/forge`: generate a group and its members from one description (`SOUL_*.md` written to the chosen workspace, group created, members added).
- Prompt: personas now get a sticker menu and a one-sticker-per-message rule.
- Tests: 51 assertions (sticker API, sticker-only message, persistence, forge validation, no-credential degradation), plus `tests/forge-e2e.mjs` for a live run.

## 0.2.1

- Tests resolve the plugin root from their own location, so `npm test` works from any working directory.
- Ship a local `tests/publish-check.mjs` so the repo validates itself (`npm run check:publish`).
- Add `CONTRIBUTING.md`.

## 0.2.0

- Add `tests/run-tests.mjs`: 44 assertions against a real router with a temp data dir.
- Remove hard-coded paths: workspace root and credential dir now derive from env / `os.homedir()`.
- UI: path examples in the workspace picker are now portable.
- Add MIT license, bilingual README, package metadata.

## 0.1.0

- First working version: persona discovery, group CRUD, SSE chat, per-persona overrides.
