@echo off
setlocal
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo [setup] Installing dependencies...
  call npm.cmd install
  if errorlevel 1 (
    echo [error] npm install failed.
    pause
    exit /b 1
  )

  rem Some npm configurations skip postinstall; fetch the Electron binary explicitly.
  if not exist "node_modules\electron\dist\electron.exe" (
    if exist "node_modules\electron\install.js" (
      echo [setup] Installing Electron binary...
      call node "node_modules\electron\install.js"
      if errorlevel 1 (
        echo [error] Electron binary install failed.
        pause
        exit /b 1
      )
    )
  )
)

echo [start] Launching Electron in development mode...
set ELECTRON_ENABLE_LOGGING=1
if not defined MCDL_DISABLE_GPU set MCDL_DISABLE_GPU=1
call npm.cmd run dev

endlocal
