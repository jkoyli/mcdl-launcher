'use strict';

/**
 * MCDL Launcher 安全边界静态检查
 *
 * 检查项：
 *   1. 每个 ipcMain.handle 是否校验调用方
 *   2. Electron 窗口 / 会话的加固开关
 *   3. 渲染层 HTML 注入汇聚点（innerHTML 等）
 *   4. preload 暴露面
 *
 * 运行：node docs/security/audit.js
 * 退出码：0 = 没有命中"高危"规则；1 = 命中了（可接进 CI）。
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const mainJs = read(path.join('electron', 'main.js'));
const preload = read(path.join('electron', 'preload.js'));
const html = read(path.join('electron', 'renderer', 'index.html'));
const renderer = read(path.join('electron', 'renderer', 'renderer.js'));
const launchJs = read(path.join('electron', 'launch.js'));

const problems = [];
const lines = [];

const say = (text = '') => { lines.push(text); console.log(text); };
const bad = (id, text) => { problems.push(`${id}: ${text}`); say(`  [高危] ${text}`); };
const warn = (text) => say(`  [提示] ${text}`);
const ok = (text) => say(`  [通过] ${text}`);

// ------------------------------------------------------------------
say('## 1. IPC handler 的调用方校验');
// ------------------------------------------------------------------
const mainLines = mainJs.split(/\r?\n/);
const handlers = [];

for (let index = 0; index < mainLines.length; index += 1) {
  const match = mainLines[index].match(/ipcMain\.handle\(\s*'([^']+)'/);
  if (!match) continue;

  // 从这一行往后做括号匹配，取出 handler 的函数体
  let depth = 0;
  let started = false;
  let body = '';
  for (let i = index; i < mainLines.length; i += 1) {
    const line = mainLines[i];
    body += line;
    for (const ch of line) {
      if (ch === '{') { depth += 1; started = true; }
      else if (ch === '}') depth -= 1;
    }
    if (started && depth === 0) break;
  }

  handlers.push({ name: match[1], line: index + 1, guarded: /assertAppWindow\s*\(/.test(body) });
}

const unguarded = handlers.filter((item) => !item.guarded);
say(`  共 ${handlers.length} 个 handler`);
if (unguarded.length > 0) {
  for (const item of unguarded) bad('IPC-01', `${item.name} (main.js:${item.line}) 没有调用 assertAppWindow`);
} else {
  ok('所有 handler 都调用了 assertAppWindow');
}

if (!/senderFrame/.test(mainJs)) {
  warn('assertAppWindow 只比较 event.sender(webContents)，没有比较 event.senderFrame / origin');
  warn('当前应用不加载远程内容，所以够用；一旦以后在同一窗口里放 iframe / webview，这层就形同虚设');
}

// ------------------------------------------------------------------
say('\n## 2. Electron 加固开关');
// ------------------------------------------------------------------
const hardened = [
  ['contextIsolation: true', /contextIsolation:\s*true/.test(mainJs)],
  ['nodeIntegration: false', /nodeIntegration:\s*false/.test(mainJs)],
  ['sandbox: true', /sandbox:\s*true/.test(mainJs)],
  ['setWindowOpenHandler 拒绝新窗口', /setWindowOpenHandler/.test(mainJs)],
  ['will-navigate 拦截', /on\('will-navigate'/.test(mainJs)]
];
for (const [name, pass] of hardened) {
  if (pass) ok(name);
  else bad('CFG-01', `缺少 ${name}`);
}

const soft = [
  ['will-frame-navigate（子框架导航）', /will-frame-navigate/.test(mainJs)],
  ['web-contents-created 统一兜底', /web-contents-created/.test(mainJs)],
  ['setPermissionRequestHandler', /setPermissionRequestHandler/.test(mainJs)],
  ['Content-Security-Policy', /Content-Security-Policy/i.test(html)]
];
for (const [name, pass] of soft) {
  if (pass) ok(name);
  else warn(`缺少 ${name}`);
}

// CSP 现在是明确要求：缺了就把 XSS 的利用窗口放大到任意时长。
const htmlNoComments = html.replace(/<!--[\s\S]*?-->/g, '');
const cspMatch = htmlNoComments.match(/Content-Security-Policy"[^>]*content="([^"]+)"/i)
  || htmlNoComments.match(/content="([^"]*default-src[^"]*)"/i);

if (!cspMatch) {
  bad('CFG-03', 'index.html 缺少 Content-Security-Policy');
} else {
  const directives = cspMatch[1].replace(/\s+/g, ' ');
  const scriptSrc = (directives.match(/script-src([^;]*)/i) || ['', ''])[1];
  if (/unsafe-(inline|eval)/.test(scriptSrc)) {
    bad('CFG-04', `CSP 的 script-src 里有 unsafe-inline / unsafe-eval：${scriptSrc.trim()}`);
  } else {
    ok(`CSP script-src 是干净的（${scriptSrc.trim()}）`);
  }
}

// --no-sandbox：默认启动路径里出现就报；*troubleshoot* 脚本与注释行不算。
const DEFAULT_SCRIPTS = ['start', 'start:local', 'dev'];

for (const entry of ['启动.bat', path.join('electron', 'dev.cmd'), 'run-electron.ps1']) {
  let content = '';
  try { content = read(entry); } catch { continue; }

  const activeLines = content.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    return trimmed && !/^(rem\b|#|'|::)/i.test(trimmed);
  });

  if (activeLines.some((line) => /--no-sandbox/.test(line))) {
    bad('CFG-02', `${entry} 的启动命令里带 --no-sandbox：Chromium 进程沙箱被整体关掉，webPreferences.sandbox 也随之失效`);
  }
}

try {
  const pkg = JSON.parse(read(path.join('electron', 'package.json')));
  for (const name of DEFAULT_SCRIPTS) {
    const command = String((pkg.scripts || {})[name] || '');
    if (/--no-sandbox/.test(command)) {
      bad('CFG-02', `package.json 的 ${name} 脚本带 --no-sandbox`);
    }
  }
} catch {
  warn('package.json 读取失败，跳过启动脚本检查');
}

// ------------------------------------------------------------------
say('\n## 3. 渲染层 HTML 注入汇聚点');
// ------------------------------------------------------------------
const assignments = [...renderer.matchAll(/([\w$.]+)\.innerHTML\s*=\s*([^;]+);/g)];
say(`  innerHTML 赋值 ${assignments.length} 处`);
let reviewed = 0;
for (const assignment of assignments) {
  const rhs = assignment[2].replace(/\s+/g, ' ').trim();
  const constantEmpty = rhs === "''" || rhs === '""';
  const whitelistedSvg = /^cubeSvg\(preset\)$/.test(rhs) || /^pixelAvatarSvg\(/.test(rhs);
  if (!constantEmpty && !whitelistedSvg) {
    reviewed += 1;
    warn(`${assignment[1]}.innerHTML = ${rhs.slice(0, 60)}（需要人工确认右侧没有任何不可信数据）`);
  }
}
if (reviewed === 0) ok('所有 innerHTML 只用于清空容器或写入白名单里的固定 SVG');

if (/\bfetch\(|XMLHttpRequest/.test(renderer)) {
  warn('渲染进程会自己发网络请求，注意远程数据源');
} else {
  ok('渲染进程不主动发网络请求');
}
if (/<script(?![^>]*src=)/i.test(htmlNoComments)) warn('index.html 里有内联 <script>');
if (/<(iframe|webview)\b/i.test(htmlNoComments)) bad('WEB-01', 'index.html 里有 iframe / webview');
if (/\son[a-z]+\s*=\s*"/i.test(htmlNoComments)) warn('index.html 里有内联事件处理器');

// ------------------------------------------------------------------
say('\n## 4. 高价值 IPC 的入参校验');
// ------------------------------------------------------------------
if (/setModEnabled\(String\(payload\.path/.test(mainJs)) {
  bad('IPC-03', 'instances:content-toggle: payload.path 直达 setModEnabled（应传 instance 做 containment 校验）');
} else {
  ok('content-toggle 把 instance 一起传给 setModEnabled（有越界校验）');
}

const openFolderBlock = (mainJs.match(/ipcMain\.handle\('instances:open-folder'[\s\S]{0,700}?\n  \}\);/ ) || [''])[0];
if (openFolderBlock && !/assertOpenablePath/.test(openFolderBlock)) {
  bad('IPC-04', 'instances:open-folder: 调用方给的 path 没有经过 assertOpenablePath');
} else if (openFolderBlock) {
  ok('open-folder 的 path 走 assertOpenablePath（限定在数据目录 / 游戏目录内）');
}

// writeSettings 现在多了第二个参数（options.trustWallFile），正则不能写死 `patch)`。
// 窗口放宽到 2400 字符，是因为函数前半段多了壁纸字段的归一化与 wallFile 写入闸。
if (!/async function writeSettings\(patch[\s\S]{0,2400}?assertJavaSelection/.test(mainJs)) {
  bad('IPC-05', 'settings:save: 写入 javaPath 前没有 assertJavaSelection 授权校验');
} else {
  ok('settings:save 在落盘前校验 javaPath 授权');
}

if (!/async function resolveJavaRuntime[\s\S]{0,900}?assertUsableJava/.test(mainJs)) {
  bad('IPC-06', 'resolveJavaRuntime: 没有走 assertUsableJava（使用点授权校验）');
} else {
  ok('resolveJavaRuntime 走 assertUsableJava');
}

if (!/createLaunchSpec\(plan,\s*\{[\s\S]{0,200}?assertJava/.test(mainJs)
  && !/createLaunchSpec\(plan,\s*\{[\s\S]{0,200}?assertJava/.test(launchJs)) {
  bad('IPC-09', 'launchInstance 没有把 assertJava 传进 createLaunchSpec（使用点校验缺失）');
} else {
  ok('launchInstance 在 createLaunchSpec 里做使用点授权校验');
}

if (/downloads:install-pack'[\s\S]{0,4000}?String\(payload\.file/.test(mainJs)) {
  bad('IPC-07', 'downloads:install-pack 仍然按路径取整合包');
} else if (/modpackGuard\.consume\(\s*payload/.test(mainJs)) {
  ok('downloads:install-pack 只接受预检产出的 token');
} else {
  bad('IPC-07', 'downloads:install-pack 没有用一次性 token');
}

if (!/modpackGuard\.prepare\(/.test(mainJs)) {
  bad('IPC-10', '整合包没有走 modpack-guard 预检');
} else {
  ok('整合包走 modpack-guard 预检（条目 / 大小 / 链接条目）');
}

if (!/verifyExtractedTree/.test(mainJs)) {
  bad('IPC-11', '整合包解压后没有做结果核对');
} else {
  ok('整合包解压后有 verifyExtractedTree 核对');
}

if (!/assertInsideReal|assertInsideAnyRoots/.test(mainJs)) {
  bad('IPC-12', 'open-folder / content-reveal 没有用 realpath 规范化后的越界判断（junction 可绕过）');
} else {
  ok('open-folder / content-reveal 使用 realpath 判定越界');
}

if (!/function assertAppWindow\(event\)[\s\S]{0,700}?senderFrame/.test(mainJs)) {
  bad('IPC-08', 'assertAppWindow 没有校验 event.senderFrame');
} else {
  ok('assertAppWindow 校验 senderFrame + 来源');
}

// ------------------------------------------------------------------
say('\n## 5. preload 暴露面');
// ------------------------------------------------------------------
const apiNames = [...preload.matchAll(/^\s{2}([A-Za-z]\w*):/gm)].map((match) => match[1]);
say(`  window.launcherAPI 方法数: ${apiNames.length}`);
if (/exposeInMainWorld\(\s*'ipcRenderer'/.test(preload)) bad('PRE-01', 'preload 直接把 ipcRenderer 暴露给了页面');
else ok('没有暴露 ipcRenderer');
if (!/event\.senderFrame/.test(preload)) warn('preload 收到回调时没有过滤 event.senderFrame');

// ------------------------------------------------------------------
say('\n## 结论');
if (problems.length === 0) {
  say('  没有命中高危规则。');
} else {
  say(`  命中 ${problems.length} 条高危规则：`);
  for (const problem of problems) say(`    - ${problem}`);
}

fs.writeFileSync(path.join(__dirname, 'audit-report.txt'), lines.join('\n') + '\n', 'utf8');
say('\n  详细输出已写入 docs/security/audit-report.txt');

process.exitCode = problems.length === 0 ? 0 : 1;
