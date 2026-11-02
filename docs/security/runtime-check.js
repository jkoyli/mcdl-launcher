'use strict';

/**
 * 运行时边界自检（需要 electron 依赖已安装）
 *
 * 静态检查（audit.js）证明"代码里写了校验"，这个脚本证明"运行时真的生效"：
 *   1. 页面在 CSP 下正常渲染、preload 桥可用
 *   2. IPC 能通——即 assertAppWindow 的 senderFrame 校验没有误杀正常调用
 *   3. shell:open-external 只吃 http(s)
 *   4. CSP 能挡住 XSS 真正会用的两种落地形态：内联 <script> 和内联 onerror=
 *
 * 运行：node docs/security/runtime-check.js
 * 说明：会临时启动一个自己的 Electron 实例（--multi-instance），跑完就关掉，
 *       不影响已经在运行的启动器。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { writeGoodPack } = require('./zip-fixture');

const APP_DIR = path.resolve(__dirname, '..', '..', 'electron');
const EXE = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = Number(process.env.MCDL_CHECK_PORT) || 9333;
const SMOKE_DIR = path.join(os.tmpdir(), 'mcdl-sec-smoke');

let goodPack = '';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findPage() {
  for (let i = 0; i < 40; i += 1) {
    await sleep(400);
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await response.json();
      const page = targets.find((item) => item.type === 'page' && /index\.html/.test(item.url));
      if (page) return page;
    } catch {
      // 还没起来，继续等
    }
  }
  return null;
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
}

function makeEvaluator(ws) {
  let seq = 0;
  const pending = new Map();

  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    pending.get(message.id)(message);
    pending.delete(message.id);
  });

  return (expression) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (message) => {
      if (message.error) return reject(new Error(JSON.stringify(message.error)));
      if (message.result && message.result.exceptionDetails) {
        return resolve(`EXCEPTION:${message.result.exceptionDetails.text}`);
      }
      return resolve(message.result && message.result.result && message.result.result.value);
    });
    ws.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true }
    }));
  });
}

async function main() {
  if (!require('node:fs').existsSync(EXE)) {
    console.error(`找不到 electron：${EXE}（先在 electron/ 里 npm install）`);
    process.exitCode = 1;
    return;
  }

  const child = spawn(EXE, [
    '--no-stdio-init', '--multi-instance', `--remote-debugging-port=${PORT}`, '.'
  ], { cwd: APP_DIR, windowsHide: true, stdio: 'ignore' });

  goodPack = await writeGoodPack(SMOKE_DIR).catch(() => '');

  const checks = [];
  try {
    const page = await findPage();
    if (!page) throw new Error('没有找到渲染页面（启动失败？）');

    const ws = await connect(page.webSocketDebuggerUrl);
    const evaluate = makeEvaluator(ws);

    const dom = await evaluate('document.querySelectorAll("*").length');
    checks.push(['页面已渲染', Number(dom) > 200, `元素 ${dom} 个`]);

    const bridge = await evaluate('typeof window.launcherAPI?.getInstanceInfo === "function"');
    checks.push(['preload 桥可用', bridge === true]);

    const instances = await evaluate(
      'window.launcherAPI.getInstanceInfo()'
        + '.then((r) => JSON.stringify({ ok: true, count: r.instances.length }))'
        + '.catch((e) => "ERR:" + e.message)'
    );
    checks.push(['IPC 能通（senderFrame 校验没误杀）', String(instances).startsWith('{'), instances]);

    const external = await evaluate(
      'window.launcherAPI.openExternal("file:///C:/Windows/System32/calc.exe")'
        + '.then(() => "ALLOWED").catch(() => "BLOCKED")'
    );
    checks.push(['openExternal 拒绝 file://', external === 'BLOCKED', external]);

    const inlineScript = await evaluate(
      'new Promise((resolve) => { window.__poc = 0;'
        + ' const s = document.createElement("script"); s.textContent = "window.__poc = 1";'
        + ' document.body.appendChild(s);'
        + ' setTimeout(() => resolve(window.__poc === 1 ? "ALLOWED" : "BLOCKED"), 60); })'
    );
    checks.push(['CSP 挡住内联 <script>', inlineScript === 'BLOCKED', inlineScript]);

    const inlineHandler = await evaluate(
      'new Promise((resolve) => { window.__poc2 = 0;'
        + ' const img = document.createElement("img");'
        + ' img.setAttribute("onerror", "window.__poc2 = 1"); img.src = "x-invalid.png";'
        + ' document.body.appendChild(img);'
        + ' setTimeout(() => { img.remove(); resolve(window.__poc2 === 1 ? "ALLOWED" : "BLOCKED"); }, 120); })'
    );
    checks.push(['CSP 挡住内联 onerror=', inlineHandler === 'BLOCKED', inlineHandler]);

    // ---------- 功能冒烟（合入前必跑：安全修复不能误伤功能） ----------
    const instanceList = await evaluate(
      'window.launcherAPI.getInstanceInfo()'
        + '.then((r) => JSON.stringify({ count: r.instances.length, first: (r.instances[0] || {}).id || "" }))'
        + '.catch((e) => "ERR:" + e.message)'
    );
    const parsed = String(instanceList).startsWith('{') ? JSON.parse(instanceList) : { count: 0, first: '' };
    checks.push(['冒烟 · 实例列表可用', parsed.count > 0, `${parsed.count} 个实例`]);

    checks.push(['冒烟 · preload 暴露了自定义 Java 对话框入口',
      (await evaluate('typeof window.launcherAPI.pickJava === "function"')) === true]);

    if (process.env.MCDL_SMOKE_OPEN_FOLDER === '1' && parsed.first) {
      const opened = await evaluate(
        `window.launcherAPI.openInstanceFolder({ instanceId: ${JSON.stringify(parsed.first)} })`
          + '.then((r) => "OPENED:" + r.path).catch((e) => "ERR:" + e.message)'
      );
      // 会真的弹一个资源管理器窗口——这正是"打开文件夹没被误伤"的证据。
      checks.push(['冒烟 · open-folder 对已登记实例仍能打开', String(opened).startsWith('OPENED:'), opened]);
    } else if (parsed.first) {
      console.log('  [跳过] 冒烟 · open-folder（设 MCDL_SMOKE_OPEN_FOLDER=1 才真的弹资源管理器）');
    }

    if (goodPack) {
      const prepared = await evaluate(
        `window.launcherAPI.prepareModpack(${JSON.stringify(goodPack)})`
          + '.then((r) => JSON.stringify({ token: Boolean(r && r.token), entries: r && r.entryCount }))'
          + '.catch((e) => "ERR:" + e.message)'
      );
      const packOk = String(prepared).startsWith('{') && JSON.parse(prepared).token === true;
      checks.push(['冒烟 · 合法整合包能过预检并拿到 token', packOk, prepared]);

      const forged = await evaluate(
        'window.launcherAPI.installModpack({ token: "forged-token", name: "" })'
          + '.then(() => "ALLOWED").catch((e) => "BLOCKED:" + e.message)'
      );
      checks.push(['冒烟 · 伪造 token 不能安装', String(forged).startsWith('BLOCKED'), forged]);
    }

    const badJava = await evaluate(
      `window.launcherAPI.saveSettings({ javaPath: ${JSON.stringify(process.execPath)} })`
        + '.then(() => "SAVED").catch((e) => "REJECTED:" + e.message)'
    );
    checks.push(['冒烟 · 未授权的 javaPath 写不进设置', String(badJava).startsWith('REJECTED'), badJava]);

    ws.close();
  } finally {
    child.kill();
    await sleep(400);
  }

  let failed = 0;
  console.log('');
  for (const [name, ok, detail] of checks) {
    console.log(`  ${ok ? '[通过]' : '[失败]'} ${name}`);
    if (!ok) {
      failed += 1;
      console.log(`         实际: ${String(detail).slice(0, 200)}`);
    } else if (detail && detail !== true) {
      console.log(`         ${String(detail).slice(0, 160)}`);
    }
  }

  console.log(`\n  失败项: ${failed}`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('运行时自检失败:', error.message);
  process.exitCode = 1;
});
