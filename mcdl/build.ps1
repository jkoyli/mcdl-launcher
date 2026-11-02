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
# javac 会把「使用了未经检查或不安全的操作」这类提示写到 stderr。
# 若让 stderr 直接流出去：$ErrorActionPreference='Stop' 会把它当终止错误（编译成功却中断），
# 外层 shell 也会把整个脚本判为失败。这里把 javac 的输出收进来再用 Write-Host 原样打印，
# 提示仍然可见，但不再污染错误流；退出码单独判断。
$previousEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$javacLog = & javac -encoding UTF-8 --release 17 -d $out $files 2>&1
$javacExit = $LASTEXITCODE
$ErrorActionPreference = $previousEap
$javacLog | ForEach-Object { Write-Host $_ }
if ($javacExit -ne 0) { throw "javac 失败（退出码 $javacExit）" }

& jar --create --file $jar --main-class mcdl.Main -C $out .
if ($LASTEXITCODE -ne 0) { throw "jar 打包失败（退出码 $LASTEXITCODE）" }


Write-Host "完成：$jar ($([math]::Round((Get-Item $jar).Length / 1KB, 1)) KB)"




