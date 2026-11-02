'use strict';

/**
 * 自上传壁纸的运行时自检（L0 数据契约 / L1 协议与安全 / L2 图层 / L3 视频 / L5 降级）
 *
 * 静态检查（audit.js）只能证明"代码里写了校验"，这个脚本证明"运行时真的生效"：
 *   1. mcdl-media:// 三个通道能加载，并被 CSP 放行
 *   2. 图层结构与 CSS 变量（模糊 / 暗化 / 内补边 / 画中画）
 *   3. settings:save 的非法值回落、数值 clamp、wallFile 写入闸
 *   4. 路径穿越与非当前视频路径被拒（403）
 *   5. 视频壁纸双解码：静音 / 循环 / 内外同步漂移
 *   6. 点缩略图切换、删除后回默认、文件丢失回落
 *
 * 运行：node docs/security/wallpaper-check.js
 * 说明：会用临时数据目录（MCDL_USER_DATA）启动一个 --multi-instance 的实例，跑完就关掉，
 *       不碰你正在用的账号与设置。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..', '..', 'electron');
const EXE = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = Number(process.env.MCDL_WALL_PORT) || 9777;
const ROOT = path.join(os.tmpdir(), 'mcdl-wallpaper-check');
/**
 * 1.8s / 320×180 / VP8 的 webm（由 MediaRecorder 录的一段色块动画）。
 * 不放成"运行时现录"：画布流依赖合成器，窗口被挡住时一帧都出不来，自检会假失败。
 */
const SAMPLE_VIDEO = path.join(__dirname, 'fixtures', 'wallpaper-sample.webm');

/** 1×1 PNG：够用来验证"文件头校验 + 缩略图 + <img> 真加载"，不占体积。 */
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let userData = '';
let settingsPath = '';

async function findPage() {
  for (let i = 0; i < 50; i += 1) {
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

function makeClient(ws) {
  let seq = 0;
  const pending = new Map();
  const events = [];

  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) {
      if (message.method) events.push(message);
      return;
    }
    if (!pending.has(message.id)) return;
    pending.get(message.id)(message);
    pending.delete(message.id);
  });

  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (message) => {
      if (message.error) return reject(new Error(JSON.stringify(message.error)));
      return resolve(message.result);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });

  return {
    events,
    send,
    async evaluate(expression) {
      const result = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true
      });
      if (result.exceptionDetails) return `EXCEPTION:${result.exceptionDetails.text}`;
      return result.result && result.result.value;
    }
  };
}

function base64url(value) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/** 直接改 settings.json 再触发一次渲染层刷新（等价于"启动时就带着这份设置"）。 */
async function writeSettingsFile(patch) {
  await fs.writeFile(settingsPath, JSON.stringify(patch, null, 2));
}

