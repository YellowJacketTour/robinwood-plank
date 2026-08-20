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

echo Starting Marketplank Next on :3800 in a new window.
echo Leave that window open. Close it only to stop the site.
start "Marketplank :3800" cmd /k "cd /d "%~dp0" && npx next dev -p 3800"

echo.
echo Site: http://localhost:3800/market/multichain
echo This window can close; the Next window stays up.
timeout /t 3 /nobreak >nul
exit /b 0
