#!/usr/bin/env bash
# ============================================================================
# AUTOMATED TEST ENVIRONMENT SETUP (Linux/macOS) — Setup_Bootstrap
# ----------------------------------------------------------------------------
# Installs the 4 Core tools from the lowest baseline, installs deps,
# starts the Hub, then verifies. Idempotent per tool and re-runnable via a
# state ledger ("<target>/.setup-state.json", written by the canonical engine
# scripts/setup/setup-state.mjs):
#
# { "steps": { "node": "done"|"failed"|"pending", ... }, "updatedAt": "..." }
#
# STEP_ORDER (M = 6, progress shown as "name (N/6)"):
# 1 node 2 pnpm 3 uv 4 task 5 install-deps 6 start-hub
#
# Tools come from brew (macOS) or curl (Linux), all user-scope. No Core
# step needs root. k6 is NOT a Core tool — it is provisioned by the k6 tool's
# own setup task (folder-presence gated), not the Core install.
#
# Android is decoupled from Core: it is opt-in via `task setup-android`
# (scripts/setup/set-android-home.sh) and never installed here.
#
# Opt-in env:
# SETUP_INSECURE_TLS=1 Prefetch Node tarball via curl -k (TLS proxy)
# SETUP_STATE_DIR Where .setup-state.json lives (default: repo root)
# ============================================================================

set -uo pipefail

echo "==================================================="
echo "  AUTOMATED TEST ENVIRONMENT SETUP (Linux/macOS)"
echo "==================================================="

SETUP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SETUP_ROOT/../.." && pwd)"
cd "$WORKSPACE_ROOT"

OS="$(uname -s)"
ARCH="$(uname -m)"

# ---------------------------------------------------------------------------
# Single source of truth for tool versions: scripts/setup/versions.env, shared
# with setup-windows.bat. The Volta pin in package.json ("volta".node) is the
# Node runtime authority; versions.env re-states it for the installer
# bootstrap. No stale literal fallback -- abort if the file is missing/unreadable.
# ---------------------------------------------------------------------------
PACKAGE_JSON="$WORKSPACE_ROOT/package.json"
PYTHON_VERSION_FILE="$WORKSPACE_ROOT/.python-version"
if [ ! -r "$PACKAGE_JSON" ] || [ ! -r "$PYTHON_VERSION_FILE" ]; then
  echo "  [error] Version source not found or unreadable: $PACKAGE_JSON / $PYTHON_VERSION_FILE"
  echo "  [hint]  Restore package.json (\"volta\": node + pnpm) and .python-version."
  exit 1
fi
volta_pin() {
  sed -n '/"volta"[[:space:]]*:/,/}/p' "$PACKAGE_JSON" \
    | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -n1
}
NODE_VERSION="$(volta_pin node)"
PNPM_VERSION="$(volta_pin pnpm)"
PYTHON_VERSION="$(head -n1 "$PYTHON_VERSION_FILE" | tr -d '[:space:]')"
if [ -z "${NODE_VERSION:-}" ] || [ -z "${PYTHON_VERSION:-}" ] || [ -z "${PNPM_VERSION:-}" ]; then
  echo "  [error] node/pnpm missing from \"volta\" in $PACKAGE_JSON, or $PYTHON_VERSION_FILE is empty"
  echo "  [hint]  Ensure package.json has \"volta\": { \"node\", \"pnpm\" } and .python-version has a version; no stale fallback is used."
  exit 1
fi
UV_LINK_MODE="copy"

# ---------------------------------------------------------------------------
# Version floor for an ALREADY-INSTALLED node/pnpm. Presence alone is not
# enough: pnpm-lock.yaml (lockfileVersion 9) and the Hub build fail with
# unrelated-looking errors on an older toolchain, and that failure lands two
# steps later where the cause is invisible. So a tool on PATH is trusted only
# when its major is >= the pinned major; otherwise the pinned version is
# installed over it.
# ---------------------------------------------------------------------------

