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

REM Global hub reads Postgres snapshots. Hard reset kills the portable cluster.
REM Postgres refuses to start as Administrator; LIMITED scheduled task if needed.
netstat -ano | findstr ":55556" | findstr "LISTENING" >nul 2>nul
if errorlevel 1 (
  echo Starting local Postgres on 55556...
  call "%~dp0scripts\start-local-pg.bat"
  if errorlevel 1 (
    schtasks /Create /TN "plank-pg-55556" /TR "%~dp0scripts\start-local-pg.bat" /SC ONCE /ST 00:00 /RL LIMITED /F >nul 2>nul
    schtasks /Run /TN "plank-pg-55556" >nul 2>nul
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

echo Starting Marketplank Next on :3800 via LIMITED scheduled task
echo ^(Grok/admin shells kill `start cmd` children; task survives.^)
echo Global hub: http://localhost:3800/market/multichain
echo Native book: http://localhost:3800/market

schtasks /Create /TN "plank-next-3800" /TR "%~dp0scripts\start-local-next.bat" /SC ONCE /ST 00:00 /RL LIMITED /F >nul 2>nul
schtasks /Run /TN "plank-next-3800"
exit /b 0
