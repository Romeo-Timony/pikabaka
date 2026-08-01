@echo off
setlocal
cd /d "%~dp0"
title Fuck HR
echo Starting Fuck HR...
where pnpm >nul 2>&1
if errorlevel 1 (
  echo pnpm not found. Make sure Node.js/npm is installed and in PATH.
  pause
  exit /b 1
)
call pnpm.cmd start
if errorlevel 1 (
  echo.
  echo Failed to start.
  pause
)