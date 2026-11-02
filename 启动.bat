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

rem Hardware acceleration is the default. If the GPU process crashes, the app
rem records it and falls back to software rendering on the next launch.
rem Force software rendering:  启动.bat --software-render
rem
rem 不要加 --no-sandbox：它会关掉整个 Chromium 进程沙箱，webPreferences.sandbox
rem 也随之失效（见 docs/security-audit.md · F2）。只在排查问题时临时手动加。
start "" "node_modules\electron\dist\electron.exe" --no-stdio-init . %*
endlocal
