@echo off
setlocal
cd /d "%~dp0"

echo.
echo ============================================================
echo   RobinWood + PlankSpace local environment
echo   Shared PostgreSQL - same storage path as plank.love
echo ============================================================
echo.

where docker >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Docker was not found.
  echo Install/start Docker Desktop, then run this file again.
  echo.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found.
  pause
  exit /b 1
)

REM Local-only credentials. These are NOT production credentials.
set "POSTGRES_DB=plank"
set "POSTGRES_USER=plankapp"
set "POSTGRES_PASSWORD=planklocaldev"
set "PLANK_DB_PORT=54329"

REM These are the exact variables Robinwood lib/postgres.ts consumes.
set "DURABLE_KV_BACKEND=postgres"
set "PGHOST=127.0.0.1"
set "PGPORT=54329"
set "PGDATABASE=plank"
set "PGUSER=plankapp"
set "PGPASSWORD=planklocaldev"
set "PGSSLMODE=disable"
set "PGPOOL_MAX=4"

echo [1/4] Starting Robinwood PostgreSQL...
docker compose -f docker-compose.inmotion.yml up -d postgres
if errorlevel 1 goto :fail

echo.
echo [2/4] Waiting for PostgreSQL health check...
set /a tries=0
:waitpg
set /a tries+=1
docker compose -f docker-compose.inmotion.yml exec -T postgres pg_isready -U plankapp -d plank >nul 2>nul
if not errorlevel 1 goto :pgready
if %tries% GEQ 30 (
  echo [ERROR] PostgreSQL did not become ready.
  goto :fail
)
timeout /t 1 /nobreak >nul
goto :waitpg

:pgready
echo PostgreSQL is ready.

echo.
echo [3/4] Running Robinwood + PlankSpace migrations...
npm run db:migrate
if errorlevel 1 goto :fail

echo.
echo [CHECK] Canonical PlankSpace profiles currently in shared storage:
docker compose -f docker-compose.inmotion.yml exec -T postgres psql -U plankapp -d plank -c "SELECT handle, display_name, left(wallet,10)||'...' AS wallet FROM plankspace_profiles ORDER BY handle;" 2>nul
if errorlevel 1 (
  echo [WARN] Could not print profile list, but migrations completed.
)

echo.
echo [4/4] Starting Next.js...
echo.
echo Open:
echo   http://localhost:3000/plankspace
echo.
echo Press Ctrl+C to stop Next.js.
echo The PostgreSQL container intentionally remains running so your
echo local PlankSpace profiles/posts persist between dev sessions.
echo.
npm run dev
exit /b %errorlevel%

:fail
echo.
echo ============================================================
echo Setup failed. Copy the error above into ChatGPT.
echo ============================================================
pause
exit /b 1
