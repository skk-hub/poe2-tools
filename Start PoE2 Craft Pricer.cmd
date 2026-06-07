@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or is not on PATH.
  echo Open index.html for the static page, or install Node.js to use live refresh.
  pause
  exit /b 1
)
node server.js
pause
