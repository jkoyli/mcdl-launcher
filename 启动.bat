@echo off
setlocal
cd /d "%~dp0electron"

if not exist "..\mcdl\mcdl.jar" (
    echo [error] Missing embedded downloader: ..\mcdl\mcdl.jar
    pause
    exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
    echo [setup] Installing Electron dependencies...
    call npm.cmd install --no-audit --no-fund
    if errorlevel 1 (
        echo [error] npm install failed.
        pause
        exit /b 1
    )

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

if not exist "node_modules\electron\dist\electron.exe" (
    echo [error] Electron binary is missing.
    pause
    exit /b 1
)

rem Software rendering is the default; remove this line to try GPU acceleration.
if not defined MCDL_DISABLE_GPU set MCDL_DISABLE_GPU=1

start "" "node_modules\electron\dist\electron.exe" --no-stdio-init --no-sandbox .
endlocal
