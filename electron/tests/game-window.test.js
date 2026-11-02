'use strict';

/**
 * 「游戏窗口真的出现了」的判定测试。
 *
 * 背景：spawn 只代表 Java 进程被创建，游戏还要加载一会儿才有窗口。
 * 启动进度弹窗如果以 spawn 为准关掉，用户会盯着空桌面以为启动失败。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const gameWindow = require('../game-window');

test('interpretWatcherLine：只认三种结论，其它一律忽略', () => {
  assert.equal(gameWindow.interpretWatcherLine('ready'), 'ready');
  assert.equal(gameWindow.interpretWatcherLine('READY\r'), 'ready');
  assert.equal(gameWindow.interpretWatcherLine('  gone '), 'gone');
  assert.equal(gameWindow.interpretWatcherLine('timeout'), 'timeout');
  assert.equal(gameWindow.interpretWatcherLine(''), null);
  assert.equal(gameWindow.interpretWatcherLine('Get-Process : error'), null);
});

test('looksLikeGameWindowLine：识别窗口创建前后的已知日志行', () => {
  assert.equal(gameWindow.looksLikeGameWindowLine('Setting user: Steve'), true);
  assert.equal(gameWindow.looksLikeGameWindowLine('[Render thread/INFO] Backend library: LWJGL version 3.3.1'), true);
  assert.equal(gameWindow.looksLikeGameWindowLine('Created: 1024x512x4 minecraft:textures/atlas/blocks.png-atlas'), true);
  assert.equal(gameWindow.looksLikeGameWindowLine('Sound engine started'), true);

  assert.equal(gameWindow.looksLikeGameWindowLine('[main/INFO] Loading 32 mods'), false);
  assert.equal(gameWindow.looksLikeGameWindowLine(''), false);
});

test('watchGameWindow：进程没有任何窗口就退出时判定 gone，不谎报成功', { skip: !gameWindow.IS_WINDOWS }, async () => {
  // 一个活 1.2 秒、没有窗口的进程：PowerShell 轮询期间应该先看到句柄为 0，再看到进程消失。
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1200)'], { stdio: 'ignore' });
  const t = child;

  try {
    let readyCall = false;
    const watcher = gameWindow.watchGameWindow(child.pid, {
      timeoutMs: 15000,
      onReady: () => { readyCall = true; }
    });

    const outcome = await watcher.promise;
    assert.equal(outcome, 'gone');
    assert.equal(readyCall, false, '没有窗口的进程不能被判成 ready');
  } finally {
    try { child.kill(); } catch { /* 已退出 */ }
    t.removeAllListeners();
  }
});

test('watchGameWindow：拿不到 pid 时给 timeout，不假装窗口出现了', async () => {
  const watcher = gameWindow.watchGameWindow(0, { timeoutMs: 30000 });
  const startedAt = Date.now();
  const outcome = await watcher.promise;
  assert.equal(outcome, 'timeout');
  assert.ok(Date.now() - startedAt >= 2500, '至少要等一小段时间再放弃');
});

test('watcherScript：数值内联且不含双引号（否则 -Command 转发会把引号吃掉）', () => {
  const script = gameWindow.watcherScript(4321, 90000, 400);
  assert.match(script, /Get-Process -Id \$targetPid/);
  assert.match(script, /\$targetPid = 4321/);
  assert.match(script, /AddMilliseconds\(90000\)/);
  assert.match(script, /WriteLine\('ready'\)/);
  assert.ok(!script.includes('"'), '脚本里不能出现双引号');

  const encoded = gameWindow.encodeCommand(script);
  const decoded = Buffer.from(encoded, 'base64').toString('utf16le');
  assert.equal(decoded, script, 'EncodedCommand 必须能解回原脚本');
});

test('watcherScript：非法数值（NaN / 负数 / 0）被规整成安全整数', () => {
  const script = gameWindow.watcherScript('abc', -1, 0);
  assert.match(script, /\$targetPid = 1/);
  // 超时为负 → 兜底到最小值 1 秒；间隔为 0 → 回到默认轮询间隔（0 是非法值，不能忙等）
  assert.match(script, /AddMilliseconds\(1000\)/);
  assert.match(script, /Start-Sleep -Milliseconds 400/);
});

test('watchGameWindow：真实带窗口的进程会被判定 ready（Windows）', { skip: !gameWindow.IS_WINDOWS }, async (t) => {
  // winver 是系统自带、进程自己持有顶层窗口的程序（不像 Windows 11 的 notepad
  // 会先起一个没有窗口的 AppExecutionAlias 存根），用来验证「MainWindowHandle 非 0」
  // 这条判定真的能认出「窗口出现了」。
  const child = spawn('winver.exe', [], { stdio: 'ignore', windowsHide: false });
  try {
    const watcher = gameWindow.watchGameWindow(child.pid, { timeoutMs: 15000 });
    const outcome = await watcher.promise;
    if (outcome !== 'ready') {
      t.skip(`当前环境没能让 winver 建出窗口（${outcome}），跳过`);
      return;
    }
    assert.equal(outcome, 'ready');
  } finally {
    try { child.kill(); } catch { /* 已退出 */ }
  }
});
