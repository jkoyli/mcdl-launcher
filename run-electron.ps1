#Requires -Version 5.1
<#
.SYNOPSIS
    启动 mcdl-launcher 的 Electron UI。

.DESCRIPTION
    在 mcdl-launcher/electron 中启动 Electron。依赖缺失时会先执行 npm install。
    默认直连启动，不需要单独安装 mcdl。

.PARAMETER Dev
    打开 DevTools（相当于 electron --dev）。

.PARAMETER SoftwareRender
    强制软件渲染（等价于设置 MCDL_RENDER=software）。默认使用硬件加速；
    如果 GPU 子进程崩溃，主进程会自动记录并以下次启动改用软件渲染。

.PARAMETER EnableGpu
    强制硬件加速（等价于设置 MCDL_RENDER=gpu），忽略崩溃标记。
    保留该参数是为了兼容旧用法。

.EXAMPLE
    .\run-electron.ps1
    .\run-electron.ps1 -Dev
    .\run-electron.ps1 -SoftwareRender
#>
param(
    [switch]$Dev,
    [switch]$SoftwareRender,
    [switch]$EnableGpu
)

$ErrorActionPreference = 'Stop'

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

# 不带 --no-sandbox：那个参数会关掉整个 Chromium 进程沙箱，webPreferences.sandbox
# 也随之失效（见 docs/security-audit.md · F2）。排查问题时再临时手动追加。
$arguments = @('--no-stdio-init', '.')
if ($Dev) {
    $arguments += '--dev'
}
if ($SoftwareRender) {
    $arguments += '--software-render'
}
if ($EnableGpu) {
    $env:MCDL_RENDER = 'gpu'
}

Write-Host "Electron: $electron" -ForegroundColor DarkGray
Write-Host "App     : $appDir" -ForegroundColor DarkGray
Write-Host "MCDL    : $mcdlJar" -ForegroundColor DarkGray

Start-Process -FilePath $electron -ArgumentList $arguments -WorkingDirectory $appDir | Out-Null
