@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or is not on PATH.
  echo Install Node.js to use live PoE Tools pricing.
  pause
  exit /b 1
)
node server.js
pause
