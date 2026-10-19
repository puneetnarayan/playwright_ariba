@echo off
cd /d "%~dp0"
call "%~dp0Env-Setup.bat"
"%NODE_EXE%" server.js
