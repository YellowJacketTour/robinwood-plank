@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ========================================================
echo  PlankCrash -- local friend-test build
echo ========================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or not on PATH.
  echo Install it from https://nodejs.org, then double-click this file again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies -- this only happens once, takes a few minutes...
  call npm install
  if errorlevel 1 (
    echo npm install failed. See the error above.
    pause
    exit /b 1
  )
)

echo.
echo [1/4] Starting a local blockchain (a new window will open -- leave it running)...
start "PlankCrash - local blockchain" cmd /k "npx hardhat node"

echo Waiting for it to come up...
timeout /t 6 /nobreak >nul

echo.
echo [2/4] Deploying the game contracts to it...
call npx hardhat run scripts\local-casino-setup.ts --network localhost
if errorlevel 1 (
  echo Deploy failed. Make sure the local blockchain window from step 1 is still open, then re-run this file.
  pause
  exit /b 1
)

echo.
echo [3/4] Starting the round keeper (a new window will open -- leave it running; it's what
echo       advances rounds, reveals crash points, and settles bets automatically)...
call node scripts\release\keeper-env.mjs > "%TEMP%\plankcrash-keeper-env.bat"
if errorlevel 1 (
  echo Could not read the deploy manifest -- see the error above.
  pause
  exit /b 1
)
start "PlankCrash - round keeper" cmd /k "call \"%TEMP%\plankcrash-keeper-env.bat\" && npx hardhat run scripts\casino-keeper.ts --network localhost"

echo.
echo [4/4] Starting the web server (a new window will open -- leave it running)...
start "PlankCrash - web server" cmd /k "npx http-server public\arcade -p 8788"

timeout /t 3 /nobreak >nul
echo.
echo Opening the game in your browser...
start "" "http://127.0.0.1:8788/crash.html"

echo.
echo ========================================================
echo  Three windows are now running (blockchain / keeper / web server).
echo  Leave all three open while you play. Closing any of them stops
echo  that part -- close this window last, or not at all.
echo.
echo  Play:  http://127.0.0.1:8788/crash.html
echo  Admin: http://127.0.0.1:8788/dev-panel.html
echo ========================================================
pause
