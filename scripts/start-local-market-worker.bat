@echo off
cd /d "%~dp0.."
title Marketplank live sync fabric

:loop
echo [%date% %time%] Running bounded multichain fabric tick...
call npx tsx --env-file=.env.local scripts/mesh-tick.ts --limit=6
echo [%date% %time%] Tick complete. Next pass in 120 seconds.
timeout /t 120 /nobreak >nul
goto loop
