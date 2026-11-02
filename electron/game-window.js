'use strict';

/**
 * 检测「游戏窗口真的出现了」。
 *
 * 为什么需要这一步：spawn 只代表 Java 进程被创建，Minecraft 还要解压资源、初始化
 * LWJGL、加载模组，几秒到几分钟之后才会建出窗口。启动进度弹窗如果在这之前就关掉，
 * 用户会盯着一个什么都没有的桌面，以为启动失败——而这正是「失败路径」的一种：
 * 界面先给了「已启动」的成功信号，实际还没起来。
 *
 * 判定依据（Windows）：
 *   `Get-Process -Id <pid> | Select MainWindowHandle` 非 0 即该进程已经有一个
 *   可见的顶层窗口。javaw.exe 的 MainWindowHandle 就是 Minecraft 的游戏窗口。
 *   为了避免每 400ms 拉起一次 PowerShell，这里只起**一个**长驻 PowerShell 子进程，
 *   由它自己轮询并把 `ready` / `gone` / `timeout` 写回 stdout。
 *
 * 非 Windows 没有等价的零依赖手段，退化为「用日志里的已知标记判断」，
 * 判断不出来就按超时处理（不假装成功）。
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const IS_WINDOWS = process.platform === 'win32';

/** 轮询间隔：400ms 足够快，又不会把 CPU 打满。 */
const POLL_INTERVAL_MS = 400;

/** 默认最多等 3 分钟：大型整合包 + 光影首次加载可能接近这个量级。 */
const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * 日志里的「窗口快出来了」标记。只用于没有窗口句柄可查的平台。
 * 都挑的是原版 / 常见加载器在窗口创建前后会打印的行。
 */
const WINDOW_LOG_MARKERS = [
  /Setting user:/i,
  /Backend library: LWJGL/i,
  /Created: .*atlas/i,
  /Sound engine started/i,
  /Reloading ResourceManager/i,
  /LWJGL Version/i
];

/** 把 watcher 子进程输出的一行翻译成结论。导出是为了能单独测。 */
function interpretWatcherLine(line) {
  const text = String(line || '').trim().toLowerCase();
  if (!text) return null;
  if (text === 'ready') return 'ready';
  if (text === 'gone') return 'gone';
  if (text === 'timeout') return 'timeout';
  return null;
}

/** 日志行是否足以判定「游戏窗口已经出现」（非 Windows 的退路）。 */
function looksLikeGameWindowLine(line) {
  const text = String(line || '');
  if (!text) return false;
  return WINDOW_LOG_MARKERS.some((pattern) => pattern.test(text));
}

function powershellPath() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * Windows 轮询脚本。只用 Get-Process，不依赖任何第三方模块。
 *
 * 数值直接内联进脚本、整体用 `-EncodedCommand` 传过去：
 * 走 `-Command <脚本> -TargetPid 123` 时，PowerShell 在转发原生命令行参数时会把脚本里的
 * 双引号吃掉（`WriteLine("gone")` 变成 `WriteLine(gone)`），脚本直接语法错误。
 * 用 base64(UTF-16LE) 传参既没有引号问题，也不用担心参数绑定。
 */
