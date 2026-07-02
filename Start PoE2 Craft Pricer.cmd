@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or is not on PATH.
  echo Install Node.js first - the app is a local server (node server.js), there is no static fallback.
  pause
  exit /b 1
)
node server.js
pause
