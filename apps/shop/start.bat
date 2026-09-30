@echo off
REM  Sri Nachiya Medicals — starts the shop's billing app on this computer.
REM  Double-click this file, or let Windows start it when the PC switches on.
title Sri Nachiya Medicals - do not close this window

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node is not installed on this computer.
  echo   Install Node ^(LTS^) from the installer given with this folder, then run this file again.
  echo.
  pause
  exit /b 1
)

cd /d "%~dp0"
start "" http://localhost:8123
node server.js

echo.
echo   The app has stopped. Close this window, then run start.bat again.
pause
