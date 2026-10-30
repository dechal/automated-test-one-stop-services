#!/usr/bin/env bash
# ============================================================================
#  ONE-CLICK INSTALLER (Linux / macOS)
# ----------------------------------------------------------------------------
#  Standalone file — distribute this SINGLE .sh. End user runs:  ./install.sh
#  Everything is handled: git clone + toolchain install + deps + Hub start.
#
#  Target Directory defaults to the CURRENT directory if the user presses
#  Enter without typing anything — no input is mandatory.
#
#  Prerequisites: a POSIX shell + curl (present on any modern Linux/macOS).
# ============================================================================

set -uo pipefail

REPO_URL="https://github.com/decha2543/automated-test-one-stop-services.git"

# ---------------------------------------------------------------------------
# --help answers before anything else happens (no folder, no log, no prompt).
# ---------------------------------------------------------------------------
case "${1:-}" in
  -h | --help)
    echo "Automated Test One-Stop Service - installer (macOS / Linux)"
    echo ""
    echo "Usage:  bash <this-file>.sh [TARGET_DIRECTORY]"
    echo ""
    echo "  TARGET_DIRECTORY   where to put the workspace. Leave it out and you are"
    echo "                     asked; pressing Enter then uses the current folder."
    echo ""
    echo "What it does: installs git if it is missing, downloads the workspace,"
    echo "installs the toolchain for your user only (volta/node/pnpm, uv, task),"
    echo "installs project dependencies, then builds and starts the local Hub."
    echo ""
    echo "Optional environment variables:"
    echo "  HUB_PORT=<port>       Hub port (default 5174)"
    echo "  SETUP_INSECURE_TLS=1   fetch through a TLS-inspecting corporate proxy"
    echo "  SETUP_SKIP_HUB=1       install the CLI only; skip the Hub build and start"
    echo ""
    echo "Each run writes install-log-<timestamp>.txt in the current folder."
    echo "To remove it all later:  node scripts/setup/uninstall.mjs --run"
    exit 0
    ;;
esac

# Wall-clock start, for the "how long did this take" line at the end.
SETUP_STARTED="$(date +%H:%M:%S 2>/dev/null || echo '--:--:--')"

# ---------------------------------------------------------------------------
# Transcript: mirror the whole run to a log file so a failed install can still
# be read (and sent to whoever helps) after this window is closed. First
# writable candidate wins; having no log is never a reason to stop.
# ---------------------------------------------------------------------------
LOG_FILE=""
for candidate in "$PWD" "$HOME" "${TMPDIR:-/tmp}"; do
  { [ -d "$candidate" ] && [ -w "$candidate" ]; } || continue
  LOG_FILE="$candidate/install-log-$(date +%Y%m%d-%H%M%S).txt"
  break
done
if [ -n "$LOG_FILE" ] && [ -n "${BASH_VERSION:-}" ] && command -v tee &>/dev/null; then
  exec > >(tee -a "$LOG_FILE") 2>&1
else
  LOG_FILE=""
fi

# Hub port: 5174 unless HUB_PORT is already set, so a normal install configures
# nothing. Exported so setup, the launcher, and this readiness poll agree — and
# so `HUB_PORT=5180 ./installer.sh` works when 5174 is taken.
export HUB_PORT="${HUB_PORT:-5174}"
HUB_URL="http://localhost:${HUB_PORT}"

echo "==================================================="
echo "  AUTOMATED TEST ONE-STOP SERVICE — INSTALLER"
echo "==================================================="
echo "  Welcome! This sets everything up for you automatically -"
echo "  no technical knowledge needed. It installs the test"
echo "  automation Hub and opens it in your browser when done."
echo ""
echo "  * It usually takes about 5-15 minutes the first time."
echo "  * You'll see technical messages scroll by - that's normal."
echo "  * Please just keep this window open until it finishes."
echo "---------------------------------------------------"
echo "  What it does, in order:"
echo "    1. installs git if missing, then downloads the workspace"
echo "       into the folder you choose below"
echo "    2. installs the tools it needs for you only, not system-wide:"
echo "       volta (node + pnpm), uv, task"
echo "    3. installs project dependencies and builds the Hub"
echo "    4. starts the Hub, adds a \"Test Hub\" desktop shortcut,"
echo "       and starts it again automatically at login"
echo "  Nothing asks for your password, unless git is missing and has to"
echo "  come from the system package manager (apt/dnf need sudo)."
if [ -n "$LOG_FILE" ]; then
  echo "  A log of this run is saved to:"
  echo "    $LOG_FILE"
fi
echo "==================================================="

# ---------------------------------------------------------------------------
# Ask for Target Directory (default = current directory)
# ---------------------------------------------------------------------------
echo ""
# A directory passed as the first argument skips the prompt, so the install can
# also run unattended (./installer.sh /opt/qa).
TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  read -r -p "Enter Target Directory [default: current dir]: " TARGET || true
fi

# Trim whitespace
TARGET="${TARGET#"${TARGET%%[![:space:]]*}"}"
TARGET="${TARGET%"${TARGET##*[![:space:]]}"}"

# Default to current directory if empty
if [ -z "$TARGET" ]; then
  TARGET="."
fi

# Expand a leading ~ without eval: `eval echo "$TARGET"` would execute command
# substitution typed into the prompt and glob-expand the path.
case "$TARGET" in
  '~') TARGET="$HOME" ;;
  '~/'*) TARGET="$HOME/${TARGET#\~/}" ;;
