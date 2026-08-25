@echo off
cd /d "%~dp0.."
title Marketplank :3800
netstat -ano | findstr ":3800" | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo Next already listening on 3800
  exit /b 0
)
npx next dev -p 3800
exit /b %ERRORLEVEL%
