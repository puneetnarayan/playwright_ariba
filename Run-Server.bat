@echo off
cd /d "%~dp0"
set "PLAYWRIGHT_BROWSERS_PATH=%~dp0browsers"
set "PATH=%~dp0runtime\node;%PATH%"
"%~dp0runtime\node\node.exe" server.js
