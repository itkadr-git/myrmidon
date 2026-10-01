@echo off
rem Host launcher for Windows. Keeps the node runtime resolution out of the
rem native messaging manifest. No arguments are accepted: the host speaks only
rem Chrome native messaging over stdio.
setlocal
set "HOST_DIR=%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo node not found in PATH 1>&2
  exit /b 1
)
node "%HOST_DIR%..\dist\index.js"
endlocal
