#Requires -Version 5.1
<#
.SYNOPSIS
    启动 mcdl-launcher 的 Electron UI。

.DESCRIPTION
    在 mcdl-launcher/electron 中启动 Electron。依赖缺失时会先执行 npm install。
    默认直连启动，不需要单独安装 mcdl。

.PARAMETER Dev
    打开 DevTools（相当于 electron --dev）。

.PARAMETER EnableGpu
    不设置 MCDL_DISABLE_GPU。默认使用软件渲染以规避部分 Windows GPU 子进程崩溃。

.EXAMPLE
    .\run-electron.ps1
    .\run-electron.ps1 -Dev
    .\run-electron.ps1 -EnableGpu
#>
param(
    [switch]$Dev,
    [switch]$EnableGpu
)

$ErrorActionPreference = 'Stop'
# 默认软件渲染：当前 Windows/Electron 组合在部分机器上 GPU 子进程会直接崩溃。
# 需要硬件加速时显式加 -EnableGpu。
if (-not $EnableGpu -and -not $env:MCDL_DISABLE_GPU) {
    $env:MCDL_DISABLE_GPU = '1'
}
$root = $PSScriptRoot
$appDir = Join-Path $root 'electron'
$electron = Join-Path $appDir 'node_modules\electron\dist\electron.exe'
$mcdlJar = Join-Path $root 'mcdl\mcdl.jar'

if (-not (Test-Path $mcdlJar)) {
    throw "找不到内置 mcdl：$mcdlJar。请先运行 mcdl\build.ps1，或恢复 mcdl.jar。"
}

if (-not (Test-Path $electron)) {
    Write-Host "Electron 依赖缺失，正在 electron\ 中执行 npm install …" -ForegroundColor Yellow
    Push-Location $appDir
    try {
        & npm.cmd install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) {
            throw "npm install 失败（exit $LASTEXITCODE）"
        }

        # 某些 npm 配置会跳过 postinstall，导致只有 electron 包、没有 dist\electron.exe。
        if (-not (Test-Path $electron)) {
            $installer = Join-Path $appDir 'node_modules\electron\install.js'
            if (-not (Test-Path $installer)) {
                throw "Electron 二进制缺失，且找不到 install.js"
            }
            & node $installer
            if ($LASTEXITCODE -ne 0 -or -not (Test-Path $electron)) {
                throw "Electron 二进制安装失败"
            }
        }
    } finally {
        Pop-Location
    }
}

$arguments = @('--no-stdio-init', '--no-sandbox', '.')
if ($Dev) {
    $arguments += '--dev'
}

Write-Host "Electron: $electron" -ForegroundColor DarkGray
Write-Host "App     : $appDir" -ForegroundColor DarkGray
Write-Host "MCDL    : $mcdlJar" -ForegroundColor DarkGray

Start-Process -FilePath $electron -ArgumentList $arguments -WorkingDirectory $appDir | Out-Null
