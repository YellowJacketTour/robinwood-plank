@echo off
setlocal
cd /d "%~dp0"

set "POSTGRES_DB=plank"
set "POSTGRES_USER=plankapp"
set "POSTGRES_PASSWORD=planklocaldev"
set "PLANK_DB_PORT=54329"

echo Stopping local Robinwood PostgreSQL container...
docker compose -f docker-compose.inmotion.yml stop postgres
echo.
echo Data volume was NOT deleted. Your local profiles remain saved.
pause
