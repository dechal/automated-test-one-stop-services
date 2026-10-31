# Automated Test One-Stop Service

A cross-platform, one-stop workspace for test automation — Playwright (web/API),
Robot Framework, and k6 (performance) — driven by a single `task` CLI and an
optional local web **Hub**. Projects are manifest-driven and portable; the Hub
wraps the same CLI recipes behind a browser UI (run tests, view reports, manage
environments) with no deploy required.

> Created and maintained by **Decha_L**. If this helps you, please keep the
> attribution and consider supporting the project (see **Support / Donate**).

## Quick start (1-click)

Download the installer for your OS from the
[latest release](https://github.com/decha2543/automated-test-one-stop-services/releases/latest)
and run it — it bootstraps git, clones the workspace, installs the toolchain +
dependencies, and starts the Hub:

- **Windows**: `automated-test-one-stop-service_installer_windows.bat`
- **macOS / Linux**: `automated-test-one-stop-service_installer_mac-and-linux.sh`

Already have a clone? The same two files live under
[`scripts/setup/`](scripts/setup/). Then open the Hub at <http://localhost:5174>.

Nothing has to be set up or configured first, and no administrator rights are
needed — every tool is installed for your user only (macOS does not need
Homebrew). Each run writes an `install-log-<timestamp>.txt` — on Windows in the
folder you picked, on macOS/Linux in the folder you ran the installer from. That
is the file to read, or to send on, if anything fails.

### "Is this safe?" — the security warning

The installer is **not code-signed yet**, so on a fresh machine your operating
system may warn that it doesn't recognize it. This is expected for a new tool —
it's a reputation check, not a virus report. Download it **only** from the
official repository, then allow it to run. The steps are the same shape on every
OS:

1. **Windows** — double-click the `.bat`. If you see **"Windows protected your
   PC"**, click **More info**, then **Run anyway**.
2. **macOS** — if double-clicking is blocked, **Control-click (right-click) →
   Open → Open**, or run `bash <installer>.sh` in Terminal.
3. **Linux** — make it executable, then run it:
   `chmod +x <installer>.sh && ./<installer>.sh` (or just `bash <installer>.sh`).

> The real warning is always a **system dialog**, never a web page. Ignore any
> browser pop-up that imitates it, and only run the file you downloaded from the
> official link.

Want to be sure the file is the published one? Each release also ships
`SHA256SUMS.txt`. Download it next to the installer, then:

```bash
# Windows (PowerShell or cmd) — compare the printed hash with SHA256SUMS.txt
certutil -hashfile automated-test-one-stop-service_installer_windows.bat SHA256

# macOS / Linux
shasum -a 256 -c SHA256SUMS.txt
```

### What happens next (so nothing looks "stuck")

A console window opens and shows progress — **keep it open**. The first run
installs tools and can take several minutes (it's working, not frozen). When it
finishes it **opens the Hub in your browser automatically** and adds a **"Test
Hub"** shortcut to your desktop so you can reopen it anytime.

One click is left before the first web test: browsers are downloaded per tool,
not by the installer. In the Hub, open the **Environment Status** panel and press
**Set up** on the tool you want (the CLI equivalent is `task setup`). If setup
had to skip Python (locked-down network), the same panel has **Install Python**.

The Hub UI speaks **Thai and English** — it follows your browser language on the
first visit, and you can switch it any time from the header toggle or
**Settings → Language**. The installer console stays English on purpose: Windows
console fonts don't carry Thai glyphs reliably, so Thai there would render as
boxes on some machines.

### Port already in use?

The Hub uses `5174` and nothing needs configuring for that. If something else on
the machine already owns that port, pass a different one to the installer and
everything downstream follows it:

```bash
# macOS / Linux
HUB_PORT=5180 ./automated-test-one-stop-service_installer_mac-and-linux.sh
```

```bat
REM Windows (quote the value — `set X=5180 &&` would keep the trailing space)
set "HUB_PORT=5180"
automated-test-one-stop-service_installer_windows.bat
```

Already installed and the Hub misbehaves? `task hub-status` answers who owns the
port and whether start-at-login is registered, and `task hub-stop` releases it. One
gotcha: `task hub` (dev mode) serves the UI on **:5173** — the single-port `:5174`
experience is the built Hub (`task hub-build` then `task hub-start`), which is what
the installer and the desktop shortcut run.

### Removing it again

```bash
node scripts/setup/uninstall.mjs          # show exactly what would be removed
node scripts/setup/uninstall.mjs --run    # remove it (asks once to confirm)
```

It stops the Hub, removes the start-at-login registration, the desktop shortcut,
the setup ledger, and — on Windows — the `PATH` entries and environment variables
setup added. It deliberately **keeps** node/pnpm/uv/task (other projects may use
them) and your workspace folder (it holds your test projects); both are listed in
the output so nothing is a surprise.

### Removing the workspace folder as well

Add `--purge`, or use the uninstaller for your OS in `scripts/setup/` — same shape
as the installers:

- **Windows**: double-click `automated-test-one-stop-service_uninstaller_windows.bat`
- **macOS / Linux**: `bash automated-test-one-stop-service_uninstaller_mac-and-linux.sh`

```bash
node scripts/setup/uninstall.mjs --purge        # dry run: plan + anything blocking it
node scripts/setup/uninstall.mjs --purge --run  # delete the folder too (type its name to confirm)
```

This one is irreversible, so it is **gated** — and the gates are not bypassable,
not even with `--yes`. It refuses while any of these is still true, and prints
exactly which ones:

1. a test project exists under `tools/<tool>/projects/<type>/` (the shipped
   `*-template-example` scaffolds don't count)
2. a project folder other than `_workspace` exists under `brain/projects/`
3. any repo — the workspace, `brain/`, or a project under `tools/` — has
   uncommitted changes or commits that are on no remote
4. the Hub is still answering on `HUB_PORT` after the uninstall stopped it — it
   holds files inside the folder, so a delete would fail halfway; nothing is
   removed and it tells you to run `task hub-stop`

That order is deliberate: every project and the knowledge vault is its own git
repo, so delete your projects and push your work **first**, then purge. The
Windows launcher continues in a second window (a batch file cannot delete the
folder it is running from) — read that window for the result.

## CLI (no Hub required)

```bash
task                      # interactive runner
task setup                # install everything (first time)
task pw:run-local  PROJECT=<name> TYPE=web TAG='@smoke'
task robot:run-local PROJECT=<name> TYPE=web
task k6:run-local  PROJECT=<name> SECTION=<name> PERFORMANCE_TYPE=LOAD
task hub                  # start the Hub in dev mode — UI on :5173, API on :5174 (Ctrl+C to stop)
task hub-build            # build the Hub (production)
task hub-start            # serve the built Hub — UI and API both on :5174
task hub-stop             # stop the Hub running on HUB_PORT
task hub-restart          # stop, wait for the port, start again
task hub-status           # port, pid, and boot auto-start state
task --list               # common tasks
task --list-all           # every task, generated — the only complete list
```

`task help` is a hand-written quick reference of the common ones. If a command is
not in `task --list-all`, it does not exist — trust the generated list.

## Environment variables

Nothing here is required — a normal install and a normal run need none of it.
These are the escape hatches for locked-down machines, mirrors, and CI.

Install-time variables are read from the **process environment**, so pass them on
the command line. They are *not* read from `scripts/.env` — that file does not
exist yet while the installer runs.

Honoured by the 1-click installer:

| Variable | Default | Meaning |
| --- | --- | --- |
| `HUB_PORT` | `5174` | Hub port. Everything downstream follows it — shortcut, launcher, readiness poll. |
| `SETUP_INSECURE_TLS=1` | off | Prefetch the Node tarball with `curl -k`. For TLS-inspecting corporate proxies. |
| `SETUP_DISABLE_SHELL_DECOUPLE=1` | off | Windows: skip putting Git's bundled GNU tools on `PATH`. Best-effort step, never required. |

```bash
# macOS / Linux — different port, behind a TLS-inspecting proxy
HUB_PORT=5180 SETUP_INSECURE_TLS=1 ./automated-test-one-stop-service_installer_mac-and-linux.sh
```

These three only apply when you run the setup script **directly**
(`bash scripts/setup/setup-linux.sh` / `scripts\setup\setup-windows.bat`). The
1-click installer sets all of them itself — it points the ledger at the folder you
chose, and opens the browser once after its own readiness poll — so setting them
on the installer has no effect:

| Variable | Default | Meaning |
| --- | --- | --- |
| `SETUP_STATE_DIR` | `.cache/state` | Where the `setup-state.json` resume ledger is written. A legacy root `.setup-state.json` is moved here on the next run, and so is a `.setup-state.json` already inside `SETUP_STATE_DIR`. |
| `SETUP_NO_OPEN=1` | off | Do not open the browser when setup finishes. |
| `SETUP_NO_PAUSE=1` | off | Windows: skip the final "press any key". For unattended runs. |

Local tool disables moved from `config/.tool-overrides.json` to
`scripts/manifests/data/.tool-overrides.json`. An older clone has to move that file by hand,
or its local disables stop applying.

A test reading an env var and getting an empty string usually means the key was never
declared, so nothing told you to set it. Each project's committed `.env.template` is
the contract of what is tunable; this finds every key the code reads but no template
declares:

```bash
node scripts/lib/env-contract.mjs            # report
node scripts/lib/env-contract.mjs --strict   # exit 1 if anything is undeclared
```

Add the missing key to that project's `.env.template` with a placeholder and a
one-line comment, then put the real value in your own `.env` — never in the template.

Android is opt-in and never part of the install — these apply to `task setup-android`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `SETUP_ANDROID_API` | `34` | API level of the system image and the `QA_Emulator` AVD. |
| `SETUP_ANDROID_CLT_URL` | resolved from the download page | Point at a mirrored `commandlinetools-*.zip` for offline or internal-mirror installs. |
| `SETUP_RECREATE_AVD=1` | off | Overwrite an existing `QA_Emulator` AVD instead of keeping it. |
| `ANDROID_HOME` | `~/Android/Sdk` — `~/Library/Android/sdk` on macOS, `%USERPROFILE%\AppData\Local\Android\Sdk` on Windows | Point at an SDK you already have (e.g. one Android Studio manages) instead of provisioning a second copy. |

Maintainer / CI only:

| Variable | Default | Meaning |
| --- | --- | --- |
| `SETUP_SMOKE=1` | off | Run the live-VM install smoke suite. Without it those tests skip, so the default suite never mutates a machine. |
| `SETUP_SMOKE_ANDROID=1` | off | Adds the Android checks — set only after `task setup-android` has run. |
| `SETUP_SMOKE_LAYERD=1` | off | Adds the shell-decoupling checks — set only after that step has run. |
| `EVAL_MIN_SCORE` | `70` | Pass threshold for the test-quality eval. |
| `EVAL_ROOTS` | `tools` | Comma-separated roots the eval scans. |
| `EVAL_JSON=1` | off | Emit the eval report as JSON instead of text. |
| `RELEASE_REMOTE` | `origin` | Remote `scripts/release.mjs` pushes to. |
| `RELEASE_BRANCH` | `main` | Branch it expects to release from. |
| `TAG_PREFIX` | `v` | Tag prefix it applies. |
| `CHUNK_DEBUG` | off | Print Vite chunk assignments during a Hub client build. |

Other scopes keep their own contract, so there is one place per concern:

- **Hub runtime** (`HUB_HOST`, `HUB_DB_PATH`, `HUB_ALLOWED_ORIGINS`, …) — [`hub/README.md`](hub/README.md#environment-variables)
- **Usage logging** (`SPREADSHEET_ID`, `SHEET_NAME`, `FORCE_TRACK`) — `scripts/.env.template`
- **Per-tool knobs** (`PLAYWRIGHT_DOWNLOAD_HOST`, `PLAYWRIGHT_BROWSERS_PATH`, load profiles, …) — that tool's own `.env.template`
- **Per-project knobs** (base URLs, credentials) — that project's `.env.template`

## Documentation

- Writing tests with a tool: that tool's own `tools/<tool>/README.md` — how to run it,
  where files go, and the rules for its runtime. Each tool is a removable plugin, so
  its guide ships inside it (`tools/playwright/README.md`,
  `tools/robot-framework/README.md`, `tools/k6/README.md` for the built-in three).
- Something broken: this file — the section that owns the topic (install warning,
  ports, env vars, removing). Tool-specific problems live in that tool's README.
- Hub: [`hub/README.md`](hub/README.md)
- Knowledge base (Obsidian vault): [`brain/README.md`](brain/README.md)

## License

Source-available under the **PolyForm Noncommercial License 1.0.0** — free to
use, modify, and share for **noncommercial** purposes. **Commercial use requires
a separate license** from the author. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

You may not remove attribution or represent this work as your own. In-house /
client project content (`tools/*/projects/*`, `brain/projects/*`) is **not**
covered by this license and is not distributed here.

### Commercial license

Noncommercial use is free. If you want to use this **commercially** — sell it,
offer it as a paid product or service, or use it inside a for-profit product —
that requires a separate commercial license. I'm happy to arrange one: open an
issue on the repository or email **<Decha.L2543@gmail.com>**.

## Support / Donate

This is built and maintained in personal time to help others do test automation
well. If it's useful to you and you'd like to support continued development,
any amount is genuinely appreciated 🙏

The easiest way: open the **Hub → Settings → Support** and scan the **PromptPay
QR** (Thailand).

<!-- To enable it: drop your PromptPay QR image at
     hub/client/public/promptpay-qr.png — it then shows in the Hub automatically. -->

Prefer other channels? (optional — fill in if you use them)

- PromptPay (Thailand): `0953481756`

## Author

**Decha_L** — creator & maintainer. Interested in commercial licensing,
collaboration, or just want to say thanks? Reach out via the repository.
