@echo off
setlocal ENABLEEXTENSIONS ENABLEDELAYEDEXPANSION
chcp 65001 >nul

REM ===========================================================================
REM   ONE-CLICK INSTALLER (Windows)
REM ===========================================================================
REM   Standalone file - distribute this SINGLE .bat. End user double-clicks it
REM   and everything is handled: git clone + toolchain install + deps + Hub start.
REM
REM   Target Directory defaults to the CURRENT directory if the user presses
REM   Enter without typing anything - no input is mandatory.
REM
REM   Prerequisites: Windows 10+ (curl + PowerShell built-in). Nothing else.
REM ===========================================================================

set "REPO_URL=https://github.com/decha2543/automated-test-one-stop-services.git"

REM --------------------------------------------------------------------------
REM --help answers before anything else happens (no folder, no log, no prompt).
REM --------------------------------------------------------------------------
if /I "%~1"=="--help" goto :usage
if /I "%~1"=="-h" goto :usage
if /I "%~1"=="/?" goto :usage
if /I "%~1"=="/help" goto :usage

REM Wall-clock start, for the "how long did this take" line at the end.
set "SETUP_STARTED=%TIME:~0,8%"

echo ===================================================
echo   AUTOMATED TEST ONE-STOP SERVICE - INSTALLER
echo ===================================================
echo   Welcome! This sets everything up for you automatically -
echo   no technical knowledge needed. It installs the test
echo   automation Hub and opens it in your browser when done.
echo.
echo   * It usually takes about 5-15 minutes the first time.
echo   * You'll see technical messages scroll by - that's normal.
echo   * Please just keep this window open until it finishes.
echo ---------------------------------------------------
echo   What it does, in order:
echo     1. installs git if missing, then downloads the workspace
echo        into the folder you choose below
echo     2. installs the tools it needs for you only, not system-wide:
echo        scoop, volta ^(node + pnpm^), uv, task
echo     3. installs project dependencies and builds the Hub
echo     4. starts the Hub, adds a "Test Hub" desktop shortcut,
echo        and starts it again automatically when you log in
echo   It does not need administrator rights. Windows may ask once if
echo   git has to be installed through the Microsoft installer.
echo ===================================================

REM --------------------------------------------------------------------------
REM Ask for Target Directory (default = current directory)
REM A directory passed as the first argument skips the prompt, so the install
REM can also run unattended (installer.bat D:\qa).
REM --------------------------------------------------------------------------
echo.
set "TARGET=%~1"
if not defined TARGET set /p "TARGET=Enter Target Directory [default: current dir]: "
if defined TARGET set "TARGET=!TARGET:"=!"

REM Default to current directory if empty/blank
if not defined TARGET set "TARGET=."
set "TARGET_NOSPACE=!TARGET: =!"
if not defined TARGET_NOSPACE set "TARGET=."

REM Resolve to absolute path
for %%I in ("!TARGET!") do set "TARGET_ABS=%%~fI"
echo.
echo   Target: !TARGET_ABS!

REM --------------------------------------------------------------------------
REM Create target directory if needed
REM --------------------------------------------------------------------------
if not exist "!TARGET_ABS!\" (
    mkdir "!TARGET_ABS!" 2>nul
    if errorlevel 1 (
        echo   [error] Cannot create directory: !TARGET_ABS!
        echo   [hint]  Check the path is valid and you have write permission.
        pause
        exit /b 1
    )
)

REM --------------------------------------------------------------------------
REM Transcript: the setup phase is mirrored to a log file next to the workspace
REM so a failed install can still be read (and sent to whoever helps) after this
REM window is closed. Timestamp comes from PowerShell because %DATE%/%TIME% are
REM locale-dependent.
REM --------------------------------------------------------------------------
set "STAMP="
for /f "usebackq delims=" %%T in (`powershell -NoProfile -Command "(Get-Date).ToString('yyyyMMdd-HHmmss')"`) do set "STAMP=%%T"
if not defined STAMP set "STAMP=%RANDOM%"
set "LOG_FILE=!TARGET_ABS!\install-log-!STAMP!.txt"
echo   Log of this run: !LOG_FILE!