function watcherScript(pid, timeoutMs, intervalMs) {
  const target = Math.max(1, Math.round(Number(pid) || 0));
  const timeout = Math.max(1000, Math.round(Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  const interval = Math.max(50, Math.round(Number(intervalMs) || POLL_INTERVAL_MS));

  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$targetPid = ${target}`,
    `$deadline = [DateTime]::UtcNow.AddMilliseconds(${timeout})`,
    'while ([DateTime]::UtcNow -lt $deadline) {',
    '  $proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue',
    "  if (-not $proc) { [Console]::Out.WriteLine('gone'); exit 0 }",
    "  if ($proc.MainWindowHandle -ne 0) { [Console]::Out.WriteLine('ready'); exit 0 }",
    `  Start-Sleep -Milliseconds ${interval}`,
    '}',
    "[Console]::Out.WriteLine('timeout')",
    ''
  ].join('\r\n');
}

/** PowerShell 的 -EncodedCommand 要求 UTF-16LE 的 base64。 */
function encodeCommand(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64');
}

/**
 * 监听一个游戏进程的窗口。
 *
 * @param {number} pid
 * @param {{
 *   timeoutMs?: number,
 *   onReady?: (detail: object) => void,
 *   onGone?: () => void,
 *   onTimeout?: () => void,
 *   onLogLine?: (line: string) => void
 * }} [options]
 * @returns {{ stop: () => void, promise: Promise<'ready'|'gone'|'timeout'|'cancelled'> }}
 */
function watchGameWindow(pid, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const useLogFallback = options.useLogFallback === undefined ? !IS_WINDOWS : Boolean(options.useLogFallback);
  const startedAt = Date.now();

  let resolveOutcome;
  const promise = new Promise((resolve) => {
    resolveOutcome = resolve;
  });

  let settled = false;
  let child = null;
  let timer = null;
  let sawLogMarker = false;

  const finish = (outcome) => {
    if (settled) return;
    settled = true;
    if (timer) clearInterval(timer);
    timer = null;
    if (child) {
      try { child.kill(); } catch { /* 已经退出 */ }
      child = null;
    }
    resolveOutcome(outcome);
  };

  /** 由启动器在收到游戏输出时调用（仅在没有窗口句柄可查时才有意义）。 */
  const noteLogLine = (line) => {
    // Windows 上有可靠的窗口句柄可查，就不拿日志猜——「Setting user:」这类行
    // 在窗口建出来之前就会打印，按它判定等于又提前宣布成功。
    if (useLogFallback === false) return;
    if (settled || sawLogMarker) return;
    if (!looksLikeGameWindowLine(line)) return;
    sawLogMarker = true;
    if (options.onReady) options.onReady({ elapsedMs: Date.now() - startedAt, viaLog: true });
    finish('ready');
  };

  if (!pid) {
    // 拿不到 pid（理论上不会发生）：3 秒后按「未知」收场，不假装窗口出现了。
    timer = setTimeout(() => finish('timeout'), Math.min(3000, timeoutMs));
    return { stop: () => finish('cancelled'), promise, noteLogLine };
  }

  if (IS_WINDOWS) {
    try {
      child = spawn(powershellPath(), [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', encodeCommand(watcherScript(pid, timeoutMs, POLL_INTERVAL_MS))
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (error) {
      child = null;
      console.warn('[game-window] could not start watcher:', error.message);
    }

    if (child) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        for (const line of String(chunk).split(/\r?\n/)) {
          const outcome = interpretWatcherLine(line);
          if (outcome === 'ready') {
            options.onReady && options.onReady({ elapsedMs: Date.now() - startedAt });
            finish('ready');
          } else if (outcome === 'gone') {
            options.onGone && options.onGone();
            finish('gone');
          } else if (outcome === 'timeout') {
            options.onTimeout && options.onTimeout({ elapsedMs: Date.now() - startedAt });
            finish('timeout');
          }
        }
      });
      child.on('error', (error) => {
        console.warn('[game-window] watcher failed:', error.message);
        finish('timeout');
      });
      child.on('close', () => {
        // 子进程没给结论就退出了（被杀 / PowerShell 起不来）：不要让等待悬空。
        if (!settled) finish('timeout');
      });
      return { stop: () => finish('cancelled'), promise, noteLogLine };
    }
  }

  // 非 Windows（或 watcher 起不来）：退化为日志标记 + 超时。
  timer = setTimeout(() => finish('timeout'), timeoutMs);
  return {
    stop: () => finish('cancelled'),
    promise,
    noteLogLine
  };
}

module.exports = {
  IS_WINDOWS,
  DEFAULT_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  WINDOW_LOG_MARKERS,
  interpretWatcherLine,
  looksLikeGameWindowLine,
  watcherScript,
  encodeCommand,
  watchGameWindow
};
