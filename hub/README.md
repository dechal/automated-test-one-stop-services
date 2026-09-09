# Hub

Web UI for the Automated Test One-Stop Service workspace. Wraps the `task` CLI behind a browser-based control panel so users can create projects, run tests, view reports, and manage environments without touching the terminal.

## Quick start

```bash
task hub          # start dev (server + client) — foreground, Ctrl+C to stop
task hub-build    # production build
task hub-start    # serve production bundle
task hub-stop     # stop the Hub running on HUB_PORT
task hub-restart  # stop, wait for the port, start the built server
task hub-status   # port, daemonless pid, boot auto-start state
```

Default ports:

- Dev — UI (Vite): <http://localhost:5173>, API (Fastify): <http://localhost:5174>
- Production (`hub-start`, the installer, the desktop shortcut) — everything on
  <http://localhost:5174>; the built client is served by the same Fastify server

`hub-stop` / `hub-restart` / `hub-status` wrap `hub/bin/hub-service.mjs`, which owns
Hub process management for the start scripts, setup, and the in-app Update button.
They act on whatever holds `HUB_PORT` — the detached background instance, an OS boot
supervisor registered by `hub-service.mjs enable-boot`, or a foreground `hub-start`.
Dev mode (`task hub`) is not managed by it: stop that with Ctrl+C.

Checks across all three packages (same commands CI runs):

```bash
pnpm -C hub run typecheck   # shared + server + client
pnpm -C hub run test        # server then client (sequential — a shared vitest
                            # process leaks the server's timers on Windows)
pnpm -C hub run lint        # biome
pnpm -C hub run test:smoke  # builds, boots the server on :5199, drives the real
                            # UI in Chromium (Playwright) — catches bundle/CSS
                            # regressions unit tests cannot see
```

`test:smoke` never touches a Hub you already have running on `:5174`, and uses an
in-memory database (`HUB_DB_PATH=:memory:`), so it leaves no state behind. Override
its port with `HUB_E2E_PORT`.

### Environment variables

All optional — every one has a working default, so the Hub runs with an empty environment.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HUB_HOST` | `127.0.0.1` | Bind address. Loopback on purpose; the Hub runs local shell commands and has no auth. |
| `HUB_PORT` | `5174` | Server port. The allowed CORS origins follow it. |
| `HUB_ALLOWED_ORIGINS` | derived from `HUB_PORT` | Comma-separated browser origins allowed to call the API. |
| `HUB_DB_PATH` | `hub/server/data/hub.db` | SQLite file. `:memory:` gives an ephemeral DB (used by tests). |
| `HUB_CLIENT_DIST` | `hub/client/dist` | Static bundle served in production. |
| `HUB_LOG_MAX_BYTES` | `5242880` (5 MB) | Size at which `hub/.run/hub.log` rotates to `hub.log.1` on start. `0` disables rotation. |
| `HUB_RUN_TIMEOUT_MS` | `14400000` (4 h) | A run exceeding this is cancelled like a manual Stop, so a hung run cannot hold a concurrency slot — and its schedule's `noOverlap` gate — forever. `0` disables the timeout. |
| `HUB_SHORTCUT_DIR` | the user's Desktop | Where `hub-service install-shortcut` writes the launcher. On Linux `XDG_DESKTOP_DIR` is honoured next. |
| `APPIUM_PORT` | `4723` | Port the managed Appium server listens on (mobile runs). |
| `HUB_E2E_HOST` | `127.0.0.1` | Bind address for the Playwright E2E suite's own Hub instance. |
| `HUB_E2E_PORT` | `5199` | Port for that E2E instance — deliberately not `5174`, so a running Hub is never disturbed. |

## Architecture

```
hub/
├── shared/    @hub/shared  → DTOs, types, and single-source taxonomies shared between server & client
├── server/    @hub/server  → Fastify 5 + WebSocket + embedded SQLite + project scanner + process runner + scheduler
└── client/    @hub/client  → React 19 + Vite + Mantine + xterm.js + TanStack Router/Query
```

## Features

### Run & monitor

- **Run** — pick tool / type / project / tags (multi-select, auto-categorized) / headed-headless / mode (local or Docker) / extra args
- **Live Output** — xterm.js terminal streamed over WebSocket, with cancel and reconnect to in-flight runs
- **Run queue** — bounded concurrency (configurable in Settings); waiting runs are listed by project and can be moved to the front or taken out
- **Schedules** — cron-based scheduled runs with a calendar view
- **Active-run reconnect** — a floating window + banner keep live runs visible across pages

### Results & analysis

- **Dashboard** — doctor status, project counts, run heatmap, trend chart, top projects, needs-attention widget
- **Reports** — filter / sort / status table, open the HTML report, rerun; severity-weighted pass score
- **History** — full run history with pass %, severity breakdown, and triggered-by
- **Insights** — flaky-test detection and k6 performance trends (tabbed)
- **Artifacts** — browse and download per-run artifacts (traces, videos, logs)
- **Test cases** — browse a project's test-case documents (`.csv` / `.xlsx`), edit cells in place, and sync run status back into the sheet

### Manage

- **Projects** — list / create / clone projects per tool & type (manifest-driven)
- **Env Editor & Env Profiles** — edit project & scripts `.env`; save and apply reusable env profiles
- **Docker Services** — status and control of the per-tool compose stacks (Appium, InfluxDB, Grafana)
- **Webhooks** — outbound notifications on run events
- **Doctor** — installation status (node, pnpm, uv, task, k6, docker, etc.) with an ordered install gate
- **Settings** — theme, EN/TH language, sound, concurrency, run defaults, output retention + auto-cleanup, import/export, in-app update

Cross-cutting: spotlight search, in-app notifications, keyboard shortcuts, bookmarks, EN/TH i18n, dark/light theme.

## How it talks to the workspace

Server spawns `task` commands as child processes (same commands the CLI runner uses). All scanning, validation, and command building reuse the patterns from `scripts/runner.ts` and `scripts/create-project.ts`.

## Boundaries

- Hub does **not** modify test code or framework configs
- Hub does **not** bypass `task` — every action maps to an existing recipe
- Hub does **not** require new tooling; only adds Node packages
