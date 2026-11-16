# dsh-group-chat-room

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Tests: 44 passing](https://img.shields.io/badge/tests-44%20passing-brightgreen)](tests/run-tests.mjs)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-4a9eff)](https://github.com/deepseek-ai)
[![No external deps](https://img.shields.io/badge/dependencies-none-blueviolet)](package.json)

**A group chat tab for the [DeepSeek Harness](https://github.com/deepseek-ai) sidebar — several AI personas in one room, each backed by a `SOUL_*.md` file in your workspace.**

[中文说明](README.zh-CN.md)

---

## Why

Most chat UIs give you one assistant. This one gives you a room: you drop `SOUL_*.md` persona files into any workspace, tick the ones you want, and they answer in the same thread — with turn-taking, streaming, and the ability to stay quiet when they have nothing to add.

## Features

- **Persona discovery** — recursively scans each configured workspace (up to 4 levels) for `SOUL_*.md`; the first `# heading` becomes the display name.
- **Group management** — create / rename / describe / activate / delete groups, tick members from a picker.
- **Real streaming** — one SSE endpoint (`/groupchat/api/say`) emits `user_msg`, `typing`, `msg_start`, `delta`, `skipped`, `error`, `done`.
- **Turn-taking that feels like a chat** — naming someone gets only that persona; `let's chat` gets everyone for two rounds; otherwise each persona speaks with a 55% chance (at least one always does), and may bail out with `<SKIP>`.
- **Per-persona overrides** — alias, emoji avatar, short bio, enable/disable, and which workspace `SKILL.md` files get injected into its context.
- **Sticker packs** — reuses the host meme service (`/api/memes/catalog`, `/api/memes/assets/:id`). The picker mirrors what the assistant itself can send, messages persist a `sticker` field, and personas may answer with a one-line `[STICKER:st_xxx]`.
- **Personas from one sentence** — describe the room ("a dev team: PM, frontend, backend, QA, design") and it creates the group plus one `SOUL_*.md` per member, then puts them in it.
- **Local only** — history, config and personas never leave your machine. No telemetry, no external calls except your own model endpoint.

## Prerequisites

Check these first. The top three are required — missing any one and the plugin does not work.

### Required

| Requirement | Why | Without it |
|---|---|---|
| DSH in **web form** (desktop app, or `dsh web`) | Every `/groupchat/*` route is mounted on the host's `webServer` service; the plugin never opens its own port | The plugin loads but the page is unreachable. TUI / headless profiles have no such service |
| DeepSeek API credentials (default `~/.dsh/.credentials.yaml`) | Persona replies are a direct POST to `https://api.deepseek.com/chat/completions` | The page opens and your message is accepted, but nobody answers |
| At least one `SOUL_*.md` persona file | Group members are the `SOUL_*.md` files found inside the configured workspaces | The member list is empty, so there is nobody to pick |

### Optional

| Requirement | Author / source | Purpose | Without it |
|---|---|---|---|
| `dsh-better-sidebar` (provides the `betterSidebar` service) | **omdsh-dev** · [DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) | Used to register the "group chat" sidebar tab | Chat still works, there is just no sidebar entry — open `/groupchat/` manually |
| A host-provided same-origin `/api/memes/catalog` | Supplied by a host-side sticker plugin, e.g. **FeWOO** · [DeepSeek-meme](https://github.com/FeWOO/DeepSeek-meme) | Sticker catalog (proxied, cached 5 minutes) | The sticker picker is empty; text messages and replies are unaffected |

Services are acquired opportunistically (`ctx.get('webServer')`, `ctx.get('betterSidebar')`) and `cordis.patch.yml` declares `inject: []`, so a missing service never blocks startup — features degrade as the tables describe.

Both optional integrations are third-party plugins, copyright their respective authors. This plugin only calls them through their service interface and HTTP routes — it neither bundles nor modifies their code, and runs degraded as described above when either is absent.

## Install

This is a DSH host plugin: it mounts inside the DSH web server, with **no extra port and no child process**.

1. Put the folder where your DSH profile can resolve it, e.g. link it into the profile `node_modules`:

   ```bash
   # Windows (junction, no admin needed)
   mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-group-chat-room" "<path-to-repo>\dsh-group-chat-room"
   # macOS / Linux
   ln -s "<path-to-repo>/dsh-group-chat-room" ~/.dsh/profiles/desktop/node_modules/dsh-group-chat-room
   ```

2. Register it in the profile patch layer (`~/.dsh/profiles/desktop/cordis.patch.yml`):

   ```yaml
   - insert:
       - id: dsh-group-chat-room
         name: dsh-group-chat-room
   ```

3. Restart DSH. The **Group chat** tab appears in the sidebar, and the page is served at `/groupchat/`.

## Usage

| Action | How |
|---|---|
| Open | Sidebar tab, or browse to `/groupchat/` |
| Pick personas | **Members** → tick the discovered `SOUL_*.md` files → save |
| Add a workspace | **Settings → scanned workspaces**: paste several paths at once, or browse |
| Talk | Type and send; replies stream in persona by persona |
| Address one | Put their name in the message |
| Let them talk | Write something like `let's chat, you two` |
| Reset | **Clear history** (per group) |

## HTTP API

All routes live under the DSH web server, prefix `/groupchat`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/groupchat/` | The UI |
| GET | `/groupchat/api/state` | Model, groups, active group, roster |
| GET | `/groupchat/api/discover?g=` | Workspaces, discovered personas, current members |
| GET | `/groupchat/api/browse?path=` | Directory picker (empty path returns drive roots on Windows) |
| POST | `/groupchat/api/workspaces` | `{ text }` append-parse, `{ workspaces: [] }` replace |
| POST | `/groupchat/api/groups` | `{ action: create \| update \| activate \| delete }` |
| GET | `/groupchat/api/history?g=` | Last 200 messages |
| POST | `/groupchat/api/reset?g=` | Clear one group |
| POST | `/groupchat/api/say` | `{ text, group }` → SSE stream |
| GET | `/groupchat/api/prompt?who=` | The assembled system prompt for one persona (debug) |
| GET | `/groupchat/api/bots` | POST | Persona overrides and the skill catalog |
| GET | `/groupchat/api/stickers` | Proxied sticker catalog (5 min cache, empty packs when unavailable) |
| POST | `/groupchat/api/forge` | `{ desc, mode: group \| member, workspace }` → writes `SOUL_*.md`, creates the group |
| GET | `/groupchat/api/ping` | Version + route list (health check) |

## Configuration

`~/.dsh/group-chat/config.json` holds `workspaces`, `groups` and `active`. Persona overrides live in `bots.json`, history in `history/<groupId>.json`.

| Env var | Default | Meaning |
|---|---|---|
| `GROUPCHAT_WS_ROOT` | `~` | Default workspace root scanned when no workspace is configured |
| `GROUPCHAT_DATA_DIR` | `~/.dsh/group-chat` | Data directory |
| `CHAT_MODEL` | `deepseek-flash` | Model id sent to the provider |
| `MSYS_BASH` | `bash` from `PATH` | Bash used by tool checks in related plugins |

The API key is read at call time from `~/.dsh/.credentials.yaml` (`DEEPSEEK_API_KEY: ...`). Nothing is baked into the code.

## How it works

```text
web/index.html  ──fetch/SSE──▶  lib/route.js  ──▶  lib/core.js  ──▶  model endpoint
               (tab UI)          (HTTP, scheduler)    (personas, config, history)
```

- `lib/index.js` registers the route on the DSH web server and hot-reloads `core.js` / `route.js` by mtime, so most edits need no restart.
- `lib/core.js` has no HTTP: persona discovery, config, history cache, prompt assembly, streaming client.
- `lib/route.js` does scheduling (who speaks, in what order), SSE framing, and the JSON API.
- `lib/client.js` registers the sidebar tab.

## Privacy

- Everything is local: config, persona overrides, chat history.
- No analytics, no third-party calls. The only outbound request is your configured model endpoint.
- `data/` and `~/.dsh/group-chat` are git-ignored. Before publishing, run the publish check from the companion plugin:

  ```bash
  node ../dsh-acceptance-gate/tests/publish-check.mjs .
  ```

## Development

```bash
node tests/run-tests.mjs   # 44 assertions, isolated temp data dir, no network
```

The test boots a real router on `127.0.0.1:0` with a temp `dataDir` and a non-existent credential path, so it never touches your real groups or history. It covers routing, CRUD, dedupe, SSE framing, 404/400 paths, concurrency, XSS-safety of the UI, and secret scanning.

## Limitations

- One in-flight `/say` per process (second caller gets `429 busy`).
- No auth: it is served by your local DSH web server, treat it as localhost-only.
- Persona identity is file-based; renaming a `SOUL_*.md` changes the persona id.
- Group membership is a flat list; no roles, no per-member model selection.

## License

[MIT](LICENSE)