# major_of <version> — leading integer of a version string ("v18." -> "18").
major_of() {
  local v="${1#v}"
  v="${v%%.*}"
  v="${v//[^0-9]/}"
  printf '%s' "$v"
}

# tool_major_ok <cmd> <version-flag> <min-major> — true when the tool on PATH
# reports a major >= min. An unparseable version counts as NOT ok, so the
# pinned version is installed instead of being trusted.
tool_major_ok() {
  local got
  # Probe from a dir with no package.json (a Volta-managed pnpm shim otherwise
  # auto-installs the workspace on `pnpm -v`, a wasteful side effect during a
  # pure version check — and on Windows that install collides with AV file locks).
  got="$(cd /tmp 2>/dev/null && major_of "$("$1" "$2" 2>/dev/null | head -n1)")"
  [ -n "$got" ] || return 1
  [ "$got" -ge "$3" ] 2>/dev/null
}

NODE_MAJOR_MIN="$(major_of "$NODE_VERSION")"
PNPM_MAJOR_MIN="$(major_of "$PNPM_VERSION")"

# now — clock time for the step/phase markers. The long phases (dependency
# install, Hub build) print no output for minutes at a time; a timestamp on each
# marker shows how long the current one has been running, and gives the
# installer log something support can read.
now() { date +%H:%M:%S 2>/dev/null || echo '--:--:--'; }
SETUP_STARTED="$(now)"