REM Hub port: 5174 unless HUB_PORT is already set, so a normal install configures
REM nothing. Set here so setup, the launcher, and the readiness poll below agree -
REM and so `set HUB_PORT=5180` before running works when 5174 is taken.
if not defined HUB_PORT set "HUB_PORT=5174"
set "HUB_URL=http://localhost:%HUB_PORT%"

REM --------------------------------------------------------------------------
REM Ensure git is available (install via winget or scoop if missing)
REM --------------------------------------------------------------------------
where git >nul 2>nul
if errorlevel 1 (
    echo.
    echo   [install] git not found - installing via winget ^(this takes a minute^)...
    REM Output is left visible on purpose: silencing it makes the console look
    REM frozen for the whole download.
    winget install Git.Git --accept-package-agreements --accept-source-agreements
    call :refreshPath
    where git >nul 2>nul
    if errorlevel 1 (
        echo   [install] winget failed, trying scoop...
        where scoop >nul 2>nul || (
            powershell -NoProfile -ExecutionPolicy Bypass -Command "Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser -Force; Invoke-RestMethod get.scoop.sh | Invoke-Expression" >nul 2>nul
            call :refreshPath
        )
        call scoop install git >nul 2>nul
        call :refreshPath
    )
    where git >nul 2>nul
    if errorlevel 1 (
        echo.
        echo   [error] Could not install git automatically.
        echo   [hint]  Install git manually from https://git-scm.com then re-run.
        pause
        exit /b 1
    )
    echo   [OK] git installed
)

REM --------------------------------------------------------------------------
REM Clone or update the repository
REM --------------------------------------------------------------------------
set "WORKSPACE=!TARGET_ABS!\automated-test-one-stop-service"

if exist "!WORKSPACE!\.git\" (
    echo.
    echo   [update] Repository already exists - pulling latest...
    git -C "!WORKSPACE!" pull --ff-only
    if errorlevel 1 (
        echo   [warn] git pull failed - continuing with existing code
    )
) else (
    echo.
    echo   [clone] Cloning repository...
    git clone --depth 1 "!REPO_URL!" "!WORKSPACE!"
    if errorlevel 1 (
        echo   [error] git clone failed. Check network/proxy and the URL:
        echo           !REPO_URL!
        pause
        exit /b 1
    )
    echo   [OK] Repository cloned
)

REM --------------------------------------------------------------------------
REM Run the setup bootstrap
REM --------------------------------------------------------------------------
echo.
echo ===================================================
echo   Running setup (toolchain + deps + Hub start)...
echo   The technical messages below are normal - please keep this window open.
echo ===================================================

set "SETUP_NO_PAUSE=1"
REM Let the installer open the browser once, AFTER the readiness poll below, so
REM setup itself does not open too early. install-shortcut still runs in setup.
set "SETUP_NO_OPEN=1"

REM Run setup through the log wrapper (cmd has no `tee`) so the console still
REM shows progress live AND everything lands in the log. Falls back to a plain
REM call when PowerShell or the wrapper is unavailable - a missing log must never
REM stop the install.
set "SETUP_BAT=!WORKSPACE!\scripts\setup\setup-windows.bat"
set "LOG_HELPER=!WORKSPACE!\scripts\setup\windows\run-with-log.ps1"
where powershell >nul 2>nul
if not errorlevel 1 if exist "!LOG_HELPER!" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "!LOG_HELPER!" -Script "!SETUP_BAT!" -LogFile "!LOG_FILE!"
    set "SETUP_RC=!ERRORLEVEL!"
)
if not defined SETUP_RC (
    call "!SETUP_BAT!"
    set "SETUP_RC=!ERRORLEVEL!"
)

