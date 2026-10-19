@echo off
rem Shared cache locations. Called by Start-App.bat and Run-Server.bat.
rem Big downloads (Node.js, npm packages, Chromium) live in ONE folder so new app versions reuse them.
rem Override with: set PORTABLE_ARIBA_FILES=D:\SomeFolder   (before launching)
set "APP_DIR=%~dp0"
set "NODE_VERSION=v22.16.0"
if not defined PORTABLE_ARIBA_FILES set "PORTABLE_ARIBA_FILES=C:\Portable_ARIBA_Files"
if not exist "%PORTABLE_ARIBA_FILES%\" mkdir "%PORTABLE_ARIBA_FILES%" >nul 2>nul
set "SHARED_OK="
if exist "%PORTABLE_ARIBA_FILES%\" (
  echo ok>"%PORTABLE_ARIBA_FILES%\.write-test" 2>nul && del "%PORTABLE_ARIBA_FILES%\.write-test" >nul 2>nul && set "SHARED_OK=1"
)
if not defined SHARED_OK (
  echo Could not create or write to %PORTABLE_ARIBA_FILES%. Falling back to the app folder.
  set "PORTABLE_ARIBA_FILES=%APP_DIR%shared"
  if not exist "%APP_DIR%shared\" mkdir "%APP_DIR%shared" >nul 2>nul
)
set "NODE_DIR=%PORTABLE_ARIBA_FILES%\node\%NODE_VERSION%"
set "NODE_EXE=%NODE_DIR%\node.exe"
set "NPM_CMD=%NODE_DIR%\npm.cmd"
set "BROWSER_DIR=%PORTABLE_ARIBA_FILES%\browsers"
set "PLAYWRIGHT_BROWSERS_PATH=%BROWSER_DIR%"
set "PATH=%NODE_DIR%;%PATH%"
