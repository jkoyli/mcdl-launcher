'use strict';

/**
 * 「生成启动脚本」的渲染器：**.ps1 是固定模板，数据放在同目录的 launch-data.json 里。**
 *
 * 之前是把实例别名、Java 路径、参数直接拼进 PowerShell 源码，只要别名里带一个换行
 * （`instances:rename` 不拦控制字符）就能把注释行截断，把任意命令写进脚本正文。
 * 现在模板里一个数据字节都没有：别名只进 JSON，再由脚本当数据读出来打印；
 * 参数以数组形式传给 java，不经过任何脚本语言解析。
 *
 * 另外账号令牌不落盘：模板运行时会去启动器的账号数据里读一次令牌，
 * 参数里的占位符在运行时替换。这样生成的脚本即使被转发出去也不含凭据。
 */

const TOKEN_PLACEHOLDER = '__MCDL_ACCESS_TOKEN__';

/** 文件名用固定 ASCII，且只由实例 ID 派生，cmd 里不可能出现元字符。 */
function fileStem(versionId) {
  const cleaned = String(versionId || '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^[._]+/, '')
    .slice(0, 40);
  return cleaned || 'instance';
}

// 固定模板：不含任何实例数据。改这个文件永远不需要因为实例改名而改。
const PS1_TEMPLATE = [
  '# 由 MCDL Launcher 生成，可直接双击运行。',
  '# 这是固定模板：实例名 / Java 路径 / 参数都在同目录的 launch-data.json 里。',
  '# 令牌不落盘，运行时从启动器的账号数据里读。',
  '',
  'param(',
  "  [string]$DataFile = (Join-Path $PSScriptRoot 'launch-data.json')",
  ')',
  '',
  "$ErrorActionPreference = 'Stop'",
  '',
  'if (-not (Test-Path -LiteralPath $DataFile)) {',
  '  Write-Host "找不到启动数据：$DataFile" -ForegroundColor Red',
  "  Read-Host '按 Enter 关闭窗口'",
  '  exit 1',
  '}',
  '',
  '$spec = Get-Content -LiteralPath $DataFile -Raw -Encoding UTF8 | ConvertFrom-Json',
  '',
  "$token = ''",
  "$tokenSource = ''",
  'if ($spec.accountId -and $spec.accountsFile -and (Test-Path -LiteralPath $spec.accountsFile)) {',
  '  try {',
  '    $store = Get-Content -LiteralPath $spec.accountsFile -Raw -Encoding UTF8 | ConvertFrom-Json',
  '    $account = @($store.accounts) | Where-Object { $_.id -eq $spec.accountId } | Select-Object -First 1',
  '    if ($account -and $account.accessToken) {',
  '      $token = [string]$account.accessToken',
  "      $tokenSource = '账号数据'",
  '    }',
  '  } catch {',
  "    $token = ''",
  '  }',
  '}',
  '',
  'if (-not $token) {',
  "  $token = '0'",
  '}',
  "if ($spec.needsToken -and -not $tokenSource) {",
  "  Write-Host '注意：没有读到登录令牌，游戏可能无法登录。请先在启动器里启动一次（启动器会刷新令牌）。' -ForegroundColor Yellow",
  '}',
  '',
  '$javaArgs = @()',
  'foreach ($item in @($spec.javaArgs)) {',
  "  $javaArgs += ([string]$item).Replace('__MCDL_ACCESS_TOKEN__', $token)",
  '}',
  '',
  "Write-Host ('实例：' + $spec.displayName)",
  "Write-Host ('目录：' + $spec.gameDir)",
  '',
  'Set-Location -LiteralPath $spec.gameDir',
  '& $spec.java @javaArgs',
  '',
  "Write-Host ''",
  "Read-Host '按 Enter 关闭窗口'",
  ''
].join('\r\n');

const BAT_TEMPLATE = [
  '@echo off',
  'chcp 65001 >nul',
  'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"',
  ''
].join('\r\n');

/**
 * @param {object} options
 * @param {object} options.plan        buildLaunchPlan() 的返回值
 * @param {string} [options.displayName]
 * @param {string} [options.accountId]
 * @param {string} [options.accountsFile]
 * @returns {{ps1Text:string, batText:string, dataText:string, needsToken:boolean, names:object}}
 */
function buildLaunchScriptFiles({ plan, displayName, accountId, accountsFile }) {
  const args = Array.isArray(plan && plan.args) ? plan.args.map(String) : [];
  const needsToken = args.some((arg) => arg.includes(TOKEN_PLACEHOLDER));

  const data = {
    versionId: String((plan && plan.versionId) || ''),
    displayName: String(displayName || (plan && plan.versionId) || ''),
    gameDir: String((plan && plan.gameDir) || ''),
    java: String((plan && plan.javaPath) || ''),
    javaArgs: args,
    accountId: String(accountId || ''),
    accountsFile: String(accountsFile || ''),
    needsToken,
    generatedAt: new Date().toISOString()
  };

  return {
    ps1Text: PS1_TEMPLATE,
    batText: BAT_TEMPLATE,
    dataText: JSON.stringify(data, null, 2),
    needsToken,
    names: { ps1: 'start.ps1', bat: '启动游戏.bat', data: 'launch-data.json' }
  };
}

module.exports = {
  TOKEN_PLACEHOLDER,
  PS1_TEMPLATE,
  BAT_TEMPLATE,
  fileStem,
  buildLaunchScriptFiles
};
