@echo off
setlocal
cd /d "%~dp0"

set "POSTGRES_DB=plank"
set "POSTGRES_USER=plankapp"
set "POSTGRES_PASSWORD=planklocaldev"
set "PLANK_DB_PORT=54329"

echo.
echo === PostgreSQL container ===
docker compose -f docker-compose.inmotion.yml ps postgres
echo.

echo === PlankSpace profiles ===
docker compose -f docker-compose.inmotion.yml exec -T postgres psql -U plankapp -d plank -c "SELECT handle, display_name, moderation_status, left(wallet,10)||'...' AS wallet FROM plankspace_profiles ORDER BY handle;"
echo.

echo === PlankSpace row counts ===
docker compose -f docker-compose.inmotion.yml exec -T postgres psql -U plankapp -d plank -c "SELECT 'profiles' AS item, count(*) FROM plankspace_profiles UNION ALL SELECT 'posts', count(*) FROM plankspace_posts UNION ALL SELECT 'relations', count(*) FROM plankspace_profile_relations UNION ALL SELECT 'comments', count(*) FROM plankspace_profile_comments;"
echo.

pause
