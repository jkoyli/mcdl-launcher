# 编译 MCDL：输出 build\classes 与 mcdl.jar
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$src = Join-Path $root 'src'
$out = Join-Path $root 'build\classes'
$jar = Join-Path $root 'mcdl.jar'

if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Force $out | Out-Null

$files = Get-ChildItem $src -Recurse -Filter *.java | ForEach-Object { $_.FullName }
Write-Host "编译 $($files.Count) 个源文件…"
& javac -encoding UTF-8 --release 17 -d $out $files
if ($LASTEXITCODE -ne 0) { throw "javac 失败（退出码 $LASTEXITCODE）" }

& jar --create --file $jar --main-class mcdl.Main -C $out .
if ($LASTEXITCODE -ne 0) { throw "jar 打包失败（退出码 $LASTEXITCODE）" }

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (Test-Path $csc) {
    & $csc /nologo /target:winexe "/out:$root\McdlDialog.exe" "$root\native\McdlDialog.cs"
    if ($LASTEXITCODE -ne 0) { throw "csc 失败（退出码 $LASTEXITCODE）" }
    Write-Host "完成：McdlDialog.exe"
} else {
    Write-Host '警告：未找到 csc.exe，跳过 McdlDialog.exe'
}

Write-Host "完成：$jar ($([math]::Round((Get-Item $jar).Length / 1KB, 1)) KB)"
