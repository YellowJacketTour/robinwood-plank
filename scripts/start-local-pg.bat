@echo off
REM Portable Postgres 17 used by Marketplank local hub (port 55556).
REM Must not run as Administrator -- postgres.exe refuses High IL.
REM REAL INCIDENT 2026-08-23: this previously pointed into a Claude Code
REM SESSION scratchpad Temp folder, which is not durable -- the OS/session
REM lifecycle cleaned up part of the binary directory (pg_ctl.exe, the lib/
REM folder) between sessions, taking Postgres offline with no warning.
REM Moved both the binaries and the real data directory to a permanent,
REM session-independent location under the user's own profile so this
REM class of outage cannot happen again.
set "PGBIN=C:\Users\k1rby\pg-local\pgsql\bin"
set "PGDATA=C:\Users\k1rby\pg-local\pg-data"
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
