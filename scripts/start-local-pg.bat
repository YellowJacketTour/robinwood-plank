@echo off
REM Portable Postgres 17 used by Marketplank local hub (port 55556).
REM Must not run as Administrator — postgres.exe refuses High IL.
set "PGBIN=C:\Users\k1rby\AppData\Local\Temp\claude\c--Users-k1rby-OneDrive-Desktop-SpacePoker\0af330af-4a2c-4f52-b187-0a7965cb6ae0\scratchpad\pg\pgsql\bin"
set "PGDATA=C:\Users\k1rby\AppData\Local\Temp\claude\c--Users-k1rby-OneDrive-Desktop-SpacePoker\0af330af-4a2c-4f52-b187-0a7965cb6ae0\scratchpad\pg-data"
set "PGLOG=%TEMP%\plank-pg.log"
netstat -ano | findstr ":55556" | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo Postgres already listening on 55556
  exit /b 0
)
if not exist "%PGBIN%\pg_ctl.exe" (
  echo pg_ctl not found at %PGBIN%
  exit /b 1
)
"%PGBIN%\pg_ctl.exe" -D "%PGDATA%" -l "%PGLOG%" start
exit /b %ERRORLEVEL%
