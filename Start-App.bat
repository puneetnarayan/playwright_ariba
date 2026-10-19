@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title PR Portal Inspector - Portable Launcher
set "APP_DIR=%~dp0"
set "NODE_DIR=%APP_DIR%runtime\node"
set "NODE_EXE=%NODE_DIR%\node.exe"
set "NPM_CMD=%NODE_DIR%\npm.cmd"
rem Make the portable runtime discoverable to npm and Playwright command shims.
set "PATH=%NODE_DIR%;%PATH%"
set "BROWSER_DIR=%APP_DIR%browsers"
set "PLAYWRIGHT_BROWSERS_PATH=%BROWSER_DIR%"

if not exist "%NODE_EXE%" (
  echo [1/3] Preparing portable Node.js inside this folder...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%APP_DIR%First-Run-Setup.ps1"
  if errorlevel 1 goto :failed
)
if not exist "%NODE_EXE%" (
  echo Portable Node.js was not found after setup.
  goto :failed
)

rem Re-run npm install when a newer version adds packages (e.g. exceljs).
if not exist "%APP_DIR%node_modules\exceljs\package.json" del "%APP_DIR%.dependencies-ready" >nul 2>nul
if not exist "%APP_DIR%.dependencies-ready" (
  echo [2/3] Installing application packages locally. This may take a few minutes...
  call "%NPM_CMD%" install --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    echo Package installation failed. Check internet access and try again.
    goto :failed
  )
  if not exist "%APP_DIR%node_modules\express\package.json" goto :dependenciesFailed
  if not exist "%APP_DIR%node_modules\playwright\package.json" goto :dependenciesFailed
  if not exist "%APP_DIR%node_modules\xlsx\package.json" goto :dependenciesFailed
  if not exist "%APP_DIR%node_modules\exceljs\package.json" goto :dependenciesFailed
  echo ready>"%APP_DIR%.dependencies-ready"
)

set "CHROMIUM_FOUND="
for /d %%D in ("%BROWSER_DIR%\chromium-*") do if exist "%%~fD" set "CHROMIUM_FOUND=1"
if not defined CHROMIUM_FOUND (
  echo [3/3] Installing Playwright Chromium into this application folder...
  if not exist "%APP_DIR%node_modules\.bin\playwright.cmd" (
    echo Playwright package was not installed correctly.
    goto :failed
  )
  rem Use the app-local Node.js from PATH; never rely on globally installed Node.js.
  call "%APP_DIR%node_modules\.bin\playwright.cmd" install chromium
  if errorlevel 1 (
    echo Chromium installation failed. Check internet access and proxy settings.
    goto :failed
  )
)

rem Check whether the local server is already running before starting another instance.
set "SERVER_RUNNING="
where curl.exe >nul 2>nul
if not errorlevel 1 curl.exe -fsS http://127.0.0.1:3030/api/status >nul 2>nul && set "SERVER_RUNNING=1"
if not defined SERVER_RUNNING (
  echo Starting local inspector server...
  start "PR Portal Inspector Server" /min "%APP_DIR%Run-Server.bat"
  timeout /t 3 /nobreak >nul
)
start "" http://127.0.0.1:3030
exit /b 0

:dependenciesFailed
echo Required packages are missing after installation.
goto :failed

:failed
echo.
echo Setup could not complete. No global Node.js installation was changed.
echo See README.txt under Troubleshooting, then run Start-App.bat again.
pause
exit /b 1