NODE_OS="linux"
NODE_ARCH="x64"
[ "$OS" = "Darwin" ] && NODE_OS="darwin"
{ [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; } && NODE_ARCH="arm64"

echo "Detected: $OS ($ARCH)"

# Seed PATH with the user-scope shim dirs that volta/uv/cargo write to so the
# next command can see freshly installed tools without a new shell.
export VOLTA_HOME="${VOLTA_HOME:-$HOME/.volta}"
export PATH="$VOLTA_HOME/bin:$HOME/.local/bin:$HOME/.cargo/bin:/usr/local/bin:$PATH"
export VOLTA_FEATURE_PNPM=1

# Playwright browsers share one cache across tool workspaces.
export PLAYWRIGHT_BROWSERS_PATH="$WORKSPACE_ROOT/.cache/playwright-browsers"

# Hub port: 5174 unless HUB_PORT is already set — nothing to configure for a
# normal install. Exported so the launcher, the URL printed here, and the Hub
# itself can never disagree.
export HUB_PORT="${HUB_PORT:-5174}"

# ---------------------------------------------------------------------------
# Setup_State ledger location. Steps already 'done' from a previous run are
# preserved so a re-run skips them; the ledger is written on every
# step change for progress and crash-safe re-runs.
# ---------------------------------------------------------------------------
STATE_DIR="${SETUP_STATE_DIR:-$WORKSPACE_ROOT/.cache/state}"
mkdir -p "$STATE_DIR"
STATE_FILE="$STATE_DIR/.setup-state.json"
LEGACY_STATE_FILE="$WORKSPACE_ROOT/.setup-state.json"
if [ ! -f "$STATE_FILE" ] && [ -f "$LEGACY_STATE_FILE" ] && [ "$STATE_FILE" != "$LEGACY_STATE_FILE" ]; then
  mv -f "$LEGACY_STATE_FILE" "$STATE_FILE"
fi
STATE_HELPER="$SETUP_ROOT/setup-state.mjs"

declare -A ST=(
  [node]=pending [pnpm]=pending [uv]=pending [task]=pending
  [install-deps]=pending [start-hub]=pending
)
STEP_ORDER=(node pnpm uv task install-deps start-hub)

# ===========================================================================
# Ledger helpers (read/write via the canonical engine setup-state.mjs)
# ===========================================================================

# load_state — read the ledger into ST[]. Prefers node (canonical JSON parse,
# identical to the Hub) and falls back to a grep scan when node is not yet
# installed (the very first run, before step 1 completes).
load_state() {
  [ -f "$STATE_FILE" ] || return 0
  if command -v node &>/dev/null && [ -f "$STATE_HELPER" ]; then
    while IFS=: read -r name status; do
      [ -n "$name" ] && ST[$name]="$status"
    done < <(node "$STATE_HELPER" read "$STATE_FILE")
    return 0
  fi
  local step
  for step in "${STEP_ORDER[@]}"; do
    if grep -Eq "\"$step\"[[:space:]]*:[[:space:]]*\"done\"" "$STATE_FILE"; then
      ST[$step]=done
    fi
  done
}

# write_state — persist ST[] in the canonical { steps, updatedAt } shape.
# Prefers node for an atomic write; the node-less fallback emits the same flat
# JSON by hand so early steps keep the ledger re-runnable.
write_state() {
  if command -v node &>/dev/null && [ -f "$STATE_HELPER" ]; then
    node "$STATE_HELPER" write "$STATE_FILE" \
      "node=${ST[node]}" "pnpm=${ST[pnpm]}" "uv=${ST[uv]}" "task=${ST[task]}" \
      "install-deps=${ST[install-deps]}" \
      "start-hub=${ST[start-hub]}" >/dev/null 2>&1 && return 0
  fi
  local ts tmp
  ts="$(date -u +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || echo '')"
  tmp="$STATE_FILE.tmp"
  {
    printf '{\n  "steps": {\n'
    printf '    "node": "%s",\n' "${ST[node]}"
    printf '    "pnpm": "%s",\n' "${ST[pnpm]}"
    printf '    "uv": "%s",\n' "${ST[uv]}"
    printf '    "task": "%s",\n' "${ST[task]}"
    printf '    "install-deps": "%s",\n' "${ST[install-deps]}"
    printf '    "start-hub": "%s"\n' "${ST[start-hub]}"
    printf '  },\n  "updatedAt": "%s"\n}\n' "$ts"
  } > "$tmp"
  mv -f "$tmp" "$STATE_FILE"
}

# mark_done <step> — record a step done (covers strict-SKIPPED tools) + persist.
mark_done() { ST[$1]=done; write_state; }

# fail_step <step> "<step N/M>" "<remediation>" — mark failed, persist, print
# the failing step + >=1 fix hint, and STOP (no Hub, no later component) per
# . Prior 'done' steps are left untouched in the ledger.
fail_step() {
  ST[$1]=failed
  write_state
  echo ""
  echo "  [error] Setup stopped at step: $2"
  echo "  [hint]  $3"
  echo "  [state] Progress saved to $STATE_FILE. Re-run to resume; completed steps are skipped."
  exit 1
}

# ===========================================================================
# Network + privilege helpers
# ===========================================================================

# retry <max> <timeout-seconds> <cmd...> — run a network command up to <max>
# times, each capped at <timeout> seconds. `timeout` is used when
# present; otherwise the command runs without the cap (best effort).
retry() {
  local max="$1" tmo="$2"; shift 2
  local attempt=1 rc=0
  while [ "$attempt" -le "$max" ]; do
    if command -v timeout &>/dev/null; then
      timeout "$tmo" "$@" && return 0
    else
      "$@" && return 0
    fi
    rc=$?
    echo "  [retry $attempt/$max] command failed (rc=$rc) — retrying"
    attempt=$((attempt + 1))
  done
  return "$rc"
}

# ===========================================================================
# Per-tool installers (defined before use)
# ===========================================================================

# ensure_volta — node/pnpm come from Volta; install it user-scope via the
# official curl installer (Linux) or brew (macOS). Idempotent.
ensure_volta() {
  command -v volta &>/dev/null && return 0
  echo "  Installing Volta (user-scope toolchain manager)..."
  if [ "$OS" = "Darwin" ] && command -v brew &>/dev/null; then
    brew_install volta || return 1
  else
    retry 3 30 sh -c "curl https://get.volta.sh | bash -s -- --skip-setup" || return 1
  fi
  export VOLTA_HOME="${VOLTA_HOME:-$HOME/.volta}"
  export PATH="$VOLTA_HOME/bin:$PATH"
  command -v volta &>/dev/null
}

# brew_install <pkg> — idempotent brew install with <=3 retries. macOS only.
brew_install() {
  if ! command -v brew &>/dev/null; then
    echo "  [error] Homebrew not found. Install it first:"
    echo '    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
    return 1
  fi
  if brew list "$1" &>/dev/null; then
    echo "  [skip] $1 already installed via brew"
    return 0
  fi
  retry 3 30 brew install "$1"
}

# ===========================================================================
# Load ledger + normalise so M (total steps) is known up front.
# ===========================================================================
load_state
write_state

# ===========================================================================
# STEP 1/6 — node (Volta, user-scope)
# ===========================================================================
echo ""
echo "[step] node (1/6)  [$(now)]"
if command -v node &>/dev/null && tool_major_ok node -v "$NODE_MAJOR_MIN"; then
  echo "  [SKIPPED] node $(node -v) already present on PATH (needs v${NODE_MAJOR_MIN} or newer)"; mark_done node
else
  if command -v node &>/dev/null; then
    echo "  [warn] node $(node -v) on PATH is older than this workspace needs (v${NODE_MAJOR_MIN}+)."
    echo "         Installing the pinned node@${NODE_VERSION} — your other node install is left alone."
  fi
  ensure_volta || fail_step node "node 1/6" "Volta bootstrap failed. Check network/proxy (set SETUP_INSECURE_TLS=1 if behind a TLS proxy), then re-run."
  if [ "${SETUP_INSECURE_TLS:-}" = "1" ]; then
    echo "  [warn] SETUP_INSECURE_TLS=1 — prefetching Node tarball via curl -k"
    inv="$VOLTA_HOME/tools/inventory/node"; mkdir -p "$inv"
    tarf="node-v${NODE_VERSION}-${NODE_OS}-${NODE_ARCH}.tar.gz"
    retry 3 30 curl -k -L -o "$inv/$tarf" "https://nodejs.org/dist/v${NODE_VERSION}/${tarf}" || true
  fi
  retry 3 30 volta install "node@${NODE_VERSION}" || fail_step node "node 1/6" "Node install via Volta failed after 3 attempts. Check network/proxy, then re-run."
  command -v node &>/dev/null || fail_step node "node 1/6" "Node still not on PATH after install. Open a new shell to refresh PATH, then re-run."
  tool_major_ok node -v "$NODE_MAJOR_MIN" || fail_step node "node 1/6" \
    "node@${NODE_VERSION} was installed, but '$(command -v node)' ($(node -v)) still wins on PATH. Put ${VOLTA_HOME}/bin ahead of it in your shell profile (or remove the older node), then re-run."
  mark_done node
fi

# ===========================================================================
# STEP 2/6 — pnpm (Volta)
# ===========================================================================
echo ""
echo "[step] pnpm (2/6)  [$(now)]"
if command -v pnpm &>/dev/null && tool_major_ok pnpm -v "$PNPM_MAJOR_MIN"; then
  echo "  [SKIPPED] pnpm $(pnpm -v) already present on PATH (needs v${PNPM_MAJOR_MIN} or newer)"; mark_done pnpm
else
  if command -v pnpm &>/dev/null; then
    echo "  [warn] pnpm $(pnpm -v) on PATH cannot read this workspace's lockfile (needs v${PNPM_MAJOR_MIN}+)."
    echo "         Installing the pinned pnpm@${PNPM_VERSION} — your other pnpm install is left alone."
  fi
  ensure_volta || fail_step pnpm "pnpm 2/6" "Volta bootstrap failed. Check network/proxy, then re-run."
  retry 3 30 volta install "pnpm@${PNPM_VERSION}" || fail_step pnpm "pnpm 2/6" "pnpm install via Volta failed after 3 attempts. Ensure VOLTA_FEATURE_PNPM=1, then re-run."
  command -v pnpm &>/dev/null || fail_step pnpm "pnpm 2/6" "pnpm still not on PATH after install. Open a new shell to refresh PATH, then re-run."
  tool_major_ok pnpm -v "$PNPM_MAJOR_MIN" || fail_step pnpm "pnpm 2/6" \
    "pnpm@${PNPM_VERSION} was installed, but '$(command -v pnpm)' ($(pnpm -v)) still wins on PATH. Put ${VOLTA_HOME}/bin ahead of it in your shell profile (or remove the older pnpm), then re-run."
  mark_done pnpm
fi

# ===========================================================================
# STEP 3/6 — uv (curl installer on Linux / brew on macOS, user-scope)
# ===========================================================================
echo ""
echo "[step] uv (3/6)  [$(now)]"
if command -v uv &>/dev/null; then
  echo "  [SKIPPED] uv already present on PATH (strict skip)"; mark_done uv
elif [ "${ST[uv]}" = "done" ]; then
  echo "  [SKIPPED] uv already installed (state: done)"
else
  # brew is the fast path when it exists; the official install script is the
  # fallback and works the same on macOS, so a Mac without Homebrew is NOT a
  # dead end (that used to stop setup here and ask the user to install brew).
  if [ "$OS" = "Darwin" ] && command -v brew &>/dev/null; then
    brew_install uv || fail_step uv "uv 3/6" "brew install uv failed after 3 attempts. Check network/proxy, then re-run."
  else
    retry 3 30 sh -c "curl -LsSf https://astral.sh/uv/install.sh | sh" || fail_step uv "uv 3/6" "uv install script failed after 3 attempts. Check network/proxy, then re-run."
  fi
  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
  command -v uv &>/dev/null || fail_step uv "uv 3/6" "uv still not on PATH after install. Open a new shell to refresh PATH, then re-run."
  mark_done uv
fi

# ===========================================================================
# STEP 4/6 — task (curl installer on Linux / brew go-task on macOS)
# ===========================================================================
echo ""
echo "[step] task (4/6)  [$(now)]"
if command -v task &>/dev/null; then
  echo "  [SKIPPED] task already present on PATH (strict skip)"; mark_done task
elif [ "${ST[task]}" = "done" ]; then
  echo "  [SKIPPED] task already installed (state: done)"
else
  # Same shape as uv: brew when available, official install script otherwise
  # (it supports macOS too), so no Homebrew is not a dead end.
  if [ "$OS" = "Darwin" ] && command -v brew &>/dev/null; then
    brew_install go-task || fail_step task "task 4/6" "brew install go-task failed after 3 attempts. Check network/proxy, then re-run."
  else
    # Install user-scope to ~/.local/bin (no root needed).
    mkdir -p "$HOME/.local/bin"
    retry 3 30 sh -c "curl --location https://taskfile.dev/install.sh | sh -s -- -d -b \"$HOME/.local/bin\"" || fail_step task "task 4/6" "task install script failed after 3 attempts. Check network/proxy, then re-run."
  fi
  command -v task &>/dev/null || fail_step task "task 4/6" "task still not on PATH after install. Open a new shell to refresh PATH, then re-run."
  mark_done task
fi

# ===========================================================================
# AUX (not part of the 4-tool verify) — kill-port + Android (opt-in, decoupled)
# ===========================================================================
echo ""
echo "[aux] Installing kill-port (best-effort; the Hub launcher uses it to free a stuck port)"
if command -v volta &>/dev/null; then
  volta install kill-port >/dev/null 2>&1 || echo "  [warn] kill-port install skipped (non-fatal)"
fi
echo ""
echo "[aux] Android is opt-in and NOT part of core setup. Run 'task setup-android' to install the Android SDK + emulator."

# ===========================================================================
# STEP 5/6 — install-deps (Workspace_Package + Python_Tool)
# ===========================================================================
echo ""
echo "[step] install-deps (5/6)  [$(now)]"
# The ledger alone is not proof: node_modules can be deleted (disk cleanup, a
# failed prune) long after the step was recorded done. Re-check the artefact.
if [ "${ST[install-deps]}" = "done" ] && [ -d "$WORKSPACE_ROOT/node_modules" ]; then
  echo "  [SKIPPED] dependencies already installed (state: done)"
else
  if [ "${ST[install-deps]}" = "done" ]; then
    echo "  [warn] state says done but $WORKSPACE_ROOT/node_modules is missing — installing again."
  fi
  echo "  This downloads dependencies and can take several minutes on the first run."
  echo "  Please keep this window open - it is working, not frozen."
  echo "  [$(now)] Installing Node workspace dependencies (pnpm install)..."
  pnpm -C "$WORKSPACE_ROOT" install || fail_step install-deps "install-deps 5/6" "pnpm install failed. Check network and that pnpm-lock.yaml matches package.json, then re-run."
  # ---- Python toolchain (NON-FATAL) ----------------------------------------
  # Python is needed ONLY by the robot-framework tool. A locked-down network
  # (corporate proxy/policy) can fail the download — that must NOT abort setup.
  # So we WARN and CONTINUE, leaving the Hub to start. The user finishes later
  # with one click in the Hub's "Environment Status" panel > "Install Python"
  # (POST /api/doctor/install-python), or by re-running the command shown.
  echo "  [$(now)] Installing Python toolchain (uv python install $PYTHON_VERSION)..."
  if ! uv python install "$PYTHON_VERSION" --native-tls; then
    echo "  [warn] uv python install failed — SKIPPING Python for now (non-fatal)."
    echo "  [hint] Finish later in the Hub: \"Environment Status\" panel > \"Install Python\" button — or re-run:"
    echo "         uv python install $PYTHON_VERSION --native-tls"
  fi
  mark_done install-deps
  echo "  [$(now)] Setting up the present tools (task setup: pnpm install per tool, uv sync, each tool's setup)..."
  if ! task --dir "$WORKSPACE_ROOT" setup; then
    echo "  [warn] task setup did not finish — some tool dependencies are incomplete (non-fatal)."
    echo "  [hint] Finish later in the Hub: \"Environment Status\" panel > \"Set up\" on that tool — or re-run:"
    echo "         task --dir \"$WORKSPACE_ROOT\" setup"
  fi
fi

# ===========================================================================
# STEP 6/6 — start-hub (build + daemonless launch via the shared launcher)
# ===========================================================================
echo ""
echo "[step] start-hub (6/6)  [$(now)]"
HUB_STATE="skipped"
hub_warn() {
  ST[start-hub]=failed
  write_state
  HUB_STATE="failed"
  echo "  [warn] $1 The CLI (task ...) works without the Hub (non-fatal)."
  echo "  [hint] $2"
  echo "  [state] Progress saved to $STATE_FILE. Re-run to retry the Hub; completed steps are skipped."
}
start_hub() {
  if [ "${ST[start-hub]}" = "done" ]; then
    echo "  [warn] state says done but the Hub is not responding — starting it again."
  fi
  # Rebuild unless a finished bundle is still on disk from the run that recorded
  # this step done: that is the "Hub is down, nothing is broken" re-run path.
  if [ "${ST[start-hub]}" = "done" ] && [ -f "$WORKSPACE_ROOT/hub/server/dist/index.js" ]; then
    echo "  [skip] Hub bundle already built — starting it without a rebuild."
  else
    echo "  [$(now)] Building the Hub (shared + server + client) - this can take a couple of minutes..."
    pnpm -C "$WORKSPACE_ROOT/hub" run build || {
      hub_warn "Hub build failed." "Inspect the build output above, then re-run."
      return 1
    }
  fi
  # Delegate process management to the shared launcher: it frees the port and
  # starts the Hub as a daemonless detached background process (no daemon of our
  # own, so nothing to be blocked by locked-down/corporate policy). One code
  # path, cross-OS.
  echo "  [$(now)] Starting Hub (daemonless background process)..."
  node "$WORKSPACE_ROOT/hub/bin/hub-service.mjs" start || {
    hub_warn "Hub failed to start." "Run 'node hub/bin/hub-service.mjs status' for details, then re-run."
    return 1
  }
  # Register boot auto-start: a systemd --user unit (Restart=always) + lingering,
  # so the Hub starts at boot even on a headless box with no login. Best-effort
  # (|| true): never fails setup if systemd/linger is unavailable.
  echo "  Enabling auto-start at boot (systemd --user)..."
  node "$WORKSPACE_ROOT/hub/bin/hub-service.mjs" enable-boot || true
  mark_done start-hub
  HUB_STATE="running"
}
# `status` exits 0 only while the Hub answers on its port, so a ledger entry left
# over from a machine that has since rebooted (auto-start blocked by policy) no
# longer skips this step and leaves the readiness check to fail later.
if [ ! -f "$WORKSPACE_ROOT/hub/package.json" ]; then
  echo "  [skip] No Hub in this workspace (hub/package.json absent) — the CLI works without it."
  mark_done start-hub
elif [ "${SETUP_SKIP_HUB:-}" = "1" ]; then
  echo "  [skip] Hub build and start skipped (SETUP_SKIP_HUB=1)."
elif [ "${ST[start-hub]}" = "done" ] \
  && node "$WORKSPACE_ROOT/hub/bin/hub-service.mjs" status >/dev/null 2>&1; then
  echo "  [SKIPPED] Hub already running (state: done)"
  HUB_STATE="running"
else
  start_hub
fi

# ===========================================================================
# VERIFY — only AFTER every step completed. Missing → non-zero.
# ===========================================================================
echo ""
echo "[verify] Verifying all 4 Core tools on PATH (post-setup)"
echo "---------------------------------------------------"
MISSING=""
verify() {
  if command -v "$1" &>/dev/null; then
    printf "  [OK] %s %s\n" "$1" "$("$1" ${2:-} 2>/dev/null | head -n1)"
  else
    echo "  [MISSING] $1"
    MISSING="$MISSING $1"
  fi
}
verify node "-v"
verify pnpm "-v"
verify uv "--version"
verify task "--version"
echo "[verify] Workspace binaries the root tasks run (pnpm exec, no global install)"
verify_local() {
  if (cd "$WORKSPACE_ROOT" && pnpm exec "$1" --version >/dev/null 2>&1); then
    printf "  [OK] %s %s\n" "$1" "$(cd "$WORKSPACE_ROOT" && pnpm exec "$1" --version 2>/dev/null | head -n1)"
  else
    echo "  [MISSING] $1 (root devDependency; run: pnpm install)"
    MISSING="$MISSING $1"
  fi
}
verify_local tsx
verify_local dotenvx
echo "---------------------------------------------------"
if [ -n "$MISSING" ]; then
  echo ""
  echo "  [error] Verification failed. Missing:$MISSING"
  echo "  [hint]  Open a new shell to refresh PATH, then re-run this script; completed steps are skipped."
  exit 1
fi

if [ "$HUB_STATE" != "running" ]; then
  echo ""
  echo "==================================================="
  echo "  SETUP COMPLETED — CLI ready, all 4 Core tools verified (Hub not started)"
  echo "==================================================="
  echo "  Run tasks from $WORKSPACE_ROOT: task --list"
  [ "$HUB_STATE" = "failed" ] && echo "  [warn] The Hub step failed (see above). Re-run this script to retry it."
  echo "==================================================="
  exit 0
fi

echo ""
echo "==================================================="
echo "  SETUP COMPLETED — Hub started, all 4 Core tools verified"
echo "==================================================="
echo "  Open http://localhost:${HUB_PORT}"
echo ""
echo "  The present tools were set up by 'task setup' above. If a tool reported a"
echo "  warning, open the Hub \"Environment Status\" panel and press \"Set up\" on"
echo "  that tool (or run: task setup)."
echo "==================================================="

echo ""
echo "  [setup] Creating \"Test Hub\" desktop shortcut..."
node "$WORKSPACE_ROOT/hub/bin/hub-service.mjs" install-shortcut || true
if [ "${SETUP_NO_OPEN:-}" != "1" ]; then
  node "$WORKSPACE_ROOT/hub/bin/hub-service.mjs" open || true
fi