async function refreshInRenderer(client) {
  // 画中画开关是最轻的一次真实控件交互：change → saveSettings → wallpaper:list。
  await client.evaluate(`(function () {
    var box = document.getElementById('settingsWallPip');
    if (!box) return false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(1200);
}

async function main() {
  if (!require('node:fs').existsSync(EXE)) {
    console.error(`找不到 electron：${EXE}（先在 electron/ 里 npm install）`);
    process.exitCode = 1;
    return;
  }

  await fs.rm(ROOT, { recursive: true, force: true });
  userData = path.join(ROOT, 'userdata');
  settingsPath = path.join(userData, 'launcher-settings.json');
  const bgRoot = path.join(userData, 'backgrounds');
  await fs.mkdir(path.join(bgRoot, '.thumbs'), { recursive: true });

  const firstImage = 'aaaabbbbcccc-first.png';
  const secondImage = 'ddddeeeeffff-second.png';
  await fs.writeFile(path.join(bgRoot, firstImage), PNG_1x1);
  await fs.writeFile(path.join(bgRoot, secondImage), PNG_1x1);

  await writeSettingsFile({
    wallMode: 'custom',
    wallMedia: 'image',
    wallFile: firstImage,
    wallPolicy: 'single',
    wallBlur: 24,
    wallDim: 40,
    wallInnerFit: 'contain',
    wallPip: true
  });

  const child = spawn(EXE, [
    '--no-stdio-init', '--multi-instance', `--remote-debugging-port=${PORT}`,
    // 自检时窗口常被别的窗口挡住：Chromium 会降频、甚至让 document.hidden 变 true，
    // 视频会被我们自己的 visibilitychange 逻辑暂停。这三条只影响自检进程。
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion',
    '.'
  ], {
    cwd: APP_DIR,
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, MCDL_USER_DATA: userData }
  });

  const checks = [];
  const add = (name, pass, detail) => checks.push([name, Boolean(pass), detail]);

  try {
    const page = await findPage();
    if (!page) throw new Error('渲染页面没起来（启动失败？）');

    const ws = await connect(page.webSocketDebuggerUrl);
    const client = makeClient(ws);
    await client.send('Runtime.enable', {});
    await client.send('Log.enable', {});
    await client.send('Network.enable', {});
    await sleep(2800);

    // ---------- 1. 图层与 CSS 变量 ----------
    const layer = JSON.parse(await client.evaluate(`(function () {
      var layer = document.getElementById('wallLayer');
      var cs = getComputedStyle(layer);
      var inner = document.querySelector('#wallInnerMedia > img');
      return JSON.stringify({
        hidden: layer.hidden,
        blur: cs.getPropertyValue('--wall-blur').trim(),
        dim: cs.getPropertyValue('--wall-dim').trim(),
        innerDim: cs.getPropertyValue('--wall-inner-dim').trim(),
        flat: layer.classList.contains('is-flat'),
        outerImg: document.querySelectorAll('#wallOuter > img').length,
        innerImg: document.querySelectorAll('#wallInnerMedia > img').length,
        fill: !!document.getElementById('wallInnerFill').style.backgroundImage,
        width: inner ? inner.naturalWidth : -1
      });
    })()`));
    add('壁纸图层显示', layer.hidden === false, JSON.stringify(layer));
    add('模糊 / 暗化变量生效', layer.blur === '24px' && layer.dim === '0.400',
      `${layer.blur} / ${layer.dim} / inner ${layer.innerDim}`);
    add('内外各一张图 + 同图虚化补边',
      layer.outerImg === 1 && layer.innerImg === 1 && layer.fill === true, '');
    add('mcdl-media://bg 真加载成功', layer.width === 1, `naturalWidth=${layer.width}`);

    // ---------- 2. 外观页控件 ----------
    const pane = JSON.parse(await client.evaluate(`(function () {
      var list = document.getElementById('wallList');
      return JSON.stringify({
        mode: (document.getElementById('settingsWallMode') || {}).value,
        blockHidden: (document.getElementById('wallCustomBlock') || {}).hidden,
        cards: list ? list.querySelectorAll('.wall-card').length : -1,
        label: (document.getElementById('settingsWallCurrent') || {}).textContent || ''
      });
    })()`));
    add('外观页识别自定义模式', pane.mode === 'custom' && pane.blockHidden === false,
      JSON.stringify(pane));
    add('壁纸库 + 当前壁纸标签', pane.cards === 2 && pane.label.indexOf('first') >= 0,
      `cards=${pane.cards} label=${pane.label}`);

    // ---------- 3. 设置契约 ----------
    const roundTrip = await client.evaluate(`window.launcherAPI.saveSettings({
      wallMode: 'bogus-mode', wallMedia: 'nope', wallPolicy: 'whatever',
      wallInnerFit: 'xxx', wallBlur: 999, wallDim: -5, wallPip: false
    }).then(function (s) { return JSON.stringify({
      wallMode: s.wallMode, wallMedia: s.wallMedia, wallPolicy: s.wallPolicy,
      wallInnerFit: s.wallInnerFit, wallBlur: s.wallBlur, wallDim: s.wallDim,
      wallPip: s.wallPip, wallFile: s.wallFile
    }); }).catch(function (e) { return 'ERR:' + e.message; })`);
    const state = JSON.parse(roundTrip);
    add('非法枚举回落默认',
      state.wallMode === 'default' && state.wallMedia === 'image' &&
      state.wallPolicy === 'single' && state.wallInnerFit === 'contain', roundTrip);
    add('数值 clamp 到区间', state.wallBlur === 40 && state.wallDim === 0, roundTrip);
    add('wallFile 非法不改写', state.wallFile === firstImage, state.wallFile);

    // ---------- 4. 安全边界 ----------
    const guard = await client.evaluate(`window.launcherAPI.saveSettings({
      wallMedia: 'video', wallFile: 'C:\\\\Windows\\\\System32\\\\drivers\\\\etc\\\\hosts.mp4'
    }).then(function () { return 'ALLOWED'; }).catch(function (e) { return 'BLOCKED'; })`);
    add('渲染层不能直接写视频 wallFile', guard === 'BLOCKED', guard);

    const traversal = await client.evaluate(`new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () { resolve('ALLOWED'); };
      img.onerror = function () { resolve('BLOCKED'); };
      img.src = 'mcdl-media://bg/..%5C..%5C..%5Cwindows%5Cwin.ini';
      setTimeout(function () { resolve('TIMEOUT'); }, 2000);
    })`);
    add('bg 路径穿越被拒', traversal === 'BLOCKED', traversal);

    // ---------- 5. 视频双解码 ----------
    const videoPath = path.join(ROOT, 'sample.webm');
    await fs.copyFile(SAMPLE_VIDEO, videoPath);

    await writeSettingsFile({
      wallMode: 'custom', wallMedia: 'video', wallFile: videoPath,
      wallPolicy: 'single', wallBlur: 18, wallDim: 30, wallInnerFit: 'contain', wallPip: true
    });
    await refreshInRenderer(client);
    await sleep(1800);

      const video = JSON.parse(await client.evaluate(`(function () {
        var inner = document.querySelector('#wallInnerMedia > video');
        var outer = document.querySelector('#wallOuter > video');
        var status = document.getElementById('settingsWallStatus');
        return JSON.stringify({
          inner: !!inner, outer: !!outer,
          isVideo: document.getElementById('wallLayer').classList.contains('is-video'),
          hidden: document.getElementById('wallLayer').hidden,
          status: status ? status.textContent : '',
          muted: inner ? inner.muted : null,
          loop: inner ? inner.loop : null,
          paused: inner ? inner.paused : null,
          duration: inner ? inner.duration : -1,
          innerTime: inner ? inner.currentTime : -1,
          outerTime: outer ? outer.currentTime : -1
        });
      })()`));
      add('视频壁纸挂上双 video',
        video.inner && video.outer && video.isVideo && !video.hidden, JSON.stringify(video));
      add('静音 + 循环 + 在播放',
        video.muted === true && video.loop === true && video.paused === false,
        `muted=${video.muted} loop=${video.loop} paused=${video.paused}`);

      // MediaRecorder 产出的 webm 没有 duration 头，Chromium 要先扫到末尾才报得准，
      // 所以这里轮询一会儿再看，别拿首帧时的估算值当结论。
      const durationProbe = JSON.parse(await client.evaluate(`new Promise(function (resolve) {
        var t0 = Date.now();
        (function tick() {
          var v = document.querySelector('#wallInnerMedia > video');
          var d = v ? v.duration : -1;
          if (d > 1 || Date.now() - t0 > 4000) {
            resolve(JSON.stringify({ duration: d, ready: v ? v.readyState : -1 }));
          } else {
            setTimeout(tick, 300);
          }
        })();
      })`));
      add('时长 > 1s（真视频）', Number(durationProbe.duration) > 1,
        `duration=${durationProbe.duration} ready=${durationProbe.ready}`);

      await sleep(2000);
      const drift = JSON.parse(await client.evaluate(`(function () {
        var inner = document.querySelector('#wallInnerMedia > video');
        var outer = document.querySelector('#wallOuter > video');
        return JSON.stringify({
          drift: inner && outer ? Math.abs(inner.currentTime - outer.currentTime) : -1
        });
      })()`));
      add('内外同步漂移 < 0.3s', drift.drift >= 0 && drift.drift < 0.3, JSON.stringify(drift));

      // 非当前视频路径（同目录下另一支）必须被拒
      const otherVideo = path.join(ROOT, 'other.webm');
      await fs.copyFile(SAMPLE_VIDEO, otherVideo);
      const denied = await client.evaluate(`new Promise(function (resolve) {
        var v = document.createElement('video');
        v.muted = true;
        v.onerror = function () { resolve('BLOCKED'); };
        v.onloadedmetadata = function () { resolve('ALLOWED'); };
        v.src = ${JSON.stringify(`mcdl-media://ext/${base64url(otherVideo)}`)};
        document.body.appendChild(v);
        setTimeout(function () { resolve('TIMEOUT'); }, 2500);
      })`);
      add('非当前视频路径被拒', denied === 'BLOCKED', denied);

    // ---------- 6. UI 路径：切换 / 删除 / 丢失 ----------
    const switched = await client.evaluate(`new Promise(function (resolve) {
      var cards = document.querySelectorAll('.wall-card');
      var target = null;
      for (var i = 0; i < cards.length; i += 1) {
        if (cards[i].querySelector('.wall-card__name').textContent.indexOf('second') >= 0) {
          target = cards[i];
        }
      }
      if (!target) { resolve('NO_CARD'); return; }
      target.click();
      setTimeout(function () {
        var active = document.querySelector('.wall-card.is-active .wall-card__name');
        resolve(JSON.stringify({
          active: active ? active.textContent : null,
          hidden: document.getElementById('wallLayer').hidden
        }));
      }, 1500);
    })`);
    const switchedInfo = JSON.parse(switched);
    add('点缩略图能切换当前壁纸',
      String(switchedInfo.active || '').indexOf('second') >= 0 && switchedInfo.hidden === false,
      switched);

    const removed = await client.evaluate(`new Promise(function (resolve) {
      var del = document.querySelector('.wall-card.is-active .wall-card__del');
      if (!del) { resolve('NO_DEL'); return; }
      del.click();
      setTimeout(function () {
        var ok = document.getElementById('confirmOk');
        if (!ok) { resolve('NO_CONFIRM'); return; }
        ok.click();
        setTimeout(function () {
          resolve(JSON.stringify({
            hidden: document.getElementById('wallLayer').hidden,
            mode: (document.getElementById('settingsWallMode') || {}).value,
            hasWallpaper: document.body.classList.contains('has-wallpaper'),
            cards: document.querySelectorAll('.wall-card').length
          }));
        }, 1500);
      }, 400);
    })`);
    const removedInfo = JSON.parse(removed);
    add('删除当前壁纸后回默认样式',
      removedInfo.hidden === true && removedInfo.mode === 'default' &&
      removedInfo.hasWallpaper === false, removed);

    const files = await fs.readdir(bgRoot);
    add('被删的图片文件真的没了',
      files.indexOf(secondImage) === -1 && files.indexOf(firstImage) >= 0, files.join(','));

    await writeSettingsFile({
      wallMode: 'custom', wallMedia: 'image', wallFile: 'gone-file.png',
      wallPolicy: 'single', wallBlur: 18, wallDim: 30, wallInnerFit: 'contain', wallPip: true
    });
    await refreshInRenderer(client);

    const missing = JSON.parse(await client.evaluate(`(function () {
      var status = document.getElementById('settingsWallStatus');
      return JSON.stringify({
        hidden: document.getElementById('wallLayer').hidden,
        hasWallpaper: document.body.classList.contains('has-wallpaper'),
        status: status ? status.textContent : '',
        error: status ? status.classList.contains('is-error') : false
      });
    })()`));
    add('壁纸文件丢失 → 回默认样式 + 提示',
      missing.hidden === true && missing.hasWallpaper === false &&
      missing.error === true && missing.status.indexOf('不见了') >= 0, JSON.stringify(missing));

    // ---------- 7. CSP ----------
    const cspErrors = client.events
      .filter((event) => event.method === 'Log.entryAdded')
      .map((event) => event.params.entry)
      .filter((entry) => /Content Security Policy|Refused to/i.test(entry.text || ''))
      .map((entry) => entry.text);
    add('CSP 无报错', cspErrors.length === 0, cspErrors.join(' | ') || '(none)');
  } catch (error) {
    checks.push(['脚本执行', false, error.message]);
  } finally {
    try {
      child.kill();
    } catch {
      // 已经退出
    }
  }

  let failed = 0;
  for (const [name, pass, detail] of checks) {
    if (!pass) failed += 1;
    console.log(`${pass ? '[通过]' : '[失败]'} ${name}${detail ? '  ← ' + detail : ''}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} 通过`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
