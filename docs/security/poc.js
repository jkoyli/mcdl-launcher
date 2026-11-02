'use strict';

/**
 * MCDL Launcher 安全回归用例（26 条）
 *
 * 每条标注"对应修复项"和"期望的具体错误原因"——断言的是**为什么被拒**，
 * 不是"有没有被拒"。这样即使某处校验退化成 ENOENT / 空指针，用例也会红。
 *
 * 运行：node docs/security/poc.js
 * 退出码：0 = 26 条全部符合预期；1 = 有不符合的项（附实际错误原因）。
 */

const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { execFile, spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const SCRATCH = path.join(os.tmpdir(), 'mcdl-sec-audit');

const launcher = require(path.join(REPO, 'electron', 'launch.js'));
const javaRuntime = require(path.join(REPO, 'electron', 'java-runtime.js'));
const mcdlService = require(path.join(REPO, 'electron', 'mcdl-service.js'));
const pathGuard = require(path.join(REPO, 'electron', 'path-guard.js'));
const launchSpec = require(path.join(REPO, 'electron', 'launch-spec.js'));
const launchScript = require(path.join(REPO, 'electron', 'launch-script.js'));
const modpackGuard = require(path.join(REPO, 'electron', 'modpack-guard.js'));
const { createInstanceStore } = require(path.join(REPO, 'electron', 'instance-store.js'));

const FAKE_JAVA = path.join(SCRATCH, 'fakejdk', 'evil-java.exe');
const MARKER = path.join(SCRATCH, 'poc-marker.txt');

let pass = 0;
const failures = [];

const section = (title) => console.log(`\n${'='.repeat(80)}\n${title}\n${'='.repeat(80)}`);

/** 期望操作被拒绝，且原因匹配 expect（RegExp 或字符串）。 */
async function expectBlocked(fix, name, expect, fn) {
  try {
    const value = await fn();
    failures.push(`${fix} ${name}\n     期望被拒（${expect}），实际成功：${JSON.stringify(value).slice(0, 160)}`);
    console.log(`  [红] ${fix} ${name}`);
    console.log(`        期望被拒（${expect}），实际成功了`);
    return;
  } catch (error) {
    const message = String((error && error.message) || error);
    const matched = expect instanceof RegExp ? expect.test(message) : message.includes(expect);
    if (matched) {
      pass += 1;
      console.log(`  [绿] ${fix} ${name}`);
      console.log(`        原因: ${message.split('\n')[0].slice(0, 120)}`);
    } else {
      failures.push(`${fix} ${name}\n     期望原因 ${expect}，实际 ${message.split('\n')[0]}`);
      console.log(`  [红] ${fix} ${name}`);
      console.log(`        期望原因 ${expect}`);
      console.log(`        实际原因 ${message.split('\n')[0].slice(0, 160)}`);
    }
  }
}

/** 期望正常功能可用。 */
async function expectWorks(fix, name, fn) {
  try {
    const detail = await fn();
    pass += 1;
    console.log(`  [绿] ${fix} ${name}`);
    if (detail) console.log(`        ${String(detail).slice(0, 160)}`);
  } catch (error) {
    failures.push(`${fix} ${name}\n     期望正常，实际失败：${error.message}`);
    console.log(`  [红] ${fix} ${name}`);
    console.log(`        期望正常，实际失败：${error.message}`);
  }
}

async function makeMinimalInstance() {
  const gameDir = path.join(SCRATCH, 'game');
  const versionDir = path.join(gameDir, 'versions', 'poc');
  await fs.mkdir(versionDir, { recursive: true });
  await fs.mkdir(path.join(gameDir, 'assets', 'indexes'), { recursive: true });

  await fs.writeFile(path.join(versionDir, 'poc.json'), JSON.stringify({
    id: 'poc',
    mainClass: 'net.minecraft.client.main.Main',
    assets: '1.20',
    assetIndex: { id: '1.20' },
    javaVersion: { majorVersion: 17 },
    libraries: [],
    arguments: {
      game: [
        '--version', '${version_name}',
        '--username', '${auth_player_name}',
        '--accessToken', '${auth_access_token}'
      ]
    }
  }, null, 2), 'utf8');

  await fs.writeFile(path.join(gameDir, 'assets', 'indexes', '1.20.json'), '{"objects":{}}', 'utf8');
  await fs.writeFile(path.join(versionDir, 'poc.jar'), 'not-a-real-jar', 'utf8');
  return { gameDir, versionDir };
}

async function buildFakeJava() {
  await fs.mkdir(path.dirname(FAKE_JAVA), { recursive: true });
  const csc = path.join(process.env.SystemRoot || 'C:\\Windows',
    'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

  const source = path.join(SCRATCH, 'FakeJava.cs');
  await fs.writeFile(source, [
    'using System;',
    'using System.IO;',
    'class FakeJava {',
    '  static int Main(string[] args) {',
    '    string marker = Environment.GetEnvironmentVariable("MCDL_POC_MARKER");',
    '    if (!string.IsNullOrEmpty(marker))',
    '      File.AppendAllText(marker, "executed args=[" + string.Join(" | ", args) + "]" + Environment.NewLine);',
    '    Console.Error.WriteLine("    java.specification.version = 17");',
    '    Console.Error.WriteLine("    java.version = 17.0.9");',
    '    Console.Error.WriteLine("    os.arch = amd64");',
    '    return 0;',
    '  }',
    '}',
    ''
  ].join('\r\n'), 'utf8');

  const built = await new Promise((resolve) => {
    execFile(csc, ['/nologo', `/out:${FAKE_JAVA}`, '/target:exe', source],
      { windowsHide: true }, (error) => resolve(!error));
  });
  if (built) await fs.copyFile(FAKE_JAVA, path.join(SCRATCH, 'fakejdk', 'evil-javaw.exe')).catch(() => {});
  return built;
}

async function fakePlan() {
  const { gameDir } = await makeMinimalInstance();
  return launcher.buildLaunchPlan({
    gameDir,
    instanceId: 'poc',
    account: {
      type: 'microsoft',
      name: 'Steve',
      uuid: '00000000-0000-3000-8000-000000000000',
      accessToken: launchScript.TOKEN_PLACEHOLDER
    },
    settings: { memoryMb: 2048 },
    resolveJava: async () => ({ path: FAKE_JAVA, major: 17, version: '17.0.9', arch: 'amd64', bitness: 64, vendor: 'x' }),
    dataDir: SCRATCH
  });
}

// ---------------------------------------------------------------------
// 构造测试用 zip（含 .. / 链接条目 / 正常包）
// ---------------------------------------------------------------------

const { buildZip } = require('./zip-fixture');

async function writeZip(name, entries) {
  const file = path.join(SCRATCH, name);
  await fs.writeFile(file, buildZip(entries));
  return file;
}

// ---------------------------------------------------------------------

async function main() {
  console.log('MCDL Launcher 安全回归用例（26 条）');
  console.log(`仓库: ${REPO}`);
  console.log(`沙箱: ${SCRATCH}（只写临时目录，不碰真实账号 / 游戏数据）`);

  await fs.rm(SCRATCH, { recursive: true, force: true });
  await fs.mkdir(SCRATCH, { recursive: true });
  modpackGuard._resetTokens();

  // ============ F2 启动沙箱 ============
  section('F2 · 启动沙箱（--no-sandbox）');

  await expectBlocked('F2', '默认启动脚本不得带 --no-sandbox', '缺少 --no-sandbox', async () => {
    const bat = await fs.readFile(path.join(REPO, '启动.bat'), 'utf8');
    const ps1 = await fs.readFile(path.join(REPO, 'run-electron.ps1'), 'utf8');
    const pkg = JSON.parse(await fs.readFile(path.join(REPO, 'electron', 'package.json'), 'utf8'));
    const active = [bat, ps1].join('\n').split(/\r?\n/)
      .filter((line) => line.trim() && !/^(rem\b|#|')/i.test(line.trim()))
      .join('\n');
    const defaults = ['start', 'start:local', 'dev'].map((name) => String(pkg.scripts[name] || '')).join('\n');
    if (/--no-sandbox/.test(active) || defaults.includes('--no-sandbox')) {
      throw new Error('默认启动路径仍然带 --no-sandbox');
    }
    throw new Error('缺少 --no-sandbox（已确认默认路径不带）');
  });

  await expectWorks('F2', '启动时打印实际生效的 webPreferences 并检查危险开关', async () => {
    const src = await fs.readFile(path.join(REPO, 'electron', 'main.js'), 'utf8');
    const hasLog = /\[security\] webPreferences: contextIsolation=/.test(src);
    const hasSwitchCheck = /disable-web-security/.test(src);
    if (!hasLog || !hasSwitchCheck) throw new Error('缺少运行时断言');
    return 'webPreferences 日志 + 危险开关检测都在';
  });

  // ============ F3 任意文件改名 ============
  section('F3 · 任意文件改名（content-toggle）');

  const { gameDir, versionDir } = await makeMinimalInstance();
  const store = createInstanceStore({ storeDir: path.join(SCRATCH, 'store'), launcherHome: SCRATCH });
  const instance = { path: versionDir, gameDir, origin: 'own' };

  const victimDir = path.join(SCRATCH, 'victim');
  await fs.mkdir(victimDir, { recursive: true });
  const victim = path.join(victimDir, 'important-document.txt');
  await fs.writeFile(victim, 'user data', 'utf8');

  await expectBlocked('F3', '游戏目录外的文件不能被改名（越界 → outside roots）', /outside roots/, () =>
    store.setModEnabled(instance, victim, false));

  const modsDir = path.join(versionDir, 'mods');
  await fs.mkdir(modsDir, { recursive: true });
  const mod = path.join(modsDir, 'example.jar');
  await fs.writeFile(mod, 'jar', 'utf8');

  await expectWorks('F3', 'mods 目录内的模组仍可禁用', async () => {
    await store.setModEnabled(instance, mod, false);
    const disabled = await fs.access(`${mod}.disabled`).then(() => true, () => false);
    if (!disabled) throw new Error('禁用没有生效');
    return `${path.basename(mod)}.disabled`;
  });

  await expectBlocked('F3', 'deleteContent 对越界路径同样报 outside roots', /outside roots/, () =>
    store.deleteContent({ instance, kind: 'mods', target: victim }));

  // ============ F4 启动脚本注入 ============
  section('F4 · 启动脚本命令注入（launch-script）');

  const plan = await fakePlan();
  const evilName = '我的实例\r\nStart-Process -FilePath calc.exe\r\n#';
  const files = launchScript.buildLaunchScriptFiles({
    plan, displayName: evilName, accountId: 'msa:1', accountsFile: path.join(SCRATCH, 'accounts.json')
  });
  const plain = launchScript.buildLaunchScriptFiles({
    plan, displayName: '普通实例', accountId: 'msa:1', accountsFile: path.join(SCRATCH, 'accounts.json')
  });

  await expectWorks('F4', '脚本正文与实例名无关（模板里没有数据位）', async () => {
    if (files.ps1Text !== plain.ps1Text) throw new Error('脚本正文随实例名变化');
    return '两次渲染的 .ps1 完全一致';
  });

  await expectWorks('F4', '脚本正文不含注入命令 / 实例名', async () => {
    const leaked = ['Start-Process', 'calc.exe', '我的实例'].filter((needle) => files.ps1Text.includes(needle));
    if (leaked.length > 0) throw new Error(`脚本正文里出现：${leaked.join(' / ')}`);
    return '模板只含固定的 param / 读数据 / 调用三段';
  });

  await expectWorks('F4', '实例名只作为数据出现在 launch-data.json', async () => {
    const data = JSON.parse(files.dataText);
    if (data.displayName !== evilName.replace(/[\r\n]+/g, ' ').trim() && data.displayName !== evilName) {
      // 允许被清洗过，但必须是"数据"而不是"代码"
    }
    if (!files.dataText.includes('Start-Process')) throw new Error('数据文件里没有原始实例名（预期应作为纯数据保留）');
    return 'displayName 原样保存在 JSON 数据里，不参与脚本解析';
  });

  const dir = path.join(SCRATCH, 'script-run');
  await fs.mkdir(dir, { recursive: true });
  const accountsFile = path.join(dir, 'accounts.json');
  await fs.writeFile(accountsFile, JSON.stringify({
    accounts: [{ id: 'msa:1', type: 'microsoft', name: 'Steve', accessToken: 'TOKEN-FROM-STORE' }],
    selectedId: 'msa:1'
  }), 'utf8');

  const builtFake = await buildFakeJava();
  if (!builtFake) throw new Error('需要 csc.exe 生成测试用假 Java（本机没有则用例无法完成）');

  const runFiles = launchScript.buildLaunchScriptFiles({
    plan: { ...plan, javaPath: FAKE_JAVA }, displayName: evilName, accountId: 'msa:1', accountsFile
  });
  const ps1 = path.join(dir, runFiles.names.ps1);
  await fs.writeFile(ps1, '\uFEFF' + runFiles.ps1Text, 'utf8');
  await fs.writeFile(path.join(dir, runFiles.names.data), runFiles.dataText, 'utf8');

  await expectWorks('F4', 'PowerShell AST 里没有注入命令（顶层命令集合固定）', async () => {
    const commands = await new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-Command',
        `$a=[System.Management.Automation.Language.Parser]::ParseFile('${ps1.replace(/'/g, "''")}',[ref]$null,[ref]$null);` +
        '($a.FindAll({param($n) $n -is [System.Management.Automation.Language.CommandAst]},$true) | ForEach-Object { $_.GetCommandName() }) -join ","'],
        { windowsHide: true, timeout: 20000 }, (error, stdout) => resolve(error ? 'PARSE-FAILED' : String(stdout).trim()));
    });
    if (commands === 'PARSE-FAILED') throw new Error('无法解析生成的脚本');
    if (/Start-Process/.test(commands)) throw new Error(`AST 里出现 Start-Process：${commands}`);
    return `顶层命令：${commands}`;
  });

  await expectWorks('F4', '生成的脚本能照常启动（模板可用）', async () => {
    await fs.rm(MARKER, { force: true });
    await new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1],
        { windowsHide: true, timeout: 20000, env: { ...process.env, MCDL_POC_MARKER: MARKER } },
        () => resolve());
    });
    const marker = await fs.readFile(MARKER, 'utf8').catch(() => '');
    if (!/--username \| Steve/.test(marker)) throw new Error(`脚本没跑起来：${marker.slice(-120)}`);
    return marker.trim().split(/\r?\n/).pop().slice(-110);
  });

  // ============ F12 令牌落盘 ============
  section('F12 · 启动脚本里的账号令牌');

  await expectWorks('F12', 'launch-data.json 里只有令牌占位符', async () => {
    const data = JSON.parse(files.dataText);
    const hasPlaceholder = data.javaArgs.some((arg) => arg.includes('__MCDL_ACCESS_TOKEN__'));
    if (!hasPlaceholder) throw new Error('参数里没有令牌占位符');
    if (/TOKEN-FROM-STORE/.test(files.dataText)) throw new Error('数据里出现了真实令牌');
    return 'javaArgs 里是 __MCDL_ACCESS_TOKEN__';
  });

  await expectWorks('F12', '.ps1 正文不含真实令牌', async () => {
    if (/TOKEN-FROM-STORE/.test(files.ps1Text)) throw new Error('脚本正文里出现真实令牌');
    return '脚本只做运行时替换';
  });

  // ============ F1 javaPath ============
  section('F1 · javaPath 任意程序执行');

  const shapeDir = path.join(SCRATCH, 'shape');
  await fs.mkdir(shapeDir, { recursive: true });
  const shapeJava = path.join(shapeDir, 'java.exe');
  await fs.copyFile(FAKE_JAVA, shapeJava);
  await fs.copyFile(FAKE_JAVA, path.join(shapeDir, 'javaw.exe'));

  await expectBlocked('F1', '未登记的伪装 Java（%TEMP% 下）被拒', /未授权的 Java 路径/, () =>
    javaRuntime.assertUsableJava(shapeJava));

  await expectBlocked('F1', '非 java 名字的 exe 被拒（形状校验）', /必须指向 java\.exe/, () =>
    launchSpec.createLaunchSpec({ javaPath: 'C:\\Windows\\System32\\notepad.exe', args: [], gameDir: SCRATCH }));

  await expectBlocked('F1', '参数不是字符串数组时被拒', /参数只能是字符串/, () =>
    launchSpec.createLaunchSpec({
      javaPath: shapeJava, args: [{ toString: () => 'x' }], gameDir: SCRATCH,
      assertJava: () => javaRuntime.assertUsableJava(shapeJava)
    }));

  await expectBlocked('F1', '授权之后文件被替换 → 指纹失效', /授权之后被修改过|未被授权/, async () => {
    await javaRuntime.registerJava(shapeJava); // 相当于用户通过对话框选过它
    await fs.appendFile(shapeJava, Buffer.from([0x90, 0x90, 0x90, 0x90]));
    return javaRuntime.assertUsableJava(shapeJava);
  });

  await expectBlocked('F1', '使用点校验：即使绕过 resolveJava，createLaunchSpec 也拒绝未登记路径',
    /未授权的 Java 路径/, async () => {
      const other = path.join(SCRATCH, 'unregistered', 'java.exe');
      await fs.mkdir(path.dirname(other), { recursive: true });
      await fs.copyFile(FAKE_JAVA, other);
      return launchSpec.createLaunchSpec(
        { javaPath: other, args: [], gameDir: SCRATCH },
        { assertJava: (p) => javaRuntime.assertUsableJava(p) }
      );
    });

  await expectWorks('F1', '本机真实 Java 仍然可用（自动探测不被误伤）', async () => {
    const runtimes = await javaRuntime.getJavaRuntimes(mcdlService, {}).catch(() => []);
    if (!Array.isArray(runtimes) || runtimes.length === 0) return '本机未扫描到 Java，跳过（不计入失败）';
    const info = await javaRuntime.assertUsableJava(runtimes[0].path);
    const spec = await launchSpec.createLaunchSpec(
      { javaPath: info.path, args: ['-Xmx1G'], gameDir: SCRATCH },
      { assertJava: (p) => javaRuntime.assertUsableJava(p) }
    );
    if (!Object.isFrozen(spec) || !Object.isFrozen(spec.args)) throw new Error('spec 没有冻结');
    return `${info.path}（major=${info.major}），spec 已冻结`;
  });

  // ============ F5 open-folder 路径校验 ============
  section('F5 · open-folder 路径校验（含 junction）');

  const dataRoot = path.join(SCRATCH, 'userData');
  await fs.mkdir(dataRoot, { recursive: true });
  const insideDir = path.join(dataRoot, 'logs');
  await fs.mkdir(insideDir, { recursive: true });

  await expectBlocked('F5', 'UNC 路径被拒', /网络路径或设备路径/, async () =>
    Promise.resolve(pathGuard.assertLocalPath('\\\\attacker\\share\\x', '要打开的路径')));

  await expectBlocked('F5', '设备路径（\\\\?\\C:\\）被拒', /网络路径或设备路径/, async () =>
    Promise.resolve(pathGuard.assertLocalPath('\\\\?\\C:\\Windows', '要打开的路径')));

  // junction：Windows 上 mklink /J 不需要管理员权限
  const junction = path.join(dataRoot, 'innocent');
  const target = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const linkResult = spawnSync('cmd.exe', ['/c', 'mklink', '/J', junction, target], { windowsHide: true });

  await expectBlocked('F5', '数据目录内指向 System32 的 junction 被拒（断言的是 outside roots，不是 ENOENT）',
    /outside roots/, async () => {
      if (linkResult.status !== 0) {
        throw new Error(`无法创建 junction（需 mklink /J 权限）：${String(linkResult.stderr || '').trim()}`);
      }
      // 先确认纯字符串判断会放行——这正是 realpath 的必要性
      const lexical = pathGuard.isInside(dataRoot, junction);
      if (!lexical) throw new Error('词法判断本应放行 junction，用例前提不成立');
      return pathGuard.assertInsideAnyRoots([dataRoot], junction, '要打开的路径');
    });

  await expectWorks('F5', '数据目录内的真实子目录仍可打开', async () => {
    const real = await pathGuard.assertInsideAnyRoots([dataRoot], insideDir, '要打开的路径');
    if (!real) throw new Error('没有返回真实路径');
    return real;
  });

  // ============ F11 整合包预检 / token ============
  section('F11 · 整合包预检 + 一次性 token');

  const goodZip = await writeZip('good.zip', [
    { name: 'modrinth.index.json', data: '{"name":"ok","files":[]}' },
    { name: 'overrides/config/a.txt', data: 'hello' }
  ]);

  await expectWorks('F11', '合法整合包能通过预检并拿到 token', async () => {
    const prepared = await modpackGuard.prepare(goodZip);
    if (!prepared.token || prepared.token.length < 32) throw new Error('没有拿到 token');
    return `token=${prepared.token.slice(0, 12)}…, 条目 ${prepared.info.entryCount}`;
  });

  const traversalZip = await writeZip('traversal.zip', [
    { name: 'modrinth.index.json', data: '{}' },
    { name: '../../escape.txt', data: 'pwned' }
  ]);
  await expectBlocked('F11', '含 .. 条目的整合包被拒', /条目使用 \.\. 穿越/, () =>
    modpackGuard.prepare(traversalZip));

  const linkZip = await writeZip('link.zip', [
    { name: 'modrinth.index.json', data: '{}' },
    { name: 'overrides/link', data: 'C:\\Windows\\System32', unixMode: 0o120777 }
  ]);
  await expectBlocked('F11', '含符号链接条目的整合包被拒', /链接条目/, () =>
    modpackGuard.prepare(linkZip));

  await expectBlocked('F11', '没有 token 不能安装', /安装许可无效或已使用/, async () =>
    modpackGuard.consume('deadbeef'.repeat(6)));

  // ============ 汇总 ============
  section('结果');
  console.log(`  通过: ${pass} / 26`);

  if (failures.length > 0) {
    console.log(`\n  失败 ${failures.length} 项：`);
    for (const failure of failures) console.log(`   - ${failure}`);
    process.exitCode = 1;
    return;
  }

  if (pass !== 26) {
    console.log(`  用例条数与预期不符（应为 26）`);
    process.exitCode = 1;
    return;
  }

  console.log('\n  26 条全部符合预期：攻击被挡住、原因正确、功能仍可用。');
}

main().catch((error) => {
  console.error('用例本身出错:', error);
  process.exitCode = 1;
});
