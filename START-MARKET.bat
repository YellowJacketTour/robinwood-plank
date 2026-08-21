@echo off
setlocal
cd /d "%~dp0"

REM Marketplank local hub. Opens its OWN window so a Grok/CLI session
REM dying or hanging cannot take localhost:3800 with it.
REM Do not use START.bat (that is PlankCrash / Hardhat).

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not on PATH.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

REM Already live? Do not spawn a second Next (EADDRINUSE / two trees).
netstat -ano | findstr ":3800" | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo Already live — not starting a second process.
  echo Native book:  http://localhost:3800/market
  echo Global hub:   http://localhost:3800/market/multichain
  echo Close the "Marketplank :3800" window to stop.
  exit /b 0
)

echo Starting Marketplank Next on :3800 in its OWN window.
echo That window is independent of Grok. Close it only to stop the site.
echo Global hub: http://localhost:3800/market/multichain
echo Native book: http://localhost:3800/market  ^(empty book is local listings, not Global^)

REM Detached console: survives this bat exiting. Do not `timeout ^>nul` here —
REM redirected Grok shells treat that as a fatal "Input redirection" error.
start "Marketplank :3800" cmd /k "cd /d "%~dp0" && title Marketplank :3800 && npx next dev -p 3800"
exit /b 0