esac
if [ -d "$TARGET" ]; then
  TARGET=$(cd "$TARGET" && pwd)
else
  # Parent must exist for resolution; create target below
  parent=$(dirname "$TARGET")
  if [ -d "$parent" ]; then
    TARGET="$(cd "$parent" && pwd)/$(basename "$TARGET")"
  fi
fi

echo ""
echo "  Target: $TARGET"

# ---------------------------------------------------------------------------
# Create target directory if needed
# ---------------------------------------------------------------------------
if [ ! -d "$TARGET" ]; then
  if ! mkdir -p "$TARGET" 2>/dev/null; then
    echo "  [error] Cannot create directory: $TARGET"
    echo "  [hint]  Check the path and permissions."
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Ensure git is available
# ---------------------------------------------------------------------------
if ! command -v git &>/dev/null; then
  echo ""
  echo "  [install] git not found — installing..."
  if command -v brew &>/dev/null; then
    brew install git
  elif command -v apt-get &>/dev/null; then
    sudo apt-get update -qq && sudo apt-get install -y git
  elif command -v dnf &>/dev/null; then
    sudo dnf install -y git
  else
    echo "  [error] Cannot install git automatically."
    echo "  [hint]  Install git manually, then re-run."
    exit 1
  fi
  if ! command -v git &>/dev/null; then
    echo "  [error] git still not available after install attempt."
    exit 1
  fi
  echo "  [OK] git installed"
fi

# ---------------------------------------------------------------------------
# Clone or update the repository
# ---------------------------------------------------------------------------
WORKSPACE="$TARGET/automated-test-one-stop-service"

if [ -d "$WORKSPACE/.git" ]; then
  echo ""
  echo "  [update] Repository already exists — pulling latest..."
  git -C "$WORKSPACE" pull --ff-only || echo "  [warn] git pull failed — continuing with existing code"
else
  echo ""
  echo "  [clone] Cloning repository..."
  if ! git clone --depth 1 "$REPO_URL" "$WORKSPACE"; then
    echo "  [error] git clone failed. Check network and the URL:"
    echo "          $REPO_URL"
    exit 1
  fi
  echo "  [OK] Repository cloned"
fi

# ---------------------------------------------------------------------------
# Run the setup bootstrap
# ---------------------------------------------------------------------------
echo ""
echo "==================================================="
echo "  Running setup (toolchain + deps + Hub start)..."
echo "  The technical messages below are normal - please keep this window open."
echo "==================================================="

# Let the installer open the browser once, AFTER the readiness poll below, so
# setup itself does not open too early. install-shortcut still runs in setup.
SETUP_NO_OPEN=1 bash "$WORKSPACE/scripts/setup/setup-linux.sh"
SETUP_RC=$?

if [ "$SETUP_RC" -ne 0 ]; then
  echo ""
  echo "  [error] Setup did not finish (code $SETUP_RC)."
  echo "  Don't worry - just run this installer again. It continues"
  echo "  where it left off; finished steps are skipped."
  echo "  If it keeps failing, the messages above show what to fix."
  [ -n "$LOG_FILE" ] && echo "  Full log of this run: $LOG_FILE"
  exit 1
fi
if [ ! -f "$WORKSPACE/hub/package.json" ] || [ "${SETUP_SKIP_HUB:-}" = "1" ]; then
  echo ""
  echo "  ALL SET! The CLI is ready (no Hub in this install): cd \"$WORKSPACE\" && task --list"
  [ -n "$LOG_FILE" ] && echo "  Log of this run: $LOG_FILE"
  exit 0
fi

# ---------------------------------------------------------------------------
# Wait for Hub to be ready
# ---------------------------------------------------------------------------
echo ""
echo "  Waiting for Hub on $HUB_URL (up to 60s)..."

HUB_READY=0
for _poll in $(seq 1 60); do
  if curl -fsS --max-time 3 "$HUB_URL" >/dev/null 2>&1; then
    HUB_READY=1
    break
  fi
  sleep 1
done

if [ "$HUB_READY" -eq 1 ]; then
  echo ""
  echo "==================================================="
  echo "  ALL SET! Your Test Hub is ready to use."
  echo "==================================================="
  echo "  Open: $HUB_URL"
  echo ""
  echo "  Opening it in your browser now..."
  node "$WORKSPACE/hub/bin/hub-service.mjs" open || true
  echo ""
  echo "  Next time, just double-click the \"Test Hub\" icon on your"
  echo "  desktop to open it again."
  echo ""
  echo "  Setup already ran each tool's own setup (browsers included). If a tool"
  echo "  showed a warning, open the \"Environment Status\" panel and press \"Set up\"."
  echo ""
  echo "  Workspace: $WORKSPACE"
  [ -n "$LOG_FILE" ] && echo "  Log of this run: $LOG_FILE"
  echo "  Ran from $SETUP_STARTED to $(date +%H:%M:%S 2>/dev/null || echo '--:--:--')"
  echo "==================================================="
  echo ""
  exit 0
fi

echo ""
echo "  [warn] Hub did not start within 60s. The CLI is ready: cd \"$WORKSPACE\" && task --list"
echo "  Try running this installer again - it resumes where it left off."
echo "  [hint]  Check the Hub status: node hub/bin/hub-service.mjs status (logs: hub/.run/hub.log)"
[ -n "$LOG_FILE" ] && echo "  Full log of this run: $LOG_FILE"
exit 0