if not "!SETUP_RC!"=="0" (
    echo.
    echo   [error] Setup did not finish ^(code !SETUP_RC!^).
    echo   Don't worry - just run this installer again. It continues
    echo   where it left off; finished steps are skipped.
    echo   If it keeps failing, the messages above show what to fix.
    echo   Full log of this run: !LOG_FILE!
    pause
    exit /b 1
)
set "_cliOnly="
if not exist "!WORKSPACE!\hub\package.json" set "_cliOnly=1"
if "%SETUP_SKIP_HUB%"=="1" set "_cliOnly=1"
if defined _cliOnly (
    echo.
    echo   ALL SET! The CLI is ready ^(no Hub in this install^): cd /d "!WORKSPACE!" ^&^& task --list
    echo   Log of this run: !LOG_FILE!
    pause
    exit /b 0
)

REM --------------------------------------------------------------------------
REM Wait for Hub to be ready
REM --------------------------------------------------------------------------
echo.
echo   Waiting for Hub on %HUB_URL% (up to 60s)...
set "HUB_READY=0"
set /a _poll=0
:poll_loop
set /a _poll+=1
curl.exe -fsS --max-time 3 %HUB_URL% >nul 2>nul && set "HUB_READY=1"
if "!HUB_READY!"=="1" goto :hub_ok
if !_poll! GEQ 60 goto :hub_fail
ping -n 2 127.0.0.1 >nul 2>nul
goto :poll_loop

:hub_ok
echo.
echo ===================================================
echo   ALL SET! Your Test Hub is ready to use.
echo ===================================================
echo   Open: %HUB_URL%
echo.
echo   Opening it in your browser now...
call node "!WORKSPACE!\hub\bin\hub-service.mjs" open
echo.
echo   Next time, just double-click the "Test Hub" icon on your
echo   desktop to open it again.
echo.
echo   Setup already ran each tool's own setup ^(browsers included^). If a tool
echo   showed a warning, open the "Environment Status" panel and press "Set up".
echo.
echo   Workspace: !WORKSPACE!
echo   Log of this run: !LOG_FILE!
echo   Ran from %SETUP_STARTED% to !TIME:~0,8!
echo ===================================================
echo.
pause
exit /b 0

:hub_fail
echo.
echo   [warn] Hub did not start within 60s. The CLI is ready: cd /d "!WORKSPACE!" ^&^& task --list
echo   Try running this installer again - it resumes where it left off.
echo   [hint]  Check the Hub status: node hub\bin\hub-service.mjs status ^(logs: hub\.run\hub.log^)
echo   Full log of this run: !LOG_FILE!
pause
exit /b 0

REM --------------------------------------------------------------------------
:refreshPath
for /f "usebackq tokens=* delims=" %%P in (`powershell -NoProfile -Command "[System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')"`) do set "PATH=%%P"
goto :eof

REM --------------------------------------------------------------------------
:usage
echo Automated Test One-Stop Service - installer ^(Windows^)
echo.
echo Usage:  automated-test-one-stop-service_installer_windows.bat [TARGET_DIRECTORY]
echo.
echo   TARGET_DIRECTORY   where to put the workspace. Leave it out ^(or just
echo                      double-click^) and you are asked; pressing Enter then
echo                      uses the current folder.
echo.
echo What it does: installs git if it is missing, downloads the workspace,
echo installs the toolchain for your user only ^(scoop, volta/node/pnpm, uv, task^),
echo installs project dependencies, then builds and starts the local Hub.
echo No administrator rights needed.
echo.
echo Optional environment variables:
echo   HUB_PORT=^<port^>       Hub port ^(default 5174^)
echo   SETUP_INSECURE_TLS=1   fetch through a TLS-inspecting corporate proxy
echo   SETUP_ENABLE_SHELL_DECOUPLE=1  add Git's GNU tools to your user PATH ^(off by default^)
echo   SETUP_SKIP_HUB=1       install the CLI only; skip the Hub build and start
echo.
echo Each run writes install-log-^<timestamp^>.txt into the folder you picked.
echo To remove it all later:  node scripts\setup\uninstall.mjs --run
exit /b 0
