@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title PR Portal Inspector - Portable Launcher
call "%~dp0Env-Setup.bat"
echo Shared files folder: %PORTABLE_ARIBA_FILES%

if not exist "%NODE_EXE%" (
  echo [1/3] Preparing portable Node.js in the shared folder...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%APP_DIR%First-Run-Setup.ps1" -NodeRoot "%NODE_DIR%" -NodeVersion "%NODE_VERSION%"
  if errorlevel 1 goto :failed
)
if not exist "%NODE_EXE%" (
  echo Portable Node.js was not found after setup.
  goto :failed
)

rem npm packages are cached per unique dependency set and linked into this app folder.
set "DEP_HASH="
for /f "delims=" %%H in ('node scripts\dep-hash.js') do set "DEP_HASH=%%H"
if not defined DEP_HASH goto :failed
set "MODULES_DIR=%PORTABLE_ARIBA_FILES%\modules\%DEP_HASH%"
if not exist "%MODULES_DIR%\" mkdir "%MODULES_DIR%"
if not exist "%MODULES_DIR%\.ready" (
  echo [2/3] Installing application packages into the shared folder. This may take a few minutes...
  copy /y "%APP_DIR%package.json" "%MODULES_DIR%\package.json" >nul
  pushd "%MODULES_DIR%"
  call "%NPM_CMD%" install --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    popd
    echo Package installation failed. Check internet access and try again.
    goto :failed
  )
  popd
  if not exist "%MODULES_DIR%\node_modules\express\package.json" goto :dependenciesFailed
  if not exist "%MODULES_DIR%\node_modules\playwright\package.json" goto :dependenciesFailed
  if not exist "%MODULES_DIR%\node_modules\xlsx\package.json" goto :dependenciesFailed
  if not exist "%MODULES_DIR%\node_modules\exceljs\package.json" goto :dependenciesFailed
  echo ready>"%MODULES_DIR%\.ready"
) else (
  echo [2/3] Application packages already in the shared folder - reusing them.
)

rem Link this app's node_modules to the shared copy. A plain rmdir removes only a link; a real old folder is deleted below.
rmdir "%APP_DIR%node_modules" >nul 2>nul
if exist "%APP_DIR%node_modules" rmdir /s /q "%APP_DIR%node_modules" >nul 2>nul
mklink /J "%APP_DIR%node_modules" "%MODULES_DIR%\node_modules" >nul
if errorlevel 1 (
  echo Could not link shared packages; installing a local copy instead.
  call "%NPM_CMD%" install --omit=dev --no-audit --no-fund
  if errorlevel 1 goto :failed
)

echo [3/3] Checking Playwright Chromium in the shared folder...
if not exist "%APP_DIR%node_modules\.bin\playwright.cmd" (
  echo Playwright package was not installed correctly.
  goto :failed
)
call "%APP_DIR%node_modules\.bin\playwright.cmd" install chromium
if errorlevel 1 (
  set "CHROMIUM_FOUND="
  for /d %%D in ("%BROWSER_DIR%\chromium-*") do if exist "%%~fD" set "CHROMIUM_FOUND=1"
  if not defined CHROMIUM_FOUND (
    echo Chromium installation failed. Check internet access and proxy settings.
    goto :failed
  )
  echo Could not check for a newer Chromium; continuing with the one already downloaded.
)

if exist "%APP_DIR%runtime\node\node.exe" echo Note: the old "runtime" and "browsers" folders in this app folder are no longer used and can be deleted to save space.

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
