'use strict';

// ---------------------------------------------------------
// Electron IPC -> 实例数据渲染
// preload.getInstanceInfo() 返回 { instances, selectedId }，
// updateInstanceUI() 会重新渲染右侧实例列表、当前配置和主视区。
// ---------------------------------------------------------

(function () {
  'use strict';

  var MAX_SCALE = 0.10;     // 最大额外缩放 10%
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  var cta = document.getElementById('cta');
  var ctaBox = document.getElementById('ctaBox');
  var label = cta.querySelector('.label');
  var ring = document.getElementById('ring');
  var pageA = document.getElementById('pageA');
  var pageB = document.getElementById('pageB');
  var hint = document.getElementById('hint');
  var current = 'A';
  var isAnimating = false;
  var isLoading = false;
  var keyboardFocus = false;

  // ---------------------------------------------------------
  // 窗口控制：优先 launcherAPI，其次 Tauri，最后派发自定义事件
  // ---------------------------------------------------------
  function getTauriWindow() {
    var tauri = window.__TAURI__ && window.__TAURI__.window;
    if (!tauri) return null;
    if (typeof tauri.getCurrentWindow === 'function') return tauri.getCurrentWindow();
    if (typeof tauri.getCurrent === 'function') return tauri.getCurrent();
    return tauri.appWindow || null;
  }

  function runWindowAction(action) {
    var api = window.launcherAPI;
    if (api && typeof api[action] === 'function') {
      return api[action]();
    }

    var appWindow = getTauriWindow();
    if (appWindow) {
      if (typeof appWindow[action] === 'function') {
        return appWindow[action]();
      }
      if (action === 'toggleMaximize' && typeof appWindow.isMaximized === 'function') {
        return Promise.resolve(appWindow.isMaximized()).then(function (maximized) {
          return maximized ? appWindow.unmaximize() : appWindow.maximize();
        });
      }
    }

    window.dispatchEvent(new CustomEvent('launcher:window-control', {
      detail: { action: action }
    }));
    return Promise.resolve();
  }

  Array.prototype.forEach.call(document.querySelectorAll('[data-window-action]'), function (button) {
    button.addEventListener('click', function () {
      Promise.resolve(runWindowAction(button.getAttribute('data-window-action'))).catch(function () {});
    });
    // 窗口控制按钮不参与页面的拖拽区
    button.addEventListener('pointerdown', function (event) { event.stopPropagation(); });
  });

  var dragRegion = document.querySelector('.window-drag');
  if (dragRegion) {
    dragRegion.addEventListener('dblclick', function () {
      Promise.resolve(runWindowAction('toggleMaximize')).catch(function () {});
    });
  }

  // L1 标题栏预留按钮：返回 / 刷新 / 关闭当前页 / 帮助
  Array.prototype.forEach.call(document.querySelectorAll('[data-titlebar-action]'), function (button) {
    button.addEventListener('click', function (event) {
      var action = button.getAttribute('data-titlebar-action');

      window.dispatchEvent(new CustomEvent('launcher:titlebar-action', {
        detail: { action: action }
      }));

      if (action === 'back' || action === 'close-page') {
        closeActivePanel({ focus: true });
      }

      if (action === 'refresh') {
        // 改了主进程代码时，页面刷新不会重载 Node 侧；
        // 按住 Shift 点刷新＝整进程重启，避免「新界面 + 旧后端」。
        if (event.shiftKey) {
          var api = window.launcherAPI;
          if (api && typeof api.relaunchApp === 'function') {
            api.relaunchApp().catch(function () {
              window.location.reload();
            });
            return;
          }
        }
        window.location.reload();
        return;
      }

      if (action === 'help') {
        var api = window.launcherAPI;
        if (api && typeof api.openLogFolder === 'function') {
          Promise.resolve(api.openLogFolder()).catch(function (error) {
            console.error('[help] failed to open log folder:', error);
          });
        }
      }
    });
  });

  // 鼠标方向 -> 被钉死的角（对角）
  var ORIGINS = {
    'left-top':    '100% 100%',   // 鼠标左上 -> 钉右下
    'right-top':   '0% 100%',     // 鼠标右上 -> 钉左下
    'left-bottom': '100% 0%',     // 鼠标左下 -> 钉右上
    'right-bottom':'0% 0%'        // 鼠标右下 -> 钉左上
  };

  var MAX_STRETCH = 15;   // 最大拉伸像素
  var CORNER = 9;         // 与按钮一致的圆角（被钉住的角）
  var SHARP = 2;          // 露出那条边的锐利圆角
  var TUCK = 6;           // 大圆角比拉伸量多出的余量，保证缩回本体后面

  function applyStack(nx, ny) {
    var style = ring.style;
    var baseWidth = cta.clientWidth;
    var baseHeight = cta.clientHeight;

    var stretchX = Math.abs(nx) * MAX_STRETCH;
    var stretchY = Math.abs(ny) * MAX_STRETCH;

    // 1) 宽高拉伸
    style.width = (baseWidth + stretchX) + 'px';
    style.height = (baseHeight + stretchY) + 'px';

    // 2) 钉死对角：鼠标在左钉右边，在上钉下边
    var pinRight = nx < 0;
    var pinBottom = ny < 0;
    style.left = pinRight ? 'auto' : '0';
    style.right = pinRight ? '0' : 'auto';
    style.top = pinBottom ? 'auto' : '0';
    style.bottom = pinBottom ? '0' : 'auto';

    // 3) 逐角处理：
    //    两条拉伸边夹住的角 -> 锐利直角，这是真正露出来的棱
    //    只有一条拉伸边的角  -> 圆角略大于该方向拉伸量，刚好缩回本体后面
    //    被钉住的角          -> 与本体一致，藏在按钮圆角下
    var leftStretched = nx < -0.02;
    var rightStretched = nx > 0.02;
    var topStretched = ny < -0.02;
    var bottomStretched = ny > 0.02;
    var maxRadius = Math.min(baseWidth + stretchX, baseHeight + stretchY) * 0.42;

    function cornerRadius(horizontal, vertical) {
      if (horizontal && vertical) return SHARP;
      if (vertical) return Math.min(stretchY + TUCK, maxRadius);
      if (horizontal) return Math.min(stretchX + TUCK, maxRadius);
      return CORNER;
    }

    style.borderTopLeftRadius = cornerRadius(leftStretched, topStretched) + 'px';
    style.borderTopRightRadius = cornerRadius(rightStretched, topStretched) + 'px';
    style.borderBottomLeftRadius = cornerRadius(leftStretched, bottomStretched) + 'px';
    style.borderBottomRightRadius = cornerRadius(rightStretched, bottomStretched) + 'px';

    style.transition = 'width 100ms ease-out, height 100ms ease-out, ' +
      'left 100ms ease-out, right 100ms ease-out, top 100ms ease-out, bottom 100ms ease-out, ' +
      'border-radius 100ms ease-out';
  }
  cta.addEventListener('pointermove', function (event) {
    if (isLoading || reduceMotion.matches) return;
    var rect = cta.getBoundingClientRect();
    var nx = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    var ny = ((event.clientY - rect.top) / rect.height) * 2 - 1;
    nx = Math.max(-1, Math.min(1, nx));
    ny = Math.max(-1, Math.min(1, ny));
    applyStack(nx, ny);
  });

  var RING_STYLE_PROPS = [
    'width', 'height',
    'left', 'right', 'top', 'bottom',
    'borderTopLeftRadius', 'borderTopRightRadius',
    'borderBottomLeftRadius', 'borderBottomRightRadius'
  ];

  // 完全清空 applyStack 写入的行内几何量，回到 .ring 的 CSS 默认值。
  function resetRing() {
    var style = ring.style;
    for (var i = 0; i < RING_STYLE_PROPS.length; i++) {
      style[RING_STYLE_PROPS[i]] = '';
    }
    style.transform = '';
    style.transition = '';
  }

  // 启动 loading：按钮禁用、文案切换、立即复位重影。
  function setLaunchLoading(loading) {
    loading = !!loading;
    if (isLoading === loading) return;

    isLoading = loading;
    cta.disabled = loading;
    cta.classList.toggle('is-loading', loading);
    cta.setAttribute('aria-busy', loading ? 'true' : 'false');
    label.textContent = loading ? '正在启动...' : '启动游戏';

    if (loading) resetRing();
  }

  // 供 Electron / Tauri 侧在 Java 后端返回结果后主动结束 loading。
  window.setLaunchLoading = setLaunchLoading;

  function requestLaunch() {
    var api = window.launcherAPI;
    if (api && typeof api.launchGame === 'function') {
      var selected = getSelectedInstance();
      setLaunchNote('正在准备启动…', false);
      return api.launchGame({ instanceId: selected ? selected.id : null })
        .then(function (result) {
          if (result && result.ok) {
            setLaunchNote(
              '已启动 ' + (result.versionId || '') + ' · Java ' + result.javaMajor + ' · ' + result.memoryMb + ' MB',
              false
            );
          }
          return result;
        })
        .catch(function (error) {
          setLaunchNote(describeLaunchError(error), true);
          throw error;
        });
    }

    // 未接后端时的演示回退；接入后端后由 launchGame 的 Promise 控制 loading 时长。
    window.dispatchEvent(new CustomEvent('launcher:launch-request'));
    return new Promise(function (resolve) {
      window.setTimeout(resolve, 1800);
    });
  }

  var launchNote = document.getElementById('launchNote');

  function setLaunchNote(text, isError) {
    if (!launchNote) return;
    launchNote.textContent = text || '';
    launchNote.classList.toggle('is-error', Boolean(isError));
  }

  function describeLaunchError(error) {
    var raw = error && error.message ? String(error.message) : String(error || '操作失败');
    // Electron 会给 IPC 错误加上 "Error invoking remote method '...': " 前缀。
    raw = raw.replace(/^Error invoking remote method '[^']+':\s*/, '');
    raw = raw.replace(/^Error:\s*/, '');

    var lines = raw.split(/\r?\n/).map(function (line) { return line.trim(); }).filter(Boolean);
    if (lines.length === 0) return '操作失败';
    // 两行的情况是「原因 + 处理建议」，一起展示。
    return lines.length === 1 ? lines[0] : lines[0] + ' ' + lines[1];
  }

  cta.addEventListener('pointerleave', resetRing);
  window.addEventListener('blur', resetRing);

  // 只在 Tab 导航获得焦点时显示虚线；任何鼠标/触控按下都立即撤销。
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Tab') keyboardFocus = true;
  }, true);
  document.addEventListener('pointerdown', function () {
    keyboardFocus = false;
    ctaBox.classList.remove('is-keyboard-focus');
  }, true);
  cta.addEventListener('focus', function () {
    ctaBox.classList.toggle('is-keyboard-focus', keyboardFocus);
  });
  cta.addEventListener('blur', function () {
    keyboardFocus = false;
    ctaBox.classList.remove('is-keyboard-focus');
    resetRing();
  });

  function switchHint() {
    hint.textContent = '点击切换页面 · ' + current + ' → ' + (current === 'A' ? 'B' : 'A');
  }

  // 把当前状态强制同步到 DOM，避免任何一次异常切换留下双隐藏页面。
  function syncPages() {
    pageA.classList.toggle('gone', current !== 'A');
    pageB.classList.toggle('gone', current !== 'B');
    pageA.classList.remove('is-leaving');
    pageB.classList.remove('is-leaving');
  }

  cta.addEventListener('click', function () {
    if (isAnimating || isLoading) return;

    setLaunchLoading(true);

    isAnimating = true;
    var from = current === 'A' ? pageA : pageB;
    var to = current === 'A' ? pageB : pageA;

    from.classList.add('is-leaving');
    to.classList.remove('is-leaving');
    to.classList.remove('gone');

    window.setTimeout(function () {
      from.classList.add('gone');
      from.classList.remove('is-leaving');
      to.classList.remove('is-leaving');

      current = current === 'A' ? 'B' : 'A';
      syncPages();
      switchHint();
      isAnimating = false;
    }, 220);

    requestLaunch()
      .catch(function () {})
      .then(function () { setLaunchLoading(false); });
  });

  // InstanceData 由 mcdl-service 扫描真实游戏目录后通过 IPC 提供。
  var INSTANCES = [];
  var selectedInstanceId = null;
  var instanceList = document.getElementById('instanceList');
  var instanceCard = document.getElementById('instanceCard');
  var configCard = document.getElementById('configCard');
  var ctaWrap = document.getElementById('ctaWrap');
  var stageTitle = document.querySelector('.stage-title');
  var instanceLoadState = 'loading';
  var instanceLoadError = '';
  var versionsLoaded = false;
  var versionsLoading = false;
  var versionCatalog = [];
  var installInProgress = false;
  var lastSuggestedName = '';

  var mainStage = document.querySelector('.main-stage');
  var stageHero = document.querySelector('.stage-hero');
  var stageNews = document.querySelector('.stage-news');
  var stageCreate = document.getElementById('stageCreate');
  var createForm = document.getElementById('createForm');
  var createBack = document.getElementById('createBack');
  var createVersion = document.getElementById('createVersion');
  var createVersionType = document.getElementById('createVersionType');
  var createLoader = document.getElementById('createLoader');
  var createLoaderVersion = document.getElementById('createLoaderVersion');
  var createLoaderVersionField = document.getElementById('createLoaderVersionField');
  var createName = document.getElementById('createName');
  var createMessage = document.getElementById('createMessage');
  var createProgress = document.getElementById('createProgress');
  var createProgressText = document.getElementById('createProgressText');
  var createSubmit = createForm ? createForm.querySelector('.create-submit') : null;
  var createSubmitLabel = createSubmit ? createSubmit.querySelector('span:first-child') : null;
  var scanInstancesBtn = document.getElementById('scanInstancesBtn');
  var scanInstancesStatus = document.getElementById('scanInstancesStatus');
  var gameDirPath = document.getElementById('gameDirPath');
  var scanInProgress = false;
  // 加载器版本下拉的状态；提前声明，避免初始化阶段的同步渲染读到 undefined
  var loaderVersionState = { loader: '', mcVersion: '', entries: [], loading: false, error: '' };
  var instancesRailBtn = document.getElementById('instancesRailBtn');
  var isCreateOpen = false;
  // 从实例详情页「自动安装」进来时记下目标游戏目录；常规新建留空，走默认目录
  var createGameDir = '';

  // 加载器显示名与当前选择；提前声明，初始化阶段的同步渲染可能已经用到
  var LOADER_LABELS = { Vanilla: '原版', Fabric: 'Fabric', Quilt: 'Quilt', Forge: 'Forge', NeoForge: 'NeoForge' };

  function loaderLabelOf(value) {
    return LOADER_LABELS[value] || '原版';
  }

  function currentLoaderValue() {
    return createLoader && createLoader.value ? createLoader.value : 'Vanilla';
  }

  function setText(id, value) {
    var node = document.getElementById(id);
    if (!node) return;
    node.textContent = (value === undefined || value === null || value === '') ? '—' : String(value);
  }

  function syncNetworkStatus() {
    var online = navigator.onLine !== false;
    var net = document.querySelector('.top-status__net');
    setText('networkStatus', online ? 'Online' : 'Offline');
    if (net) net.classList.toggle('is-offline', !online);
  }

  window.addEventListener('online', syncNetworkStatus);
  window.addEventListener('offline', syncNetworkStatus);
  syncNetworkStatus();

  function pad2(number) {
    return (number < 10 ? '0' : '') + number;
  }

  function normalizeInstance(raw, fallback) {
    var source = raw && typeof raw === 'object' ? raw : {};
    var base = fallback || {};

    function pick(key) {
      if (source[key] !== undefined && source[key] !== null && source[key] !== '') return source[key];
      return base[key];
    }

    return {
      id: pick('id') || ('instance-' + Date.now().toString(36)),
      displayName: source.displayName || source.name || base.displayName || '',
      versionName: source.versionName || source.version || base.versionName || '—',
      modLoader: source.modLoader || source.loader || base.modLoader || '',
      modLoaderVersion: source.modLoaderVersion || source.loaderVersion || base.modLoaderVersion || '',
      javaVersion: source.javaVersion !== undefined && source.javaVersion !== null
        ? String(source.javaVersion)
        : (base.javaVersion || ''),
      installedVersions: pick('installedVersions'),
      lastPlayed: pick('lastPlayed'),
      memoryMb: pick('memoryMb'),
      jvmArgs: pick('jvmArgs'),
      windowWidth: pick('windowWidth'),
      windowHeight: pick('windowHeight'),
      windowSize: pick('windowSize'),
      fullscreen: pick('fullscreen'),
      profileName: pick('profileName'),
      status: pick('status') || 'Ready',
      launchStatus: pick('launchStatus') || pick('status') || 'Tuned',
      javaRequirement: pick('javaRequirement'),
      path: pick('path'),
      gameDir: pick('gameDir'),
      origin: pick('origin'),
      sourceLabel: pick('sourceLabel')
    };
  }

  function getSelectedInstance() {
    for (var i = 0; i < INSTANCES.length; i++) {
      if (INSTANCES[i].id === selectedInstanceId) return INSTANCES[i];
    }
    return INSTANCES[0] || null;
  }

  function loaderLabel(instance) {
    return [instance.modLoader, instance.modLoaderVersion].filter(Boolean).join(' ') || 'Vanilla';
  }

  function instanceMeta(instance) {
    var meta = [loaderLabel(instance)];
    if (instance.javaVersion) meta.push('Java ' + instance.javaVersion);
    if (instance.sourceLabel) meta.push(instance.sourceLabel);
    return meta.join(' · ');
  }

  function updateScanMeta(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;

    if (gameDirPath) {
      var dir = snapshot.gameDir || '';
      gameDirPath.textContent = dir ? '目录：' + dir : '';
      gameDirPath.title = dir;
    }

    if (scanInstancesStatus && !scanInProgress) {
      var cached = Array.isArray(snapshot.cachedDirs) ? snapshot.cachedDirs.length : 0;
      scanInstancesStatus.textContent = cached > 0
        ? '已缓存 ' + cached + ' 个其他启动器位置'
        : '';
    }
  }

  function buildInstanceEmptyState() {
    var wrap = document.createElement('div');
    wrap.className = 'instance-empty';

    var title = document.createElement('span');
    title.className = 'instance-empty__title';

    var hint = document.createElement('span');
    hint.className = 'instance-empty__hint';

    if (instanceLoadState === 'loading') {
      title.textContent = '正在读取实例…';
      hint.textContent = '扫描真实游戏目录中的 versions';
    } else if (instanceLoadState === 'error') {
      title.textContent = '无法读取实例';
      hint.textContent = instanceLoadError || '主进程没有返回数据';

      var retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'instance-empty__cta';
      retry.setAttribute('data-reload-instances', '');
      retry.textContent = '重试';
      wrap.appendChild(title);
      wrap.appendChild(hint);
      wrap.appendChild(retry);
      return wrap;
    } else {
      title.textContent = '还没有实例';
      hint.textContent = '点击左侧网格图标，或从这里创建第一个实例。';

      var create = document.createElement('button');
      create.type = 'button';
      create.className = 'instance-empty__cta';
      create.setAttribute('data-open-create', '');
      create.textContent = '新建实例';
      wrap.appendChild(title);
      wrap.appendChild(hint);
      wrap.appendChild(create);
      return wrap;
    }

    wrap.appendChild(title);
    wrap.appendChild(hint);
    return wrap;
  }

  function renderInstanceList() {
    if (!instanceList) return;

    if (INSTANCES.length === 0) {
      instanceList.innerHTML = '';
      instanceList.appendChild(buildInstanceEmptyState());
      setText('instanceCount',
        instanceLoadState === 'loading' ? '读取中' :
          instanceLoadState === 'error' ? 'ERROR' : '00 recent');
      return;
    }

    var fragment = document.createDocumentFragment();

    INSTANCES.forEach(function (instance, index) {
      var active = instance.id === selectedInstanceId;

      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'instance-item' + (active ? ' is-active' : '');
      item.setAttribute('data-instance-id', instance.id);
      item.setAttribute('aria-pressed', active ? 'true' : 'false');

      var number = document.createElement('span');
      number.className = 'instance-item__index';
      number.textContent = pad2(index + 1);

      var body = document.createElement('span');
      body.className = 'instance-item__body';

      var name = document.createElement('strong');
      name.textContent = instance.displayName || instance.versionName;

      var meta = document.createElement('em');
      meta.textContent = instanceMeta(instance);

      body.appendChild(name);
      body.appendChild(meta);

      var dot = document.createElement('span');
      dot.className = 'instance-item__dot';

      item.appendChild(number);
      item.appendChild(body);
      item.appendChild(dot);
      fragment.appendChild(item);
    });

    instanceList.innerHTML = '';
    instanceList.appendChild(fragment);
    setText('instanceCount', pad2(INSTANCES.length) + ' recent');
  }

  function renderEmptyStage() {
    var eyebrowText = document.getElementById('stageEyebrowText');
    var stageLive = document.querySelector('.stage-live');
    var voxelScene = document.querySelector('.voxel-scene');
    var placeholderNote = document.querySelector('.stage-placeholder-note');

    if (configCard) configCard.hidden = true;
    if (ctaWrap) ctaWrap.hidden = true;

    if (stageHero) stageHero.classList.add('stage-hero--placeholder');
    if (voxelScene) voxelScene.classList.add('voxel-scene--placeholder');
    if (stageLive) stageLive.classList.add('stage-live--placeholder');
    if (stageTitle) stageTitle.classList.remove('is-long');

    if (instanceLoadState === 'loading') {
      if (eyebrowText) eyebrowText.textContent = 'Scanning instances / 正在读取';
      setText('stageVersion', 'SCANNING');
      setText('stageLoader', 'mcdl');
      setText('stageMeta', '正在扫描真实游戏目录中的 versions …');
      setText('stageStatus', 'Loading');
      if (placeholderNote) {
        placeholderNote.hidden = false;
        placeholderNote.textContent = '正在通过 mcdl 定位游戏目录并读取实例。';
      }
    } else if (instanceLoadState === 'error') {
      if (eyebrowText) eyebrowText.textContent = 'Instance scan failed / 读取失败';
      setText('stageVersion', 'ERROR');
      setText('stageLoader', 'Offline');
      setText('stageMeta', instanceLoadError || '无法读取实例列表。');
      setText('stageStatus', 'Error');
      if (placeholderNote) {
        placeholderNote.hidden = false;
        placeholderNote.textContent = '请检查 mcdl.jar、Java 和游戏目录配置。';
      }
    } else {
      if (eyebrowText) eyebrowText.textContent = 'No instance / 暂无实例';
      setText('stageVersion', 'NO INSTANCE');
      setText('stageLoader', 'Empty');
      setText('stageMeta', '还没有实例。点击左侧「实例列表」开始创建。');
      setText('stageStatus', 'Empty');
      if (placeholderNote) {
        placeholderNote.hidden = false;
        placeholderNote.textContent = '创建后会从真实 versions 目录中读取。';
      }
    }

    setText('stageIndex', '00');
    setText('voxelTagA', 'Waiting for instance');
    setText('voxelTagB', 'mcdl / versions');

    var gameRail = document.getElementById('gameRailBtn');
    if (gameRail) {
      gameRail.setAttribute('data-label', '游戏 · 无实例');
      gameRail.setAttribute('aria-label', '当前没有实例');
    }
  }

  function renderSelectedInstance() {
    var selected = getSelectedInstance();

    if (!selected) {
      renderEmptyStage();
      return;
    }

    if (configCard) configCard.hidden = false;
    if (ctaWrap) ctaWrap.hidden = false;

    var index = INSTANCES.indexOf(selected);
    var version = selected.versionName || '—';
    var loader = selected.modLoader || 'Vanilla';
    var meta = instanceMeta(selected);

    if (selected.displayName) {
      meta = selected.displayName + ' · ' + meta;
    }

    var eyebrowText = document.getElementById('stageEyebrowText');
    if (eyebrowText) eyebrowText.textContent = 'Now selected / 当前实例';

    var stageLive = document.querySelector('.stage-live');
    if (stageLive) stageLive.classList.remove('stage-live--placeholder');

    if (stageHero) stageHero.classList.remove('stage-hero--placeholder');

    var voxelScene = document.querySelector('.voxel-scene');
    if (voxelScene) voxelScene.classList.remove('voxel-scene--placeholder');

    var placeholderNote = document.querySelector('.stage-placeholder-note');
    if (placeholderNote) {
      placeholderNote.hidden = true;
      placeholderNote.textContent = '';
    }

    if (stageTitle) {
      stageTitle.classList.toggle('is-long', version.length > 14 || /[^\x00-\x7F]/.test(version));
    }

    setText('voxelTagA', 'Glass block / 001');
    setText('voxelTagB', loader + ' edition');

    setText('stageVersion', version);
    setText('stageLoader', loader);
    setText('stageMeta', meta);
    setText('stageIndex', pad2(Math.max(0, index) + 1));
    setText('stageStatus', selected.status || 'Ready');

    setText('configVersion', version);
    setText('configLoader', loader);
    setText('configMemory',
      selected.memoryMb !== undefined && selected.memoryMb !== null ? selected.memoryMb + ' MB' : '自动');
    setText('configJava', selected.javaVersion ? 'Java ' + selected.javaVersion : '未检测');
    setText('configJvm', selected.jvmArgs || '启动器默认');
    setText('configProfile',
      selected.profileName ? 'Profile / ' + selected.profileName : 'Profile / —');
    setText('configStatus', selected.launchStatus || 'Installed');
    setText('configReady', selected.status || 'Ready');

    var gameRail = document.getElementById('gameRailBtn');
    if (gameRail) {
      var gameLabel = selected.displayName || version;
      gameRail.setAttribute('data-label', '游戏 · ' + gameLabel);
      gameRail.setAttribute('aria-label', '当前游戏：' + gameLabel);
    }

    Array.prototype.forEach.call(document.querySelectorAll('.instance-item'), function (item) {
      var active = item.getAttribute('data-instance-id') === selected.id;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function renderInstances() {
    renderInstanceList();
    renderSelectedInstance();
    renderInstancePanel();
  }

  function selectInstance(id) {
    var found = false;
    for (var i = 0; i < INSTANCES.length; i++) {
      if (INSTANCES[i].id === id) {
        selectedInstanceId = id;
        found = true;
        break;
      }
    }
    if (!found) return;

    renderInstances();

    if (configCard) {
      configCard.classList.remove('is-flash');
      void configCard.offsetWidth;
      configCard.classList.add('is-flash');
    }

    window.dispatchEvent(new CustomEvent('launcher:instance-selected', {
      detail: { instance: getSelectedInstance() }
    }));
  }

  if (instanceList) {
    instanceList.addEventListener('click', function (event) {
      if (!event.target.closest) return;

      if (event.target.closest('[data-open-create]')) {
        openCreatePanel();
        return;
      }

      if (event.target.closest('[data-reload-instances]')) {
        loadInstances();
        return;
      }

      var item = event.target.closest('.instance-item');
      if (!item) return;
      selectInstance(item.getAttribute('data-instance-id'));
    });
  }

  function updateInstanceUI(data) {
    if (!data || typeof data !== 'object') return;

    if (Array.isArray(data.instances)) {
      INSTANCES = data.instances.map(function (item) {
        return normalizeInstance(item, {});
      });
      selectedInstanceId = data.selectedId || (INSTANCES[0] && INSTANCES[0].id) || null;
      if (!getSelectedInstance()) {
        selectedInstanceId = INSTANCES[0] ? INSTANCES[0].id : null;
      }
      renderInstances();
      return;
    }

    var selected = getSelectedInstance();
    if (!selected) {
      INSTANCES = [normalizeInstance(data, {})];
      selectedInstanceId = INSTANCES[0].id;
    } else {
      var index = INSTANCES.indexOf(selected);
      INSTANCES[index] = normalizeInstance(Object.assign({}, selected, data), selected);
      selectedInstanceId = INSTANCES[index].id;
    }

    renderInstances();
  }

  function loadInstances() {
    instanceLoadState = 'loading';
    instanceLoadError = '';
    INSTANCES = [];
    selectedInstanceId = null;
    renderInstances();

    var api = window.launcherAPI;
    if (!api || typeof api.getInstanceInfo !== 'function') {
      instanceLoadState = 'error';
      instanceLoadError = '主进程桥接不可用';
      renderInstances();
      return;
    }

    api.getInstanceInfo()
      .then(function (snapshot) {
        instanceLoadState = 'ready';
        instanceLoadError = '';
        updateScanMeta(snapshot);
        updateInstanceUI(snapshot);
      })
      .catch(function (error) {
        console.error('[instances] real instance scan failed:', error);
        instanceLoadState = 'error';
        instanceLoadError = error && error.message ? error.message : '读取实例失败';
        INSTANCES = [];
        selectedInstanceId = null;
        renderInstances();
      });
  }

  function scanOtherInstances() {
    if (scanInProgress) return;

    var api = window.launcherAPI;
    if (!api || typeof api.scanOtherInstances !== 'function') {
      if (scanInstancesStatus) scanInstancesStatus.textContent = '主进程桥接不可用，无法扫描';
      return;
    }

    scanInProgress = true;
    if (scanInstancesBtn) scanInstancesBtn.disabled = true;
    if (scanInstancesStatus) scanInstancesStatus.textContent = '正在扫描其他启动器位置…';

    api.scanOtherInstances()
      .then(function (snapshot) {
        scanInProgress = false;
        if (scanInstancesBtn) scanInstancesBtn.disabled = false;

        instanceLoadState = 'ready';
        instanceLoadError = '';
        updateInstanceUI(snapshot);
        updateScanMeta(snapshot);

        var cached = Array.isArray(snapshot.cachedDirs) ? snapshot.cachedDirs.length : 0;
        var newly = Number(snapshot.newlyScanned) || 0;
        if (scanInstancesStatus) {
          if (newly > 0) {
            scanInstancesStatus.textContent = '已发现 ' + newly + ' 个位置' +
              (snapshot.cachePersisted === false ? '（缓存写入失败）' : '，已缓存 ' + cached + ' 个');
          } else if (cached > 0) {
            scanInstancesStatus.textContent = '没有新的位置' +
              (snapshot.cachePersisted === false ? '，已加载 ' + cached + ' 个' : '，已缓存 ' + cached + ' 个');
          } else {
            scanInstancesStatus.textContent = '没有发现其他启动器位置';
          }
        }
      })
      .catch(function (error) {
        scanInProgress = false;
        if (scanInstancesBtn) scanInstancesBtn.disabled = false;
        console.error('[instances] scan other launchers failed:', error);
        if (scanInstancesStatus) {
          scanInstancesStatus.textContent = '扫描失败：' + (error && error.message ? error.message : error);
        }
      });
  }

  if (scanInstancesBtn) {
    scanInstancesBtn.addEventListener('click', scanOtherInstances);
  }

  // 暴露给 Java 后端桥接；Electron / Tauri 宿主也可直接调用。
  window.updateInstanceUI = updateInstanceUI;
  window.selectInstance = selectInstance;

  var launcherAPI = window.launcherAPI;

  if (launcherAPI && typeof launcherAPI.onInstallProgress === 'function') {
    launcherAPI.onInstallProgress(function (payload) {
      if (!payload || !payload.message) return;
      if (createProgressText) createProgressText.textContent = payload.message;
      if (createMessage && installInProgress) createMessage.textContent = payload.message;
      noteActiveTask(payload.message);
    });
  }

  loadInstances();

  // ---------------------------------------------------------
  // 实例管理：主视区面板切换 / 新建实例
  // ---------------------------------------------------------
  function setHomeInert(inert) {
    [stageHero, stageNews].forEach(function (node) {
      if (!node) return;
      if (inert) {
        node.setAttribute('inert', '');
        node.setAttribute('aria-hidden', 'true');
      } else {
        node.removeAttribute('inert');
        node.removeAttribute('aria-hidden');
      }
    });
  }

  function describeInstallError(error) {
    var raw = error && error.message ? error.message : String(error || '未知错误');
    var lines = raw.split(/\r?\n/).map(function (line) {
      return line.trim();
    }).filter(Boolean);
    var last = lines[lines.length - 1] || raw;
    last = last
      .replace(/^\[失败\]\s*/, '')
      .replace(/^安装失败：\s*/, '');

    // mcdl 的 AccessDeniedException 只给出完整路径；UI 里只展示文件名。
    if (/^[A-Za-z]:[\\/]/.test(last)) {
      var name = last.split(/[\\/]/).pop();
      return '无法写入 ' + (name || '版本文件');
    }

    return last;
  }

  function defaultInstanceName() {
    var version = createVersion && createVersion.value ? createVersion.value : '';
    var loader = currentLoaderValue();
    var label = loaderLabelOf(loader);
    if (!version) return '新实例 · ' + label;
    return version + ' · ' + label;
  }

  function updateSuggestedName(force) {
    if (!createName) return;
    var suggestion = defaultInstanceName();
    if (force || !createName.value.trim() || createName.value === lastSuggestedName) {
      createName.value = suggestion;
      lastSuggestedName = suggestion;
    }
  }

  // ---------------- 加载器版本列表 ----------------

  function setLoaderVersionFieldVisible(visible) {
    if (!createLoaderVersionField) return;
    createLoaderVersionField.hidden = !visible;
  }

  function renderLoaderVersionOptions() {
    if (!createLoaderVersion) return;

    var previous = createLoaderVersion.value;
    createLoaderVersion.innerHTML = '';

    var placeholder = document.createElement('option');
    placeholder.value = '';
    if (loaderVersionState.loading) {
      placeholder.textContent = '正在读取加载器版本…';
    } else if (loaderVersionState.error) {
      placeholder.textContent = '读取失败 · 使用最新稳定版';
    } else {
      placeholder.textContent = '最新稳定版';
    }
    createLoaderVersion.appendChild(placeholder);

    loaderVersionState.entries.forEach(function (entry) {
      if (!entry || !entry.version) return;
      var option = document.createElement('option');
      option.value = entry.version;
      option.textContent = entry.version + (entry.note ? ' · ' + entry.note : '');
      createLoaderVersion.appendChild(option);
    });

    createLoaderVersion.disabled = installInProgress || loaderVersionState.loading;

    // 重新渲染（换类型 / 换版本后的刷新）时保留用户已经选中的构建
    if (previous) {
      for (var i = 0; i < createLoaderVersion.options.length; i += 1) {
        if (createLoaderVersion.options[i].value === previous) {
          createLoaderVersion.value = previous;
          break;
        }
      }
    }
  }

  /**
   * 拉取当前「游戏版本 + 加载器」可用的构建列表。
   * 同一个组合只请求一次；force 用于换版本 / 重选加载器时刷新。
   */
  function refreshLoaderVersions(force) {
    var loader = currentLoaderValue();
    var mcVersion = createVersion && createVersion.value ? createVersion.value : '';

    setLoaderVersionFieldVisible(loader !== 'Vanilla');

    if (loader === 'Vanilla' || !mcVersion) {
      loaderVersionState = { loader: loader, mcVersion: mcVersion, entries: [], loading: false, error: '' };
      renderLoaderVersionOptions();
      return;
    }

    var same = loaderVersionState.loader === loader && loaderVersionState.mcVersion === mcVersion;
    if (!force && same && (loaderVersionState.loading || loaderVersionState.entries.length > 0)) {
      renderLoaderVersionOptions();
      return;
    }

    var api = window.launcherAPI;
    if (!api || typeof api.listLoaders !== 'function') {
      loaderVersionState = { loader: loader, mcVersion: mcVersion, entries: [], loading: false, error: '桥接不可用' };
      renderLoaderVersionOptions();
      return;
    }

    loaderVersionState = { loader: loader, mcVersion: mcVersion, entries: [], loading: true, error: '' };
    renderLoaderVersionOptions();

    api.listLoaders({ loader: loader, mcVersion: mcVersion }).then(function (data) {
      if (loaderVersionState.loader !== loader || loaderVersionState.mcVersion !== mcVersion) return;
      loaderVersionState.loading = false;
      loaderVersionState.error = '';
      loaderVersionState.entries = (data && data.versions) || [];
      renderLoaderVersionOptions();
    }).catch(function (error) {
      if (loaderVersionState.loader !== loader || loaderVersionState.mcVersion !== mcVersion) return;
      console.error('[loaders] failed to list versions:', error);
      loaderVersionState.loading = false;
      loaderVersionState.error = error && error.message ? error.message : String(error);
      loaderVersionState.entries = [];
      renderLoaderVersionOptions();
    });
  }

  function setCreateBusy(busy) {
    installInProgress = !!busy;

    if (createVersionType) createVersionType.disabled = installInProgress || versionsLoading;
    if (createVersion) createVersion.disabled = installInProgress || versionsLoading;
    if (createLoader) createLoader.disabled = installInProgress;
    if (createLoaderVersion) createLoaderVersion.disabled = installInProgress || loaderVersionState.loading;
    if (createName) createName.disabled = installInProgress;
    if (createBack) createBack.disabled = installInProgress;
    if (createSubmit) createSubmit.disabled = installInProgress || !versionsLoaded || !createVersion.value;

    if (createSubmitLabel) {
      createSubmitLabel.textContent = installInProgress ? '正在安装…' : '创建实例';
    }
    if (createProgress) {
      createProgress.hidden = !installInProgress;
    }
  }

  function versionTypeLabel(type) {
    if (type === 'snapshot') return '快照';
    if (type === 'old') return '远古版';
    if (type === 'all') return '全部';
    return '正式版';
  }

  function renderVersionOptions(preferredId) {
    if (!createVersion || !versionsLoaded) return;

    var type = createVersionType ? createVersionType.value : 'release';
    var list = versionCatalog.filter(function (version) {
      return type === 'all' || version.type === type;
    });
    var previous = preferredId || createVersion.value;
    var fragment = document.createDocumentFragment();

    list.forEach(function (version) {
      var option = document.createElement('option');
      option.value = version.id;
      option.textContent = version.id + (version.date ? ' · ' + version.date : '');
      fragment.appendChild(option);
    });

    createVersion.innerHTML = '';
    if (list.length === 0) {
      var empty = document.createElement('option');
      empty.value = '';
      empty.textContent = '该类型暂无版本';
      createVersion.appendChild(empty);
      createVersion.disabled = true;
    } else {
      createVersion.appendChild(fragment);
      var selected = list.filter(function (version) { return version.id === previous; })[0] || list[0];
      createVersion.value = selected.id;
      createVersion.disabled = installInProgress || versionsLoading;
    }

    if (createSubmit) {
      createSubmit.disabled = installInProgress || !versionsLoaded || !createVersion.value || list.length === 0;
    }

    updateSuggestedName(!createName.value.trim());
    refreshLoaderVersions(false);
    if (createMessage) {
      createMessage.classList.remove('is-error');
      createMessage.textContent = list.length === 0
        ? '该类型暂无可用版本'
        : '版本类型：' + versionTypeLabel(type) + ' · ' + list.length + ' 个';
    }
  }

  function loadVersionOptions() {
    if (versionsLoaded || versionsLoading) return;

    var api = window.launcherAPI;
    versionsLoading = true;
    if (createVersionType) createVersionType.disabled = true;
    if (createVersion) {
      createVersion.disabled = true;
      createVersion.innerHTML = '';
      var loadingOption = document.createElement('option');
      loadingOption.value = '';
      loadingOption.textContent = '正在从 mcdl 读取版本列表…';
      createVersion.appendChild(loadingOption);
    }
    if (createMessage) {
      createMessage.classList.remove('is-error');
      createMessage.textContent = '正在从 mcdl 获取版本列表…';
    }
    setCreateBusy(false);

    if (!api || typeof api.getVersions !== 'function') {
      versionsLoading = false;
      versionsLoaded = false;
      if (createMessage) {
        createMessage.textContent = '主进程桥接不可用，无法读取版本列表';
        createMessage.classList.add('is-error');
      }
      return;
    }

    api.getVersions()
      .then(function (versions) {
        versionsLoading = false;
        if (!Array.isArray(versions) || versions.length === 0) {
          throw new Error('mcdl 返回的版本列表为空');
        }

        versionCatalog = versions;
        versionsLoaded = true;
        if (createVersionType) createVersionType.disabled = false;
        renderVersionOptions();
        setCreateBusy(false);
      })
      .catch(function (error) {
        versionsLoading = false;
        versionsLoaded = false;
        versionCatalog = [];
        if (createVersionType) createVersionType.disabled = true;
        if (createVersion) {
          createVersion.innerHTML = '';
          var failed = document.createElement('option');
          failed.value = '';
          failed.textContent = '版本列表读取失败';
          createVersion.appendChild(failed);
          createVersion.disabled = true;
        }
        if (createMessage) {
          createMessage.textContent = '无法读取版本列表：' + (error && error.message ? error.message : error);
          createMessage.classList.add('is-error');
        }
        setCreateBusy(false);
      });
  }

  // ---------------------------------------------------------
  // 二级页面栈：实例列表 / 新建实例 / 游戏目录 / 账户 / 设置
  // 一次只点亮一个：主视区加一个 is-xxx 类，其余面板保持 inert。
  // ---------------------------------------------------------
  var PANEL_ELEMENTS = {
    instances: 'stageInstances',
    detail: 'stageInstanceDetail',
    create: 'stageCreate',
    gamedir: 'stageGameDir',
    account: 'stageAccount',
    settings: 'stageSettings',
    download: 'stageDownload'
  };
  var PANEL_STATES = {
    instances: 'is-instances',
    detail: 'is-detail',
    create: 'is-create',
    gamedir: 'is-gamedir',
    account: 'is-account',
    settings: 'is-settings',
    download: 'is-download'
  };
  var activePanel = null;

  function panelElement(name) {
    var id = PANEL_ELEMENTS[name];
    return id ? document.getElementById(id) : null;
  }

  function hideActivePanel(options) {
    options = options || {};
    if (!activePanel) return null;

    var closing = activePanel;
    var element = panelElement(closing);
    activePanel = null;
    isCreateOpen = false;
    overlayPanel = null;

    if (mainStage) mainStage.classList.remove(PANEL_STATES[closing]);
    delete document.body.dataset.panel;
    if (element) {
      element.setAttribute('inert', '');
      element.setAttribute('aria-hidden', 'true');
    }
    setHomeInert(false);

    if (instancesRailBtn) {
      instancesRailBtn.setAttribute('aria-expanded', 'false');
    }

    window.dispatchEvent(new CustomEvent('launcher:panel-change', {
      detail: { panel: 'stage-home' }
    }));

    return closing;
  }

  function showPanel(name, options) {
    options = options || {};
    var element = panelElement(name);
    if (!mainStage || !element) return;

    if (activePanel === name) return;
    hideActivePanel({ focus: false });

    activePanel = name;
    isCreateOpen = name === 'create';
    overlayPanel = (name === 'account' || name === 'settings') ? name : null;

    mainStage.classList.add(PANEL_STATES[name]);
    document.body.dataset.panel = name;
    element.removeAttribute('inert');
    element.setAttribute('aria-hidden', 'false');
    setHomeInert(true);

    if (name === 'instances' && instancesRailBtn) {
      instancesRailBtn.setAttribute('aria-expanded', 'true');
    }

    window.dispatchEvent(new CustomEvent('launcher:panel-change', {
      detail: { panel: name }
    }));
  }

  /** 标题栏「返回 / 关闭当前页」、Esc、各页面返回按钮共用。 */
  function closeActivePanel(options) {
    options = options || {};
    if (!activePanel) return;
    if (activePanel === 'create' && installInProgress) return;
    if (activePanel === 'download' && (installBusy || packBusy)) return;

    // 游戏目录页是从实例列表进来的，返回时回到列表而不是主视区。
    // 游戏目录页 / 实例详情页都是从实例列表进来的，返回时回到列表。
    if (activePanel === 'gamedir' || activePanel === 'detail') {
      showPanel('instances');
      renderInstancePanel();
      if (options.focus !== false) {
        var backBtn = document.getElementById('instancesBack');
        if (backBtn) backBtn.focus();
      }
      return;
    }

    var closing = hideActivePanel(options);
    if (options.focus !== false && closing) {
      var rail = document.querySelector('.rail-btn[data-nav="' + closing + '"]');
      if (rail) rail.focus();
    }
  }

  function openInstancesPanel() {
    showPanel('instances');
    renderInstancePanel();
    // 每次进来都重扫一遍：用户可能刚在资源管理器里装了新版本。
    if (typeof loadInstances === 'function') loadInstances();
    window.setTimeout(function () {
      if (newInstanceBtn) newInstanceBtn.focus({ preventScroll: true });
    }, 220);
  }

  function openCreatePanel() {
    if (!mainStage || !stageCreate) return;
    if (installInProgress) return;

    // 常规新建：目标目录回到默认；「自动安装」会在调用后再覆盖成实例所在目录
    createGameDir = '';

    showPanel('create');

    if (createName) createName.classList.remove('is-invalid');
    if (createMessage) {
      createMessage.classList.remove('is-error');
      createMessage.textContent = versionsLoaded
        ? '名称可留空，会自动生成'
        : '正在准备版本列表…';
    }

    if (versionsLoaded) {
      updateSuggestedName(!createName.value.trim());
    } else {
      loadVersionOptions();
    }

    setCreateBusy(false);
    if (createVersion) createVersion.disabled = !versionsLoaded;
    setLoaderVersionFieldVisible(currentLoaderValue() !== 'Vanilla');
    refreshLoaderVersions(false);

    window.setTimeout(function () {
      if (createVersion) createVersion.focus();
    }, 220);

    window.dispatchEvent(new CustomEvent('launcher:panel-change', {
      detail: { panel: 'create-instance' }
    }));
  }

  function closeCreatePanel(options) {
    if (!isCreateOpen || installInProgress) return;
    options = options || {};

    hideActivePanel({ focus: false });
    if (options.focus !== false && instancesRailBtn) instancesRailBtn.focus();
  }

  function handleCreateSubmit(event) {
    event.preventDefault();
    if (installInProgress) return;

    var version = createVersion ? createVersion.value : '';
    if (!version) {
      if (createMessage) {
        createMessage.textContent = '版本列表尚未就绪，请稍后重试';
        createMessage.classList.add('is-error');
      }
      return;
    }

    // 名称可以留空：这时使用当前版本的自动默认名称。
    var name = createName ? createName.value.trim() : '';
    if (!name) {
      name = defaultInstanceName();
      if (createName) createName.value = name;
    }

    var api = window.launcherAPI;
    if (!api || typeof api.createInstance !== 'function') {
      if (createMessage) {
        createMessage.textContent = '主进程桥接不可用，无法安装';
        createMessage.classList.add('is-error');
      }
      return;
    }

    setCreateBusy(true);
    if (createMessage) {
      createMessage.classList.remove('is-error');
      createMessage.textContent = '正在调用 mcdl 安装 ' + version + ' …';
    }
    if (createProgressText) {
      createProgressText.textContent = '正在启动 mcdl…';
    }

    api.createInstance({
      version: version,
      loader: currentLoaderValue(),
      loaderVersion: createLoaderVersion ? createLoaderVersion.value : '',
      name: name,
      gameDir: createGameDir
    })
      .then(function (snapshot) {
        setCreateBusy(false);
        instanceLoadState = 'ready';
        instanceLoadError = '';
        updateInstanceUI(snapshot);
        updateScanMeta(snapshot);

        if (createForm) createForm.reset();
        if (createVersionType) createVersionType.value = 'release';
        createGameDir = '';
        if (createLoader) createLoader.value = 'Vanilla';
        setLoaderVersionFieldVisible(false);
        renderVersionOptions();

        closeCreatePanel({ focus: true });

        if (createMessage) {
          createMessage.classList.remove('is-error');
          createMessage.textContent = '安装完成';
        }

        window.dispatchEvent(new CustomEvent('launcher:instance-created', {
          detail: { version: version, name: name }
        }));
      })
      .catch(function (error) {
        setCreateBusy(false);
        console.error('[instances] create failed:', error);
        if (createMessage) {
          createMessage.textContent = '安装失败：' + describeInstallError(error);
          createMessage.classList.add('is-error');
        }
      });
  }

  if (createForm) {
    createForm.addEventListener('submit', handleCreateSubmit);
  }

  if (createVersionType) {
    createVersionType.addEventListener('change', function () {
      renderVersionOptions();
    });
  }

  if (createVersion) {
    createVersion.addEventListener('change', function () {
      updateSuggestedName(false);
      refreshLoaderVersions(true);
    });
  }

  if (createLoader) {
    createLoader.addEventListener('change', function () {
      setLoaderVersionFieldVisible(currentLoaderValue() !== 'Vanilla');
      refreshLoaderVersions(true);
      updateSuggestedName(false);
    });
  }

  if (createBack) {
    createBack.addEventListener('click', function () {
      closeCreatePanel({ focus: true });
    });
  }

  if (createName) {
    createName.addEventListener('input', function () {
      createName.classList.remove('is-invalid');
      if (createMessage && !installInProgress) {
        createMessage.classList.remove('is-error');
        createMessage.textContent = '名称可留空，会自动生成';
      }
    });
  }

  setCreateBusy(false);

  // 对照 ui-tree-controls.html：实例管理的 3 个 L2 直达控件的真正处理在
  // 「实例列表页」那一段（data-instance-action 的委托监听）。

  // ---------------------------------------------------------
  // 左侧 / 顶部导航：当前页高亮 + 交给宿主路由
  // ---------------------------------------------------------
  document.addEventListener('click', function (event) {
    var trigger = event.target.closest ? event.target.closest('[data-nav]') : null;
    if (!trigger) return;

    var target = trigger.getAttribute('data-nav');
    var railButtons = document.querySelectorAll('.rail-btn');
    var isRailButton = trigger.classList.contains('rail-btn');
    var matchedRail = false;

    Array.prototype.forEach.call(railButtons, function (button) {
      if (button.getAttribute('data-nav') === target) matchedRail = true;
    });

    // 只有点击侧边栏项，或目标确实对应侧边栏项时才同步高亮。
    if (isRailButton || matchedRail) {
      Array.prototype.forEach.call(railButtons, function (button) {
        var active = button.getAttribute('data-nav') === target;
        button.classList.toggle('is-active', active);
        if (active) {
          button.setAttribute('aria-current', 'page');
        } else {
          button.removeAttribute('aria-current');
        }
      });
    }

    if (target === 'instances' && instanceCard) {
      instanceCard.classList.remove('is-flash');
      void instanceCard.offsetWidth;
      instanceCard.classList.add('is-flash');
    }

    if (isRailButton && target === 'instances') {
      closeActivePanel({ focus: false });
      openInstancesPanel();
    } else if (isRailButton && target === 'download') {
      closeActivePanel({ focus: false });
      openDownloadPanel();
    } else if (isRailButton && (target === 'account' || target === 'settings')) {
      closeActivePanel({ focus: false });
      openOverlayPanel(target);
    } else if (isRailButton) {
      // 「游戏」等没有独立页面的项：回到主视区
      closeActivePanel({ focus: false });
    }

    window.dispatchEvent(new CustomEvent('launcher:navigate', {
      detail: { target: target }
    }));
  });

  // ---------------------------------------------------------
  // 账户页：登录方式入口 + 账户列表 + L5 弹窗
  // 对应 docs/history/ui-tree-controls.html 的 [L2] 账户 与它下面的 5 个 [L5] 弹窗：
  //   account.methods.microsoft → 微软登录
  //   account.methods.offline   → 添加离线账户（离线模式 / 正版登录 两个页签）
  //   account.injector.add      → 添加认证服务器向导
  //   账户列表项                → 设为当前 / 离线皮肤设置 / 删除
  // ---------------------------------------------------------
  var stageAccount = document.getElementById('stageAccount');
  var accountBack = document.getElementById('accountBack');
  var accountEntries = document.getElementById('accountEntries');
  var accountList = document.getElementById('accountList');
  var accountCount = document.getElementById('accountCount');
  var accountName = document.getElementById('accountName');
  var topAvatar = document.querySelector('.top-account .top-avatar');
  var railAvatar = document.querySelector('.rail-avatar');
  var accountRailBtn = document.querySelector('.rail-btn[data-nav="account"]');
  var gameRailBtn = document.getElementById('gameRailBtn');

  var stageSettings = document.getElementById('stageSettings');
  var settingsBack = document.getElementById('settingsBack');
  var settingsForm = document.getElementById('settingsForm');
  var settingsMemory = document.getElementById('settingsMemory');
  var settingsJava = document.getElementById('settingsJava');
  var settingsWidth = document.getElementById('settingsWidth');
  var settingsHeight = document.getElementById('settingsHeight');
  var settingsJvmArgs = document.getElementById('settingsJvmArgs');
  var settingsIsolation = document.getElementById('settingsIsolation');
  var settingsStatus = document.getElementById('settingsStatus');
  var settingsSubmit = document.getElementById('settingsSubmit');

  var settingsJavaCount = document.getElementById('settingsJavaCount');
  var settingsJavaScan = document.getElementById('settingsJavaScan');
  var settingsJavaPick = document.getElementById('settingsJavaPick');
  var settingsJavaInstall = document.getElementById('settingsJavaInstall');
  var settingsJavaStatus = document.getElementById('settingsJavaStatus');
  var settingsLanguage = document.getElementById('settingsLanguage');
  var settingsAprilFools = document.getElementById('settingsAprilFools');
  var settingsOpenLogs = document.getElementById('settingsOpenLogs');
  var settingsGeneralStatus = document.getElementById('settingsGeneralStatus');
  var settingsDisableAnimations = document.getElementById('settingsDisableAnimations');
  var settingsVersionSource = document.getElementById('settingsVersionSource');
  var settingsDownloadSource = document.getElementById('settingsDownloadSource');
  var settingsAddonSource = document.getElementById('settingsAddonSource');
  var settingsDownloadStatus = document.getElementById('settingsDownloadStatus');
  var settingsAboutVersion = document.getElementById('settingsAboutVersion');
  var settingsAboutMeta = document.getElementById('settingsAboutMeta');
  var settingsOpenRepo = document.getElementById('settingsOpenRepo');
  var settingsOpenLicense = document.getElementById('settingsOpenLicense');

  var ACCOUNTS = [];
  var SERVERS = [];
  var selectedAccountId = null;
  var settingsLoaded = false;
  var settingsCache = null;
  var settingsTab = 'game';

  /** 提示行：tone = 'error' | 'ok' | 省略 */
  function setHint(node, text, tone) {
    if (!node) return;
    node.textContent = text || '';
    node.classList.toggle('is-error', tone === 'error');
    node.classList.toggle('is-ok', tone === 'ok');
  }

  // ---------------- 共享组件基座 ----------------

  /**
   * 页签基座：把 [data-*-tab] 按钮和 [data-*-panel] 面板绑成一个 tablist。
   *
   *   var tabs = createTabs({
   *     tabAttr: 'data-settings-tab',
   *     panelAttr: 'data-settings-pane',
   *     onChange: function (value) { ... }   // 切换后要做的事
   *   });
   *   tabs.set('java');
   *
   * 统一负责：aria-selected / is-active / roving tabindex / ←→ Home End
   * 键盘导航 + 焦点移动 + 面板 hidden 同步。
   */
  function createTabs(options) {
    var opts = options || {};
    var tabAttr = opts.tabAttr;
    var panelAttr = opts.panelAttr;
    var activeClass = opts.activeClass === null ? '' : (opts.activeClass || 'is-active');
    var root = opts.root || document;
    var current = '';

    function tabNodes() {
      return Array.prototype.slice.call(root.querySelectorAll('[' + tabAttr + ']'));
    }

    function panelNodes() {
      if (!panelAttr) return [];
      return Array.prototype.slice.call(root.querySelectorAll('[' + panelAttr + ']'));
    }

    function values() {
      return tabNodes().map(function (tab) {
        return tab.getAttribute(tabAttr);
      });
    }

    function apply(value) {
      tabNodes().forEach(function (tab) {
        var active = tab.getAttribute(tabAttr) === value;
        tab.setAttribute('aria-selected', active ? 'true' : 'false');
        tab.setAttribute('tabindex', active ? '0' : '-1');
        if (activeClass) tab.classList.toggle(activeClass, active);
      });

      panelNodes().forEach(function (panel) {
        var active = panel.getAttribute(panelAttr) === value;
        panel.hidden = !active;
        if (activeClass) panel.classList.toggle(activeClass, active);
      });
    }

    function set(value, config) {
      var all = values();
      var next = value;
      // 传了不存在的页签名（比如外部数据）时退回第一个，别让所有面板都消失。
      if (all.length && all.indexOf(next) < 0) next = all[0];

      current = next;
      apply(current);

      if (!(config && config.silent) && typeof opts.onChange === 'function') {
        opts.onChange(current);
      }
      return current;
    }

    tabNodes().forEach(function (tab) {
      tab.addEventListener('click', function () {
        set(tab.getAttribute(tabAttr));
      });

      tab.addEventListener('keydown', function (event) {
        var key = event.key;
        if (key !== 'ArrowRight' && key !== 'ArrowLeft' && key !== 'ArrowDown'
            && key !== 'ArrowUp' && key !== 'Home' && key !== 'End') {
          return;
        }

        var tabs = tabNodes();
        var index = tabs.indexOf(tab);
        if (index < 0 || tabs.length === 0) return;

        var nextIndex = index;
        if (key === 'ArrowRight' || key === 'ArrowDown') nextIndex = (index + 1) % tabs.length;
        else if (key === 'ArrowLeft' || key === 'ArrowUp') nextIndex = (index - 1 + tabs.length) % tabs.length;
        else if (key === 'Home') nextIndex = 0;
        else nextIndex = tabs.length - 1;

        event.preventDefault();
        var next = tabs[nextIndex];
        if (!next) return;
        set(next.getAttribute(tabAttr));
        next.focus();
      });
    });

    // 初始状态：HTML 里 aria-selected="true" 的那个，没有就用第一个。
    var initialTabs = tabNodes();
    var initialTab = initialTabs.filter(function (tab) {
      return tab.getAttribute('aria-selected') === 'true';
    })[0] || initialTabs[0];
    current = initialTab ? initialTab.getAttribute(tabAttr) : '';
    if (current) apply(current);

    return {
      set: set,
      get: function () { return current; },
      values: values,
      sync: function () { apply(current); }
    };
  }

  /**
   * 列表基座：容器 + 数据 + 行渲染 + 选中 + 空态 + 计数，一处实现。
   *
   *   var list = createList({
   *     container: node,
   *     itemKey: function (item) { return item.id; },
   *     renderRow: function (item) { return rowNode; },
   *     emptyState: '还没有内容',            // 字符串或 () => Node
   *     countEl: countNode,
   *     onSelect: function (item, key) {}
   *   });
   *   list.render(items, { selected: id });
   *
   * 行节点会被写上 data-list-key；选中只切 is-selected，不重建整表，
   * 避免「点一下行，行被替换掉」导致后续 click / dblclick 落空。
   */
  function createList(options) {
    var opts = options || {};
    var container = opts.container || null;
    var items = [];
    var selectedKey = '';

    function keyOf(item, index) {
      if (typeof opts.itemKey === 'function') return String(opts.itemKey(item, index));
      return String(index);
    }

    function applySelection() {
      if (!container) return;
      Array.prototype.forEach.call(container.children, function (row) {
        if (!row || !row.getAttribute) return;
        row.classList.toggle('is-selected', row.getAttribute('data-list-key') === selectedKey);
      });
    }

    function render(nextItems, config) {
      items = Array.isArray(nextItems) ? nextItems.slice() : [];
      if (config && config.selected !== undefined) {
        selectedKey = config.selected == null ? '' : String(config.selected);
      }

      if (!container) return items;

      container.innerHTML = '';

      if (items.length === 0) {
        if (typeof opts.emptyState === 'function') {
          var custom = opts.emptyState();
          if (custom) container.appendChild(custom);
        } else if (opts.emptyState) {
          var empty = document.createElement('div');
          empty.className = opts.emptyClass || 'content-empty';
          empty.textContent = String(opts.emptyState);
          container.appendChild(empty);
        }
        if (opts.countEl) opts.countEl.textContent = '0';
        return items;
      }

      var fragment = document.createDocumentFragment();
      items.forEach(function (item, index) {
        var row = typeof opts.renderRow === 'function' ? opts.renderRow(item, index) : null;
        if (!row || !row.setAttribute) return;
        row.setAttribute('data-list-key', keyOf(item, index));
        fragment.appendChild(row);
      });
      container.appendChild(fragment);

      if (opts.countEl) opts.countEl.textContent = String(items.length);
      applySelection();
      return items;
    }

    function selectedItem() {
      for (var i = 0; i < items.length; i += 1) {
        if (keyOf(items[i], i) === selectedKey) return items[i];
      }
      return null;
    }

    function select(key) {
      selectedKey = key == null ? '' : String(key);
      applySelection();
    }

    if (container && typeof opts.onSelect === 'function') {
      container.addEventListener('click', function (event) {
        var row = event.target && event.target.closest
          ? event.target.closest('[data-list-key]')
          : null;
        if (!row || !container.contains(row)) return;

        var key = row.getAttribute('data-list-key');
        select(key);
        opts.onSelect(selectedItem(), key);
      });
    }

    return {
      render: render,
      select: select,
      selected: selectedItem,
      items: function () { return items.slice(); },
      container: container
    };
  }

  function openAccountError(error, node) {
    var message = describeLaunchError(error);
    setHint(node, message, 'error');
    return message;
  }

  function selectedAccount() {
    for (var i = 0; i < ACCOUNTS.length; i += 1) {
      if (ACCOUNTS[i].id === selectedAccountId) return ACCOUNTS[i];
    }
    return null;
  }

  function accountById(id) {
    for (var i = 0; i < ACCOUNTS.length; i += 1) {
      if (ACCOUNTS[i].id === id) return ACCOUNTS[i];
    }
    return null;
  }

  function accountTypeLabel(account) {
    if (!account) return '';
    if (account.type === 'microsoft') return '微软账户';
    if (account.type === 'authlib') {
      return account.serverName ? '认证服务器 · ' + account.serverName : '认证服务器';
    }
    return '离线账户';
  }

  /** 卡片左上角的小标签：一眼看出这是哪种账号。 */
  function accountKindBadge(account) {
    if (!account) return { text: '未知', kind: 'unknown' };
    if (account.type === 'microsoft') return { text: '微软', kind: 'microsoft' };
    if (account.type === 'authlib') return { text: '第三方', kind: 'authlib' };
    return { text: '离线', kind: 'offline' };
  }

  function syncAccountChrome() {
    var current = selectedAccount();
    var label = current ? current.name : '未接入';
    var kind = current ? accountTypeLabel(current) : '未选择账号';

    if (accountName) accountName.textContent = label;

    if (topAvatar) {
      topAvatar.textContent = current ? String(current.name).slice(0, 1).toUpperCase() : '?';
    }
    if (railAvatar) {
      railAvatar.textContent = current ? String(current.name).slice(0, 1).toUpperCase() : '?';
    }
    if (accountRailBtn) {
      accountRailBtn.setAttribute('data-label', '账户 · ' + label);
      accountRailBtn.setAttribute('aria-label', '账户：' + (current ? label + ' · ' + kind : '未选择账号'));
    }

    if (gameRailBtn) {
      var instance = getSelectedInstance();
      if (instance) {
        gameRailBtn.setAttribute('aria-label', '当前游戏：' + (instance.displayName || instance.versionName || '实例'));
      }
    }

    if (current) {
      setLaunchNote('使用 ' + current.name + ' 启动', false);
    } else if (!launchNote || !launchNote.textContent) {
      setLaunchNote('请先在「账户」页选择账号', false);
    }
  }

  // ---------------- 文本框原生右键菜单（共享组件） ----------------

  /**
   * 所有 input / textarea 共用一套原生右键菜单（撤销/重做/剪切/复制/粘贴/删除/全选）。
   *
   * 菜单在主进程用 Menu.popup 弹出，编辑动作走 Chromium 原生 role，
   * 不用 document.execCommand —— 后者对中文输入法的撤销栈不可靠。
   * 这里只负责把焦点控件的状态（可否编辑 / 有选中 / 是否密码框）报上去。
   */
  document.addEventListener('contextmenu', function (event) {
    var field = event.target && event.target.closest
      ? event.target.closest('input, textarea')
      : null;
    if (!field) return;

    var api = window.launcherAPI;
    if (!api || typeof api.showTextContextMenu !== 'function') return;

    // 启动器没有默认右键菜单，输入框上的右键一律由原生菜单接管。
    event.preventDefault();

    var hasSelection = false;
    try {
      hasSelection = typeof field.selectionStart === 'number'
        && field.selectionStart !== field.selectionEnd;
    } catch (error) {
      // type=number / date 等控件没有 selectionStart：退化成「无选中」。
      hasSelection = false;
    }

    api.showTextContextMenu({
      x: event.clientX,
      y: event.clientY,
      editable: !field.disabled && !field.readOnly,
      secret: field.type === 'password',
      hasSelection: hasSelection
    }).catch(function (error) {
      console.warn('[context-menu] failed:', error);
    });
  });

  // ---------------- 弹窗管理（L5 层） ----------------

  var dialogLayer = document.getElementById('dialogLayer');
  var DIALOGS = {
    microsoft: document.getElementById('dlgMicrosoft'),
    offline: document.getElementById('dlgOffline'),
    server: document.getElementById('dlgServer'),
    skin: document.getElementById('dlgSkin'),
    confirm: document.getElementById('dlgConfirm'),
    instance: document.getElementById('dlgInstance'),
    icon: document.getElementById('dlgIcon'),
    install: document.getElementById('dlgInstall'),
    packFiles: document.getElementById('dlgPackFiles'),
    addon: document.getElementById('dlgAddon'),
    task: document.getElementById('dlgTask')
  };
  var openDialogName = null;
  var dialogReturnFocus = null;
  var confirmCallback = null;
  var confirmPrompt = null;      // askPrompt 的待决状态：{ resolve, required }
  var taskDialogState = null;    // runTask 的当前任务：{ id, settled, cancelled, ... }

  function openDialog(name, trigger) {
    var pane = DIALOGS[name];
    if (!pane || !dialogLayer) return;

    if (openDialogName && DIALOGS[openDialogName] && openDialogName !== name) {
      // 切走「确认框」时，挂着的 askPrompt 必须有个结果，否则调用方永远等下去。
      if (openDialogName === 'confirm') settlePrompt(null);
      DIALOGS[openDialogName].classList.remove('is-open');
      DIALOGS[openDialogName].hidden = true;
    }

    dialogReturnFocus = trigger || document.activeElement;
    openDialogName = name;
    dialogLayer.hidden = false;
    pane.hidden = false;
    // 重启过渡：先落到初始帧，再加 is-open。
    pane.classList.remove('is-open');
    void pane.offsetWidth;
    pane.classList.add('is-open');

    window.setTimeout(function () {
      if (openDialogName !== name) return;
      var focusable = pane.querySelector('input:not([disabled]), select:not([disabled]), button:not([disabled])');
      if (focusable) focusable.focus();
    }, 140);
  }

  function closeDialog() {
    if (!openDialogName) return;
    // 安装 / 解压期间不允许把弹窗关掉，避免状态错乱。
    if (openDialogName === 'install' && installBusy) return;
    if (openDialogName === 'addon' && addonDialog.busy) return;
    // 任务跑着的时候只能通过「取消任务」结束，不能直接把进度框关掉。
    if (openDialogName === 'task' && taskDialogState && !taskDialogState.settled) return;

    var pane = DIALOGS[openDialogName];
    if (pane) {
      pane.classList.remove('is-open');
      pane.hidden = true;
    }

    openDialogName = null;
    if (dialogLayer) dialogLayer.hidden = true;
    closeAccountMenu();

    if (dialogReturnFocus && typeof dialogReturnFocus.focus === 'function') {
      try {
        dialogReturnFocus.focus();
      } catch (error) {
        // 元素可能已经被重绘掉
      }
    }
    dialogReturnFocus = null;
    // 关掉确认框 = 取消：把还在等结果的输入框/确认框调用方放行。
    settlePrompt(null);
    confirmCallback = null;
    taskDialogState = null;
  }

  if (dialogLayer) {
    dialogLayer.addEventListener('click', function (event) {
      var closer = event.target && event.target.closest ? event.target.closest('[data-dialog-close]') : null;
      if (closer) closeDialog();
    });
  }

  var confirmText = document.getElementById('confirmText');
  var confirmOk = document.getElementById('confirmOk');
  var confirmTitle = document.getElementById('dlgConfirmTitle');
  var confirmInputField = document.getElementById('confirmInputField');
  var confirmInputLabel = document.getElementById('confirmInputLabel');
  var confirmInput = document.getElementById('confirmInput');
  var confirmStatus = document.getElementById('confirmStatus');

  /** 把通用对话框恢复成「普通确认」的初始形态。 */
  function resetConfirmDialog() {
    if (confirmTitle) confirmTitle.textContent = '确认';
    if (confirmText) {
      confirmText.hidden = false;
      confirmText.textContent = '确定要继续吗？';
    }
    if (confirmInputField) confirmInputField.hidden = true;
    if (confirmInput) {
      confirmInput.value = '';
      confirmInput.placeholder = '';
      confirmInput.type = 'text';
      confirmInput.maxLength = 120;
      confirmInput.classList.remove('is-invalid');
      confirmInput.removeAttribute('aria-invalid');
    }
    if (confirmStatus) setHint(confirmStatus, '');
    if (confirmOk) {
      confirmOk.textContent = '确定';
      confirmOk.disabled = false;
    }
  }

  /** askPrompt 的收尾：同一个对话框只能有一个待决 Promise。 */
  function settlePrompt(value) {
    var pending = confirmPrompt;
    confirmPrompt = null;
    if (pending && typeof pending.resolve === 'function') pending.resolve(value);
  }

  function askConfirm(text, onConfirm, confirmLabel) {
    resetConfirmDialog();
    if (confirmText) confirmText.textContent = text;
    if (confirmOk) confirmOk.textContent = confirmLabel || '确定';
    confirmCallback = onConfirm;
    openDialog('confirm');
  }

  /**
   * 通用输入对话框：复用 dlgConfirm，加上一个输入框。
   *
   * 返回 Promise<string|null>：点「确定」得到 trim 后的值，取消 / 关闭得到 null。
   * 默认 required，留空会停在对话框里提示，不会静默返回空串。
   */
  function askPrompt(options) {
    var opts = options || {};

    return new Promise(function (resolve) {
      resetConfirmDialog();
      confirmCallback = null;

      if (confirmTitle) confirmTitle.textContent = opts.title || '请输入';
      if (confirmText) {
        if (opts.text) {
          confirmText.hidden = false;
          confirmText.textContent = opts.text;
        } else {
          confirmText.hidden = true;
          confirmText.textContent = '';
        }
      }
      if (confirmInputLabel) confirmInputLabel.textContent = opts.label || '名称';
      if (confirmInputField) confirmInputField.hidden = false;
      if (confirmInput) {
        confirmInput.value = opts.value == null ? '' : String(opts.value);
        confirmInput.placeholder = opts.placeholder || '';
        confirmInput.type = opts.password ? 'password' : 'text';
        if (Number(opts.maxLength) > 0) confirmInput.maxLength = Number(opts.maxLength);
      }
      if (confirmOk) confirmOk.textContent = opts.okText || '确定';

      confirmPrompt = {
        resolve: resolve,
        // required 默认 true；确实允许空值时显式传 allowEmpty: true。
        required: opts.required !== false && opts.allowEmpty !== true
      };

      openDialog('confirm');

      window.setTimeout(function () {
        if (openDialogName !== 'confirm' || !confirmInput) return;
        confirmInput.focus();
        try {
          confirmInput.select();
        } catch (error) {
          // 个别 input type 不支持 select()
        }
      }, 150);
    });
  }

  if (confirmOk) {
    confirmOk.addEventListener('click', function () {
      if (confirmPrompt) {
        var value = confirmInput ? confirmInput.value : '';
        if (confirmPrompt.required && !value.trim()) {
          setHint(confirmStatus, '不能为空', 'error');
          if (confirmInput) {
            confirmInput.classList.add('is-invalid');
            confirmInput.focus();
          }
          return;
        }

        var resolvePrompt = confirmPrompt.resolve;
        confirmPrompt = null;
        closeDialog();
        if (typeof resolvePrompt === 'function') resolvePrompt(value.trim());
        return;
      }

      var callback = confirmCallback;
      confirmCallback = null;
      closeDialog();
      if (typeof callback === 'function') callback();
    });
  }

  if (confirmInput) {
    confirmInput.addEventListener('input', function () {
      confirmInput.classList.remove('is-invalid');
      confirmInput.removeAttribute('aria-invalid');
      if (confirmStatus) setHint(confirmStatus, '');
    });

    confirmInput.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      if (confirmOk) confirmOk.click();
    });
  }

  // ---------------- 通用任务对话框（runTask） ----------------

  var taskTitleEl = document.getElementById('dlgTaskTitle');
  var taskStatusEl = document.getElementById('taskStatus');
  var taskProgressEl = document.getElementById('taskProgress');
  var taskProgressBar = document.getElementById('taskProgressBar');
  var taskCancelBtn = document.getElementById('taskCancel');
  var taskCloseBtn = document.getElementById('taskClose');

  /** percent 省略 = 不确定进度（来回滚动的条）。 */
  function setTaskProgress(text, percent) {
    if (text !== undefined && text !== null) setHint(taskStatusEl, String(text));

    var value = Number(percent);
    var determinate = percent !== undefined && percent !== null && Number.isFinite(value);

    if (taskProgressEl) {
      taskProgressEl.classList.toggle('is-indeterminate', !determinate);
      if (determinate) {
        var clamped = Math.max(0, Math.min(100, Math.round(value)));
        taskProgressEl.setAttribute('aria-valuenow', String(clamped));
        taskProgressEl.setAttribute('aria-valuetext', clamped + '%');
      } else {
        taskProgressEl.removeAttribute('aria-valuenow');
        taskProgressEl.setAttribute('aria-valuetext', '进行中');
      }
    }
    if (taskProgressBar) {
      taskProgressBar.style.width = determinate ? Math.max(0, Math.min(100, value)) + '%' : '';
    }
  }

  /** 安装 / 下载的进度事件顺手写进任务框，调用点不用自己接线。 */
  function noteActiveTask(message) {
    if (!taskDialogState || taskDialogState.settled) return;
    if (!message) return;
    setHint(taskStatusEl, String(message));
  }

  function taskErrorMessage(error) {
    var raw = error && error.message ? String(error.message) : String(error || '未知错误');
    var lines = raw.split(/\r?\n/).map(function (line) { return line.trim(); }).filter(Boolean);
    return lines[lines.length - 1] || '未知错误';
  }

  /**
   * 通用长任务对话框。
   *
   *   runTask({
   *     title: '安装整合包',
   *     cancelable: true,
   *     run: function (ctx) { return api.installModpack({ ... , taskId: ctx.taskId }); }
   *   })
   *
   * ctx.taskId 会随原有 IPC 传下去；点「取消任务」→ 主进程 task:cancel → abort
   * → mcdl 子进程被 kill / fetch 中断。取消时 Promise 结果为 null，失败时 reject。
   */
  function runTask(options) {
    var opts = options || {};

    return new Promise(function (resolve, reject) {
      var taskId = String(opts.taskId || ('task-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)));
      var state = { id: taskId, settled: false, cancelled: false };
      taskDialogState = state;

      if (taskTitleEl) taskTitleEl.textContent = opts.title || '任务';
      setTaskProgress(opts.status || '准备中…', null);
      if (taskCancelBtn) {
        taskCancelBtn.hidden = opts.cancelable === false;
        taskCancelBtn.disabled = false;
        taskCancelBtn.textContent = opts.cancelText || '取消任务';
      }
      if (taskCloseBtn) taskCloseBtn.hidden = true;

      openDialog('task');

      var ctx = {
        taskId: taskId,
        progress: function (text, percent) { setTaskProgress(text, percent); },
        isCancelled: function () { return state.cancelled; }
      };

      function finish(error, result) {
        if (state.settled) return;
        state.settled = true;

        if (taskCancelBtn) taskCancelBtn.hidden = true;
        if (taskCloseBtn) taskCloseBtn.hidden = false;
        if (taskProgressEl) taskProgressEl.classList.remove('is-indeterminate');

        var cancelled = Boolean(state.cancelled
          || (error && (error.cancelled || error.code === 'TASK_CANCELLED')));

        if (cancelled) {
          if (taskProgressBar) taskProgressBar.style.width = '0%';
          setHint(taskStatusEl, opts.cancelledText || '已取消', 'ok');
          window.setTimeout(function () {
            if (openDialogName === 'task' && taskDialogState === state) closeDialog();
          }, 900);
          resolve(null);
          return;
        }

        if (error) {
          if (taskProgressBar) taskProgressBar.style.width = '0%';
          setHint(taskStatusEl, '失败：' + taskErrorMessage(error), 'error');
          reject(error);
          return;
        }

        if (taskProgressBar) taskProgressBar.style.width = '100%';
        setHint(taskStatusEl, opts.doneText || '完成', 'ok');
        window.setTimeout(function () {
          if (openDialogName === 'task' && taskDialogState === state) closeDialog();
        }, 800);
        resolve(result);
      }

      Promise.resolve()
        .then(function () {
          if (typeof opts.run !== 'function') throw new Error('runTask 缺少 run()');
          return opts.run(ctx);
        })
        .then(function (result) { finish(null, result); }, function (error) { finish(error); });
    });
  }

  if (taskCancelBtn) {
    taskCancelBtn.addEventListener('click', function () {
      var state = taskDialogState;
      if (!state || state.settled || state.cancelled) return;

      state.cancelled = true;
      taskCancelBtn.disabled = true;
      setHint(taskStatusEl, '正在取消…');

      var api = window.launcherAPI;
      if (!api || typeof api.cancelTask !== 'function') return;
      Promise.resolve(api.cancelTask(state.id)).catch(function (error) {
        console.warn('[task] cancel failed:', error);
      });
    });
  }

  if (taskCloseBtn) {
    taskCloseBtn.addEventListener('click', function () {
      closeDialog();
    });
  }

  // ---------------- 账户列表 ----------------

  var openMenuId = null;

  function closeAccountMenu() {
    if (!openMenuId) return;
    var menu = document.querySelector('.account-menu');
    if (menu) menu.remove();
    openMenuId = null;
  }

  function openAccountMenu(id) {
    closeAccountMenu();

    var account = accountById(id);
    if (!account || !accountList) return;

    var item = accountList.querySelector('[data-account-id="' + id + '"]');
    if (!item) return;

    var trigger = item.querySelector('[data-account-menu]');
    if (!trigger) return;

    var menu = document.createElement('div');
    menu.className = 'account-menu';
    menu.setAttribute('role', 'menu');

    var addAction = function (label, action, danger) {
      var button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.setAttribute('data-menu-action', action);
      button.setAttribute('data-menu-account', id);
      button.textContent = label;
      if (danger) button.classList.add('is-danger');
      menu.appendChild(button);
    };

    if (account.id !== selectedAccountId) addAction('设为当前账户', 'use');
    if (account.type === 'offline') addAction('离线皮肤设置', 'skin');
    if (account.type === 'microsoft' || account.type === 'authlib') {
      addAction('刷新皮肤', 'refresh-skin');
      addAction('重新登录', 'relogin');
    }
    addAction('删除账户', 'delete', true);

    // 账户面板带 transform，挂在面板里会让 position: fixed 相对面板定位，
    // 所以菜单挂到 body 上，按视口坐标定位。
    document.body.appendChild(menu);

    var rect = trigger.getBoundingClientRect();
    var menuRect = menu.getBoundingClientRect();
    var top = rect.bottom + 6;
    if (top + menuRect.height > window.innerHeight - 12) {
      top = Math.max(12, rect.top - menuRect.height - 6);
    }
    menu.style.top = Math.round(top) + 'px';
    menu.style.left = Math.round(Math.min(rect.right - menuRect.width, window.innerWidth - menuRect.width - 12)) + 'px';

    openMenuId = id;

    var first = menu.querySelector('button');
    if (first) first.focus();
  }

  /**
   * 8×8 对称像素头像：颜色与图案都由玩家名哈希决定，同一个名字永远是同一张脸。
   * 有皮肤的账号会换成真实皮肤头部（见 loadTileSkin）。
   */
  function pixelAvatarSvg(name) {
    var seed = 2166136261;
    var text = String(name || '?');

    for (var i = 0; i < text.length; i += 1) {
      seed ^= text.charCodeAt(i);
      seed = Math.imul(seed, 16777619) >>> 0;
    }

    function next() {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    }

    // 色相限制在蓝—青—靛之间，和整体冷色调一致，避免出现大红大绿
    var hue = 200 + Math.floor(next() * 52);
    var palette = [
      'hsl(' + hue + ', 24%, 21%)',
      'hsl(' + ((hue + 10) % 360) + ', 27%, 31%)',
      'hsl(' + ((hue + 20) % 360) + ', 24%, 41%)',
      'hsl(' + ((hue + 4) % 360) + ', 20%, 15%)'
    ];

    var rects = [];
    for (var y = 0; y < 8; y += 1) {
      for (var x = 0; x < 4; x += 1) {
        var r = next();
        var color = r < 0.42 ? palette[0] : r < 0.68 ? palette[1] : r < 0.86 ? palette[2] : palette[3];
        rects.push('<rect x="' + x + '" y="' + y + '" width="1" height="1" fill="' + color + '"/>');
        rects.push('<rect x="' + (7 - x) + '" y="' + y + '" width="1" height="1" fill="' + color + '"/>');
      }
    }

    // 顶部一层极淡的高光，让方块看起来有体积感
    rects.push('<rect x="0" y="0" width="8" height="1" fill="rgba(255,255,255,.05)"/>');

    return '<svg viewBox="0 0 8 8" shape-rendering="crispEdges" aria-hidden="true">' + rects.join('') + '</svg>';
  }

  function loadTileSkin(id, node) {
    var api = window.launcherAPI;
    if (!api || typeof api.getSkinData !== 'function') return;

    api.getSkinData(id)
      .then(function (data) {
        if (!data || !data.dataUrl || !node.isConnected) {
          if (node.isConnected) node.classList.add('is-missing');
          return;
        }
        node.style.backgroundImage = 'url("' + data.dataUrl + '")';
        node.classList.remove('is-missing');
        node.hidden = false;
      })
      .catch(function () {
        if (node.isConnected) node.classList.add('is-missing');
      });
  }

  function renderAccounts() {
    if (!accountList) return;
    closeAccountMenu();
    accountList.innerHTML = '';
    accountList.classList.toggle('is-empty', ACCOUNTS.length === 0);

    if (accountCount) accountCount.textContent = String(ACCOUNTS.length);

    if (ACCOUNTS.length === 0) {
      var empty = document.createElement('p');
      empty.className = 'account-empty';
      empty.textContent = '还没有账户。从上面的卡片添加一个，账号会以头像卡片的形式出现在这里。';
      accountList.appendChild(empty);
      syncAccountChrome();
      return;
    }

    ACCOUNTS.forEach(function (account) {
      var isSelected = account.id === selectedAccountId;
      var tile = document.createElement('div');
      tile.className = 'account-tile' + (isSelected ? ' is-selected' : '');
      tile.setAttribute('role', 'listitem');
      tile.setAttribute('tabindex', '0');
      tile.setAttribute('data-account-id', account.id);
      tile.setAttribute('aria-label',
        account.name + ' · ' + accountTypeLabel(account) + (isSelected ? ' · 当前账号' : ''));

      var avatar = document.createElement('div');
      avatar.className = 'account-tile__avatar';

      // 兜底头像：皮肤没取到 / 加载失败时显示，识别度来自玩家名。
      var fallback = document.createElement('div');
      fallback.className = 'account-tile__fallback';
      fallback.innerHTML = pixelAvatarSvg(account.name);
      avatar.appendChild(fallback);

      // 微软 / 认证服务器的皮肤要联网取，离线账号也可能手动设过皮肤，
      // 所以一律先试一次；取不到就保留下面的兜底头像。
      var skin = document.createElement('div');
      skin.className = 'account-tile__skin';
      skin.hidden = true;
      avatar.appendChild(skin);
      loadTileSkin(account.id, skin);

      // 左上角类型标签：微软 / 离线 / 认证服务器
      var badge = accountKindBadge(account);
      var kind = document.createElement('span');
      kind.className = 'account-tile__kind account-tile__kind--' + badge.kind;
      kind.textContent = badge.text;
      avatar.appendChild(kind);

      if (isSelected) {
        var dot = document.createElement('span');
        dot.className = 'account-tile__dot';
        dot.setAttribute('aria-hidden', 'true');
        avatar.appendChild(dot);
      }

      tile.appendChild(avatar);

      var name = document.createElement('span');
      name.className = 'account-tile__name';
      name.textContent = account.name;
      tile.appendChild(name);

      var meta = document.createElement('span');
      meta.className = 'account-tile__meta';
      meta.textContent = (isSelected ? '当前 · ' : '') + accountTypeLabel(account);
      meta.title = accountTypeLabel(account);
      tile.appendChild(meta);

      var menuBtn = document.createElement('button');
      menuBtn.type = 'button';
      menuBtn.className = 'account-tile__menu';
      menuBtn.textContent = '⋯';
      menuBtn.setAttribute('aria-haspopup', 'true');
      menuBtn.setAttribute('aria-label', account.name + ' 的账户操作');
      menuBtn.setAttribute('data-account-menu', account.id);
      tile.appendChild(menuBtn);

      accountList.appendChild(tile);
    });

    syncAccountChrome();
  }

  function renderServers(preferredId) {
    var select = document.getElementById('authlibServer');
    if (!select) return;

    var current = preferredId || select.value;

    select.innerHTML = '';
    if (SERVERS.length === 0) {
      var emptyOption = document.createElement('option');
      emptyOption.value = '';
      emptyOption.textContent = '还没有认证服务器，先添加一个';
      select.appendChild(emptyOption);
      return;
    }

    SERVERS.forEach(function (server) {
      var option = document.createElement('option');
      option.value = server.id;
      option.textContent = server.name + ' · ' + server.apiRoot;
      select.appendChild(option);
    });

    var exists = SERVERS.some(function (server) { return server.id === current; });
    select.value = exists ? current : SERVERS[0].id;
  }

  function applyAccountSnapshot(snapshot) {
    if (!snapshot) return;
    ACCOUNTS = Array.isArray(snapshot.accounts) ? snapshot.accounts : [];
    selectedAccountId = snapshot.selectedId || null;
    if (Array.isArray(snapshot.servers)) SERVERS = snapshot.servers;
    renderServers();
    renderAccounts();
  }

  function loadAccounts() {
    var api = window.launcherAPI;
    if (!api || typeof api.getAccounts !== 'function') return;

    api.getAccounts()
      .then(applyAccountSnapshot)
      .catch(function (error) {
        console.error('[accounts] load failed:', error);
      });
  }

  // ---------------- L5：微软登录弹窗 ----------------

  var msaDialogStatus = document.getElementById('msaDialogStatus');
  var msaDialogLogin = document.getElementById('msaDialogLogin');
  var msaBusy = false;

  function openMsDialog() {
    setHint(msaDialogStatus, '');
    openDialog('microsoft');
  }

  function loginMicrosoft() {
    var api = window.launcherAPI;
    if (!api || typeof api.addMicrosoftAccount !== 'function') {
      setHint(msaDialogStatus, '主进程桥接不可用', 'error');
      return;
    }
    if (msaBusy) return;

    msaBusy = true;
    if (msaDialogLogin) msaDialogLogin.disabled = true;
    setHint(msaDialogStatus, '已打开登录窗口，请在其中完成微软登录…');

    api.addMicrosoftAccount()
      .then(function (snapshot) {
        applyAccountSnapshot(snapshot);
        var current = selectedAccount();
        setHint(msaDialogStatus, current ? '已登录：' + current.name : '登录完成', 'ok');
        window.setTimeout(closeDialog, 700);
      })
      .catch(function (error) {
        openAccountError(error, msaDialogStatus);
      })
      .then(function () {
        msaBusy = false;
        if (msaDialogLogin) msaDialogLogin.disabled = false;
      });
  }

  // ---------------- L5：添加账户弹窗（离线 / 正版登录） ----------------

  var offlineName = document.getElementById('offlineName');
  var offlineDialogStatus = document.getElementById('offlineDialogStatus');
  var offlineDialogLogin = document.getElementById('offlineDialogLogin');
  var authlibDialogLogin = document.getElementById('authlibDialogLogin');
  var tabOffline = document.getElementById('tabOffline');
  var tabAuthlib = document.getElementById('tabAuthlib');
  var paneOffline = document.getElementById('paneOffline');
  var paneAuthlib = document.getElementById('paneAuthlib');
  var authlibServer = document.getElementById('authlibServer');
  var authlibUser = document.getElementById('authlibUser');
  var authlibPass = document.getElementById('authlibPass');
  var authlibHint = document.getElementById('authlibHint');
  var accountBusy = false;

  // 添加离线账户时的内嵌皮肤选择（清单 CreateAccountPane.java:606 可点击面板 + :574 取消）
  var offlineSkinPreview = document.getElementById('offlineSkinPreview');
  var offlineSkinImage = document.getElementById('offlineSkinImage');
  var offlineSkinPlaceholder = document.getElementById('offlineSkinPlaceholder');
  var offlineSkinName = document.getElementById('offlineSkinName');
  var offlineSkinPick = document.getElementById('offlineSkinPick');
  var offlineSkinClear = document.getElementById('offlineSkinClear');
  var offlineSkinModel = document.getElementById('offlineSkinModel');
  var offlineSkinModelWrap = document.getElementById('offlineSkinModelWrap');
  var offlineSkinNote = document.getElementById('offlineSkinNote');
  var pendingSkin = null;

  function renderOfflineSkin() {
    var hasSkin = Boolean(pendingSkin && pendingSkin.dataUrl);

    if (offlineSkinImage) {
      if (hasSkin) {
        offlineSkinImage.src = pendingSkin.dataUrl;
        offlineSkinImage.hidden = false;
      } else {
        offlineSkinImage.removeAttribute('src');
        offlineSkinImage.hidden = true;
      }
    }
    if (offlineSkinPlaceholder) offlineSkinPlaceholder.hidden = hasSkin;
    if (offlineSkinName) {
      offlineSkinName.textContent = hasSkin
        ? pendingSkin.width + '×' + pendingSkin.height + ' · 创建后会应用到该账号'
        : '未选择，使用默认皮肤';
    }
    if (offlineSkinClear) offlineSkinClear.hidden = !hasSkin;
    // 模型只有选了皮肤才有意义，没选时整块收起来，避免出现一个灰掉的空下拉。
    if (offlineSkinModelWrap) offlineSkinModelWrap.hidden = !hasSkin;
    if (offlineSkinModel) offlineSkinModel.disabled = !hasSkin;
    // 选中皮肤后明确告知：只存本机，游戏内还需要皮肤服务。
    if (offlineSkinNote) offlineSkinNote.hidden = !hasSkin;
  }

  function clearOfflineSkin(focusPick) {
    pendingSkin = null;
    renderOfflineSkin();
    if (focusPick && offlineSkinPick) offlineSkinPick.focus();
  }

  function pickOfflineSkin() {
    var api = window.launcherAPI;
    if (!api || typeof api.pickSkinFile !== 'function') {
      setHint(offlineDialogStatus, '主进程桥接不可用', 'error');
      return;
    }

    api.pickSkinFile()
      .then(function (file) {
        if (!file) return;
        pendingSkin = file;
        renderOfflineSkin();
        setHint(offlineDialogStatus, '已选择皮肤，点「登录」创建账号时会一并保存', 'ok');
      })
      .catch(function (error) {
        openAccountError(error, offlineDialogStatus);
      });
  }

  function setAccountTab(tab) {
    var isOffline = tab !== 'authlib';

    if (tabOffline) tabOffline.setAttribute('aria-selected', String(isOffline));
    if (tabAuthlib) tabAuthlib.setAttribute('aria-selected', String(!isOffline));
    if (paneOffline) paneOffline.hidden = !isOffline;
    if (paneAuthlib) paneAuthlib.hidden = isOffline;
    if (offlineDialogLogin) offlineDialogLogin.hidden = !isOffline;
    if (authlibDialogLogin) authlibDialogLogin.hidden = isOffline;

    if (!isOffline && authlibHint) {
      authlibHint.textContent = SERVERS.length
        ? '登录成功后会用 authlib-injector 把游戏请求转发到该服务器。'
        : '还没有认证服务器。先关闭这个窗口，用「添加认证服务器」添加一个。';
    }

    setHint(offlineDialogStatus, '');
  }

  function openOfflineDialog(tab) {
    if (offlineName) offlineName.value = '';
    if (authlibUser) authlibUser.value = '';
    if (authlibPass) authlibPass.value = '';
    pendingSkin = null;
    renderOfflineSkin();
    renderServers();
    setAccountTab(tab || 'offline');
    openDialog('offline');
  }

  function submitOfflineAccount() {
    var api = window.launcherAPI;
    var name = offlineName ? offlineName.value.trim() : '';

    if (!api || typeof api.addOfflineAccount !== 'function') {
      setHint(offlineDialogStatus, '主进程桥接不可用', 'error');
      return;
    }
    if (!name) {
      setHint(offlineDialogStatus, '请输入玩家名', 'error');
      if (offlineName) offlineName.focus();
      return;
    }
    if (accountBusy) return;

    accountBusy = true;
    setHint(offlineDialogStatus, '正在创建…');

    var created = false;
    var keepOpen = false;

    api.addOfflineAccount(name)
      .then(function (snapshot) {
        created = true;
        applyAccountSnapshot(snapshot);

        // 选了皮肤就在创建后立刻挂到新账号上；皮肤失败不影响账号本身。
        if (!pendingSkin || !snapshot || !snapshot.selectedId) {
          setHint(offlineDialogStatus, '已创建并选中：' + name, 'ok');
          return null;
        }

        var accountId = snapshot.selectedId;
        var model = offlineSkinModel && offlineSkinModel.value === 'slim' ? 'slim' : 'classic';
        setHint(offlineDialogStatus, '账号已创建，正在保存皮肤…');

        return api.applySkin({ id: accountId, sourcePath: pendingSkin.filePath, model: model })
          .then(function (result) {
            if (result && result.account) updateAccountInList(result.account);
            setHint(offlineDialogStatus, '已创建并选中：' + name + '（含皮肤）', 'ok');
          })
          .catch(function (error) {
            keepOpen = true;
            setHint(offlineDialogStatus, '账号已创建，但皮肤保存失败：' + describeLaunchError(error), 'error');
          });
      })
      .catch(function (error) {
        keepOpen = true;
        openAccountError(error, offlineDialogStatus);
      })
      .then(function () {
        accountBusy = false;
        if (created && !keepOpen) window.setTimeout(closeDialog, 700);
      });
  }

  function submitAuthlibAccount() {
    var api = window.launcherAPI;
    if (!api || typeof api.loginAuthlib !== 'function') {
      setHint(offlineDialogStatus, '主进程桥接不可用', 'error');
      return;
    }

    var serverId = authlibServer ? authlibServer.value : '';
    var username = authlibUser ? authlibUser.value.trim() : '';
    var password = authlibPass ? authlibPass.value : '';

    if (!serverId) {
      setHint(offlineDialogStatus, '请先添加并选择一个认证服务器', 'error');
      return;
    }
    if (!username) {
      setHint(offlineDialogStatus, '请输入用户名', 'error');
      if (authlibUser) authlibUser.focus();
      return;
    }
    if (!password) {
      setHint(offlineDialogStatus, '请输入密码', 'error');
      if (authlibPass) authlibPass.focus();
      return;
    }
    if (accountBusy) return;

    accountBusy = true;
    setHint(offlineDialogStatus, '正在登录认证服务器…');

    api.loginAuthlib({ serverId: serverId, username: username, password: password })
      .then(function (result) {
        applyAccountSnapshot(result);
        setHint(offlineDialogStatus, '已登录并选中：' + (result.account ? result.account.name : username), 'ok');
        window.setTimeout(closeDialog, 600);
      })
      .catch(function (error) {
        openAccountError(error, offlineDialogStatus);
      })
      .then(function () {
        accountBusy = false;
      });
  }

  // ---------------- 账户列表：菜单动作 ----------------

  function selectAccount(id) {
    var api = window.launcherAPI;
    if (!api || typeof api.selectAccount !== 'function') return;
    api.selectAccount(id)
      .then(applyAccountSnapshot)
      .catch(function (error) {
        console.error('[accounts] select failed:', error);
      });
  }

  function handleAccountMenuAction(action, id) {
    var api = window.launcherAPI;
    var account = accountById(id);
    closeAccountMenu();
    if (!account) return;

    if (action === 'use') {
      selectAccount(id);
      return;
    }

    if (action === 'skin') {
      openSkinDialog(account);
      return;
    }

    if (action === 'refresh-skin') {
      if (!api || typeof api.refreshSkin !== 'function') return;
      api.refreshSkin(id)
        .then(function (result) {
          if (result && result.error) setLaunchNote(result.error, true);
          else setLaunchNote('已刷新 ' + account.name + ' 的皮肤', false);
          // 重新拉一次列表，让卡片按新皮肤重绘。
          return api.getAccounts();
        })
        .then(applyAccountSnapshot)
        .catch(function (error) {
          console.warn('[accounts] 刷新皮肤失败:', error && error.message);
          setLaunchNote('刷新皮肤失败：' + describeLaunchError(error), true);
        });
      return;
    }

    if (action === 'relogin') {
      if (account.type === 'microsoft') openMsDialog();
      else openOfflineDialog('authlib');
      return;
    }

    if (action === 'delete') {
      askConfirm('确定删除账户「' + account.name + '」吗？本机保存的令牌与皮肤会一起移除。', function () {
        if (!api || typeof api.removeAccount !== 'function') return;
        api.removeAccount(id)
          .then(applyAccountSnapshot)
          .catch(function (error) {
            console.error('[accounts] remove failed:', error);
          });
      }, '删除');
    }
  }

  // 菜单挂在 body 上，所以监听 document 而不是账户列表。
  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.closest) return;

    var menuTrigger = target.closest('[data-account-menu]');
    if (menuTrigger) {
      var id = menuTrigger.getAttribute('data-account-menu');
      if (openMenuId === id) closeAccountMenu();
      else openAccountMenu(id);
      return;
    }

    var actionEl = target.closest('[data-menu-action]');
    if (actionEl) {
      handleAccountMenuAction(actionEl.getAttribute('data-menu-action'), actionEl.getAttribute('data-menu-account'));
      return;
    }

    if (openMenuId) closeAccountMenu();

    // 点头像卡片本身就是切换账号
    var tile = target.closest('.account-tile');
    var tileId = tile ? tile.getAttribute('data-account-id') : null;
    if (tileId && tileId !== selectedAccountId) selectAccount(tileId);
  });

  // 键盘：卡片聚焦后回车 / 空格切换
  if (accountList) {
    accountList.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      var tile = event.target && event.target.closest ? event.target.closest('.account-tile') : null;
      if (!tile) return;
      event.preventDefault();
      var id = tile.getAttribute('data-account-id');
      if (id) selectAccount(id);
    });
  }

  // 滚动 / 改窗口大小时菜单会飘走，直接收起。
  if (accountList) {
    accountList.addEventListener('scroll', function () { closeAccountMenu(); }, true);
  }
  window.addEventListener('resize', function () { closeAccountMenu(); });

  // ---------------- 账户页入口（L2） ----------------

  if (accountEntries) {
    accountEntries.addEventListener('click', function (event) {
      var trigger = event.target && event.target.closest ? event.target.closest('[data-account-action]') : null;
      if (!trigger) return;

      var action = trigger.getAttribute('data-account-action');
      if (action === 'microsoft') {
        openMsDialog();
      } else if (action === 'offline') {
        openOfflineDialog('offline');
      } else if (action === 'server') {
        resetServerWizard();
        openDialog('server');
      }

      window.dispatchEvent(new CustomEvent('launcher:account-action', {
        detail: {
          action: action,
          key: trigger.getAttribute('data-control-key')
        }
      }));
    });
  }

  // ---------------- 弹窗内按钮 ----------------

  if (tabOffline) {
    tabOffline.addEventListener('click', function () { setAccountTab('offline'); });
  }
  if (tabAuthlib) {
    tabAuthlib.addEventListener('click', function () { setAccountTab('authlib'); });
  }
  if (offlineDialogLogin) {
    offlineDialogLogin.addEventListener('click', submitOfflineAccount);
  }
  if (offlineSkinPreview) {
    offlineSkinPreview.addEventListener('click', pickOfflineSkin);
  }
  if (offlineSkinPick) {
    offlineSkinPick.addEventListener('click', pickOfflineSkin);
  }
  if (offlineSkinClear) {
    offlineSkinClear.addEventListener('click', function () {
      clearOfflineSkin(true);
      setHint(offlineDialogStatus, '已取消皮肤选择，将使用默认皮肤', 'ok');
    });
  }
  if (authlibDialogLogin) {
    authlibDialogLogin.addEventListener('click', submitAuthlibAccount);
  }
  if (offlineName) {
    offlineName.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        submitOfflineAccount();
      }
    });
  }
  if (authlibPass) {
    authlibPass.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        submitAuthlibAccount();
      }
    });
  }
  if (msaDialogLogin) {
    msaDialogLogin.addEventListener('click', loginMicrosoft);
  }

  // 微软登录弹窗里的整块可点击面板：登录受阻时打开账号安全页
  var msaHelpPanel = document.getElementById('msaHelpPanel');
  if (msaHelpPanel) {
    msaHelpPanel.addEventListener('click', function () {
      var api = window.launcherAPI;
      if (!api || typeof api.openExternal !== 'function') {
        setHint(msaDialogStatus, '主进程桥接不可用', 'error');
        return;
      }
      api.openExternal('https://account.microsoft.com/security')
        .then(function () {
          setHint(msaDialogStatus, '已在浏览器中打开 Microsoft 账号安全页', 'ok');
        })
        .catch(function (error) {
          openAccountError(error, msaDialogStatus);
        });
    });
  }

  // ---------------- L5：添加认证服务器向导 ----------------

  var serverWizardPath = document.getElementById('serverWizardPath');
  var serverUrl = document.getElementById('serverUrl');
  var serverStepOne = document.getElementById('serverStepOne');
  var serverStepOneHint = document.getElementById('serverStepOneHint');
  var serverStepTwo = document.getElementById('serverStepTwo');
  var serverInfoName = document.getElementById('serverInfoName');
  var serverInfoApi = document.getElementById('serverInfoApi');
  var serverInfoImpl = document.getElementById('serverInfoImpl');
  var serverDialogStatus = document.getElementById('serverDialogStatus');
  var serverDialogNext = document.getElementById('serverDialogNext');
  var serverDialogPrev = document.getElementById('serverDialogPrev');
  var serverDialogFinish = document.getElementById('serverDialogFinish');
  var serverWizardStep = 1;
  var createdServer = null;
  var serverBusy = false;

  function setServerStep(step) {
    serverWizardStep = step;
    var isFirst = step === 1;

    if (serverStepOne) serverStepOne.hidden = !isFirst;
    if (serverStepOneHint) serverStepOneHint.hidden = !isFirst;
    if (serverStepTwo) serverStepTwo.hidden = isFirst;

    if (serverDialogNext) serverDialogNext.hidden = !isFirst;
    if (serverDialogPrev) serverDialogPrev.hidden = isFirst;
    if (serverDialogFinish) serverDialogFinish.hidden = isFirst;

    if (serverWizardPath) {
      var dots = serverWizardPath.querySelectorAll('.wizard-path__dot');
      for (var i = 0; i < dots.length; i += 1) {
        dots[i].classList.toggle('is-done', i < step);
      }
    }
  }

  function resetServerWizard() {
    serverWizardStep = 1;
    createdServer = null;
    if (serverUrl) serverUrl.value = '';
    if (serverInfoName) serverInfoName.textContent = '—';
    if (serverInfoApi) serverInfoApi.textContent = '—';
    if (serverInfoImpl) serverInfoImpl.textContent = '—';
    setHint(serverDialogStatus, '');
    setServerStep(1);
  }

  function submitServerUrl() {
    var api = window.launcherAPI;
    if (!api || typeof api.addAuthServer !== 'function') {
      setHint(serverDialogStatus, '主进程桥接不可用', 'error');
      return;
    }

    var url = serverUrl ? serverUrl.value.trim() : '';
    if (!url) {
      setHint(serverDialogStatus, '请输入认证服务器地址', 'error');
      if (serverUrl) serverUrl.focus();
      return;
    }
    if (serverBusy) return;

    serverBusy = true;
    if (serverDialogNext) serverDialogNext.disabled = true;
    setHint(serverDialogStatus, '正在验证地址并读取服务器信息…');

    api.addAuthServer(url)
      .then(function (result) {
        createdServer = result && result.server ? result.server : null;
        if (result && Array.isArray(result.servers)) SERVERS = result.servers;

        if (serverInfoName) serverInfoName.textContent = createdServer ? createdServer.name : '已添加';
        if (serverInfoApi) serverInfoApi.textContent = createdServer ? createdServer.apiRoot : url;
        if (serverInfoImpl) {
          serverInfoImpl.textContent = createdServer
            ? (createdServer.implementationName || 'authlib-injector') +
              (createdServer.implementationVersion ? ' ' + createdServer.implementationVersion : '')
            : '';
        }

        setServerStep(2);
        setHint(serverDialogStatus, '地址验证通过', 'ok');
        renderServers(createdServer ? createdServer.id : undefined);
      })
      .catch(function (error) {
        openAccountError(error, serverDialogStatus);
      })
      .then(function () {
        serverBusy = false;
        if (serverDialogNext) serverDialogNext.disabled = false;
      });
  }

  if (serverDialogNext) {
    serverDialogNext.addEventListener('click', submitServerUrl);
  }
  if (serverDialogPrev) {
    serverDialogPrev.addEventListener('click', function () {
      setHint(serverDialogStatus, '');
      setServerStep(1);
    });
  }
  if (serverDialogFinish) {
    serverDialogFinish.addEventListener('click', function () {
      renderServers(createdServer ? createdServer.id : undefined);
      closeDialog();
    });
  }
  if (serverUrl) {
    serverUrl.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        submitServerUrl();
      }
    });
  }

  // ---------------- L5：离线皮肤设置 ----------------

  var skinAccountId = null;
  var skinPendingPath = null;
  var skinFrame = document.getElementById('skinFrame');
  var skinImage = document.getElementById('skinImage');
  var skinFileMeta = document.getElementById('skinFileMeta');
  var skinModel = document.getElementById('skinModel');
  var skinDialogStatus = document.getElementById('skinDialogStatus');
  var skinPick = document.getElementById('skinPick');
  var skinConfirm = document.getElementById('skinConfirm');
  var skinClear = document.getElementById('skinClear');
  var skinBusy = false;

  function setSkinPreview(dataUrl, meta) {
    if (skinImage) {
      if (dataUrl) {
        skinImage.src = dataUrl;
        skinImage.hidden = false;
      } else {
        skinImage.removeAttribute('src');
        skinImage.hidden = true;
      }
    }
    if (skinFrame) skinFrame.classList.toggle('is-empty', !dataUrl);
    if (skinFileMeta) skinFileMeta.textContent = meta || '';
  }

  function openSkinDialog(account) {
    skinAccountId = account.id;
    skinPendingPath = null;

    if (skinModel) skinModel.value = account.skinModel === 'slim' ? 'slim' : 'classic';
    setHint(skinDialogStatus, '');
    setSkinPreview(null, account.hasSkin ? '已保存的皮肤' : '还没有选择皮肤');
    openDialog('skin');

    var api = window.launcherAPI;
    if (!account.hasSkin || !api || typeof api.getSkinData !== 'function') return;

    api.getSkinData(account.id)
      .then(function (data) {
        if (skinAccountId !== account.id) return;
        setSkinPreview(data && data.dataUrl, data && data.dataUrl ? '已保存的皮肤' : '还没有选择皮肤');
      })
      .catch(function (error) {
        console.warn('[accounts] skin preview failed:', error);
      });
  }

  if (skinPick) {
    skinPick.addEventListener('click', function () {
      var api = window.launcherAPI;
      if (!api || typeof api.pickSkinFile !== 'function') return;

      api.pickSkinFile()
        .then(function (file) {
          if (!file) return;
          skinPendingPath = file.filePath;
          setSkinPreview(file.dataUrl, file.width + '×' + file.height + ' · ' + file.filePath);
          setHint(skinDialogStatus, '已选择新皮肤，点「确定」保存', 'ok');
        })
        .catch(function (error) {
          openAccountError(error, skinDialogStatus);
        });
    });
  }

  if (skinConfirm) {
    skinConfirm.addEventListener('click', function () {
      var api = window.launcherAPI;
      if (!api) return;
      if (skinBusy) return;

      var id = skinAccountId;
      var model = skinModel ? skinModel.value : 'classic';

      if (!skinPendingPath) {
        // 只改了模型：保存模型即可。
        if (typeof api.setSkinModel === 'function') {
          api.setSkinModel({ id: id, model: model })
            .then(function (account) {
              updateAccountInList(account);
              closeDialog();
            })
            .catch(function (error) {
              openAccountError(error, skinDialogStatus);
            });
        } else {
          closeDialog();
        }
        return;
      }

      skinBusy = true;
      if (skinConfirm) skinConfirm.disabled = true;
      setHint(skinDialogStatus, '正在保存皮肤…');

      api.applySkin({ id: id, sourcePath: skinPendingPath, model: model })
        .then(function (result) {
          updateAccountInList(result && result.account);
          setHint(skinDialogStatus, '皮肤已保存', 'ok');
          window.setTimeout(closeDialog, 400);
        })
        .catch(function (error) {
          openAccountError(error, skinDialogStatus);
        })
        .then(function () {
          skinBusy = false;
          if (skinConfirm) skinConfirm.disabled = false;
        });
    });
  }

  if (skinClear) {
    skinClear.addEventListener('click', function () {
      var api = window.launcherAPI;
      if (!api || typeof api.clearSkin !== 'function' || !skinAccountId) return;

      api.clearSkin(skinAccountId)
        .then(function (account) {
          skinPendingPath = null;
          updateAccountInList(account);
          setSkinPreview(null, '还没有选择皮肤');
          setHint(skinDialogStatus, '皮肤已清除', 'ok');
        })
        .catch(function (error) {
          openAccountError(error, skinDialogStatus);
        });
    });
  }

  function updateAccountInList(account) {
    if (!account) return;
    for (var i = 0; i < ACCOUNTS.length; i += 1) {
      if (ACCOUNTS[i].id === account.id) {
        ACCOUNTS[i] = account;
        break;
      }
    }
    renderAccounts();
  }

  // Esc：先关弹窗，再关菜单；都要早于「关闭二级页面」的处理。
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;

    if (openDialogName) {
      event.stopPropagation();
      closeDialog();
      return;
    }
    if (openMenuId) {
      event.stopPropagation();
      closeAccountMenu();
    }
  }, true);

  // ---------------------------------------------------------
  // 设置面板：内存 / Java / 窗口尺寸 / 额外 JVM 参数
  // ---------------------------------------------------------
  function fillJavaOptions(runtimes, currentPath) {
    if (!settingsJava) return;
    settingsJava.innerHTML = '';

    var auto = document.createElement('option');
    auto.value = '';
    auto.textContent = '自动选择（按版本要求）';
    settingsJava.appendChild(auto);

    (runtimes || []).forEach(function (runtime) {
      var option = document.createElement('option');
      option.value = runtime.path;
      option.textContent = 'Java ' + runtime.major + ' · ' + runtime.version + ' · ' +
        (runtime.bitness === 32 ? '32 位' : '64 位') + ' · ' + runtime.path;
      settingsJava.appendChild(option);
    });

    if (currentPath) {
      var matched = (runtimes || []).some(function (runtime) {
        return runtime.path === currentPath;
      });
      if (!matched) {
        var custom = document.createElement('option');
        custom.value = currentPath;
        custom.textContent = '自定义 · ' + currentPath;
        settingsJava.appendChild(custom);
      }
    }

    settingsJava.value = currentPath || '';
  }

  function applyAnimationPreference(settings) {
    var disabled = Boolean(settings && settings.disableAnimations);
    document.body.classList.toggle('no-motion', disabled);
    // 视频壁纸跟着「关闭动画」一起停：继续解码既费电又和新设置相悖。
    if (wall && wall.settings) wallApply(wall.settings, wall.items);
  }

  function fillSettingsFields(settings, runtimes) {
    settings = settings || {};
    if (settingsMemory) settingsMemory.value = settings.memoryMb || '';
    if (settingsWidth) settingsWidth.value = settings.width || '';
    if (settingsHeight) settingsHeight.value = settings.height || '';
    if (settingsJvmArgs) settingsJvmArgs.value = settings.jvmArgs || '';
    if (settingsIsolation) settingsIsolation.value = settings.gameIsolation || 'auto';
    fillJavaOptions(runtimes, settings.javaPath || '');

    if (settingsAprilFools) settingsAprilFools.checked = Boolean(settings.disableAprilFools);
    if (settingsDisableAnimations) settingsDisableAnimations.checked = Boolean(settings.disableAnimations);
    if (settingsLanguage) settingsLanguage.value = settings.language || 'zh-CN';

    if (settingsVersionSource) settingsVersionSource.value = settings.versionListSource || 'auto';
    if (settingsDownloadSource) settingsDownloadSource.value = settings.downloadSource || 'auto';
    if (settingsAddonSource) settingsAddonSource.value = settings.addonSource || 'modrinth';

    if (settingsJavaCount) {
      settingsJavaCount.textContent = (runtimes ? runtimes.length : 0) + ' 个';
    }
    applyAnimationPreference(settings);
    // settings:get 比 wallpaper:list 慢（要扫 Java），只用它同步一次控件显示值；
    // 图层与列表以壁纸面板自己的那份数据为准，已经同步过就不再覆盖。
    if (!wall.loaded) wallSyncControls(settings);
  }

  function loadSettings() {
    var api = window.launcherAPI;
    if (!api || typeof api.getSettings !== 'function') return;

    if (settingsStatus) {
      settingsStatus.textContent = settingsLoaded ? '已就绪' : '正在读取 Java 列表…';
      settingsStatus.classList.remove('is-error');
    }

    api.getSettings()
      .then(function (data) {
        settingsCache = (data && data.settings) || {};
        fillSettingsFields(settingsCache, data && data.javaRuntimes);

        var count = data && data.javaRuntimes ? data.javaRuntimes.length : 0;
        if (settingsStatus) {
          settingsStatus.textContent = '检测到 ' + count + ' 个 Java 运行时 · 默认内存 ' +
            ((data && data.defaultMemoryMb) || '-') + ' MB';
        }
        if (settingsJavaStatus) {
          settingsJavaStatus.textContent = count
            ? '已扫描到 ' + count + ' 个运行时'
            : '没有扫描到 Java，可以手动安装后重新扫描';
        }
        settingsLoaded = true;
      })
      .catch(function (error) {
        if (settingsStatus) {
          settingsStatus.textContent = describeLaunchError(error);
          settingsStatus.classList.add('is-error');
        }
      });
  }

  /** 其它页签的控件没有保存按钮：改完立刻写盘。 */
  function saveSettingsPatch(patch, statusNode) {
    var api = window.launcherAPI;
    if (!api || typeof api.saveSettings !== 'function') {
      setHint(statusNode, '主进程桥接不可用', 'error');
      return Promise.resolve(null);
    }

    setHint(statusNode, '正在保存…');
    return api.saveSettings(patch)
      .then(function (saved) {
        settingsCache = saved;
        applyAnimationPreference(saved);
        setHint(statusNode, '已保存', 'ok');
        return saved;
      })
      .catch(function (error) {
        setHint(statusNode, describeLaunchError(error), 'error');
        return null;
      });
  }

  // ---------------------------------------------------------
  // 自上传壁纸
  //   L2 图层：#wallOuter 全屏 cover + 模糊 + 暗化；#wallInner 框内 contain + 同图虚化补边
  //   L3 视频：内外各一个 <video>，内层为主时钟
  //   L4 控件：外观页 7 个控件 + 壁纸库
  //   L5 降级：软件渲染 / 关动画 / 文件丢失 / 编码不支持
  // 默认样式下 #wallLayer 带 hidden，零绘制、零回归。
  // ---------------------------------------------------------
  var WALL_DEFAULTS = {
    wallMode: 'default',
    wallMedia: 'image',
    wallFile: '',
    wallPolicy: 'single',
    wallBlur: 18,
    wallDim: 30,
    wallInnerFit: 'contain',
    wallPip: true
  };
  var WALL_INNER_DIM_BASE = 0.12;    // 框内固定的一层可读性底
  var WALL_INNER_DIM_RATIO = 0.6;    // 再叠 wallDim × 0.6
  var WALL_DRIFT_SECONDS = 0.3;      // 内外视频允许的最大漂移
  var WALL_SAVE_DELAY = 500;         // 滑块延迟写盘

  var wallLayer = document.getElementById('wallLayer');
  var wallOuter = document.getElementById('wallOuter');
  var wallInnerMedia = document.getElementById('wallInnerMedia');
  var wallInnerFill = document.getElementById('wallInnerFill');

  var wallPane = {
    mode: document.getElementById('settingsWallMode'),
    custom: document.getElementById('wallCustomBlock'),
    current: document.getElementById('settingsWallCurrent'),
    kind: document.getElementById('settingsWallKind'),
    pickImage: document.getElementById('settingsWallPickImage'),
    pickVideo: document.getElementById('settingsWallPickVideo'),
    openFolder: document.getElementById('settingsWallOpenFolder'),
    pip: document.getElementById('settingsWallPip'),
    fit: document.getElementById('settingsWallFit'),
    blur: document.getElementById('settingsWallBlur'),
    blurValue: document.getElementById('settingsWallBlurValue'),
    dim: document.getElementById('settingsWallDim'),
    dimValue: document.getElementById('settingsWallDimValue'),
    policy: document.getElementById('settingsWallPolicy'),
    list: document.getElementById('wallList'),
    listCount: document.getElementById('wallListCount'),
    listEmpty: document.getElementById('wallListEmpty'),
    status: document.getElementById('settingsWallStatus')
  };

  var wall = {
    settings: null,
    items: [],
    root: '',
    missing: false,
    base: '',
    chosen: null,
    sessionPicked: false,
    innerVideo: null,
    outerVideo: null,
    syncTimer: 0,
    saveTimer: 0,
    pending: null,
    saveChain: null,
    loaded: false
  };

  function wallNum(value, fallback) {
    var n = Number(value);
    return isFinite(n) ? n : fallback;
  }

  function wallClampNumber(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function wallSetStatus(text, tone) {
    setHint(wallPane.status, text || '—', tone);
  }

  function wallSizeLabel(bytes) {
    var n = Number(bytes) || 0;
    if (!n) return '—';
    if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
    if (n >= 1024 * 1024) return Math.round(n / (1024 * 1024)) + ' MB';
    return Math.max(1, Math.round(n / 1024)) + ' KB';
  }

  function wallMotionOff() {
    if (document.body.classList.contains('no-motion')) return true;
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function wallSoftwareMode() {
    return document.body.classList.contains('is-software');
  }

  /** 只改 CSS 变量：拖滑块时实时生效、不重建 DOM、不写盘。 */
  function wallApplyVars(settings) {
    if (!wallLayer) return;
    settings = settings || WALL_DEFAULTS;
    var blur = wallClampNumber(wallNum(settings.wallBlur, 18), 0, 40);
    var dim = wallClampNumber(wallNum(settings.wallDim, 30), 0, 70);

    wallLayer.style.setProperty('--wall-blur', blur + 'px');
    wallLayer.style.setProperty('--wall-dim', (dim / 100).toFixed(3));
    wallLayer.style.setProperty('--wall-inner-dim',
      (WALL_INNER_DIM_BASE + dim * WALL_INNER_DIM_RATIO / 100).toFixed(3));
    wallLayer.style.setProperty('--wall-inner-fit',
      settings.wallInnerFit === 'cover' ? 'cover' : 'contain');
    wallLayer.classList.toggle('is-flat', settings.wallPip === false);
  }

  function wallPauseAll() {
    var list = [wall.innerVideo, wall.outerVideo];
    for (var i = 0; i < list.length; i += 1) {
      if (!list[i]) continue;
      try {
        list[i].pause();
      } catch (error) {
        // 元素可能已经被移除
      }
    }
  }

  function wallPlayAll() {
    var list = [wall.innerVideo, wall.outerVideo];
    for (var i = 0; i < list.length; i += 1) {
      var video = list[i];
      if (!video) continue;
      var played = video.play();
      // 自动播放被拒（没静音 / 策略变化）时静默失败，画面停在首帧总比崩掉好。
      if (played && typeof played.catch === 'function') played.catch(function () {});
    }
  }

  /** 拆掉图层与解码器。注意：它会把 #wallLayer 设为 hidden。 */
  function wallTeardown() {
    if (wall.syncTimer) {
      window.clearInterval(wall.syncTimer);
      wall.syncTimer = 0;
    }

    wallPauseAll();
    wall.innerVideo = null;
    wall.outerVideo = null;

    var nodes = [wallInnerMedia, wallOuter];
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      if (!node) continue;
      while (node.firstChild) node.removeChild(node.firstChild);
    }

    if (wallInnerFill) {
      wallInnerFill.hidden = true;
      wallInnerFill.style.backgroundImage = '';
    }
    if (wallLayer) wallLayer.hidden = true;
    document.body.classList.remove('has-wallpaper');
  }

  function wallFail(reason) {
    wallTeardown();
    wallSetStatus(reason + '，已回到默认样式', 'error');
  }

  function wallCreateVideo(url) {
    var video = document.createElement('video');
    video.muted = true;
    video.loop = true;
    video.preload = 'auto';
    video.playsInline = true;
    video.disablePictureInPicture = true;
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    video.setAttribute('disablepictureinpicture', '');
    video.setAttribute('aria-hidden', 'true');
    video.src = url;
    return video;
  }

  function wallMountImage(item) {
    var failed = function () {
      wallFail('壁纸图片加载失败');
    };

    var outerImg = document.createElement('img');
    outerImg.alt = '';
    outerImg.decoding = 'async';
    outerImg.addEventListener('error', failed);
    outerImg.src = item.url;
    wallOuter.appendChild(outerImg);

    var innerImg = document.createElement('img');
    innerImg.alt = '';
    innerImg.decoding = 'async';
    innerImg.addEventListener('error', failed);
    innerImg.src = item.url;
    wallInnerMedia.appendChild(innerImg);

    // 补边只在画中画开启时有意义：关掉时内外是同一条连续的 cover 图。
    if (wall.settings && wall.settings.wallPip !== false) {
      wallInnerFill.style.backgroundImage = 'url("' + item.url + '")';
      wallInnerFill.hidden = false;
    } else {
      wallInnerFill.style.backgroundImage = '';
      wallInnerFill.hidden = true;
    }
  }

  /**
   * @param {object} item 壁纸条目
   * @param {boolean} lite 软件渲染 / 关动画：只留首帧，不做全屏模糊
   */
  function wallMountVideo(item, lite) {
    var failed = function () {
      wallFail('视频加载失败，可能是不支持的编码（建议 mp4 / h264 或 webm）');
    };

    var inner = wallCreateVideo(item.url);
    inner.addEventListener('error', failed);
    wallInnerMedia.appendChild(inner);
    wall.innerVideo = inner;

    if (lite) {
      // 只解码一帧：暂停在第一帧，不跑渲染循环。
      inner.addEventListener('loadeddata', function () {
        if (wall.innerVideo !== inner) return;
        try {
          inner.pause();
          inner.currentTime = 0.01;
        } catch (error) {
          // 忽略 seek 失败
        }
      });
      return;
    }

    var outer = wallCreateVideo(item.url);
    outer.addEventListener('error', failed);
    wallOuter.appendChild(outer);
    wall.outerVideo = outer;

    inner.addEventListener('canplay', function () {
      if (wall.innerVideo !== inner) return;
      if (!document.hidden) wallPlayAll();
    });

    // 以内层为主时钟：外层（背景那张）追内层，用户看的是框内那张。
    wall.syncTimer = window.setInterval(function () {
      if (!wall.innerVideo || !wall.outerVideo) return;
      if (wall.innerVideo.paused || wall.outerVideo.paused) return;
      if (wall.innerVideo.readyState < 2 || wall.outerVideo.readyState < 2) return;
      if (Math.abs(wall.innerVideo.currentTime - wall.outerVideo.currentTime) > WALL_DRIFT_SECONDS) {
        try {
          wall.outerVideo.currentTime = wall.innerVideo.currentTime;
        } catch (error) {
          // 元数据还没就绪时 seek 会抛，下一轮再试
        }
      }
    }, 500);
  }

  function wallBaseKey(settings, items, motionOff, software) {
    var names = [];
    for (var i = 0; i < items.length; i += 1) {
      names.push(items[i].name + (items[i].active ? '!' : '') + (items[i].missing ? '?' : ''));
    }
    return [
      settings.wallMode,
      settings.wallMedia,
      settings.wallFile,
      settings.wallPip === false ? '0' : '1',
      settings.wallInnerFit,
      settings.wallPolicy,
      motionOff ? 'm' : '',
      software ? 's' : '',
      names.join(',')
    ].join('|');
  }

  function wallChooseItem(settings, items) {
    var pool = [];
    for (var i = 0; i < items.length; i += 1) {
      if (!items[i].missing && items[i].url) pool.push(items[i]);
    }
    if (!pool.length) return null;

    var active = null;
    for (var j = 0; j < pool.length; j += 1) {
      if (pool[j].active) active = pool[j];
    }

    function stillPooled(candidate) {
      if (!candidate) return false;
      for (var k = 0; k < pool.length; k += 1) {
        if (pool[k].name === candidate.name) return pool[k];
      }
      return false;
    }

    // single：只认"当前那一张"。找不到就说明文件丢了 —— 不能顺手换成列表里的
    // 另一张，那会让"壁纸没了"表现成"壁纸被换了"。
    if (settings.wallPolicy === 'single') return active;

    if (settings.wallPolicy === 'startup') {
      // 每次启动只掷一次：判断依据是本次会话是否已经选过。
      var kept = stillPooled(wall.chosen);
      if (kept && wall.sessionPicked) return kept;
      wall.chosen = pool[Math.floor(Math.random() * pool.length)];
      wall.sessionPicked = true;
      return wall.chosen;
    }

    // random：每次重建（切页 / 改设置 / 重新上传）重掷一次
    wall.chosen = pool[Math.floor(Math.random() * pool.length)];
    return wall.chosen;
  }

  function wallActive(settings) {
    return Boolean(settings && settings.wallMode === 'custom' && settings.wallFile);
  }

  /**
   * 应用壁纸。
   * @param {object} settings
   * @param {Array} items
   * @param {{force?: boolean}} [options]
   */
  function wallApply(settings, items, options) {
    if (!wallLayer) return;
    settings = settings || WALL_DEFAULTS;
    items = items || [];

    wall.settings = settings;
    wall.items = items;

    // 变量每次都刷：拖滑块要实时生效。
    wallApplyVars(settings);

    var software = wallSoftwareMode();
    var motionOff = wallMotionOff();
    var baseKey = wallBaseKey(settings, items, motionOff, software);

    if (!options || !options.force) {
      if (baseKey === wall.base) return;
    }
    wall.base = baseKey;

    if (!wallActive(settings)) {
      wallTeardown();
      return;
    }

    var item = wallChooseItem(settings, items);
    if (!item || !item.url) {
      wallTeardown();
      if (wall.missing) {
        wallSetStatus('壁纸文件不见了（被移动或删除），已回到默认样式', 'error');
      }
      return;
    }

    wallTeardown();

    var lite = item.kind === 'video' && (software || motionOff);
    wallLayer.hidden = false;
    document.body.classList.add('has-wallpaper');
    wallLayer.classList.toggle('is-video', item.kind === 'video');
    wallLayer.classList.toggle('is-lite', lite);

    if (item.kind === 'video') {
      wallMountVideo(item, lite);
    } else {
      wallMountImage(item);
    }
  }

  // ---- 外观页控件 ----

  function wallSyncControls(settings) {
    if (!wallPane.mode || !settings) return;

    var mode = settings.wallMode === 'custom' ? 'custom' : 'default';
    var blur = wallClampNumber(wallNum(settings.wallBlur, 18), 0, 40);
    var dim = wallClampNumber(wallNum(settings.wallDim, 30), 0, 70);
    var pip = settings.wallPip !== false;

    wallPane.mode.value = mode;
    if (wallPane.custom) wallPane.custom.hidden = mode !== 'custom';
    if (wallPane.pip) wallPane.pip.checked = pip;
    if (wallPane.fit) {
      wallPane.fit.value = settings.wallInnerFit === 'cover' ? 'cover' : 'contain';
      wallPane.fit.disabled = !pip;
    }
    if (wallPane.policy) wallPane.policy.value = settings.wallPolicy || 'single';
    if (wallPane.blur) wallPane.blur.value = String(blur);
    if (wallPane.blurValue) wallPane.blurValue.textContent = String(blur);
    if (wallPane.dim) wallPane.dim.value = String(dim);
    if (wallPane.dimValue) wallPane.dimValue.textContent = String(dim);

    var fitLine = wallPane.fit && wallPane.fit.closest ? wallPane.fit.closest('.settings-line') : null;
    if (fitLine) fitLine.classList.toggle('is-disabled', !pip);

    var active = null;
    for (var i = 0; i < wall.items.length; i += 1) {
      if (wall.items[i].active) active = wall.items[i];
    }

    if (wallPane.current) {
      wallPane.current.textContent = active ? active.label : '未选择';
      wallPane.current.title = active ? active.name : '';
    }
    if (wallPane.kind) {
      wallPane.kind.textContent = active
        ? (active.kind === 'video' ? '视频 · 引用' : '图片')
        : '—';
    }
  }

  function wallRenderList(items, settings) {
    if (!wallPane.list) return;

    while (wallPane.list.firstChild) wallPane.list.removeChild(wallPane.list.firstChild);

    var custom = settings && settings.wallMode === 'custom';
    for (var i = 0; i < items.length; i += 1) {
      wallPane.list.appendChild(wallBuildCard(items[i], custom));
    }

    if (wallPane.listCount) wallPane.listCount.textContent = items.length + ' 项';
    if (wallPane.listEmpty) wallPane.listEmpty.hidden = items.length > 0;
  }

  function wallBuildCard(item, custom) {
    var card = document.createElement('div');
    card.className = 'wall-card';
    card.setAttribute('role', 'listitem');
    card.setAttribute('tabindex', '0');
    if (item.active && custom) card.classList.add('is-active');
    if (item.missing) card.classList.add('is-missing');

    if (item.kind === 'video') {
      var videoThumb = document.createElement('span');
      videoThumb.className = 'wall-card__thumb wall-card__thumb--video';
      videoThumb.textContent = '▶';
      card.appendChild(videoThumb);
    } else {
      var img = document.createElement('img');
      img.className = 'wall-card__thumb';
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.src = item.thumb || item.url;
      card.appendChild(img);
    }

    var name = document.createElement('span');
    name.className = 'wall-card__name';
    name.textContent = item.label;
    name.title = item.name;
    card.appendChild(name);

    var meta = document.createElement('span');
    meta.className = 'wall-card__meta';
    meta.textContent = item.missing
      ? '文件已丢失'
      : (item.external ? '引用 · ' : '') + wallSizeLabel(item.size);
    card.appendChild(meta);

    if (item.active && custom) {
      var badge = document.createElement('span');
      badge.className = 'wall-card__badge';
      badge.textContent = '当前';
      card.appendChild(badge);
    }

    var del = document.createElement('button');
    del.className = 'wall-card__del';
    del.type = 'button';
    del.textContent = '×';
    del.title = item.kind === 'video' ? '清除引用（不删除原文件）' : '删除这张壁纸';
    del.setAttribute('aria-label', del.title + '：' + item.label);
    del.addEventListener('click', function (event) {
      event.stopPropagation();
      wallAskRemove(item);
    });
    card.appendChild(del);

    card.addEventListener('click', function () {
      wallActivate(item);
    });
    card.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      wallActivate(item);
    });

    return card;
  }

  function wallActivate(item) {
    if (!item || item.missing) return;
    if (item.kind === 'video') {
      // 视频只能通过「上传视频」换：引用路径不允许渲染层自己写。
      wallSetStatus('视频壁纸请用「上传视频」重新选择');
      return;
    }
    if (wall.settings && wall.settings.wallMode === 'custom' &&
        wall.settings.wallFile === item.name) {
      return;
    }
    wallSave({ wallMode: 'custom', wallMedia: 'image', wallFile: item.name }, '已切换壁纸');
  }

  function wallAskRemove(item) {
    var detail = item.kind === 'video'
      ? '只会清除引用，不会删除原视频文件。'
      : '图片会从数据目录中删除，此操作不可撤销。';
    askConfirm('确定移除壁纸「' + item.label + '」吗？\n' + detail, function () {
      var api = window.launcherAPI;
      if (!api || typeof api.removeWallpaper !== 'function') {
        wallSetStatus('主进程桥接不可用', 'error');
        return;
      }
      wallSetStatus('正在移除…');
      api.removeWallpaper({ name: item.name, kind: item.kind })
        .then(function (result) {
          if (!result) return;
          wallAcknowledge(result);
          wallSetStatus('已移除「' + item.label + '」', 'ok');
        })
        .catch(function (error) {
          wallSetStatus(describeLaunchError(error), 'error');
        });
    }, '移除');
  }

  /** 主进程返回的 { settings, items, root, missing } 统一落到界面与图层。 */
  function wallAcknowledge(payload) {
    if (!payload) return;
    var settings = payload.settings || WALL_DEFAULTS;
    var items = payload.items || [];

    wall.root = payload.root || wall.root;
    wall.missing = Boolean(payload.missing);
    // 先落数据再同步控件：wallSyncControls 要靠 wall.items 找"当前那一张"。
    wall.settings = settings;
    wall.items = items;
    wallSyncControls(settings);
    wallRenderList(items, settings);
    wallApply(settings, items);
  }

  function wallSave(patch, okText) {
    var api = window.launcherAPI;
    if (!api || typeof api.saveSettings !== 'function') {
      wallSetStatus('主进程桥接不可用', 'error');
      return Promise.resolve(null);
    }

    wallSetStatus('正在保存…');

    // 串行化：连续拖滑块时后发的响应不能覆盖先发的。
    var run = function () {
      return api.saveSettings(patch)
        .then(function (saved) {
          wallSetStatus(okText || '已保存', 'ok');
          return wallRefresh(false).then(function () {
            return saved;
          });
        })
        .catch(function (error) {
          wallSetStatus(describeLaunchError(error), 'error');
          return null;
        });
    };

    wall.saveChain = (wall.saveChain || Promise.resolve()).then(run, run);
    return wall.saveChain;
  }

  function wallQueueSave(patch) {
    if (!patch) return;
    wall.pending = wall.pending || {};
    for (var key in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) wall.pending[key] = patch[key];
    }
    if (wall.saveTimer) window.clearTimeout(wall.saveTimer);
    wall.saveTimer = window.setTimeout(wallFlushSave, WALL_SAVE_DELAY);
  }

  function wallFlushSave() {
    if (wall.saveTimer) {
      window.clearTimeout(wall.saveTimer);
      wall.saveTimer = 0;
    }
    var patch = wall.pending;
    wall.pending = null;
    if (!patch) return;
    wallSave(patch, '已保存');
  }

  function wallRefresh() {
    var api = window.launcherAPI;
    if (!api || typeof api.listWallpapers !== 'function') return Promise.resolve(null);

    return api.listWallpapers()
      .then(function (payload) {
        if (!payload) return null;
        wall.loaded = true;
        wallAcknowledge(payload);
        if (wall.missing) {
          wallSetStatus('壁纸文件不见了（被移动或删除），已回到默认样式', 'error');
        }
        return payload;
      })
      .catch(function (error) {
        wallSetStatus(describeLaunchError(error), 'error');
        return null;
      });
  }

  function wallPick(media) {
    var api = window.launcherAPI;
    if (!api || typeof api.pickWallpaper !== 'function') {
      wallSetStatus('主进程桥接不可用', 'error');
      return;
    }

    wallSetStatus(media === 'video' ? '正在选择视频…' : '正在选择图片…');

    api.pickWallpaper(media)
      .then(function (payload) {
        if (!payload) {
          wallSetStatus('已取消');
          return;
        }
        wallAcknowledge(payload);

        var warnings = payload.warnings || [];
        if (warnings.length) {
          wallSetStatus(warnings.join('；'), 'error');
        } else {
          wallSetStatus('壁纸已更新', 'ok');
        }
      })
      .catch(function (error) {
        wallSetStatus(describeLaunchError(error), 'error');
      });
  }

  function wallBindSlider(input, valueNode, key) {
    if (!input) return;

    var paint = function () {
      if (valueNode) valueNode.textContent = input.value;
    };

    input.addEventListener('input', function () {
      paint();
      // 实时预览：只改 CSS 变量，延迟 500ms 才写盘（否则每拖一下写一次盘）。
      var preview = {};
      for (var k in WALL_DEFAULTS) {
        if (Object.prototype.hasOwnProperty.call(WALL_DEFAULTS, k)) {
          preview[k] = wall.settings ? wall.settings[k] : WALL_DEFAULTS[k];
        }
      }
      preview[key] = Number(input.value);
      wallApplyVars(preview);

      var patch = {};
      patch[key] = Number(input.value);
      wallQueueSave(patch);
    });

    input.addEventListener('change', function () {
      paint();
      wallFlushSave();
    });
  }

  if (wallPane.mode) {
    wallPane.mode.addEventListener('change', function () {
      var mode = wallPane.mode.value === 'custom' ? 'custom' : 'default';
      if (wallPane.custom) wallPane.custom.hidden = mode !== 'custom';
      wallSave({ wallMode: mode }, mode === 'custom' ? '已启用自定义壁纸' : '已回到默认样式');
    });
  }

  if (wallPane.pickImage) {
    wallPane.pickImage.addEventListener('click', function () {
      wallPick('image');
    });
  }

  if (wallPane.pickVideo) {
    wallPane.pickVideo.addEventListener('click', function () {
      wallPick('video');
    });
  }

  if (wallPane.openFolder) {
    wallPane.openFolder.addEventListener('click', function () {
      var api = window.launcherAPI;
      if (!api || typeof api.openWallpaperFolder !== 'function') return;
      api.openWallpaperFolder().catch(function (error) {
        wallSetStatus(describeLaunchError(error), 'error');
      });
    });
  }

  if (wallPane.pip) {
    wallPane.pip.addEventListener('change', function () {
      var pip = Boolean(wallPane.pip.checked);
      if (wallPane.fit) {
        wallPane.fit.disabled = !pip;
        var line = wallPane.fit.closest ? wallPane.fit.closest('.settings-line') : null;
        if (line) line.classList.toggle('is-disabled', !pip);
      }
      wallSave({ wallPip: pip }, pip ? '画中画已开启' : '画中画已关闭（内外同一张 cover）');
    });
  }

  if (wallPane.fit) {
    wallPane.fit.addEventListener('change', function () {
      wallSave({ wallInnerFit: wallPane.fit.value === 'cover' ? 'cover' : 'contain' }, '已保存');
    });
  }

  if (wallPane.policy) {
    wallPane.policy.addEventListener('change', function () {
      wall.chosen = null;
      wall.sessionPicked = false;
      wallSave({ wallPolicy: wallPane.policy.value }, '已保存');
    });
  }

  wallBindSlider(wallPane.blur, wallPane.blurValue, 'wallBlur');
  wallBindSlider(wallPane.dim, wallPane.dimValue, 'wallDim');

  // 切到后台时暂停两路解码；回到前台再恢复。
  document.addEventListener('visibilitychange', function () {
    if (!wall.innerVideo && !wall.outerVideo) return;
    if (document.hidden) wallPauseAll();
    else wallPlayAll();
  });

  var settingsTabs = createTabs({
    tabAttr: 'data-settings-tab',
    panelAttr: 'data-settings-pane',
    onChange: function (tab) {
      // 「关于」第一次打开时才去问主进程版本号，避免每次进设置都拉一遍。
      if (tab === 'about' && settingsAboutVersion &&
          settingsAboutVersion.textContent === 'MCDL Launcher') {
        loadAppInfo();
      }
    }
  });

  function setSettingsTab(tab) {
    settingsTab = tab || 'game';
    settingsTabs.set(settingsTab);
  }

  function loadAppInfo() {
    var api = window.launcherAPI;
    if (!api || typeof api.getAppInfo !== 'function') return;

    api.getAppInfo()
      .then(function (info) {
        if (!info) return;
        if (settingsAboutVersion) settingsAboutVersion.textContent = 'MCDL Launcher ' + info.version;
        if (settingsAboutMeta) {
          settingsAboutMeta.textContent = [
            'Electron ' + info.electron + ' · Chromium ' + info.chrome + ' · Node ' + info.node,
            '平台 ' + info.platform,
            '数据目录 ' + info.userData,
            '游戏目录 ' + info.gameDir
          ].join('\n');
        }
      })
      .catch(function (error) {
        console.warn('[settings] could not load app info:', error);
        if (settingsAboutMeta) settingsAboutMeta.textContent = '读取版本信息失败';
      });
  }

  if (settingsJava) {
    settingsJava.addEventListener('change', function () {
      saveSettingsPatch({ javaPath: settingsJava.value }, settingsJavaStatus);
    });
  }

  if (settingsJavaScan) {
    settingsJavaScan.addEventListener('click', function () {
      settingsLoaded = false;
      setHint(settingsJavaStatus, '正在重新扫描…');
      loadSettings();
    });
  }

  // 自定义 Java：对话框由主进程弹，选完它自己验证 + 登记指纹，这里只负责保存。
  if (settingsJavaPick) {
    settingsJavaPick.addEventListener('click', function () {
      var api = window.launcherAPI;
      if (!api || typeof api.pickJava !== 'function') {
        setHint(settingsJavaStatus, '主进程桥接不可用，无法选择 Java');
        return;
      }

      setHint(settingsJavaStatus, '正在验证所选 Java…');
      api.pickJava()
        .then(function (picked) {
          if (!picked) {
            setHint(settingsJavaStatus, '已取消');
            return;
          }
          return saveSettingsPatch({ javaPath: picked.path }, settingsJavaStatus)
            .then(function () {
              settingsLoaded = false;
              loadSettings();
            });
        })
        .catch(function (error) {
          setHint(settingsJavaStatus, '无法使用这个 Java：' + describeLaunchError(error), 'error');
        });
    });
  }

  if (settingsAprilFools) {
    settingsAprilFools.addEventListener('change', function () {
      saveSettingsPatch({ disableAprilFools: settingsAprilFools.checked }, settingsGeneralStatus);
    });
  }

  if (settingsOpenLogs) {
    settingsOpenLogs.addEventListener('click', function () {
      var api = window.launcherAPI;
      if (!api || typeof api.openLogFolder !== 'function') {
        setHint(settingsGeneralStatus, '主进程桥接不可用', 'error');
        return;
      }
      api.openLogFolder()
        .then(function () {
          setHint(settingsGeneralStatus, '已打开日志文件夹', 'ok');
        })
        .catch(function (error) {
          setHint(settingsGeneralStatus, describeLaunchError(error), 'error');
        });
    });
  }

  if (settingsDisableAnimations) {
    settingsDisableAnimations.addEventListener('change', function () {
      document.body.classList.toggle('no-motion', settingsDisableAnimations.checked);
      saveSettingsPatch({ disableAnimations: settingsDisableAnimations.checked }, null);
    });
  }

  [
    [settingsVersionSource, 'versionListSource'],
    [settingsDownloadSource, 'downloadSource'],
    [settingsAddonSource, 'addonSource']
  ].forEach(function (pair) {
    if (!pair[0]) return;
    pair[0].addEventListener('change', function () {
      var patch = {};
      patch[pair[1]] = pair[0].value;
      saveSettingsPatch(patch, settingsDownloadStatus);
    });
  });

  if (settingsOpenRepo) {
    settingsOpenRepo.addEventListener('click', function () {
      var api = window.launcherAPI;
      if (api && typeof api.openExternal === 'function') {
        api.openExternal('https://github.com/jkoyli/mcdl-launcher');
      }
    });
  }

  if (settingsOpenLicense) {
    settingsOpenLicense.addEventListener('click', function () {
      var api = window.launcherAPI;
      if (api && typeof api.openExternal === 'function') {
        api.openExternal('https://github.com/jkoyli/mcdl-launcher/blob/main/LICENSE');
      }
    });
  }

  if (settingsForm) {
    settingsForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var api = window.launcherAPI;
      if (!api || typeof api.saveSettings !== 'function') return;

      if (settingsStatus) {
        settingsStatus.textContent = '正在保存…';
        settingsStatus.classList.remove('is-error');
      }

      api.saveSettings({
        memoryMb: settingsMemory ? settingsMemory.value : '',
        width: settingsWidth ? settingsWidth.value : '',
        height: settingsHeight ? settingsHeight.value : '',
        jvmArgs: settingsJvmArgs ? settingsJvmArgs.value : '',
        gameIsolation: settingsIsolation ? settingsIsolation.value : 'auto'
      })
        .then(function (saved) {
          settingsCache = saved;
          if (settingsMemory) settingsMemory.value = saved.memoryMb;
          if (settingsWidth) settingsWidth.value = saved.width;
          if (settingsHeight) settingsHeight.value = saved.height;
          if (settingsStatus) {
            settingsStatus.textContent = '已保存：' + saved.memoryMb + ' MB · ' +
              saved.width + '×' + saved.height;
          }
        })
        .catch(function (error) {
          if (settingsStatus) {
            settingsStatus.textContent = describeLaunchError(error);
            settingsStatus.classList.add('is-error');
          }
        });
    });
  }

  // ---------------------------------------------------------
  // 账户 / 设置：包装页面栈
  // ---------------------------------------------------------
  var overlayPanel = null;

  function closeOverlayPanel(options) {
    if (!overlayPanel) return;
    closeActivePanel(options || {});
  }

  function openOverlayPanel(name) {
    if (name !== 'account' && name !== 'settings') return;
    showPanel(name);

    if (name === 'account') {
      loadAccounts();
      window.setTimeout(function () {
        // 账户页的首个入口按钮（微软账户）拿到焦点，而不是弹窗里的输入框。
        var firstEntry = accountEntries ? accountEntries.querySelector('.account-action') : null;
        if (firstEntry) firstEntry.focus();
      }, 240);
    } else {
      setSettingsTab(settingsTab);
      loadSettings();
    }
  }

  /** 「全局游戏设置」= 一次跳转，落到设置页的游戏设置区。 */
  function openGlobalGameSettings() {
    openOverlayPanel('settings');
    setSettingsTab('game');
    window.setTimeout(function () {
      var form = document.getElementById('settingsForm');
      if (!form) return;
      form.classList.remove('is-flash');
      void form.offsetWidth;
      form.classList.add('is-flash');
      var first = form.querySelector('input');
      if (first) first.focus();
    }, 260);
  }

  if (accountBack) {
    accountBack.addEventListener('click', function () {
      closeOverlayPanel({ focus: true });
    });
  }

  if (settingsBack) {
    settingsBack.addEventListener('click', function () {
      closeOverlayPanel({ focus: true });
    });
  }

  // ---------------------------------------------------------
  // 实例列表页：渲染 / 右键菜单 / 实例操作
  // ---------------------------------------------------------
  var instancePanelStatus = null;
  var openInstanceMenuId = null;
  var dialogInstanceId = null;

  var INSTANCE_MENU_ITEMS = [
    { action: 'detail', label: '实例详情' },
    { action: 'launch', label: '启动游戏' },
    { action: 'test', label: '测试游戏' },
    { action: 'script', label: '生成启动脚本' },
    { action: 'rename', label: '重命名该实例' },
    { action: 'icon', label: '更换图标' },
    { action: 'duplicate', label: '复制游戏实例' },
    { action: 'delete', label: '删除该实例', danger: true },
    { action: 'export', label: '导出整合包', disabled: true, hint: '导出整合包待接入' },
    { action: 'folder', label: '实例运行文件夹' }
  ];

  function instanceById(id) {
    for (var i = 0; i < INSTANCES.length; i += 1) {
      if (INSTANCES[i].id === id) return INSTANCES[i];
    }
    return null;
  }

  function instanceLabel(instance) {
    return instance ? (instance.displayName || instance.versionName || instance.profileName || '实例') : '实例';
  }

  function setInstancePanelStatus(text, tone) {
    if (!instancePanelStatus) instancePanelStatus = document.getElementById('instancePanelStatus');
    if (!instancePanelStatus) return;
    instancePanelStatus.textContent = text || '';
    instancePanelStatus.classList.toggle('is-error', tone === 'error');
    instancePanelStatus.classList.toggle('is-ok', tone === 'ok');
  }

  function buildIlistEmpty(title, hint) {
    var wrap = document.createElement('div');
    wrap.className = 'ilist-empty';

    var head = document.createElement('span');
    head.textContent = title;
    wrap.appendChild(head);

    if (hint) {
      var sub = document.createElement('span');
      sub.textContent = hint;
      wrap.appendChild(sub);
    }

    return wrap;
  }

  var instancePanelSignature = '';

  /**
   * 只同步选中态：选中时不能整表重建，否则单击的行元素会被替换，
   * 紧接着的第二次点击就落在新元素上，dblclick 永远触发不了。
   */
  function syncInstancePanelSelection() {
    var rows = document.getElementById('instanceRows');
    if (!rows) return;

    Array.prototype.forEach.call(rows.querySelectorAll('[data-instance-row]'), function (row) {
      var selected = row.getAttribute('data-instance-row') === selectedInstanceId;
      row.classList.toggle('is-selected', selected);

      var badge = row.querySelector('.badge--current');
      if (badge) badge.hidden = !selected;
    });
  }

  function renderInstancePanel() {
    var rows = document.getElementById('instanceRows');
    if (!rows) return;

    var count = document.getElementById('instancePanelCount');
    if (count) count.textContent = String(INSTANCES.length);

    // 名字 / 图标变了也要重建，所以签名里带上这两项。
    var signature = INSTANCES.map(function (item) {
      return [item.id, item.displayName || '', item.iconKey || '', item.iconDataUrl ? item.iconDataUrl.length : 0].join('~');
    }).join('|') + '::' + instanceLoadState;

    // 实例集合没变（只是换了选中）→ 原地同步，不重建。
    if (signature === instancePanelSignature && rows.children.length > 0) {
      syncInstancePanelSelection();
      return;
    }
    instancePanelSignature = signature;

    rows.innerHTML = '';

    if (instanceLoadState === 'loading') {
      rows.appendChild(buildIlistEmpty('正在读取实例…', '扫描游戏目录中的 versions'));
      return;
    }

    if (instanceLoadState === 'error') {
      rows.appendChild(buildIlistEmpty('无法读取实例', instanceLoadError || '主进程没有返回数据'));
      return;
    }

    if (INSTANCES.length === 0) {
      var empty = buildIlistEmpty('还没有实例', '点下面的「新建实例」安装一个原版，或用「扫描实例」找其他启动器。');
      var createBtn = document.createElement('button');
      createBtn.type = 'button';
      createBtn.className = 'dialog-btn';
      createBtn.textContent = '新建实例';
      createBtn.addEventListener('click', openCreatePanel);
      empty.appendChild(createBtn);
      rows.appendChild(empty);
      return;
    }

    INSTANCES.forEach(function (instance) {
      var selected = instance.id === selectedInstanceId;

      var row = document.createElement('div');
      row.className = 'ilist-row' + (selected ? ' is-selected' : '');
      row.setAttribute('role', 'listitem');
      row.setAttribute('tabindex', '0');
      row.setAttribute('data-instance-row', instance.id);

      var avatar = document.createElement('span');
      avatar.className = 'ilist-row__avatar';
      avatar.setAttribute('aria-hidden', 'true');
      fillInstanceIcon(avatar, instance);

      var main = document.createElement('div');
      main.className = 'ilist-row__main';

      var name = document.createElement('span');
      name.className = 'ilist-row__name';
      name.textContent = instanceLabel(instance);

      var meta = document.createElement('span');
      meta.className = 'ilist-row__meta';
      meta.textContent = instanceMeta(instance);

      main.appendChild(name);
      main.appendChild(meta);

      var badges = document.createElement('div');
      badges.className = 'ilist-row__badges';

      // 版本徽标只在它真的提供额外信息时显示：
      // 整合包实例的 versionName 常常回退成实例名，重复显示会挤掉别的徽标。
      var versionText = String(instance.versionName || '').trim();
      var labelText = instanceLabel(instance);
      if (versionText && versionText !== labelText && versionText.length <= 20) {
        var versionBadge = document.createElement('span');
        versionBadge.className = 'badge';
        versionBadge.textContent = versionText;
        versionBadge.title = versionText;
        badges.appendChild(versionBadge);
      }

      var loaderText = loaderLabel(instance);
      if (loaderText && loaderText !== 'Vanilla') {
        var loaderBadge = document.createElement('span');
        loaderBadge.className = 'badge badge--loader';
        loaderBadge.textContent = loaderText;
        badges.appendChild(loaderBadge);
      }

      if (instance.origin === 'external') {
        var externalBadge = document.createElement('span');
        externalBadge.className = 'badge badge--external';
        externalBadge.textContent = '外部';
        badges.appendChild(externalBadge);
      }

      // 「当前」徽标常驻，靠 hidden 切换，这样选中态可以原地更新。
      var currentBadge = document.createElement('span');
      currentBadge.className = 'badge badge--current';
      currentBadge.textContent = '当前';
      currentBadge.hidden = !selected;
      badges.appendChild(currentBadge);

      var menuBtn = document.createElement('button');
      menuBtn.type = 'button';
      menuBtn.className = 'ilist-row__menu';
      menuBtn.textContent = '⋯';
      menuBtn.setAttribute('aria-haspopup', 'true');
      menuBtn.setAttribute('aria-label', instanceLabel(instance) + ' 的操作');
      menuBtn.setAttribute('data-instance-menu', instance.id);

      row.appendChild(avatar);
      row.appendChild(main);
      row.appendChild(badges);
      row.appendChild(menuBtn);
      rows.appendChild(row);
    });
  }

  function closeInstanceMenu() {
    if (!openInstanceMenuId) return;
    var menu = document.querySelector('.ctx-menu');
    if (menu) menu.remove();
    openInstanceMenuId = null;
  }

  function openInstanceMenu(id, anchor) {
    closeInstanceMenu();
    closeAccountMenu();

    if (!instanceById(id) || !anchor) return;

    var menu = document.createElement('div');
    menu.className = 'account-menu ctx-menu';
    menu.setAttribute('role', 'menu');

    INSTANCE_MENU_ITEMS.forEach(function (item) {
      var button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.setAttribute('data-instance-menu-action', item.action);
      button.setAttribute('data-instance-menu-id', id);
      button.textContent = item.label;
      if (item.danger) button.classList.add('is-danger');
      if (item.disabled) {
        button.disabled = true;
        button.title = item.hint || '待接入';
      }
      menu.appendChild(button);
    });

    document.body.appendChild(menu);

    var rect = anchor.getBoundingClientRect();
    var menuRect = menu.getBoundingClientRect();
    var top = rect.bottom + 6;
    if (top + menuRect.height > window.innerHeight - 12) {
      top = Math.max(12, rect.top - menuRect.height - 6);
    }
    menu.style.top = Math.round(top) + 'px';
    menu.style.left = Math.round(Math.min(rect.right - menuRect.width, window.innerWidth - menuRect.width - 12)) + 'px';

    openInstanceMenuId = id;
    var first = menu.querySelector('button:not([disabled])');
    if (first) first.focus();
  }

  function handleInstanceMenuAction(action, id) {
    closeInstanceMenu();

    var instance = instanceById(id);
    if (!instance) return;

    if (action === 'detail') {
      openInstanceDetail(instance.id);
      return;
    }

    if (action === 'launch') {
      launchInstanceFlow(instance, false);
      return;
    }

    if (action === 'icon') {
      openIconDialog(instance.id);
      return;
    }

    if (action === 'test') {
      launchInstanceFlow(instance, true);
      return;
    }

    if (action === 'script') {
      createLaunchScript(instance);
      return;
    }

    if (action === 'rename') {
      renameInstanceFlow(instance);
      return;
    }

    if (action === 'duplicate') {
      duplicateInstance(instance);
      return;
    }

    if (action === 'delete') {
      confirmRemoveInstance(instance);
      return;
    }

    if (action === 'folder') {
      var api = window.launcherAPI;
      if (!api || typeof api.openInstanceFolder !== 'function') return;
      api.openInstanceFolder({ instanceId: instance.id })
        .then(function () { setInstancePanelStatus('已打开 ' + instanceLabel(instance) + ' 的运行文件夹', 'ok'); })
        .catch(function (error) { setInstancePanelStatus(describeLaunchError(error), 'error'); });
    }
  }

  function launchInstanceFlow(instance, test) {
    var api = window.launcherAPI;
    if (!api || typeof api.launchGame !== 'function') return;

    selectInstance(instance.id);
    setLaunchLoading(true);
    setInstancePanelStatus((test ? '正在测试启动 ' : '正在启动 ') + instanceLabel(instance) + ' …');

    api.launchGame({ instanceId: instance.id, test: Boolean(test) })
      .then(function (result) {
        if (result && result.ok) {
          setInstancePanelStatus(
            (test ? '测试启动已完成 · PID ' : '已启动 · PID ') + (result.pid || '-') +
            ' · Java ' + result.javaMajor,
            'ok'
          );
          window.launcherAPI.onLaunchProgress && setLaunchNote(
            (test ? '测试启动 ' : '已启动 ') + (result.versionId || '') + ' · PID ' + (result.pid || '-'),
            false
          );
        }
      })
      .catch(function (error) {
        setInstancePanelStatus(describeLaunchError(error), 'error');
      })
      .then(function () {
        setLaunchLoading(false);
      });
  }

  function createLaunchScript(instance) {
    var api = window.launcherAPI;
    if (!api || typeof api.createLaunchScript !== 'function') return;

    setInstancePanelStatus('正在生成启动脚本…');

    api.createLaunchScript({ instanceId: instance.id })
      .then(function (result) {
        var name = result && result.bat ? result.bat.split(/[\\/]/).pop() : '启动脚本';
        setInstancePanelStatus(
          (result && result.fallback ? '实例目录不可写，脚本已放到数据目录：' : '已生成 ') + name,
          'ok'
        );
        if (result && result.dir && api.openInstanceFolder) {
          api.openInstanceFolder({ path: result.dir }).catch(function () {});
        }
      })
      .catch(function (error) {
        setInstancePanelStatus(describeLaunchError(error), 'error');
      });
  }

  /**
   * 重命名实例（askPrompt 调用点 1/3：实例管理页 / 实例右键菜单）。
   * 只改显示名，不动 versions 下的文件夹。
   */
  function renameInstanceFlow(instance) {
    var api = window.launcherAPI;
    if (!instance || !api || typeof api.renameInstance !== 'function') return;

    var currentName = instanceLabel(instance);
    askPrompt({
      title: '重命名实例',
      text: '只改启动器里显示的名字，版本文件夹不变：' + (instance.versionName || instance.id),
      label: '实例名称',
      value: currentName,
      placeholder: '例如 1.21.4 · 原版',
      okText: '重命名',
      maxLength: 48
    }).then(function (name) {
      if (!name || name === currentName) return;

      setInstancePanelStatus('正在重命名…');
      return api.renameInstance({ instanceId: instance.id, name: name })
        .then(function (snapshot) {
          if (snapshot) updateInstanceUI(snapshot);
          setInstancePanelStatus('已重命名为 ' + name, 'ok');
        })
        .catch(function (error) {
          setInstancePanelStatus(describeLaunchError(error), 'error');
        });
    });
  }

  /**
   * 复制实例（askPrompt 调用点 2/3）：先问副本名，再走 instances:duplicate。
   */
  function duplicateInstance(instance) {
    var api = window.launcherAPI;
    if (!instance || !api || typeof api.duplicateInstance !== 'function') return;

    askPrompt({
      title: '复制游戏实例',
      text: '会完整复制实例文件夹（模组、配置、存档），比较大的实例需要一会儿。',
      label: '副本名称',
      value: instanceLabel(instance) + ' · 副本',
      okText: '开始复制',
      maxLength: 48
    }).then(function (name) {
      if (!name) return;

      setInstancePanelStatus('正在复制 ' + instanceLabel(instance) + ' …');
      return api.duplicateInstance({ instanceId: instance.id, name: name })
        .then(function (snapshot) {
          updateInstanceUI(snapshot);
          setInstancePanelStatus('已复制为「' + name + '」', 'ok');
        })
        .catch(function (error) {
          setInstancePanelStatus(describeLaunchError(error), 'error');
        });
    });
  }

  function confirmRemoveInstance(instance) {
    askConfirm(
      '确定删除实例「' + instanceLabel(instance) + '」吗？\n' +
      '会删除该实例的版本文件夹（含模组与配置），此操作不可撤销。',
      function () {
        var api = window.launcherAPI;
        if (!api || typeof api.removeInstance !== 'function') return;

        setInstancePanelStatus('正在删除 ' + instanceLabel(instance) + ' …');

        api.removeInstance({ instanceId: instance.id })
          .then(function (snapshot) {
            updateInstanceUI(snapshot);
            setInstancePanelStatus('已删除 ' + instanceLabel(instance), 'ok');
          })
          .catch(function (error) {
            setInstancePanelStatus(describeLaunchError(error), 'error');
          });
      },
      '删除'
    );
  }

  // ---- 实例操作对话框（L5，对应 Instances.java）----

  function openInstanceDialog(id) {
    var instance = instanceById(id);
    if (!instance) return;

    dialogInstanceId = id;

    var meta = document.getElementById('instanceDialogMeta');
    var status = document.getElementById('instanceDialogStatus');
    var del = document.getElementById('instanceDelete');

    if (meta) {
      meta.textContent = instanceLabel(instance) + ' · ' + (instance.versionName || '—') +
        (loaderLabel(instance) !== 'Vanilla' ? ' · ' + loaderLabel(instance) : '') +
        (instance.origin === 'external' ? ' · 外部目录' : '');
    }
    if (status) setHint(status, '');
    if (del) del.disabled = false;

    openDialog('instance');
  }

  var instanceRenameApply = document.getElementById('instanceRenameApply');
  var instanceDuplicateBtn = document.getElementById('instanceDuplicate');
  var instanceDeleteBtn = document.getElementById('instanceDelete');

  // 「重命名」不再自带输入框，统一走 askPrompt（确定 / 取消 / 空值校验都是基座行为）。
  if (instanceRenameApply) {
    instanceRenameApply.addEventListener('click', function () {
      var instance = instanceById(dialogInstanceId);
      if (!instance) return;
      closeDialog();
      renameInstanceFlow(instance);
    });
  }

  if (instanceDuplicateBtn) {
    instanceDuplicateBtn.addEventListener('click', function () {
      var instance = instanceById(dialogInstanceId);
      if (!instance) return;
      closeDialog();
      duplicateInstance(instance);
    });
  }

  if (instanceDeleteBtn) {
    instanceDeleteBtn.addEventListener('click', function () {
      var instance = instanceById(dialogInstanceId);
      if (!instance) return;
      closeDialog();
      confirmRemoveInstance(instance);
    });
  }

  // ---------------------------------------------------------
  // 游戏目录管理页（GameDirectoryPage）
  // ---------------------------------------------------------
  var gameDirCache = [];
  var gameDirEditingId = null;
  var gameDirAddMode = false;

  function gameDirStatus(text, tone) {
    var node = document.getElementById('gameDirStatus');
    if (!node) return;
    node.textContent = text || '';
    node.classList.toggle('is-error', tone === 'error');
  }

  function applyGameDirForm() {
    var input = document.getElementById('gameDirInput');
    var relative = document.getElementById('gameDirRelative');
    var hintNode = document.getElementById('gameDirRelativeHint');
    var deleteBtn = document.getElementById('gameDirDelete');

    var entry = null;
    for (var i = 0; i < gameDirCache.length; i += 1) {
      if (gameDirCache[i].id === gameDirEditingId) entry = gameDirCache[i];
    }

    if (input) input.value = entry ? entry.path : '';
    if (relative) {
      relative.checked = entry ? Boolean(entry.useRelativePath) : false;
      relative.disabled = entry ? !entry.relativePossible : false;
      if (!relative.disabled) relative.removeAttribute('title');
      else relative.setAttribute('title', '该文件夹不在启动器目录内，无法使用相对路径');
    }
    if (hintNode) {
      hintNode.textContent = entry && entry.relativePossible
        ? '这个文件夹在启动器目录内，可以勾选相对路径'
        : '只有位于启动器目录内的文件夹才能用相对路径';
    }
    if (deleteBtn) deleteBtn.hidden = !entry || entry.primary;
  }

  var gameDirList = createList({
    container: document.getElementById('gameDirList'),
    itemKey: function (entry) { return entry.id; },
    renderRow: function (entry) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'gamedir-item';
      item.setAttribute('data-gamedir-id', entry.id);

      var main = document.createElement('div');
      main.className = 'gamedir-item__main';

      var pathNode = document.createElement('span');
      pathNode.className = 'gamedir-item__path';
      pathNode.textContent = entry.displayPath || entry.path;

      var metaNode = document.createElement('span');
      metaNode.className = 'gamedir-item__meta';
      metaNode.textContent = entry.primary ? '主目录 · 安装落点' : '附加目录';

      main.appendChild(pathNode);
      main.appendChild(metaNode);
      item.appendChild(main);
      return item;
    },
    onSelect: function (entry) {
      if (!entry) return;
      gameDirEditingId = entry.id;
      gameDirAddMode = false;
      renderGameDirList();
      applyGameDirForm();
    }
  });

  function renderGameDirList() {
    gameDirList.render(gameDirCache, { selected: gameDirEditingId });
  }

  function loadGameDirs(selectId) {
    var api = window.launcherAPI;
    if (!api || typeof api.getGameDirs !== 'function') return;

    api.getGameDirs()
      .then(function (data) {
        gameDirCache = data && Array.isArray(data.dirs) ? data.dirs : [];

        if (gameDirAddMode) {
          // 「添加游戏文件夹」进来：表单保持空白，不预选已有目录，
          // 否则保存会把主目录原地改成新路径。
          gameDirEditingId = null;
        } else if (selectId) {
          gameDirEditingId = selectId;
        } else if (!gameDirEditingId || !gameDirCache.some(function (entry) { return entry.id === gameDirEditingId; })) {
          gameDirEditingId = gameDirCache.length ? gameDirCache[0].id : null;
        }

        renderGameDirList();
        applyGameDirForm();
        gameDirStatus(gameDirAddMode
          ? '填写路径后点「保存」新增'
          : '共 ' + gameDirCache.length + ' 个游戏文件夹');
      })
      .catch(function (error) {
        gameDirStatus(describeLaunchError(error), 'error');
      });
  }

  function openGameDirPage(options) {
    options = options || {};
    gameDirAddMode = !options.id;
    gameDirEditingId = options.id || null;
    showPanel('gamedir');
    loadGameDirs(options.id || null);

    window.setTimeout(function () {
      var input = document.getElementById('gameDirInput');
      if (input) input.focus();
    }, 240);
  }

  var gameDirForm = document.getElementById('gameDirForm');

  if (gameDirForm) {
    gameDirForm.addEventListener('submit', function (event) {
      event.preventDefault();

      var api = window.launcherAPI;
      if (!api || typeof api.saveGameDir !== 'function') return;

      var input = document.getElementById('gameDirInput');
      var relative = document.getElementById('gameDirRelative');
      var dirPath = input ? input.value.trim() : '';

      if (!dirPath) {
        gameDirStatus('请填写游戏文件夹路径', 'error');
        if (input) input.focus();
        return;
      }

      gameDirStatus('正在保存…');

      api.saveGameDir({
        id: gameDirEditingId || '',
        path: dirPath,
        useRelativePath: relative ? Boolean(relative.checked) : false
      })
        .then(function (result) {
          gameDirCache = result && Array.isArray(result.dirs) ? result.dirs : gameDirCache;
          if (result && result.dir) gameDirEditingId = result.dir.id;
          gameDirAddMode = false;
          renderGameDirList();
          applyGameDirForm();
          gameDirStatus('已保存：' + ((result && result.dir && (result.dir.displayPath || result.dir.path)) || dirPath), 'ok');
          loadInstances();
        })
        .catch(function (error) {
          gameDirStatus(describeLaunchError(error), 'error');
        });
    });
  }

  var gameDirBrowse = document.getElementById('gameDirBrowse');
  if (gameDirBrowse) {
    gameDirBrowse.addEventListener('click', function () {
      var api = window.launcherAPI;
      if (!api || typeof api.pickGameDir !== 'function') return;

      api.pickGameDir()
        .then(function (picked) {
          if (!picked) return;
          var input = document.getElementById('gameDirInput');
          if (input) input.value = picked;
          gameDirStatus('已选择文件夹，点「保存」加入列表');
        })
        .catch(function (error) {
          gameDirStatus(describeLaunchError(error), 'error');
        });
    });
  }

  var gameDirDelete = document.getElementById('gameDirDelete');
  if (gameDirDelete) {
    gameDirDelete.addEventListener('click', function () {
      var api = window.launcherAPI;
      if (!api || typeof api.removeGameDir !== 'function' || !gameDirEditingId) return;

      var entry = null;
      for (var i = 0; i < gameDirCache.length; i += 1) {
        if (gameDirCache[i].id === gameDirEditingId) entry = gameDirCache[i];
      }
      if (!entry) return;

      askConfirm(
        '从列表移除「' + (entry.displayPath || entry.path) + '」吗？\n' +
        '只会停止扫描这个文件夹，不会删除磁盘上的文件。',
        function () {
          api.removeGameDir(entry.id)
            .then(function (result) {
              gameDirCache = result && Array.isArray(result.dirs) ? result.dirs : [];
              gameDirEditingId = gameDirCache.length ? gameDirCache[0].id : null;
              renderGameDirList();
              applyGameDirForm();
              gameDirStatus('已移除', 'ok');
              loadInstances();
            })
            .catch(function (error) {
              gameDirStatus(describeLaunchError(error), 'error');
            });
        },
        '移除'
      );
    });
  }

  // ---------------------------------------------------------
  // 实例详情（[L3] 6 页签）+ 实例图标（[L5]）
  // ---------------------------------------------------------
  var detailInstanceId = null;
  var detailTab = 'game';
  var iconTargetId = null;

  var TAB_CONTENT_KIND = {
    mods: 'mods',
    resourcepacks: 'resourcepacks',
    worlds: 'saves',
    schematics: 'schematics'
  };

  // 内置图标：等距立方体，用三种颜色区分。
  var ICON_PRESETS = [
    { key: 'grass', label: '草方块', top: '#7cc46a', left: '#4f7d43', right: '#659e55' },
    { key: 'chest', label: '箱子', top: '#c8a06a', left: '#7d5c39', right: '#a07d51' },
    { key: 'furnace', label: '熔炉', top: '#9aa0a6', left: '#5c6166', right: '#7a8085' },
    { key: 'craft', label: '工作台', top: '#c9a273', left: '#8a6440', right: '#a97f56' },
    { key: 'command', label: '命令方块', top: '#e2a06a', left: '#9d5f36', right: '#c07f4d' },
    { key: 'ender', label: '末影箱', top: '#5f6f8a', left: '#33404f', right: '#46566a' }
  ];

  function cubeSvg(preset) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M12 3 20 7.5 12 12 4 7.5Z" fill="' + preset.top + '"/>' +
      '<path d="M4 7.5 12 12v9l-8-4.5Z" fill="' + preset.left + '"/>' +
      '<path d="M20 7.5 20 16.5 12 21v-9Z" fill="' + preset.right + '"/>' +
      '</svg>';
  }

  function presetByKey(key) {
    for (var i = 0; i < ICON_PRESETS.length; i += 1) {
      if (ICON_PRESETS[i].key === key) return ICON_PRESETS[i];
    }
    return null;
  }

  /** 把实例图标画进任意容器：自定义图片 > 内置图标 > 名字首字母。 */
  function fillInstanceIcon(node, instance) {
    if (!node || !instance) return;
    node.innerHTML = '';

    if (instance.iconDataUrl) {
      var img = document.createElement('img');
      img.src = instance.iconDataUrl;
      img.alt = '';
      node.appendChild(img);
      return;
    }

    var preset = presetByKey(instance.iconKey);
    if (preset) {
      node.innerHTML = cubeSvg(preset);
      return;
    }

    var letter = document.createElement('span');
    letter.textContent = instanceLabel(instance).slice(0, 1).toUpperCase();
    node.appendChild(letter);
  }

  function setDetailStatus(text, tone) {
    var node = document.getElementById('detailContentStatus');
    if (!node) return;
    node.textContent = text || '';
    node.classList.toggle('is-error', tone === 'error');
    node.classList.toggle('is-ok', tone === 'ok');
  }

  function setDetailSettingsStatus(text, tone) {
    var node = document.getElementById('detailSettingsStatus');
    if (!node) return;
    node.textContent = text || '';
    node.classList.toggle('is-error', tone === 'error');
    node.classList.toggle('is-ok', tone === 'ok');
  }

  function detailInstance() {
    return instanceById(detailInstanceId);
  }

  function renderDetailHeader() {
    var instance = detailInstance();
    if (!instance) return;

    var name = document.getElementById('detailName');
    var meta = document.getElementById('detailMeta');
    var letterNode = document.getElementById('detailIconLetter');
    var imageNode = document.getElementById('detailIconImage');

    if (name) name.textContent = instanceLabel(instance);

    if (meta) {
      var parts = [];
      if (instance.versionName) parts.push(instance.versionName);
      var loader = loaderLabel(instance);
      if (loader && loader !== 'Vanilla') parts.push(loader);
      if (instance.origin === 'external') parts.push('外部目录');
      if (instance.gameDir) parts.push(instance.gameDir);
      meta.textContent = parts.join(' · ') || '—';
    }

    if (letterNode && imageNode) {
      var preset = presetByKey(instance.iconKey);
      if (instance.iconDataUrl) {
        imageNode.src = instance.iconDataUrl;
        imageNode.hidden = false;
        letterNode.hidden = true;
        letterNode.innerHTML = '';
      } else if (preset) {
        imageNode.hidden = true;
        letterNode.hidden = false;
        letterNode.innerHTML = cubeSvg(preset);
      } else {
        imageNode.hidden = true;
        letterNode.hidden = false;
        letterNode.textContent = instanceLabel(instance).slice(0, 1).toUpperCase();
      }
    }
  }

  function openInstanceDetail(id) {
    var instance = instanceById(id) || getSelectedInstance();
    if (!instance) {
      setInstancePanelStatus('还没有实例，先创建一个', 'error');
      return;
    }

    detailInstanceId = instance.id;
    selectInstance(instance.id);
    showPanel('detail');
    renderDetailHeader();
    setDetailTab(detailTab || 'game');
  }

  var detailTabs = createTabs({
    tabAttr: 'data-detail-tab',
    panelAttr: 'data-detail-panel',
    onChange: function (tab) {
      if (tab === 'game') {
        loadDetailSettings();
        return;
      }
      if (tab === 'installers') {
        renderInstallerList();
        return;
      }
      if (tab === 'worlds') {
        openWorldList();
        return;
      }

      var kind = TAB_CONTENT_KIND[tab];
      if (kind) loadInstanceContent(kind);
    }
  });

  function setDetailTab(tab) {
    detailTab = tab || 'game';
    detailTabs.set(detailTab);
  }

  // ---------------- 页签：游戏设置（实例级） ----------------

  function fillDetailJavaOptions(runtimes, currentPath) {
    var select = document.getElementById('detailJava');
    if (!select) return;

    select.innerHTML = '';

    var inherit = document.createElement('option');
    inherit.value = '';
    inherit.textContent = '继承全局设置';
    select.appendChild(inherit);

    (runtimes || []).forEach(function (runtime) {
      var option = document.createElement('option');
      option.value = runtime.path;
      option.textContent = 'Java ' + runtime.major + ' · ' + runtime.version + ' · ' + runtime.path;
      select.appendChild(option);
    });

    if (currentPath && !(runtimes || []).some(function (runtime) { return runtime.path === currentPath; })) {
      var custom = document.createElement('option');
      custom.value = currentPath;
      custom.textContent = '自定义 · ' + currentPath;
      select.appendChild(custom);
    }

    select.value = currentPath || '';
  }

  function loadDetailSettings() {
    var api = window.launcherAPI;
    var instance = detailInstance();
    if (!api || !instance || typeof api.getInstanceSettings !== 'function') return;

    applyDetailSettings({}, {});

    // 实例设置很快，Java 列表要扫描本机（可能十几秒），分开加载：
    // 先把内存 / 窗口 / JVM 参数显示出来，Java 下拉晚一步补上。
    api.getInstanceSettings({ instanceId: instance.id })
      .then(function (data) {
        var overrides = (data && data.overrides) || {};
        applyDetailSettings(overrides, (data && data.global) || {});
        setDetailSettingsStatus('留空表示继承全局设置');

        if (typeof api.getSettings !== 'function') return;
        api.getSettings()
          .then(function (settingsData) {
            if (detailInstanceId !== instance.id) return;
            fillDetailJavaOptions((settingsData && settingsData.javaRuntimes) || [], overrides.javaPath || '');
          })
          .catch(function () {
            // Java 列表拿不到不影响其它字段
          });
      })
      .catch(function (error) {
        setDetailSettingsStatus(describeLaunchError(error), 'error');
      });
  }

  function applyDetailSettings(overrides, globalSettings) {
    var memory = document.getElementById('detailMemory');
    var width = document.getElementById('detailWidth');
    var height = document.getElementById('detailHeight');
    var jvm = document.getElementById('detailJvmArgs');

    if (memory) {
      memory.value = overrides.memoryMb || '';
      memory.placeholder = '继承全局：' + (globalSettings.memoryMb || '—') + ' MB';
    }
    if (width) {
      width.value = overrides.width || '';
      width.placeholder = '继承全局：' + (globalSettings.width || '—');
    }
    if (height) {
      height.value = overrides.height || '';
      height.placeholder = '继承全局：' + (globalSettings.height || '—');
    }
    if (jvm) {
      jvm.value = overrides.jvmArgs || '';
      jvm.placeholder = globalSettings.jvmArgs
        ? '继承全局：' + globalSettings.jvmArgs
        : '留空继承全局设置';
    }

    // Java 下拉单独填充；这里只保证已选路径不会丢。
    var javaSelect = document.getElementById('detailJava');
    if (javaSelect && overrides.javaPath) {
      for (var i = 0; i < javaSelect.options.length; i += 1) {
        if (javaSelect.options[i].value === overrides.javaPath) {
          javaSelect.value = overrides.javaPath;
          break;
        }
      }
    }
  }

  var detailSettingsForm = document.getElementById('detailSettingsForm');
  if (detailSettingsForm) {
    detailSettingsForm.addEventListener('submit', function (event) {
      event.preventDefault();

      var api = window.launcherAPI;
      var instance = detailInstance();
      if (!api || !instance || typeof api.saveInstanceSettings !== 'function') return;

      var valueOf = function (id) {
        var node = document.getElementById(id);
        return node ? node.value : '';
      };

      setDetailSettingsStatus('正在保存…');

      api.saveInstanceSettings({
        instanceId: instance.id,
        patch: {
          memoryMb: valueOf('detailMemory'),
          width: valueOf('detailWidth'),
          height: valueOf('detailHeight'),
          jvmArgs: valueOf('detailJvmArgs'),
          javaPath: valueOf('detailJava')
        }
      }).then(function (result) {
        var effective = (result && result.effective) || {};
        setDetailSettingsStatus(
          '已保存 · 生效值：' + (effective.memoryMb || '—') + ' MB / ' +
          (effective.width || '—') + '×' + (effective.height || '—'),
          'ok'
        );
      }).catch(function (error) {
        setDetailSettingsStatus(describeLaunchError(error), 'error');
      });
    });
  }

  var detailSettingsReset = document.getElementById('detailSettingsReset');
  if (detailSettingsReset) {
    detailSettingsReset.addEventListener('click', function () {
      var api = window.launcherAPI;
      var instance = detailInstance();
      if (!api || !instance) return;

      api.saveInstanceSettings({
        instanceId: instance.id,
        patch: { memoryMb: '', width: '', height: '', jvmArgs: '', javaPath: '' }
      }).then(function () {
        loadDetailSettings();
        setDetailSettingsStatus('已恢复为继承全局设置', 'ok');
      }).catch(function (error) {
        setDetailSettingsStatus(describeLaunchError(error), 'error');
      });
    });
  }

  // ---------------- 页签：自动安装 ----------------

  var INSTALLER_ENTRIES = [
    { name: 'Forge', key: 'Forge', desc: 'net.minecraftforge · 1.7.10 – 最新', auto: true },
    { name: 'NeoForge', key: 'NeoForge', desc: 'net.neoforged · 1.20.1 起', auto: true },
    { name: 'Fabric', key: 'Fabric', desc: 'net.fabricmc · 1.14 起', auto: true },
    { name: 'Quilt', key: 'Quilt', desc: 'org.quiltmc · 1.18 起', auto: true },
    { name: 'LiteLoader', key: '', desc: '1.5.2 – 1.12.2 · 已停止更新', auto: false },
    { name: 'OptiFine', key: '', desc: '各版本独立发布 · 需手动下载安装器', auto: false }
  ];

  /**
   * 「自动安装」页签的入口：直接带着当前实例的游戏版本跳到新建实例页，
   * 那里的加载器版本下拉和进度条是现成的，避免再写一套安装流程。
   */
  function startLoaderInstall(loaderKey) {
    var instance = typeof getSelectedInstance === 'function' ? getSelectedInstance() : null;
    var mcVersion = instance && instance.versionName ? String(instance.versionName) : '';

    openCreatePanel();
    createGameDir = instance && instance.gameDir ? instance.gameDir : '';

    if (createLoader) createLoader.value = loaderKey;
    setLoaderVersionFieldVisible(true);

    if (mcVersion && createVersion) {
      var known = false;
      for (var i = 0; i < createVersion.options.length; i += 1) {
        if (createVersion.options[i].value === mcVersion) known = true;
      }
      if (!known) {
        var option = document.createElement('option');
        option.value = mcVersion;
        option.textContent = mcVersion;
        createVersion.appendChild(option);
      }
      createVersion.value = mcVersion;
    }

    refreshLoaderVersions(true);
    updateSuggestedName(true);

    if (createMessage) {
      createMessage.classList.remove('is-error');
      createMessage.textContent = mcVersion
        ? '将为 Minecraft ' + mcVersion + ' 新建一个 ' + loaderLabelOf(loaderKey) + ' 实例'
        : '请选择游戏版本后再安装 ' + loaderLabelOf(loaderKey);
    }
  }

  function renderInstallerList() {
    var list = document.getElementById('detailInstallerList');
    if (!list) return;

    list.innerHTML = '';

    INSTALLER_ENTRIES.forEach(function (entry) {
      var row = document.createElement('div');
      row.className = 'content-row';

      var main = document.createElement('div');
      main.className = 'content-row__main';

      var name = document.createElement('span');
      name.className = 'content-row__name';
      name.textContent = entry.name;

      var meta = document.createElement('span');
      meta.className = 'content-row__meta';
      meta.textContent = entry.desc;

      main.appendChild(name);
      main.appendChild(meta);

      var actions = document.createElement('div');
      actions.className = 'content-row__actions';

      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'dialog-btn';
      button.textContent = '安装';
      button.disabled = !entry.auto;
      button.title = entry.auto
        ? '用当前实例的游戏版本新建一个 ' + entry.name + ' 实例'
        : (entry.name === 'OptiFine'
          ? 'OptiFine 需要从官网手动下载安装器，暂未接入'
          : 'LiteLoader 已停止更新，暂未接入');
      button.setAttribute('data-control-key', 'button.install');

      button.addEventListener('click', function () {
        if (!entry.auto) return;
        startLoaderInstall(entry.key);
      });

      actions.appendChild(button);
      row.appendChild(main);
      row.appendChild(actions);
      list.appendChild(row);
    });
  }

  // ---------------- 页签：模组 / 资源包 / 世界 / 原理图 ----------------

  function formatSize(bytes) {
    if (!bytes) return '0 KB';
    if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function formatDate(iso) {
    if (!iso) return '';
    return String(iso).slice(0, 10);
  }

  var CONTENT_PAGE_SIZE = 80;

  var CONTENT_META = {
    mods: { label: '模组', importLabel: '导入模组', canToggle: true, canImport: true, canCheckUpdate: true },
    resourcepacks: { label: '资源包', importLabel: '导入资源包', canToggle: false, canImport: true },
    saves: { label: '世界', canToggle: false, canImport: false },
    schematics: { label: '原理图', importLabel: '导入原理图', canToggle: false, canImport: true }
  };

  var contentState = {};

  function contentStateOf(kind) {
    if (!contentState[kind]) {
      contentState[kind] = { entries: [], query: '', selected: {}, visible: CONTENT_PAGE_SIZE, loaded: false };
    }
    return contentState[kind];
  }

  function contentPanelOf(kind) {
    return document.querySelector('[data-content-panel="' + kind + '"]');
  }

  function contentMeta(kind) {
    return CONTENT_META[kind] || { label: '条目' };
  }

  function filteredEntries(kind) {
    var state = contentStateOf(kind);
    var query = state.query.trim().toLowerCase();
    if (!query) return state.entries;
    return state.entries.filter(function (entry) {
      return String(entry.name).toLowerCase().indexOf(query) >= 0;
    });
  }

  function selectedPaths(kind) {
    var state = contentStateOf(kind);
    return Object.keys(state.selected).filter(function (path) { return state.selected[path]; });
  }

  function clearSelection(kind) {
    contentStateOf(kind).selected = {};
  }

  /** 工具栏只建一次，之后只刷新列表与计数。 */
  function ensureContentPanel(kind) {
    var panel = contentPanelOf(kind);
    if (!panel || panel.getAttribute('data-ready') === '1') return panel;

    var meta = contentMeta(kind);
    var parts = [];

    parts.push('<div class="content-toolbar">');
    parts.push('  <label class="content-search">');
    parts.push('    <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 5 5"/></svg>');
    parts.push('    <input type="search" data-content-search placeholder="搜索' + meta.label + '…" autocomplete="off">');
    parts.push('  </label>');
    parts.push('  <button class="dialog-btn content-refresh" type="button" data-content-refresh="' + kind + '">刷新</button>');
    parts.push('  <span class="content-count" data-content-count>0</span>');
    parts.push('</div>');

    parts.push('<div class="content-actions">');
    parts.push('  <label class="content-select-all"><input type="checkbox" data-content-select-all><span>全选</span></label>');
    if (meta.canToggle) {
      parts.push('  <button class="dialog-btn" type="button" data-content-bulk="enable">批量启用</button>');
      parts.push('  <button class="dialog-btn" type="button" data-content-bulk="disable">批量禁用</button>');
    }
    parts.push('  <button class="dialog-btn" type="button" data-content-bulk="delete">批量删除</button>');
    parts.push('  <button class="dialog-btn" type="button" data-content-reveal="1">定位文件</button>');
    parts.push('  <button class="dialog-btn" type="button" data-content-folder="' + kind + '">打开文件夹</button>');
    if (meta.canCheckUpdate) {
      parts.push('  <button class="dialog-btn is-pending" type="button" data-content-check-update="1" disabled title="检查更新待接入">检查更新</button>');
    }
    if (meta.canImport) {
      parts.push('  <button class="dialog-btn" type="button" data-content-import="' + kind + '">' + (meta.importLabel || '导入') + '</button>');
    }
    parts.push('</div>');

    parts.push('<div class="content-root" data-content-root title=""></div>');
    parts.push('<div class="content-list" data-content-list></div>');

    parts.push('<div class="content-more" hidden>');
    parts.push('  <button class="dialog-btn" type="button" data-content-more="1">显示更多</button>');
    parts.push('  <span class="content-more__label" data-content-more-label></span>');
    parts.push('</div>');

    panel.innerHTML = parts.join('\n');
    panel.setAttribute('data-ready', '1');
    return panel;
  }

  function buildContentRow(kind, entry) {
    var meta = contentMeta(kind);
    var state = contentStateOf(kind);

    var row = document.createElement('div');
    row.className = 'content-row' + (entry.enabled === false ? ' is-disabled' : '');
    row.setAttribute('data-content-row', entry.path);

    var check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'content-row__check';
    check.checked = Boolean(state.selected[entry.path]);
    check.setAttribute('data-row-select', entry.path);
    check.setAttribute('aria-label', '选择 ' + entry.name);

    var main = document.createElement('div');
    main.className = 'content-row__main';

    var name = document.createElement('span');
    name.className = 'content-row__name';
    name.textContent = entry.name;
    name.title = entry.path;

    var metaLine = document.createElement('span');
    metaLine.className = 'content-row__meta';
    metaLine.textContent = [
      entry.isDirectory ? '文件夹' : formatSize(entry.size),
      formatDate(entry.modifiedAt),
      meta.canToggle && entry.enabled === false ? '已禁用' : ''
    ].filter(Boolean).join(' · ');

    main.appendChild(name);
    main.appendChild(metaLine);

    var actions = document.createElement('div');
    actions.className = 'content-row__actions';

    if (meta.canToggle) {
      var toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'dialog-btn';
      toggle.textContent = entry.enabled === false ? '启用' : '禁用';
      toggle.setAttribute('data-row-toggle', entry.path);
      toggle.setAttribute('data-row-enabled', entry.enabled === false ? 'false' : 'true');
      actions.appendChild(toggle);
    }

    var reveal = document.createElement('button');
    reveal.type = 'button';
    reveal.className = 'dialog-btn';
    reveal.textContent = '定位';
    reveal.setAttribute('data-row-reveal', entry.path);
    actions.appendChild(reveal);

    var remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'dialog-btn';
    remove.textContent = '删除';
    remove.setAttribute('data-row-delete', entry.path);
    remove.setAttribute('data-row-name', entry.name);
    actions.appendChild(remove);

    row.appendChild(check);
    row.appendChild(main);
    row.appendChild(actions);
    return row;
  }

  function renderContentPanel(kind) {
    var panel = ensureContentPanel(kind);
    if (!panel) return;

    var state = contentStateOf(kind);
    var meta = contentMeta(kind);
    var entries = filteredEntries(kind);

    var list = panel.querySelector('[data-content-list]');
    var count = panel.querySelector('[data-content-count]');
    var more = panel.querySelector('.content-more');
    var moreLabel = panel.querySelector('[data-content-more-label]');
    var selectAll = panel.querySelector('[data-content-select-all]');

    if (count) {
      var picked = selectedPaths(kind).length;
      var base = state.query
        ? '匹配 ' + entries.length + ' / 共 ' + state.entries.length
        : '共 ' + state.entries.length;
      count.textContent = picked > 0 ? base + ' · 已选 ' + picked : base;
    }

    if (list) {
      list.innerHTML = '';

      var rootNode = panel.querySelector('[data-content-root]');
      if (rootNode) {
        var rootText = state.root ? '目录：' + state.root : '';
        if (state.root && state.rootExists === false) rootText += '（目录不存在，导入时会创建）';
        rootNode.textContent = rootText;
        rootNode.title = state.root || '';
      }

      if (entries.length === 0) {
        var empty = document.createElement('div');
        empty.className = 'content-empty';
        empty.textContent = !state.loaded
          ? '正在读取…'
          : state.query
            ? '没有匹配「' + state.query + '」的' + meta.label
            : '还没有' + meta.label + '，用上面的按钮导入或刷新';
        list.appendChild(empty);
      } else {
        var visible = entries.slice(0, state.visible);
        visible.forEach(function (entry) {
          list.appendChild(buildContentRow(kind, entry));
        });
      }
    }

    if (more) {
      more.hidden = entries.length <= state.visible;
      if (moreLabel) {
        moreLabel.textContent = entries.length > state.visible
          ? '另有 ' + (entries.length - state.visible) + ' 个未显示'
          : '';
      }
    }

    if (selectAll) {
      // 「全选」作用于当前过滤结果的全部条目，不只是已显示的这一页。
      var selectedCount = entries.filter(function (entry) { return state.selected[entry.path]; }).length;
      selectAll.checked = entries.length > 0 && selectedCount === entries.length;
      selectAll.indeterminate = selectedCount > 0 && selectedCount < entries.length;
    }
  }

  function loadInstanceContent(kind, options) {
    options = options || {};
    var api = window.launcherAPI;
    var instance = detailInstance();
    if (!api || !instance || typeof api.listInstanceContent !== 'function') return;

    var state = contentStateOf(kind);
    if (!options.keepSelection) clearSelection(kind);
    state.loaded = false;
    renderContentPanel(kind);

    api.listInstanceContent({ instanceId: instance.id, kind: kind })
      .then(function (data) {
        if (detailInstanceId !== instance.id) return;
        state.entries = data && Array.isArray(data.entries) ? data.entries : [];
        state.root = (data && data.root) || '';
        state.rootExists = data && typeof data.exists === 'boolean' ? data.exists : true;
        state.loaded = true;
        if (state.visible < CONTENT_PAGE_SIZE) state.visible = CONTENT_PAGE_SIZE;
        renderContentPanel(kind);
      })
      .catch(function (error) {
        state.loaded = true;
        setDetailStatus(describeLaunchError(error), 'error');
        renderContentPanel(kind);
      });
  }

  // ---------------- 内容面板：事件 ----------------

  function contentKindOf(node) {
    var panel = node && node.closest ? node.closest('[data-content-panel]') : null;
    return panel ? panel.getAttribute('data-content-panel') : '';
  }

  function withContentApi(kind, run) {
    var api = window.launcherAPI;
    var instance = detailInstance();
    if (!api || !instance) return;
    run(api, instance, kind);
  }

  function bulkSetEnabled(kind, enabled) {
    var paths = selectedPaths(kind);
    if (paths.length === 0) {
      setDetailStatus('请先勾选要操作的' + contentMeta(kind).label, 'error');
      return;
    }

    withContentApi(kind, function (api, instance) {
      setDetailStatus((enabled ? '正在批量启用 ' : '正在批量禁用 ') + paths.length + ' 个…');
      api.setInstanceContentMany({ instanceId: instance.id, kind: kind, paths: paths, enabled: enabled })
        .then(function (result) {
          var failed = (result && result.failed) || [];
          setDetailStatus(
            (enabled ? '已启用 ' : '已禁用 ') + ((result && result.changed) || 0) + ' 个' +
            (failed.length ? ' · ' + failed.length + ' 个失败' : ''),
            failed.length ? 'error' : 'ok'
          );
          loadInstanceContent(kind, { keepSelection: false });
        })
        .catch(function (error) {
          setDetailStatus(describeLaunchError(error), 'error');
        });
    });
  }

  function bulkDelete(kind) {
    var paths = selectedPaths(kind);
    if (paths.length === 0) {
      setDetailStatus('请先勾选要删除的' + contentMeta(kind).label, 'error');
      return;
    }

    askConfirm('确定删除选中的 ' + paths.length + ' 个' + contentMeta(kind).label + '吗？文件会从游戏目录里移除，无法撤销。', function () {
      withContentApi(kind, function (api, instance) {
        setDetailStatus('正在删除 ' + paths.length + ' 个…');
        api.deleteInstanceContentMany({ instanceId: instance.id, kind: kind, paths: paths })
          .then(function (result) {
            var failed = (result && result.failed) || [];
            setDetailStatus(
              '已删除 ' + ((result && result.changed) || 0) + ' 个' + (failed.length ? ' · ' + failed.length + ' 个失败' : ''),
              failed.length ? 'error' : 'ok'
            );
            clearSelection(kind);
            loadInstanceContent(kind);
          })
          .catch(function (error) {
            setDetailStatus(describeLaunchError(error), 'error');
          });
      });
    }, '删除');
  }

  /** 资源管理器路径太长，状态栏只显示末尾两段。 */
  function shortPath(value) {
    var text = String(value || '');
    if (!text) return '';
    var parts = text.split(/[\\/]/).filter(Boolean);
    if (parts.length <= 2) return text;
    return '…\\' + parts.slice(-2).join('\\');
  }

  function revealContent(kind, targetPath) {
    withContentApi(kind, function (api, instance) {
      var path = targetPath || selectedPaths(kind)[0] || '';
      api.revealInstanceContent({ instanceId: instance.id, kind: kind, path: path })
        .then(function (result) {
          var opened = (result && result.path) || path;
          setDetailStatus(
            (path ? '已请求在资源管理器中定位：' : '已请求打开文件夹：') + shortPath(opened),
            'ok'
          );
        })
        .catch(function (error) {
          setDetailStatus(describeLaunchError(error), 'error');
        });
    });
  }

  function importContent(kind) {
    withContentApi(kind, function (api, instance) {
      setDetailStatus('正在选择文件…');
      api.importInstanceContent({ instanceId: instance.id, kind: kind })
        .then(function (data) {
          if (!data) {
            setDetailStatus('');
            return;
          }
          setDetailStatus('已导入', 'ok');
          loadInstanceContent(kind);
        })
        .catch(function (error) {
          setDetailStatus(describeLaunchError(error), 'error');
        });
    });
  }

  function openContentFolder(kind) {
    withContentApi(kind, function (api, instance) {
      api.openInstanceContentFolder({ instanceId: instance.id, kind: kind })
        .then(function (result) {
          setDetailStatus('已请求打开文件夹：' + shortPath(result && result.path), 'ok');
        })
        .catch(function (error) { setDetailStatus(describeLaunchError(error), 'error'); });
    });
  }

  function toggleContent(kind, targetPath, enabled) {
    withContentApi(kind, function (api, instance) {
      api.toggleInstanceContent({ instanceId: instance.id, kind: kind, path: targetPath, enabled: enabled })
        .then(function () {
          setDetailStatus(enabled ? '已启用' : '已禁用', 'ok');
          loadInstanceContent(kind, { keepSelection: true });
        })
        .catch(function (error) {
          setDetailStatus(describeLaunchError(error), 'error');
        });
    });
  }

  function removeContent(kind, targetPath) {
    withContentApi(kind, function (api, instance) {
      api.deleteInstanceContent({ instanceId: instance.id, kind: kind, path: targetPath })
        .then(function () {
          setDetailStatus('已删除', 'ok');
          loadInstanceContent(kind, { keepSelection: true });
        })
        .catch(function (error) {
          setDetailStatus(describeLaunchError(error), 'error');
        });
    });
  }

  var detailBody = document.querySelector('.detail-body');
  if (detailBody) {
    detailBody.addEventListener('click', function (event) {
      var target = event.target;
      if (!target || !target.closest) return;

      var kind = contentKindOf(target);
      if (!kind) return;

      var bulk = target.closest('[data-content-bulk]');
      if (bulk) {
        var mode = bulk.getAttribute('data-content-bulk');
        if (mode === 'delete') bulkDelete(kind);
        else bulkSetEnabled(kind, mode === 'enable');
        return;
      }

      var importBtn = target.closest('[data-content-import]');
      if (importBtn) {
        importContent(importBtn.getAttribute('data-content-import'));
        return;
      }

      var refreshBtn = target.closest('[data-content-refresh]');
      if (refreshBtn) {
        loadInstanceContent(refreshBtn.getAttribute('data-content-refresh'));
        return;
      }

      var folderBtn = target.closest('[data-content-folder]');
      if (folderBtn) {
        openContentFolder(folderBtn.getAttribute('data-content-folder'));
        return;
      }

      var revealBtn = target.closest('[data-content-reveal]');
      if (revealBtn) {
        revealContent(kind, '');
        return;
      }

      var moreBtn = target.closest('[data-content-more]');
      if (moreBtn) {
        contentStateOf(kind).visible += CONTENT_PAGE_SIZE;
        renderContentPanel(kind);
        return;
      }

      var rowReveal = target.closest('[data-row-reveal]');
      if (rowReveal) {
        revealContent(kind, rowReveal.getAttribute('data-row-reveal'));
        return;
      }

      var rowToggle = target.closest('[data-row-toggle]');
      if (rowToggle) {
        toggleContent(kind, rowToggle.getAttribute('data-row-toggle'),
          rowToggle.getAttribute('data-row-enabled') !== 'true');
        return;
      }

      var rowDelete = target.closest('[data-row-delete]');
      if (rowDelete) {
        var path = rowDelete.getAttribute('data-row-delete');
        var name = rowDelete.getAttribute('data-row-name');
        askConfirm('确定删除「' + name + '」吗？文件会从游戏目录里移除，无法撤销。', function () {
          removeContent(kind, path);
        }, '删除');
      }
    });

    detailBody.addEventListener('change', function (event) {
      var target = event.target;
      if (!target || !target.matches) return;

      var kind = contentKindOf(target);
      if (!kind) return;

      var state = contentStateOf(kind);

      if (target.matches('[data-content-select-all]')) {
        var entries = filteredEntries(kind);
        entries.forEach(function (entry) {
          if (target.checked) state.selected[entry.path] = true;
          else delete state.selected[entry.path];
        });
        renderContentPanel(kind);
        return;
      }

      if (target.matches('[data-row-select]')) {
        var rowPath = target.getAttribute('data-row-select');
        if (target.checked) state.selected[rowPath] = true;
        else delete state.selected[rowPath];
        renderContentPanel(kind);
      }
    });

    var searchTimer = null;
    detailBody.addEventListener('input', function (event) {
      var target = event.target;
      if (!target || !target.matches || !target.matches('[data-content-search]')) return;

      var kind = contentKindOf(target);
      if (!kind) return;

      var value = target.value;
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(function () {
        var state = contentStateOf(kind);
        state.query = value;
        state.visible = CONTENT_PAGE_SIZE;
        renderContentPanel(kind);
      }, 120);
    });
  }

  // ---------------------------------------------------------
  // 世界（存档）管理：列表 / 世界信息 / 备份 / 数据包
  // 对照 [L4] 世界管理（3 页签）与 [L4] 世界详情（level.dat）
  // ---------------------------------------------------------
  var WORLD_GAME_TYPES = ['生存', '创造', '冒险', '旁观'];
  var WORLD_DIFFICULTIES = ['和平', '简单', '普通', '困难'];

  var worldState = {
    loadedFor: '',
    list: [],
    query: '',
    view: 'list',
    folder: '',
    info: null,
    tab: 'info',
    busy: false
  };
  var openWorldMenuFolder = null;

  var worldPanel = document.getElementById('worldPanel');
  var worldSearch = document.getElementById('worldSearch');
  var worldRefresh = document.getElementById('worldRefresh');
  var worldCount = document.getElementById('worldCount');
  var worldList = document.getElementById('worldList');
  var worldRootEl = document.getElementById('worldRoot');
  var worldStatus = document.getElementById('worldStatus');
  var worldOpenFolder = document.getElementById('worldOpenFolder');
  var worldChunkbase = document.getElementById('worldChunkbase');
  var worldManageBack = document.getElementById('worldManageBack');
  var worldManageName = document.getElementById('worldManageName');
  var worldManageStatus = document.getElementById('worldManageStatus');
  var worldInfoNote = document.getElementById('worldInfoNote');
  var worldCheats = document.getElementById('worldCheats');
  var worldFeatures = document.getElementById('worldFeatures');
  var worldDifficulty = document.getElementById('worldDifficulty');
  var worldLock = document.getElementById('worldLock');
  var worldGameMode = document.getElementById('worldGameMode');
  var worldLaunch = document.getElementById('worldLaunch');
  var worldScript = document.getElementById('worldScript');
  var worldExport = document.getElementById('worldExport');
  var worldDuplicate = document.getElementById('worldDuplicate');
  var worldDelete = document.getElementById('worldDelete');
  var worldManageFolder = document.getElementById('worldManageFolder');
  var worldManageChunkbase = document.getElementById('worldManageChunkbase');
  var worldBackupList = document.getElementById('worldBackupList');
  var worldDatapackList = document.getElementById('worldDatapackList');

  function setWorldStatus(text, tone) {
    setHint(worldStatus, text, tone);
  }

  function setWorldManageStatus(text, tone) {
    setHint(worldManageStatus, text, tone);
  }

  function worldApi() {
    return window.launcherAPI || null;
  }

  function worldInstance() {
    return detailInstance();
  }

  function formatWorldDate(value) {
    if (!value) return '—';
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    var pad = function (n) { return n < 10 ? '0' + n : String(n); };
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  }

  function syncWorldView() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-world-view]'), function (view) {
      var active = view.getAttribute('data-world-view') === worldState.view;
      if (active) view.removeAttribute('hidden');
      else view.setAttribute('hidden', '');
    });
  }

  var worldTabs = createTabs({
    tabAttr: 'data-world-tab',
    panelAttr: 'data-world-panel',
    onChange: function (tab) {
      if (tab === 'backup') loadWorldBackups();
      if (tab === 'datapack') loadWorldDatapacks();
    }
  });

  function setWorldTab(tab) {
    worldState.tab = tab || 'info';
    worldTabs.set(worldState.tab);
  }

  function renderWorldEmpty(text) {
    if (!worldList) return;
    worldList.innerHTML = '';
    var empty = document.createElement('div');
    empty.className = 'content-empty';
    empty.textContent = text;
    worldList.appendChild(empty);
  }

  function renderWorldList() {
    if (!worldList) return;
    worldList.innerHTML = '';

    var query = worldState.query.trim().toLowerCase();
    var worlds = worldState.list.filter(function (world) {
      if (!query) return true;
      return String(world.levelName || '').toLowerCase().indexOf(query) >= 0
        || String(world.folder || '').toLowerCase().indexOf(query) >= 0;
    });

    if (worlds.length === 0) {
      renderWorldEmpty(worldState.list.length === 0 ? '这个实例还没有世界。' : '没有匹配的世界。');
      if (worldCount) worldCount.textContent = String(worldState.list.length);
      return;
    }

    var fragment = document.createDocumentFragment();
    worlds.forEach(function (world) {
      var row = document.createElement('div');
      row.className = 'content-row world-row';
      row.setAttribute('data-world-folder', world.folder);
      row.setAttribute('role', 'listitem');

      var icon = document.createElement('span');
      icon.className = 'world-row__icon';
      if (world.iconDataUrl) {
        var img = document.createElement('img');
        img.src = world.iconDataUrl;
        img.alt = '';
        icon.appendChild(img);
      } else {
        icon.textContent = 'WORLD';
      }

      var main = document.createElement('span');
      main.className = 'content-row__main';

      var name = document.createElement('span');
      name.className = 'content-row__name';
      name.textContent = world.levelName || world.folder;

      var meta = document.createElement('span');
      meta.className = 'content-row__meta';
      var mode = WORLD_GAME_TYPES[world.gameType] || '未知';
      var difficulty = WORLD_DIFFICULTIES[world.difficulty] || '未知';
      meta.textContent = [
        world.versionName || '未知版本',
        mode,
        difficulty,
        (world.size / (1024 * 1024)).toFixed(1) + ' MB',
        formatWorldDate(world.lastPlayed),
        world.hasLevelDat ? '' : '缺少 level.dat'
      ].filter(Boolean).join(' · ');

      main.appendChild(name);
      main.appendChild(meta);

      var actions = document.createElement('span');
      actions.className = 'world-row__actions';

      var manage = document.createElement('button');
      manage.type = 'button';
      manage.className = 'dialog-btn';
      manage.textContent = '管理';
      manage.setAttribute('data-world-open', world.folder);

      var menu = document.createElement('button');
      menu.type = 'button';
      menu.className = 'dialog-btn';
      menu.textContent = '⋯';
      menu.setAttribute('data-world-menu', world.folder);
      menu.setAttribute('aria-label', '世界操作');

      actions.appendChild(manage);
      actions.appendChild(menu);

      row.appendChild(icon);
      row.appendChild(main);
      row.appendChild(actions);
      fragment.appendChild(row);
    });

    worldList.appendChild(fragment);
    if (worldCount) worldCount.textContent = String(worlds.length);
  }

  function loadWorlds() {
    var api = worldApi();
    var instance = worldInstance();
    if (!api || typeof api.listWorlds !== 'function' || !instance) return;

    setWorldStatus('正在读取世界…');
    api.listWorlds({ instanceId: instance.id })
      .then(function (data) {
        worldState.list = (data && data.worlds) || [];
        worldState.loadedFor = instance.id;
        if (worldRootEl) worldRootEl.textContent = data && data.root ? data.root : '';
        renderWorldList();
        setWorldStatus(worldState.list.length
          ? '共 ' + worldState.list.length + ' 个世界 · 点击行进入管理'
          : '还没有世界，进入游戏创建后刷新', worldState.list.length ? 'ok' : '');
      })
      .catch(function (error) {
        console.error('[worlds] list failed:', error);
        worldState.list = [];
        renderWorldEmpty('读取世界列表失败');
        setWorldStatus('读取世界失败：' + describeLaunchError(error), 'error');
      });
  }

  function openWorldList() {
    worldState.view = 'list';
    worldState.folder = '';
    worldState.info = null;
    syncWorldView();
    loadWorlds();
  }

  function findWorld(folder) {
    return worldState.list.filter(function (world) { return world.folder === folder; })[0] || null;
  }

  function applyWorldInfo(info) {
    worldState.info = info;
    if (worldManageName) worldManageName.textContent = (info.levelName || info.folder)
      + (info.versionName ? ' · ' + info.versionName : '');

    if (worldCheats) worldCheats.setAttribute('aria-checked', info.allowCommands ? 'true' : 'false');
    if (worldFeatures) worldFeatures.setAttribute('aria-checked', info.generateFeatures ? 'true' : 'false');
    if (worldDifficulty) worldDifficulty.value = String(info.difficulty);
    if (worldLock) worldLock.setAttribute('aria-checked', info.difficultyLocked ? 'true' : 'false');
    if (worldGameMode) worldGameMode.value = String(info.gameType);

    var disabled = !info.hasLevelDat;
    [worldCheats, worldFeatures, worldDifficulty, worldLock, worldGameMode].forEach(function (node) {
      if (node) node.disabled = disabled;
    });

    if (worldInfoNote) {
      worldInfoNote.textContent = disabled
        ? '这个目录里没有 level.dat，无法读写世界设置。'
        : '种子 ' + (info.seed || '未知') + ' · 改动会直接写入 level.dat，覆盖前保留 level.dat_old。';
    }
    if (worldChunkbase) worldChunkbase.disabled = !info.seed;
  }

  function openWorldManage(folder) {
    var api = worldApi();
    var instance = worldInstance();
    if (!api || typeof api.getWorldInfo !== 'function' || !instance) return;

    worldState.view = 'manage';
    worldState.folder = folder;
    worldState.info = null;
    syncWorldView();
    setWorldTab('info');
    if (worldManageName) worldManageName.textContent = folder;
    setWorldManageStatus('正在读取 level.dat…');

    api.getWorldInfo({ instanceId: instance.id, folder: folder })
      .then(function (info) {
        applyWorldInfo(info);
        setWorldManageStatus(info.readError
          ? 'level.dat 读取失败：' + info.readError
          : '已读取世界信息', info.readError ? 'error' : 'ok');
      })
      .catch(function (error) {
        console.error('[worlds] info failed:', error);
        setWorldManageStatus('读取世界信息失败：' + describeLaunchError(error), 'error');
      });
  }

  function saveWorldPatch(patch) {
    var api = worldApi();
    var instance = worldInstance();
    if (!api || typeof api.saveWorldInfo !== 'function' || !instance || !worldState.folder) return;

    if (worldState.busy) return;
    worldState.busy = true;
    setWorldManageStatus('正在写入 level.dat…');

    api.saveWorldInfo({ instanceId: instance.id, folder: worldState.folder, patch: patch })
      .then(function (info) {
        worldState.busy = false;
        applyWorldInfo(info);
        var index = worldState.list.findIndex(function (world) { return world.folder === info.folder; });
        if (index >= 0) worldState.list[index] = info;
        renderWorldList();
        setWorldManageStatus('已写入 level.dat', 'ok');
      })
      .catch(function (error) {
        worldState.busy = false;
        console.error('[worlds] save failed:', error);
        setWorldManageStatus('写入失败：' + describeLaunchError(error), 'error');
      });
  }

  function chunkbaseUrl(app, seed) {
    var base = 'https://www.chunkbase.com/apps/' + app + '#seed=' + encodeURIComponent(seed) + '&platform=java';
    return base;
  }

  function openChunkbaseMenu(anchor) {
    var api = worldApi();
    var info = worldState.info;
    var seed = info && info.seed ? info.seed : '';
    if (!api || typeof api.openExternal !== 'function' || !seed || !anchor) return;

    closeWorldMenu();
    var menu = document.createElement('div');
    menu.className = 'account-menu ctx-menu world-menu';
    menu.setAttribute('role', 'menu');

    [
      { app: 'seed-map', label: '种子地图' },
      { app: 'stronghold-finder', label: '要塞地图' },
      { app: 'nether-fortress-finder', label: '下界要塞地图' },
      { app: 'end-city-finder', label: '末地城地图' }
    ].forEach(function (item) {
      var button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.setAttribute('data-world-map', item.app);
      button.textContent = item.label;
      menu.appendChild(button);
    });

    document.body.appendChild(menu);
    var rect = anchor.getBoundingClientRect();
    var menuRect = menu.getBoundingClientRect();
    var top = rect.bottom + 6;
    if (top + menuRect.height > window.innerHeight - 12) {
      top = Math.max(12, rect.top - menuRect.height - 6);
    }
    menu.style.top = Math.round(top) + 'px';
    menu.style.left = Math.round(Math.min(rect.left, window.innerWidth - menuRect.width - 12)) + 'px';
    var first = menu.querySelector('button');
    if (first) first.focus();
  }

  function closeWorldMenu() {
    var menu = document.querySelector('.world-menu');
    if (menu) menu.remove();
    openWorldMenuFolder = null;
  }

  function openWorldMenu(folder, anchor) {
    closeWorldMenu();
    closeInstanceMenu();
    closeAccountMenu();

    var api = worldApi();
    if (!api || !anchor) return;

    openWorldMenuFolder = folder;
    var menu = document.createElement('div');
    menu.className = 'account-menu ctx-menu world-menu';
    menu.setAttribute('role', 'menu');

    [
      { action: 'launch', label: '启动游戏' },
      { action: 'folder', label: '世界文件夹' },
      { action: 'rename', label: '重命名此世界' },
      { action: 'export', label: '导出此世界' },
      { action: 'duplicate', label: '复制此世界' },
      { action: 'delete', label: '删除此世界', danger: true }
    ].forEach(function (item) {
      var button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.setAttribute('data-world-action', item.action);
      button.textContent = item.label;
      if (item.danger) button.classList.add('is-danger');
      menu.appendChild(button);
    });

    document.body.appendChild(menu);
    var rect = anchor.getBoundingClientRect();
    var menuRect = menu.getBoundingClientRect();
    var top = rect.bottom + 6;
    if (top + menuRect.height > window.innerHeight - 12) {
      top = Math.max(12, rect.top - menuRect.height - 6);
    }
    menu.style.top = Math.round(top) + 'px';
    menu.style.left = Math.round(Math.min(rect.right - menuRect.width, window.innerWidth - menuRect.width - 12)) + 'px';
    var first = menu.querySelector('button');
    if (first) first.focus();
  }

  function exportWorld(folder) {
    var api = worldApi();
    var instance = worldInstance();
    if (!api || typeof api.exportWorld !== 'function' || !instance) return;
    setWorldManageStatus('正在导出压缩包…');
    api.exportWorld({ instanceId: instance.id, folder: folder })
      .then(function (result) {
        if (!result) {
          setWorldManageStatus('已取消导出');
          return;
        }
        setWorldManageStatus('已导出：' + result.file, 'ok');
      })
      .catch(function (error) {
        console.error('[worlds] export failed:', error);
        setWorldManageStatus('导出失败：' + describeLaunchError(error), 'error');
      });
  }

  function duplicateWorld(folder) {
    var api = worldApi();
    var instance = worldInstance();
    if (!api || typeof api.duplicateWorld !== 'function' || !instance) return;
    setWorldManageStatus('正在复制世界…');
    api.duplicateWorld({ instanceId: instance.id, folder: folder })
      .then(function (result) {
        setWorldManageStatus('已复制为「' + (result && result.folder) + '」', 'ok');
        loadWorlds();
      })
      .catch(function (error) {
        console.error('[worlds] duplicate failed:', error);
        setWorldManageStatus('复制失败：' + describeLaunchError(error), 'error');
      });
  }

  /**
   * 重命名世界（askPrompt 调用点 3/3：世界列表 / 世界管理页）。
   * 只改 level.dat 里的 LevelName（游戏内显示名），存档文件夹名不变。
   */
  function renameWorld(folder, currentName) {
    var api = worldApi();
    var instance = worldInstance();
    if (!api || typeof api.saveWorldInfo !== 'function' || !instance) return;

    askPrompt({
      title: '重命名世界',
      text: '只改世界在游戏内和列表里显示的名字，文件夹名保持「' + folder + '」不变。',
      label: '世界名称',
      value: currentName || folder,
      okText: '重命名',
      maxLength: 64
    }).then(function (name) {
      if (!name || name === (currentName || folder)) return;

      setWorldManageStatus('正在重命名…');
      return api.saveWorldInfo({
        instanceId: instance.id,
        folder: folder,
        patch: { levelName: name }
      })
        .then(function (info) {
          worldState.list = worldState.list.map(function (world) {
            if (world.folder !== folder) return world;
            return Object.assign({}, world, { levelName: name });
          });
          renderWorldList();

          if (worldState.folder === folder) {
            applyWorldInfo(Object.assign({}, worldState.info || {}, info || {}, { levelName: name }));
          }

          setWorldManageStatus('已重命名为「' + name + '」', 'ok');
        })
        .catch(function (error) {
          console.error('[worlds] rename failed:', error);
          setWorldManageStatus('重命名失败：' + describeLaunchError(error), 'error');
        });
    });
  }

  function deleteWorld(folder) {
    var api = worldApi();
    var instance = worldInstance();
    if (!api || typeof api.deleteWorld !== 'function' || !instance) return;

    askConfirm('删除世界「' + folder + '」？世界目录会从磁盘删除，不能撤销。', function () {
      api.deleteWorld({ instanceId: instance.id, folder: folder })
        .then(function (data) {
          worldState.view = 'list';
          worldState.folder = '';
          syncWorldView();
          worldState.list = (data && data.worlds) || [];
          renderWorldList();
          setWorldStatus('已删除世界：' + folder, 'ok');
        })
        .catch(function (error) {
          console.error('[worlds] delete failed:', error);
          setWorldStatus('删除失败：' + describeLaunchError(error), 'error');
        });
    }, '删除');
  }

  function openWorldFolder(folder) {
    var api = worldApi();
    var instance = worldInstance();
    if (!api || typeof api.openWorldFolder !== 'function' || !instance) return;
    api.openWorldFolder({ instanceId: instance.id, folder: folder })
      .then(function (result) {
        setWorldManageStatus('已请求打开：' + (result && result.path ? result.path : folder), 'ok');
      })
      .catch(function (error) {
        setWorldManageStatus(describeLaunchError(error), 'error');
      });
  }

  function loadWorldBackups() {
    var api = worldApi();
    var instance = worldInstance();
    if (!api || typeof api.listWorldBackups !== 'function' || !instance) return;
    if (!worldBackupList) return;

    api.listWorldBackups({ instanceId: instance.id })
      .then(function (data) {
        renderWorldBackups((data && data.backups) || []);
      })
      .catch(function (error) {
        console.error('[worlds] backups failed:', error);
        worldBackupList.innerHTML = '';
        var empty = document.createElement('div');
        empty.className = 'content-empty';
        empty.textContent = '读取备份失败：' + describeLaunchError(error);
        worldBackupList.appendChild(empty);
      });
  }

  function renderWorldBackups(backups) {
    if (!worldBackupList) return;
    worldBackupList.innerHTML = '';

    if (backups.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'content-empty';
      empty.textContent = '还没有备份。点「创建备份」把当前世界打包成 zip。';
      worldBackupList.appendChild(empty);
      return;
    }

    var fragment = document.createDocumentFragment();
    backups.forEach(function (backup) {
      var row = document.createElement('div');
      row.className = 'content-row';

      var main = document.createElement('span');
      main.className = 'content-row__main';
      var name = document.createElement('span');
      name.className = 'content-row__name';
      name.textContent = backup.folder + ' · ' + (backup.at || formatWorldDate(backup.mtime));
      var meta = document.createElement('span');
      meta.className = 'content-row__meta';
      meta.textContent = (backup.size / (1024 * 1024)).toFixed(1) + ' MB · '
        + formatWorldDate(backup.mtime);
      main.appendChild(name);
      main.appendChild(meta);

      var actions = document.createElement('span');
      actions.className = 'content-row__actions';

      var restore = document.createElement('button');
      restore.type = 'button';
      restore.className = 'dialog-btn';
      restore.textContent = '恢复';
      restore.setAttribute('data-world-backup-restore', backup.file);

      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'dialog-btn is-danger';
      remove.textContent = '删除';
      remove.setAttribute('data-world-backup-delete', backup.file);

      actions.appendChild(restore);
      actions.appendChild(remove);
      row.appendChild(main);
      row.appendChild(actions);
      fragment.appendChild(row);
    });

    worldBackupList.appendChild(fragment);
  }

  function createWorldBackup() {
    var api = worldApi();
    var instance = worldInstance();
    if (!api || typeof api.createWorldBackup !== 'function' || !instance) return;
    setWorldManageStatus('正在创建备份…');
    api.createWorldBackup({ instanceId: instance.id, folder: worldState.folder })
      .then(function (data) {
        renderWorldBackups((data && data.backups) || []);
        setWorldManageStatus('已创建备份', 'ok');
      })
      .catch(function (error) {
        console.error('[worlds] backup failed:', error);
        setWorldManageStatus('创建备份失败：' + describeLaunchError(error), 'error');
      });
  }

  function restoreWorldBackup(file) {
    var api = worldApi();
    var instance = worldInstance();
    if (!api || typeof api.restoreWorldBackup !== 'function' || !instance) return;
    setWorldManageStatus('正在恢复备份…');
    api.restoreWorldBackup({ instanceId: instance.id, file: file })
      .then(function (result) {
        setWorldManageStatus('已恢复为「' + (result && result.folder) + '」', 'ok');
        loadWorlds();
      })
      .catch(function (error) {
        console.error('[worlds] restore failed:', error);
        setWorldManageStatus('恢复失败：' + describeLaunchError(error), 'error');
      });
  }

  function deleteWorldBackup(file) {
    var api = worldApi();
    var instance = worldInstance();
    if (!api || typeof api.deleteWorldBackup !== 'function' || !instance) return;
    api.deleteWorldBackup({ instanceId: instance.id, file: file })
      .then(function (data) {
        renderWorldBackups((data && data.backups) || []);
        setWorldManageStatus('已删除备份', 'ok');
      })
      .catch(function (error) {
        setWorldManageStatus('删除备份失败：' + describeLaunchError(error), 'error');
      });
  }

  function loadWorldDatapacks() {
    var api = worldApi();
    var instance = worldInstance();
    if (!api || typeof api.listDatapacks !== 'function' || !instance) return;
    if (!worldDatapackList) return;

    api.listDatapacks({ instanceId: instance.id, folder: worldState.folder })
      .then(function (data) {
        renderWorldDatapacks((data && data.packs) || []);
      })
      .catch(function (error) {
        console.error('[worlds] datapacks failed:', error);
        worldDatapackList.innerHTML = '';
        var empty = document.createElement('div');
        empty.className = 'content-empty';
        empty.textContent = '读取数据包失败：' + describeLaunchError(error);
        worldDatapackList.appendChild(empty);
      });
  }

  function renderWorldDatapacks(packs) {
    if (!worldDatapackList) return;
    worldDatapackList.innerHTML = '';

    if (packs.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'content-empty';
      empty.textContent = '这个世界的 datapacks 目录是空的。';
      worldDatapackList.appendChild(empty);
      return;
    }

    var fragment = document.createDocumentFragment();
    packs.forEach(function (pack) {
      var row = document.createElement('div');
      row.className = 'content-row';

      var main = document.createElement('span');
      main.className = 'content-row__main';
      var name = document.createElement('span');
      name.className = 'content-row__name';
      name.textContent = pack.name;
      var meta = document.createElement('span');
      meta.className = 'content-row__meta';
      meta.textContent = (pack.isDirectory ? '文件夹' : '压缩包') + ' · '
        + (pack.size / 1024).toFixed(1) + ' KB · ' + formatWorldDate(pack.modifiedAt);
      main.appendChild(name);
      main.appendChild(meta);

      var actions = document.createElement('span');
      actions.className = 'content-row__actions';
      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'dialog-btn is-danger';
      remove.textContent = '删除';
      remove.setAttribute('data-world-datapack-delete', pack.name);
      actions.appendChild(remove);

      row.appendChild(main);
      row.appendChild(actions);
      fragment.appendChild(row);
    });

    worldDatapackList.appendChild(fragment);
  }

  function importWorldDatapack() {
    var api = worldApi();
    var instance = worldInstance();
    if (!api || typeof api.importDatapack !== 'function' || !instance) return;
    setWorldManageStatus('正在选择数据包…');
    api.importDatapack({ instanceId: instance.id, folder: worldState.folder })
      .then(function (data) {
        if (!data) {
          setWorldManageStatus('已取消导入');
          return;
        }
        renderWorldDatapacks((data && data.packs) || []);
        setWorldManageStatus('已导入 ' + (data.imported ? data.imported.length : 0) + ' 个数据包', 'ok');
      })
      .catch(function (error) {
        console.error('[worlds] import datapack failed:', error);
        setWorldManageStatus('导入失败：' + describeLaunchError(error), 'error');
      });
  }

  function deleteWorldDatapack(name) {
    var api = worldApi();
    var instance = worldInstance();
    if (!api || typeof api.deleteDatapack !== 'function' || !instance) return;
    api.deleteDatapack({ instanceId: instance.id, folder: worldState.folder, name: name })
      .then(function (data) {
        renderWorldDatapacks((data && data.packs) || []);
        setWorldManageStatus('已删除数据包', 'ok');
      })
      .catch(function (error) {
        setWorldManageStatus('删除失败：' + describeLaunchError(error), 'error');
      });
  }

  // ---- 世界：事件 ----

  if (worldSearch) {
    worldSearch.addEventListener('input', function () {
      worldState.query = worldSearch.value;
      renderWorldList();
    });
  }

  if (worldRefresh) {
    worldRefresh.addEventListener('click', function () {
      loadWorlds();
    });
  }

  if (worldOpenFolder) {
    worldOpenFolder.addEventListener('click', function () {
      var api = worldApi();
      var instance = worldInstance();
      if (!api || typeof api.openInstanceContentFolder !== 'function' || !instance) return;
      api.openInstanceContentFolder({ instanceId: instance.id, kind: 'saves' })
        .then(function () { setWorldStatus('已打开世界文件夹', 'ok'); })
        .catch(function (error) { setWorldStatus(describeLaunchError(error), 'error'); });
    });
  }

  if (worldChunkbase) {
    worldChunkbase.addEventListener('click', function () {
      var world = findWorld(worldState.folder);
      if (world) {
        worldState.info = world;
      }
      if (!worldState.info) {
        var first = worldState.list[0];
        if (first) worldState.info = first;
      }
      openChunkbaseMenu(worldChunkbase);
    });
  }

  if (worldList) {
    worldList.addEventListener('click', function (event) {
      var target = event.target;
      if (!target || !target.closest) return;

      var menuBtn = target.closest('[data-world-menu]');
      if (menuBtn) {
        openWorldMenu(menuBtn.getAttribute('data-world-menu'), menuBtn);
        return;
      }

      var openBtn = target.closest('[data-world-open]');
      if (openBtn) {
        openWorldManage(openBtn.getAttribute('data-world-open'));
        return;
      }

      var row = target.closest('[data-world-folder]');
      if (row) openWorldManage(row.getAttribute('data-world-folder'));
    });
  }

  if (worldManageBack) {
    worldManageBack.addEventListener('click', function () {
      openWorldList();
    });
  }

  if (worldCheats) {
    worldCheats.addEventListener('click', function () {
      saveWorldPatch({ allowCommands: worldCheats.getAttribute('aria-checked') !== 'true' });
    });
  }

  if (worldFeatures) {
    worldFeatures.addEventListener('click', function () {
      saveWorldPatch({ generateFeatures: worldFeatures.getAttribute('aria-checked') !== 'true' });
    });
  }

  if (worldDifficulty) {
    worldDifficulty.addEventListener('change', function () {
      saveWorldPatch({ difficulty: Number(worldDifficulty.value) });
    });
  }

  if (worldLock) {
    worldLock.addEventListener('click', function () {
      saveWorldPatch({ difficultyLocked: worldLock.getAttribute('aria-checked') !== 'true' });
    });
  }

  if (worldGameMode) {
    worldGameMode.addEventListener('change', function () {
      saveWorldPatch({ gameType: Number(worldGameMode.value) });
    });
  }

  if (worldLaunch) {
    worldLaunch.addEventListener('click', function () {
      var instance = worldInstance();
      if (instance) launchInstanceFlow(instance, false);
    });
  }

  if (worldScript) {
    worldScript.addEventListener('click', function () {
      var instance = worldInstance();
      if (instance) createLaunchScript(instance);
    });
  }

  if (worldExport) worldExport.addEventListener('click', function () { exportWorld(worldState.folder); });
  if (worldDuplicate) worldDuplicate.addEventListener('click', function () { duplicateWorld(worldState.folder); });
  if (worldDelete) worldDelete.addEventListener('click', function () { deleteWorld(worldState.folder); });
  if (worldManageFolder) worldManageFolder.addEventListener('click', function () { openWorldFolder(worldState.folder); });
  if (worldManageChunkbase) {
    worldManageChunkbase.addEventListener('click', function () {
      openChunkbaseMenu(worldManageChunkbase);
    });
  }

  var worldBackupCreateBtn = document.getElementById('worldBackupCreate');
  var worldBackupFolderBtn = document.getElementById('worldBackupFolder');
  var worldBackupRefreshBtn = document.getElementById('worldBackupRefresh');
  var worldDatapackImportBtn = document.getElementById('worldDatapackImport');
  var worldDatapackFolderBtn = document.getElementById('worldDatapackFolder');
  var worldDatapackRefreshBtn = document.getElementById('worldDatapackRefresh');

  if (worldBackupCreateBtn) worldBackupCreateBtn.addEventListener('click', createWorldBackup);
  if (worldBackupRefreshBtn) worldBackupRefreshBtn.addEventListener('click', loadWorldBackups);
  if (worldBackupFolderBtn) {
    worldBackupFolderBtn.addEventListener('click', function () {
      var api = worldApi();
      var instance = worldInstance();
      if (!api || typeof api.openWorldBackupFolder !== 'function' || !instance) return;
      api.openWorldBackupFolder({ instanceId: instance.id })
        .then(function () { setWorldManageStatus('已打开备份文件夹', 'ok'); })
        .catch(function (error) { setWorldManageStatus(describeLaunchError(error), 'error'); });
    });
  }
  if (worldDatapackImportBtn) worldDatapackImportBtn.addEventListener('click', importWorldDatapack);
  if (worldDatapackRefreshBtn) worldDatapackRefreshBtn.addEventListener('click', loadWorldDatapacks);
  if (worldDatapackFolderBtn) {
    worldDatapackFolderBtn.addEventListener('click', function () {
      var api = worldApi();
      var instance = worldInstance();
      if (!api || typeof api.openWorldFolder !== 'function' || !instance) return;
      api.openWorldFolder({ instanceId: instance.id, folder: worldState.folder })
        .then(function () { setWorldManageStatus('已打开世界文件夹', 'ok'); })
        .catch(function (error) { setWorldManageStatus(describeLaunchError(error), 'error'); });
    });
  }

  if (worldBackupList) {
    worldBackupList.addEventListener('click', function (event) {
      var target = event.target;
      if (!target || !target.closest) return;
      var restore = target.closest('[data-world-backup-restore]');
      if (restore) {
        restoreWorldBackup(restore.getAttribute('data-world-backup-restore'));
        return;
      }
      var remove = target.closest('[data-world-backup-delete]');
      if (remove) deleteWorldBackup(remove.getAttribute('data-world-backup-delete'));
    });
  }

  if (worldDatapackList) {
    worldDatapackList.addEventListener('click', function (event) {
      var target = event.target;
      if (!target || !target.closest) return;
      var remove = target.closest('[data-world-datapack-delete]');
      if (remove) deleteWorldDatapack(remove.getAttribute('data-world-datapack-delete'));
    });
  }

  // 世界菜单 / Chunkbase 菜单：点外面关闭、点菜单项执行
  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.closest) return;

    var mapItem = target.closest('[data-world-map]');
    if (mapItem) {
      var info = worldState.info;
      var seed = info && info.seed ? info.seed : '';
      var api = worldApi();
      if (seed && api && typeof api.openExternal === 'function') {
        api.openExternal(chunkbaseUrl(mapItem.getAttribute('data-world-map'), seed));
      }
      closeWorldMenu();
      return;
    }

    var actionItem = target.closest('[data-world-action]');
    if (actionItem) {
      var folder = openWorldMenuFolder;
      var action = actionItem.getAttribute('data-world-action');
      closeWorldMenu();
      if (!folder) return;
      if (action === 'launch') {
        var instance = worldInstance();
        if (instance) launchInstanceFlow(instance, false);
      } else if (action === 'folder') openWorldFolder(folder);
      else if (action === 'rename') {
        var target = findWorld(folder);
        renameWorld(folder, target ? target.levelName : folder);
      }
      else if (action === 'export') exportWorld(folder);
      else if (action === 'duplicate') duplicateWorld(folder);
      else if (action === 'delete') deleteWorld(folder);
      return;
    }

    if (target.closest('[data-world-menu]') || target.closest('.world-menu')) return;
    if (openWorldMenuFolder) closeWorldMenu();
  });

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    if (!document.querySelector('.world-menu')) return;
    event.stopPropagation();
    closeWorldMenu();
  }, true);

  // ---------------- 页签 / 文件夹入口绑定 ----------------

  var detailBackBtn = document.getElementById('detailBack');
  if (detailBackBtn) {
    detailBackBtn.addEventListener('click', function () {
      showPanel('instances');
      renderInstancePanel();
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll('[data-detail-folder]'), function (button) {
    button.addEventListener('click', function () {
      var kind = button.getAttribute('data-detail-folder');
      var api = window.launcherAPI;
      var instance = detailInstance();
      if (!api || !instance) return;

      if (kind === 'game') {
        api.openInstanceFolder({ instanceId: instance.id })
          .then(function (result) {
            setDetailStatus('已请求打开实例目录：' + shortPath(result && result.path), 'ok');
          })
          .catch(function (error) { setDetailStatus(describeLaunchError(error), 'error'); });
        return;
      }

      openContentFolder(kind);
    });
  });

  var detailIconBtn = document.getElementById('detailIconBtn');
  if (detailIconBtn) {
    detailIconBtn.addEventListener('click', function () {
      if (detailInstanceId) openIconDialog(detailInstanceId);
    });
  }

  // 右侧「当前配置」卡点进去看实例详情（HMCL 的「游戏」页也是这么进）
  if (configCard) {
    configCard.addEventListener('click', function () {
      var instance = getSelectedInstance();
      if (instance) openInstanceDetail(instance.id);
    });
  }

  // ---------------- [L5] 实例图标选择 ----------------

  function renderIconGrid(activeKey) {
    var grid = document.getElementById('iconGrid');
    if (!grid) return;

    grid.innerHTML = '';

    ICON_PRESETS.forEach(function (preset) {
      var tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'icon-tile' + (preset.key === activeKey ? ' is-active' : '');
      tile.setAttribute('data-icon-key', preset.key);
      tile.setAttribute('aria-label', preset.label);
      tile.title = preset.label;
      tile.innerHTML = cubeSvg(preset);
      grid.appendChild(tile);
    });
  }

  function openIconDialog(id) {
    var instance = instanceById(id);
    if (!instance) return;

    iconTargetId = id;
    renderIconGrid(instance.iconKey || '');
    setHint(document.getElementById('iconDialogStatus'), '');
    openDialog('icon');
  }

  function applyIconResult(result) {
    var instance = instanceById(iconTargetId);
    if (instance && result) {
      instance.iconKey = result.iconKey || '';
      instance.iconDataUrl = result.iconDataUrl || '';
    }

    renderInstancePanel();
    if (detailInstanceId && detailInstanceId === iconTargetId) renderDetailHeader();
    renderInstanceList();
  }

  var iconGrid = document.getElementById('iconGrid');
  if (iconGrid) {
    iconGrid.addEventListener('click', function (event) {
      var tile = event.target.closest ? event.target.closest('[data-icon-key]') : null;
      if (!tile) return;

      var api = window.launcherAPI;
      if (!api || typeof api.setInstanceBuiltinIcon !== 'function' || !iconTargetId) return;

      var key = tile.getAttribute('data-icon-key');
      var status = document.getElementById('iconDialogStatus');
      setHint(status, '正在应用…');

      api.setInstanceBuiltinIcon({ instanceId: iconTargetId, key: key })
        .then(function (result) {
          applyIconResult(result);
          renderIconGrid(key);
          setHint(status, '已应用内置图标', 'ok');
          window.setTimeout(closeDialog, 320);
        })
        .catch(function (error) {
          setHint(status, describeLaunchError(error), 'error');
        });
    });
  }

  var iconPickFile = document.getElementById('iconPickFile');
  if (iconPickFile) {
    iconPickFile.addEventListener('click', function () {
      var api = window.launcherAPI;
      if (!api || typeof api.pickInstanceIcon !== 'function' || !iconTargetId) return;

      var status = document.getElementById('iconDialogStatus');
      setHint(status, '正在选择图片…');

      api.pickInstanceIcon({ instanceId: iconTargetId })
        .then(function (result) {
          if (!result) {
            setHint(status, '');
            return;
          }
          applyIconResult(result);
          setHint(status, '已使用本地图片', 'ok');
          window.setTimeout(closeDialog, 320);
        })
        .catch(function (error) {
          setHint(status, describeLaunchError(error), 'error');
        });
    });
  }

  var iconReset = document.getElementById('iconReset');
  if (iconReset) {
    iconReset.addEventListener('click', function () {
      var api = window.launcherAPI;
      if (!api || typeof api.clearInstanceIcon !== 'function' || !iconTargetId) return;

      api.clearInstanceIcon({ instanceId: iconTargetId })
        .then(function (result) {
          applyIconResult(result);
          renderIconGrid('');
          setHint(document.getElementById('iconDialogStatus'), '已恢复默认图标', 'ok');
          window.setTimeout(closeDialog, 320);
        })
        .catch(function (error) {
          setHint(document.getElementById('iconDialogStatus'), describeLaunchError(error), 'error');
        });
    });
  }

  // ---------------------------------------------------------
  // 页面返回按钮与入口
  // ---------------------------------------------------------
  var instancesBackBtn = document.getElementById('instancesBack');
  if (instancesBackBtn) {
    instancesBackBtn.addEventListener('click', function () {
      closeActivePanel({ focus: true });
    });
  }

  var gameDirBackBtn = document.getElementById('gameDirBack');
  if (gameDirBackBtn) {
    gameDirBackBtn.addEventListener('click', function () {
      closeActivePanel({ focus: true });
    });
  }

  var newInstanceBtn = document.getElementById('newInstanceBtn');
  if (newInstanceBtn) {
    newInstanceBtn.addEventListener('click', function () {
      openCreatePanel();
    });
  }

  var instanceEntries = document.getElementById('instanceEntries');
  if (instanceEntries) {
    instanceEntries.addEventListener('click', function (event) {
      var trigger = event.target.closest ? event.target.closest('[data-instance-action]') : null;
      if (!trigger) return;

      var action = trigger.getAttribute('data-instance-action');

      window.dispatchEvent(new CustomEvent('launcher:instance-action', {
        detail: {
          action: action,
          key: trigger.getAttribute('data-control-key'),
          instance: getSelectedInstance()
        }
      }));

      if (action === 'edit') {
        var instance = getSelectedInstance();
        if (!instance) {
          setInstancePanelStatus('还没有可修改的实例', 'error');
          return;
        }
        openInstanceDialog(instance.id);
        return;
      }

      if (action === 'add-directory') {
        openGameDirPage();
        return;
      }

      if (action === 'global-settings') {
        openGlobalGameSettings();
      }
    });
  }

  var instanceRowsEl = document.getElementById('instanceRows');
  if (instanceRowsEl) {
    instanceRowsEl.addEventListener('click', function (event) {
      var menuBtn = event.target.closest ? event.target.closest('[data-instance-menu]') : null;
      if (menuBtn) {
        var menuId = menuBtn.getAttribute('data-instance-menu');
        if (openInstanceMenuId === menuId) closeInstanceMenu();
        else openInstanceMenu(menuId, menuBtn);
        return;
      }

      var row = event.target.closest ? event.target.closest('[data-instance-row]') : null;
      if (row) {
        selectInstance(row.getAttribute('data-instance-row'));
        setInstancePanelStatus('');
      }
    });

    instanceRowsEl.addEventListener('contextmenu', function (event) {
      var row = event.target.closest ? event.target.closest('[data-instance-row]') : null;
      if (!row) return;
      event.preventDefault();
      var anchor = row.querySelector('[data-instance-menu]') || row;
      openInstanceMenu(row.getAttribute('data-instance-row'), anchor);
    });

    // 双击进入该实例的管理页（启动走右侧「启动游戏」或右键菜单的「启动游戏」）
    instanceRowsEl.addEventListener('dblclick', function (event) {
      var row = event.target.closest ? event.target.closest('[data-instance-row]') : null;
      if (!row) return;
      var instance = instanceById(row.getAttribute('data-instance-row'));
      if (instance) openInstanceDetail(instance.id);
    });
  }

  // 实例菜单也挂在 body 上，统一在 document 上收口
  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.closest) return;

    var actionEl = target.closest('[data-instance-menu-action]');
    if (actionEl) {
      handleInstanceMenuAction(
        actionEl.getAttribute('data-instance-menu-action'),
        actionEl.getAttribute('data-instance-menu-id')
      );
      return;
    }

    // 点「⋯」或菜单本身时不要走到「点外面就关闭」这一步：
    // 行上的处理器已经把菜单开/关了，这里再关一次会表现为「点了没反应」。
    if (target.closest('[data-instance-menu]') || target.closest('.ctx-menu')) return;

    if (openInstanceMenuId) closeInstanceMenu();
  });

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;

    if (openDialogName) return;          // 弹窗的 Esc 由前面的捕获阶段处理
    if (openInstanceMenuId) {
      event.stopPropagation();
      closeInstanceMenu();
      return;
    }
    if (activePanel) {
      closeActivePanel({ focus: true });
    }
  });

  if (window.launcherAPI && typeof window.launcherAPI.onLaunchProgress === 'function') {
    window.launcherAPI.onLaunchProgress(function (payload) {
      if (!payload) return;
      if (payload.phase === 'starting') {
        setLaunchNote('正在准备 ' + (payload.versionId || '实例') + ' …', false);
      } else if (payload.phase === 'spawned') {
        setLaunchNote('游戏已启动 · PID ' + (payload.pid || '-'), false);
      } else if (payload.phase === 'error') {
        setLaunchNote(describeLaunchError({ message: payload.message }), true);
      } else if (payload.phase === 'exit') {
        setLaunchNote('游戏已退出（code ' + payload.code + '）', payload.code !== 0);
      }
    });
  }

  loadAccounts();

  // 软件渲染时启用降级样式：去掉每帧重算的 backdrop-filter 与极光动画。
  (function detectRenderMode() {
    var api = window.launcherAPI;
    if (!api || typeof api.getRenderMode !== 'function') return;

    api.getRenderMode()
      .then(function (info) {
        if (!info) return;
        if (info.software) {
          document.body.classList.add('is-software');
          console.log('[render] 软件渲染模式：已启用降级样式');
        } else {
          document.body.classList.remove('is-software');
        }
      })
      .catch(function (error) {
        console.warn('[render] 读取渲染模式失败:', error && error.message);
      });
  })();

  // ---------------------------------------------------------
  // 主视区立方体：6 个面 + 拖动旋转（松手后按拖动速度继续转）
  // ---------------------------------------------------------
  (function setupVoxelDrag() {
    var cube = document.getElementById('voxelCube');
    var holder = document.getElementById('voxelFloat');
    if (!cube || !holder) return;

    var reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

    var DEG_PER_PX = 0.42;   // 拖动灵敏度：像素 → 角度
    var MAX_SPIN = 900;      // 惯性最大角速度（度 / 秒）
    var IDLE_SPIN = 13;      // 松手后回落到的基础自转（度 / 秒），约等于原来 30 秒一圈
    var REST_TILT = -22;     // 默认俯仰角
    var TILT_MIN = -78;
    var TILT_MAX = 78;
    var SPIN_DECAY = 3.0;    // 角速度衰减系数，越大停得越快

    var tilt = REST_TILT;
    var spin = -32;
    var velTilt = 0;
    var velSpin = 0;

    var dragging = false;
    var pointerId = null;
    var lastX = 0;
    var lastY = 0;
    var lastMoveAt = 0;
    var lastFrameAt = 0;
    var frameHandle = 0;

    function clamp(value, min, max) {
      return value < min ? min : (value > max ? max : value);
    }

    function paint() {
      cube.style.transform = 'rotateX(' + tilt.toFixed(2) + 'deg) rotateY(' + spin.toFixed(2) + 'deg)';
    }

    function schedule() {
      if (frameHandle) return;
      frameHandle = requestAnimationFrame(step);
    }

    function step(now) {
      frameHandle = 0;

      var dt = lastFrameAt ? Math.min(0.05, (now - lastFrameAt) / 1000) : 0.016;
      lastFrameAt = now;

      // 拖动中由 pointermove 直接改角度，这里不插值
      if (dragging) {
        schedule();
        return;
      }
      // 系统开启「减少动态效果」时只保留拖动，不做自转与惯性
      if (reduced) return;

      spin += velSpin * dt;
      tilt += velTilt * dt;

      var decay = Math.exp(-SPIN_DECAY * dt);

      // 竖直方向：松手后缓慢回到默认俯仰角
      velTilt *= decay;
      if (Math.abs(velTilt) < 30) {
        tilt += (REST_TILT - tilt) * Math.min(1, dt * 1.6);
      }
      tilt = clamp(tilt, TILT_MIN, TILT_MAX);

      // 水平方向：高于基础自转时按摩擦衰减；降到基础速度后收拢到基础自转。
      // 两段分开处理，避免「摩擦」和「回落到基础速度」互相拉扯到中间值。
      if (Math.abs(velSpin) > IDLE_SPIN) {
        velSpin *= decay;
      } else {
        velSpin += (IDLE_SPIN - velSpin) * Math.min(1, dt * 4);
      }

      paint();
      schedule();
    }

    function onPointerDown(event) {
      if (event.pointerType === 'mouse' && event.button !== 0) return;

      dragging = true;
      pointerId = event.pointerId;
      lastX = event.clientX;
      lastY = event.clientY;
      lastMoveAt = performance.now();
      velSpin = 0;
      velTilt = 0;

      holder.classList.add('is-dragging');
      try {
        holder.setPointerCapture(pointerId);
      } catch (error) {
        // 某些环境下没有 pointer capture，退化为普通拖动
      }

      schedule();
      event.preventDefault();
    }

    function onPointerMove(event) {
      if (!dragging || event.pointerId !== pointerId) return;

      var now = performance.now();
      var dx = event.clientX - lastX;
      var dy = event.clientY - lastY;
      var dt = Math.max(0.004, (now - lastMoveAt) / 1000);

      spin += dx * DEG_PER_PX;
      tilt = clamp(tilt - dy * DEG_PER_PX, TILT_MIN, TILT_MAX);

      // 拖动速度决定松手后的惯性；与拖动方向一致。
      // 用指数平滑，避免只取最后一帧造成的抖动。
      var instantSpin = (dx * DEG_PER_PX) / dt;
      var instantTilt = (-dy * DEG_PER_PX) / dt;
      velSpin = clamp(velSpin * 0.55 + instantSpin * 0.45, -MAX_SPIN, MAX_SPIN);
      velTilt = clamp(velTilt * 0.55 + instantTilt * 0.45, -MAX_SPIN, MAX_SPIN);

      lastX = event.clientX;
      lastY = event.clientY;
      lastMoveAt = now;

      paint();
      event.preventDefault();
    }

    function endDrag() {
      if (!dragging) return;

      dragging = false;
      holder.classList.remove('is-dragging');

      if (pointerId !== null) {
        try {
          holder.releasePointerCapture(pointerId);
        } catch (error) {
          // 已经释放
        }
      }
      pointerId = null;

      // 松手前停住超过 120ms：当作没有甩动
      if (performance.now() - lastMoveAt > 120) {
        velSpin = 0;
        velTilt = 0;
      }

      if (reduced) paint();
      else schedule();
    }

    holder.addEventListener('pointerdown', onPointerDown);
    holder.addEventListener('pointermove', onPointerMove);
    holder.addEventListener('pointerup', endDrag);
    holder.addEventListener('pointercancel', endDrag);
    holder.addEventListener('lostpointercapture', endDrag);
    holder.addEventListener('dragstart', function (event) { event.preventDefault(); });

    // 窗口隐藏时停掉动画，回来再继续
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        if (frameHandle) {
          cancelAnimationFrame(frameHandle);
          frameHandle = 0;
        }
        return;
      }
      if (!reduced) schedule();
    });

    paint();
    if (!reduced) schedule();
  })();

  // 静态截图用：打开 #stack 定格在左上拉伸
  if (window.location.hash === '#stack') {
    applyStack(-0.8, -0.8);
    ring.style.transition = 'none';
    void ring.offsetWidth;
  }

  // ---------------------------------------------------------
  // 下载中心（对照 docs/history/ui-tree-controls.html 的 [L2] 下载）
  //   [L3] 游戏版本        ← 最新正式版 / 最新快照 / 版本列表 / 刷新
  //   [L4] 安装向导·可选文件 ← dlgInstall（加载器 / 加载器版本 / 实例名 / assets）
  //   [L3] 整合包          ← 来源 / 选择文件 / 可选文件预览 / 安装
  //   [L3] 内容列表        ← 模组 / 资源包 / 光影 / 世界（在线源待接入）
  // ---------------------------------------------------------
  var stageDownload = document.getElementById('stageDownload');
  var downloadRailBtn = document.getElementById('downloadRailBtn');
  var downloadBack = document.getElementById('downloadBack');
  var downloadSearch = document.getElementById('downloadSearch');
  var downloadType = document.getElementById('downloadType');
  var downloadRefresh = document.getElementById('downloadRefresh');
  var downloadLatest = document.getElementById('downloadLatest');
  var downloadVersions = document.getElementById('downloadVersions');
  var downloadStatus = document.getElementById('downloadStatus');
  var downloadCount = document.getElementById('downloadCount');

  var packSources = document.getElementById('packSources');
  var packPick = document.getElementById('packPick');
  var packFileEl = document.getElementById('packFile');
  var packMetaEl = document.getElementById('packMeta');
  var packName = document.getElementById('packName');
  var packOptional = document.getElementById('packOptional');
  var packInstall = document.getElementById('packInstall');
  var packStatus = document.getElementById('packStatus');

  var installVersionEl = document.getElementById('installVersion');
  var installMetaEl = document.getElementById('installMeta');
  var installLoader = document.getElementById('installLoader');
  var installLoaderVersionField = document.getElementById('installLoaderVersionField');
  var installLoaderVersion = document.getElementById('installLoaderVersion');
  var installName = document.getElementById('installName');
  var installAssets = document.getElementById('installAssets');
  var installReveal = document.getElementById('installReveal');
  var installStatus = document.getElementById('installStatus');
  var installSubmit = document.getElementById('installSubmit');

  var packFilesMeta = document.getElementById('packFilesMeta');
  var packFilesList = document.getElementById('packFilesList');

  var DOWNLOAD_LIST_LIMIT = 240;

  var downloadCatalog = null;
  var downloadLoading = false;
  var downloadTab = 'game';
  var installBusy = false;
  var packBusy = false;
  var packInfo = null;
  var installState = {
    version: '',
    loader: 'Vanilla',
    mcVersion: '',
    entries: [],
    loading: false,
    error: ''
  };

  function setDownloadStatus(text, tone) {
    setHint(downloadStatus, text, tone);
  }

  function setPackStatus(text, tone) {
    setHint(packStatus, text, tone);
  }

  function setInstallStatus(text, tone) {
    setHint(installStatus, text, tone);
  }

  function versionTypeText(type) {
    if (type === 'snapshot') return '快照';
    if (type === 'old') return '远古';
    return '正式';
  }

  function formatBytes(bytes) {
    var value = Number(bytes) || 0;
    if (value >= 1024 * 1024 * 1024) return (value / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    if (value >= 1024 * 1024) return (value / (1024 * 1024)).toFixed(1) + ' MB';
    if (value >= 1024) return (value / 1024).toFixed(0) + ' KB';
    return value + ' B';
  }

  function installedVersionSet() {
    var set = {};
    (INSTANCES || []).forEach(function (instance) {
      var version = instance && instance.versionName ? String(instance.versionName) : '';
      if (version) set[version] = true;
    });
    return set;
  }

  function downloadFilteredVersions() {
    if (!downloadCatalog || !Array.isArray(downloadCatalog.versions)) return [];
    var type = downloadType ? downloadType.value : 'release';
    var keyword = downloadSearch && downloadSearch.value
      ? downloadSearch.value.trim().toLowerCase()
      : '';

    return downloadCatalog.versions.filter(function (version) {
      if (!version || !version.id) return false;
      if (type !== 'all' && version.type !== type) return false;
      if (!keyword) return true;
      return String(version.id).toLowerCase().indexOf(keyword) >= 0
        || String(version.date || '').indexOf(keyword) >= 0;
    });
  }

  function renderDownloadLatest() {
    if (!downloadLatest) return;
    downloadLatest.innerHTML = '';

    if (!downloadCatalog) {
      downloadLatest.hidden = true;
      return;
    }

    var cards = [
      { kicker: 'Latest release / 最新正式版', id: downloadCatalog.latestRelease },
      { kicker: 'Latest snapshot / 最新快照', id: downloadCatalog.latestSnapshot }
    ].filter(function (item) {
      return Boolean(item.id);
    });

    if (cards.length === 0) {
      downloadLatest.hidden = true;
      return;
    }

    cards.forEach(function (item) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'latest-card';
      button.setAttribute('data-download-latest', item.id);

      var kicker = document.createElement('span');
      kicker.className = 'latest-card__kicker';
      kicker.textContent = item.kicker;

      var id = document.createElement('span');
      id.className = 'latest-card__id';
      id.textContent = item.id;

      var note = document.createElement('span');
      note.className = 'latest-card__note';
      note.textContent = '点击选择版本并安装';

      button.appendChild(kicker);
      button.appendChild(id);
      button.appendChild(note);
      downloadLatest.appendChild(button);
    });

    downloadLatest.hidden = false;
  }

  function renderDownloadVersions() {
    if (!downloadVersions) return;
    downloadVersions.innerHTML = '';
    renderDownloadLatest();

    var list = downloadFilteredVersions();
    var total = downloadCatalog && Array.isArray(downloadCatalog.versions)
      ? downloadCatalog.versions.length
      : 0;

    if (!downloadCatalog) {
      if (downloadCount) downloadCount.textContent = '';
      return;
    }

    if (list.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'download-empty';
      var strong = document.createElement('strong');
      strong.textContent = '没有匹配的版本';
      var span = document.createElement('span');
      span.textContent = '换一个版本类型，或者清空搜索关键词。';
      empty.appendChild(strong);
      empty.appendChild(span);
      downloadVersions.appendChild(empty);
      if (downloadCount) downloadCount.textContent = '共 ' + total + ' 个';
      return;
    }

    var installed = installedVersionSet();
    var shown = list.slice(0, DOWNLOAD_LIST_LIMIT);
    var fragment = document.createDocumentFragment();

    shown.forEach(function (version) {
      var card = document.createElement('button');
      card.type = 'button';
      card.className = 'version-card';
      card.setAttribute('role', 'listitem');
      card.setAttribute('data-download-version', version.id);
      card.setAttribute('aria-label', '安装 ' + version.id);
      if (installed[version.id]) card.classList.add('is-installed');

      var id = document.createElement('span');
      id.className = 'version-card__id';
      id.textContent = version.id;

      var row = document.createElement('span');
      row.className = 'version-card__row';

      var date = document.createElement('span');
      date.textContent = version.date || '—';

      var badge = document.createElement('span');
      badge.className = 'version-card__badge';
      badge.textContent = installed[version.id] ? '已安装' : versionTypeText(version.type);

      row.appendChild(date);
      row.appendChild(badge);
      card.appendChild(id);
      card.appendChild(row);
      fragment.appendChild(card);
    });

    downloadVersions.appendChild(fragment);
    if (downloadCount) {
      downloadCount.textContent = '匹配 ' + list.length + ' / 共 ' + total
        + (list.length > shown.length ? ' · 显示前 ' + shown.length : '');
    }
  }

  function loadDownloadCatalog(force) {
    if (downloadLoading) return;
    var api = window.launcherAPI;
    if (!api || typeof api.getVersionCatalog !== 'function') {
      setDownloadStatus('主进程桥接不可用，无法读取版本列表', 'error');
      return;
    }

    downloadLoading = true;
    if (downloadRefresh) downloadRefresh.classList.add('is-busy');
    setDownloadStatus(force ? '正在刷新版本列表…' : '正在从 mcdl 读取版本列表…');
    renderDownloadVersions();

    api.getVersionCatalog({ force: Boolean(force) })
      .then(function (data) {
        downloadLoading = false;
        if (downloadRefresh) downloadRefresh.classList.remove('is-busy');
        if (!data || !Array.isArray(data.versions) || data.versions.length === 0) {
          throw new Error('mcdl 返回的版本列表为空');
        }
        downloadCatalog = data;
        renderDownloadVersions();
        fillAddonVersionOptions();
        var latest = data.latestRelease ? ' 最新正式版 ' + data.latestRelease : '';
        setDownloadStatus('版本列表已就绪' + latest, 'ok');
      })
      .catch(function (error) {
        downloadLoading = false;
        if (downloadRefresh) downloadRefresh.classList.remove('is-busy');
        downloadCatalog = null;
        renderDownloadVersions();
        console.error('[downloads] failed to load versions:', error);
        setDownloadStatus('无法读取版本列表：' + (error && error.message ? error.message : error), 'error');
        if (downloadCount) downloadCount.textContent = '';
      });
  }

  var downloadTabs = createTabs({
    tabAttr: 'data-download-tab',
    panelAttr: 'data-download-pane',
    onChange: function (tab) {
      if (tab === 'game' && !downloadCatalog && !downloadLoading) {
        loadDownloadCatalog(false);
      }

      if (ADDON_PAGES && ADDON_PAGES[tab]) {
        updateAddonTargets();
        fillAddonVersionOptions();
        var addonPage = ADDON_PAGES[tab];
        if (!addonPage.loaded && !addonPage.loading) searchAddons(tab);
      }
    }
  });

  function setDownloadTab(tab) {
    downloadTab = tab || 'game';
    downloadTabs.set(downloadTab);
  }

  function openDownloadPanel() {
    if (!mainStage || !stageDownload) return;

    showPanel('download');
    setDownloadTab(downloadTab);
    if (!downloadCatalog) loadDownloadCatalog(false);

    window.setTimeout(function () {
      if (downloadSearch) downloadSearch.focus({ preventScroll: true });
    }, 220);

    window.dispatchEvent(new CustomEvent('launcher:panel-change', {
      detail: { panel: 'download' }
    }));
  }

  function closeDownloadPanel(options) {
    if (installBusy || packBusy) return;
    options = options || {};
    hideActivePanel({ focus: false });
    if (options.focus !== false && downloadRailBtn) downloadRailBtn.focus();
  }

  function updateInstallSummary() {
    if (installVersionEl) installVersionEl.textContent = installState.version || '—';
    if (!installMetaEl) return;
    var loader = installLoader ? installLoader.value : 'Vanilla';
    var label = 'Vanilla · 原版';
    if (loader !== 'Vanilla' && installLoader && installLoader.selectedIndex >= 0) {
      label = installLoader.options[installLoader.selectedIndex].textContent;
    }
    installMetaEl.textContent = label;
  }

  function setInstallLoaderVersionVisible(visible) {
    if (installLoaderVersionField) installLoaderVersionField.hidden = !visible;
  }

  function renderInstallLoaderOptions() {
    if (!installLoaderVersion) return;
    var previous = installLoaderVersion.value;
    installLoaderVersion.innerHTML = '';

    var placeholder = document.createElement('option');
    placeholder.value = '';
    if (installState.loading) {
      placeholder.textContent = '正在读取加载器版本…';
    } else if (installState.error) {
      placeholder.textContent = '读取失败 · 使用最新稳定版';
    } else {
      placeholder.textContent = '最新稳定版';
    }
    installLoaderVersion.appendChild(placeholder);

    installState.entries.forEach(function (entry) {
      if (!entry || !entry.version) return;
      var option = document.createElement('option');
      option.value = entry.version;
      option.textContent = entry.version + (entry.note ? ' · ' + entry.note : '');
      installLoaderVersion.appendChild(option);
    });

    installLoaderVersion.disabled = installBusy || installState.loading;

    if (previous) {
      for (var i = 0; i < installLoaderVersion.options.length; i += 1) {
        if (installLoaderVersion.options[i].value === previous) {
          installLoaderVersion.value = previous;
          break;
        }
      }
    }
  }

  function refreshInstallLoaderVersions(force) {
    var loader = installLoader ? installLoader.value : 'Vanilla';
    var mcVersion = installState.version;

    setInstallLoaderVersionVisible(loader !== 'Vanilla');

    if (loader === 'Vanilla' || !mcVersion) {
      installState = { version: mcVersion, loader: loader, mcVersion: mcVersion, entries: [], loading: false, error: '' };
      renderInstallLoaderOptions();
      return;
    }

    var same = installState.loader === loader && installState.mcVersion === mcVersion;
    if (!force && same && (installState.loading || installState.entries.length > 0)) {
      renderInstallLoaderOptions();
      return;
    }

    var api = window.launcherAPI;
    if (!api || typeof api.listLoaders !== 'function') {
      installState = { version: mcVersion, loader: loader, mcVersion: mcVersion, entries: [], loading: false, error: '桥接不可用' };
      renderInstallLoaderOptions();
      return;
    }

    installState = {
      version: mcVersion,
      loader: loader,
      mcVersion: mcVersion,
      entries: [],
      loading: true,
      error: ''
    };
    renderInstallLoaderOptions();

    api.listLoaders({ loader: loader, mcVersion: mcVersion })
      .then(function (data) {
        if (installState.loader !== loader || installState.mcVersion !== mcVersion) return;
        installState.loading = false;
        installState.error = '';
        installState.entries = (data && data.versions) || [];
        renderInstallLoaderOptions();
      })
      .catch(function (error) {
        if (installState.loader !== loader || installState.mcVersion !== mcVersion) return;
        console.error('[downloads] failed to list loader versions:', error);
        installState.loading = false;
        installState.error = error && error.message ? error.message : String(error);
        installState.entries = [];
        renderInstallLoaderOptions();
      });
  }

  function setInstallBusy(busy) {
    installBusy = Boolean(busy);
    if (installLoader) installLoader.disabled = installBusy;
    if (installLoaderVersion) installLoaderVersion.disabled = installBusy || installState.loading;
    if (installName) installName.disabled = installBusy;
    if (installAssets) installAssets.disabled = installBusy;
    if (installReveal) installReveal.disabled = installBusy;
    if (installSubmit) {
      installSubmit.disabled = installBusy;
      installSubmit.textContent = installBusy ? '正在安装…' : '安装';
    }
  }

  function openInstallDialog(version, trigger) {
    if (!DIALOGS.install) return;

    installState = {
      version: version || '',
      loader: 'Vanilla',
      mcVersion: version || '',
      entries: [],
      loading: false,
      error: ''
    };

    if (installLoader) installLoader.value = 'Vanilla';
    if (installLoaderVersion) installLoaderVersion.value = '';
    if (installName) {
      installName.value = version ? version + ' · ' + loaderLabelOf('Vanilla') : '';
      installName.classList.remove('is-invalid');
    }
    if (installAssets) installAssets.checked = true;
    if (installReveal) installReveal.checked = true;

    updateInstallSummary();
    setInstallLoaderVersionVisible(false);
    renderInstallLoaderOptions();
    setInstallBusy(false);
    setInstallStatus('确认选项后点「安装」');
    openDialog('install', trigger);
  }

  function submitInstall() {
    if (installBusy) return;
    var api = window.launcherAPI;
    if (!api || typeof api.createInstance !== 'function') {
      setInstallStatus('主进程桥接不可用，无法安装', 'error');
      return;
    }

    var version = installState.version;
    if (!version) {
      setInstallStatus('缺少游戏版本', 'error');
      return;
    }

    var loader = installLoader ? installLoader.value : 'Vanilla';
    var name = installName ? installName.value.trim() : '';
    if (!name) {
      name = version + ' · ' + loaderLabelOf(loader);
      if (installName) installName.value = name;
    }

    setInstallBusy(true);
    setInstallStatus('正在启动 mcdl…');

    runTask({
      title: '安装 ' + version + (loader !== 'Vanilla' ? ' · ' + loaderLabelOf(loader) : ''),
      status: '正在启动 mcdl…',
      cancelable: true,
      doneText: '安装完成：' + name,
      run: function (ctx) {
        return api.createInstance({
          version: version,
          loader: loader,
          loaderVersion: installLoaderVersion ? installLoaderVersion.value : '',
          name: name,
          assets: installAssets ? installAssets.checked : true,
          taskId: ctx.taskId
        });
      }
    })
      .then(function (snapshot) {
        setInstallBusy(false);
        if (!snapshot) {
          // 用户取消：任务框自己显示「已取消」，这里只把安装向导复位。
          setInstallStatus('已取消安装', 'ok');
          return;
        }

        instanceLoadState = 'ready';
        instanceLoadError = '';
        updateInstanceUI(snapshot);
        updateScanMeta(snapshot);
        setInstallStatus('安装完成：' + name, 'ok');
        window.dispatchEvent(new CustomEvent('launcher:instance-created', {
          detail: { version: version, name: name }
        }));

        if (!installReveal || installReveal.checked) {
          closeActivePanel({ focus: false });
          openInstancesPanel();
          if (snapshot.selectedId) selectInstance(snapshot.selectedId);
        }
      })
      .catch(function (error) {
        setInstallBusy(false);
        console.error('[downloads] install failed:', error);
        setInstallStatus('安装失败：' + describeInstallError(error), 'error');
      });
  }

  // ---------------- 整合包 ----------------

  function setPackBusy(busy) {
    packBusy = Boolean(busy);
    if (packPick) packPick.disabled = packBusy;
    if (packName) packName.disabled = packBusy;
    if (packSources) {
      Array.prototype.forEach.call(packSources.querySelectorAll('button'), function (button) {
        if (button.getAttribute('data-pack-source') === 'local') button.disabled = packBusy;
      });
    }
    if (packOptional) packOptional.disabled = packBusy || !packInfo;
    if (packInstall) {
      packInstall.disabled = packBusy || !packInfo;
      var labelNode = packInstall.querySelector('span:first-child');
      if (labelNode) labelNode.textContent = packBusy ? '正在安装…' : '安装';
    }
  }

  function applyPackInfo(info) {
    packInfo = info || null;
    if (!info) {
      if (packFileEl) packFileEl.textContent = '尚未选择整合包';
      if (packMetaEl) packMetaEl.textContent = '选择 .zip / .mrpack 后这里显示包内条目、mod 数量与解压后的实例名。';
      setPackBusy(false);
      setPackStatus('等待选择整合包');
      return;
    }

    if (packFileEl) packFileEl.textContent = info.file;
    if (packMetaEl) {
      packMetaEl.textContent = formatBytes(info.size)
        + ' · 共 ' + info.entryCount + ' 个条目'
        + ' · mod ' + (info.modCount || 0) + ' 个'
        + (info.manifest ? ' · 清单 ' + info.manifest : '');
    }
    if (packName && !packName.value.trim()) {
      packName.value = String(info.file).replace(/\.(zip|mrpack)$/i, '');
    }
    setPackBusy(false);
    setPackStatus('已选择整合包，可以直接安装', 'ok');
  }

  function pickModpackFile() {
    var api = window.launcherAPI;
    if (!api || typeof api.pickModpack !== 'function') {
      setPackStatus('主进程桥接不可用，无法选择文件', 'error');
      return;
    }

    setPackStatus('正在读取整合包…');
    api.pickModpack()
      .then(function (info) {
        if (!info) {
          setPackStatus('未选择整合包');
          return;
        }
        applyPackInfo(info);
      })
      .catch(function (error) {
        console.error('[downloads] inspect modpack failed:', error);
        setPackStatus('无法读取整合包：' + (error && error.message ? error.message : error), 'error');
      });
  }

  /**
   * 拖拽整合包：路径只是候选，主进程会做内容预检（条目 / 大小 / 链接条目），
   * 通过后才会拿到安装许可（token）。
   */
  function dropModpackFile(event) {
    var api = window.launcherAPI;
    if (!api || typeof api.prepareModpack !== 'function' || typeof api.pathForFile !== 'function') {
      setPackStatus('当前版本不支持拖拽，请用「选择文件」', 'error');
      return;
    }

    var files = (event && event.dataTransfer && event.dataTransfer.files) || [];
    if (files.length === 0) return;

    var file = files[0];
    var filePath = '';
    try {
      filePath = api.pathForFile(file);
    } catch (error) {
      setPackStatus('无法读取拖入文件的路径', 'error');
      return;
    }
    if (!filePath) {
      setPackStatus('无法读取拖入文件的路径', 'error');
      return;
    }

    setPackStatus('正在检查整合包…');
    api.prepareModpack(filePath)
      .then(function (info) {
        if (!info) {
          setPackStatus('未选择整合包');
          return;
        }
        applyPackInfo(info);
      })
      .catch(function (error) {
        console.error('[downloads] prepare modpack failed:', error);
        setPackStatus('这个整合包被拒绝：' + (error && error.message ? error.message : error), 'error');
      });
  }

  function openPackFilesDialog() {
    if (!packInfo) return;
    if (packFilesMeta) {
      packFilesMeta.textContent = packInfo.file + ' · ' + packInfo.entryCount + ' 个条目，前 '
        + (packInfo.sample ? packInfo.sample.length : 0) + ' 个如下（mcdl 会解压全部内容，这里只是预览）。';
    }
    if (packFilesList) {
      packFilesList.innerHTML = '';
      (packInfo.sample || []).forEach(function (name) {
        var row = document.createElement('span');
        row.setAttribute('role', 'listitem');
        row.textContent = name;
        packFilesList.appendChild(row);
      });
      if (!packInfo.sample || packInfo.sample.length === 0) {
        var empty = document.createElement('span');
        empty.textContent = '（这个整合包里没有可显示的文件条目）';
        packFilesList.appendChild(empty);
      }
    }
    openDialog('packFiles');
  }

  function submitPackInstall() {
    if (packBusy) return;
    if (!packInfo) {
      setPackStatus('请先选择整合包', 'error');
      return;
    }
    var api = window.launcherAPI;
    if (!api || typeof api.installModpack !== 'function') {
      setPackStatus('主进程桥接不可用，无法安装', 'error');
      return;
    }

    setPackBusy(true);
    setPackStatus('正在解压并安装整合包…');

    runTask({
      title: '安装整合包',
      status: '正在解压并安装整合包…',
      cancelable: true,
      doneText: '安装完成',
      run: function (ctx) {
        return api.installModpack({
          token: packInfo.token,
          name: packName ? packName.value.trim() : '',
          taskId: ctx.taskId
        });
      }
    })
      .then(function (result) {
        setPackBusy(false);
        if (!result) {
          setPackStatus('已取消安装', 'ok');
          return;
        }
        if (result.snapshot) {
          instanceLoadState = 'ready';
          instanceLoadError = '';
          updateInstanceUI(result.snapshot);
          updateScanMeta(result.snapshot);
        }
        setPackStatus('安装完成：' + (result.instanceId ? result.instanceId : '整合包'), 'ok');
        window.dispatchEvent(new CustomEvent('launcher:instance-created', {
          detail: { version: '', name: result.instanceId || '' }
        }));
        closeActivePanel({ focus: false });
        openInstancesPanel();
        if (result.snapshot && result.snapshot.selectedId) {
          selectInstance(result.snapshot.selectedId);
        }
      })
      .catch(function (error) {
        setPackBusy(false);
        console.error('[downloads] modpack install failed:', error);
        setPackStatus('安装失败：' + (error && error.message ? error.message : error), 'error');
      });
  }

  // 清单 [L5] 实例操作对话框里的「前往下载页面」：直接跳下载中心。
  var instanceGotoDownloadBtn = document.getElementById('instanceGotoDownload');
  if (instanceGotoDownloadBtn) {
    instanceGotoDownloadBtn.addEventListener('click', function () {
      closeDialog();
      hideActivePanel({ focus: false });
      openDownloadPanel();
    });
  }

  // ---------------- 下载中心事件绑定 ----------------

  if (downloadBack) {
    downloadBack.addEventListener('click', function () {
      closeDownloadPanel({ focus: true });
    });
  }

  if (downloadSearch) {
    downloadSearch.addEventListener('input', function () {
      renderDownloadVersions();
    });
  }

  if (downloadType) {
    downloadType.addEventListener('change', function () {
      renderDownloadVersions();
    });
  }

  if (downloadRefresh) {
    downloadRefresh.addEventListener('click', function () {
      loadDownloadCatalog(true);
    });
  }

  if (downloadVersions) {
    downloadVersions.addEventListener('click', function (event) {
      var card = event.target && event.target.closest
        ? event.target.closest('[data-download-version]')
        : null;
      if (!card) return;
      openInstallDialog(card.getAttribute('data-download-version'), card);
    });
  }

  if (downloadLatest) {
    downloadLatest.addEventListener('click', function (event) {
      var card = event.target && event.target.closest
        ? event.target.closest('[data-download-latest]')
        : null;
      if (!card) return;
      openInstallDialog(card.getAttribute('data-download-latest'), card);
    });
  }

  if (installLoader) {
    installLoader.addEventListener('change', function () {
      updateInstallSummary();
      refreshInstallLoaderVersions(true);
    });
  }

  if (installSubmit) {
    installSubmit.addEventListener('click', submitInstall);
  }

  if (DIALOGS.install) {
    DIALOGS.install.addEventListener('click', function (event) {
      if (!installBusy) return;
      if (event.target && event.target.closest && event.target.closest('[data-dialog-close]')) {
        event.preventDefault();
        event.stopPropagation();
      }
    }, true);
  }

  if (packPick) {
    packPick.addEventListener('click', pickModpackFile);
  }

  var packDropZone = document.getElementById('packDropZone');
  if (packDropZone) {
    ['dragenter', 'dragover'].forEach(function (name) {
      packDropZone.addEventListener(name, function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
        packDropZone.classList.add('is-drop-target');
      });
    });

    ['dragleave', 'dragend'].forEach(function (name) {
      packDropZone.addEventListener(name, function (event) {
        event.preventDefault();
        packDropZone.classList.remove('is-drop-target');
      });
    });

    packDropZone.addEventListener('drop', function (event) {
      event.preventDefault();
      event.stopPropagation();
      packDropZone.classList.remove('is-drop-target');
      if (packBusy) return;
      dropModpackFile(event);
    });
  }

  if (packOptional) {
    packOptional.addEventListener('click', openPackFilesDialog);
  }

  if (packInstall) {
    packInstall.addEventListener('click', submitPackInstall);
  }

  if (packSources) {
    packSources.addEventListener('click', function (event) {
      var card = event.target && event.target.closest
        ? event.target.closest('[data-pack-source]')
        : null;
      if (!card || card.disabled) return;
      if (card.getAttribute('data-pack-source') !== 'local') return;
      Array.prototype.forEach.call(packSources.querySelectorAll('[data-pack-source]'), function (button) {
        var active = button === card;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
    });
  }

  if (window.launcherAPI && typeof window.launcherAPI.onDownloadProgress === 'function') {
    window.launcherAPI.onDownloadProgress(function (payload) {
      if (!payload || !payload.message) return;
      if (packBusy) setPackStatus(payload.message);
      noteActiveTask(payload.message);
    });
  }

  if (window.launcherAPI && typeof window.launcherAPI.onInstallProgress === 'function') {
    window.launcherAPI.onInstallProgress(function (payload) {
      if (!payload || !payload.message) return;
      if (installBusy) setInstallStatus(payload.message);
      noteActiveTask(payload.message);
    });
  }

  // ---------------------------------------------------------
  // 下载中心 · 在线内容（Modrinth）：模组 / 资源包 / 光影
  //   对照 [L3] 内容列表（搜索 / 结果面板）与 [L4] 内容下载页
  //   （版本选择 / 下载到本地文件夹 / 取消 / 确定）
  // ---------------------------------------------------------
  var ADDON_KINDS = ['mods', 'resourcepack', 'shader'];
  var ADDON_PAGE_SIZE = 24;
  var ADDON_PAGES = {};
  var addonDialog = { busy: false, kind: '', project: null, versions: [], selectedId: '' };

  var dlgAddonTitle = document.getElementById('dlgAddonTitle');
  var dlgAddonMeta = document.getElementById('dlgAddonMeta');
  var dlgAddonDesc = document.getElementById('dlgAddonDesc');
  var dlgAddonTarget = document.getElementById('dlgAddonTarget');
  var addonVersionList = document.getElementById('addonVersionList');
  var addonInstallDeps = document.getElementById('addonInstallDeps');
  var addonDepCount = document.getElementById('addonDepCount');
  var dlgAddonStatus = document.getElementById('dlgAddonStatus');
  var addonConfirm = document.getElementById('addonConfirm');
  var addonSaveAsBtn = document.getElementById('addonSaveAs');

  function addonSuffix(kind) {
    if (kind === 'mods') return 'Mods';
    if (kind === 'resourcepack') return 'Resourcepack';
    return 'Shader';
  }

  ADDON_KINDS.forEach(function (kind) {
    var suffix = addonSuffix(kind);
    ADDON_PAGES[kind] = {
      kind: kind,
      search: document.getElementById('addonSearch' + suffix),
      version: document.getElementById('addonVersion' + suffix),
      loader: document.getElementById('addonLoader' + suffix),
      sort: document.getElementById('addonSort' + suffix),
      grid: document.getElementById('addonGrid' + suffix),
      status: document.getElementById('addonStatus' + suffix),
      count: document.getElementById('addonCount' + suffix),
      target: document.getElementById('addonTarget' + suffix),
      items: [],
      total: 0,
      loading: false,
      loaded: false
    };
  });

  function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatCount(value) {
    var number = Number(value) || 0;
    if (number >= 100000000) return (number / 100000000).toFixed(1) + ' 亿';
    if (number >= 10000) return (number / 10000).toFixed(1) + ' 万';
    return String(number);
  }

  function instanceLoaderKey(instance) {
    var value = String(instance && instance.modLoader || '').toLowerCase();
    return ['fabric', 'quilt', 'forge', 'neoforge'].indexOf(value) >= 0 ? value : '';
  }

  function addonTargetText(instance) {
    if (!instance) return '安装到：<strong>未选择实例</strong> · 先在右侧实例列表选一个';
    var loader = loaderLabel(instance) !== 'Vanilla' ? ' · ' + loaderLabel(instance) : '';
    return '安装到：<strong>' + escapeHtml(instanceLabel(instance)) + '</strong> · '
      + escapeHtml(instance.versionName || '—') + escapeHtml(loader);
  }

  function updateAddonTargets() {
    var html = addonTargetText(getSelectedInstance());
    ADDON_KINDS.forEach(function (kind) {
      var page = ADDON_PAGES[kind];
      if (page && page.target) page.target.innerHTML = html;
    });
    if (dlgAddonTarget) dlgAddonTarget.innerHTML = html;
  }

  function fillAddonVersionOptions() {
    if (!downloadCatalog || !Array.isArray(downloadCatalog.versions)) return;

    var list = downloadCatalog.versions.filter(function (version) {
      return version && (version.type === 'release' || version.type === 'snapshot');
    }).slice(0, 240);

    var instance = getSelectedInstance();
    var instanceVersion = instance && instance.versionName ? instance.versionName : '';

    ADDON_KINDS.forEach(function (kind) {
      var page = ADDON_PAGES[kind];
      if (!page || !page.version) return;

      var current = page.version.value;
      var preferred = current || instanceVersion;
      page.version.innerHTML = '';

      var all = document.createElement('option');
      all.value = '';
      all.textContent = '全部版本';
      page.version.appendChild(all);

      list.forEach(function (version) {
        var option = document.createElement('option');
        option.value = version.id;
        option.textContent = version.id;
        page.version.appendChild(option);
      });

      if (preferred) {
        for (var i = 0; i < page.version.options.length; i += 1) {
          if (page.version.options[i].value === preferred) {
            page.version.value = preferred;
            break;
          }
        }
      }
    });
  }

  // 内容卡片图标：页面 CSP 只放行 data: / mcdl-media:，渲染层也不联网，
  // 所以 <img> 指向主进程的图标代理；非 Modrinth CDN 的地址不代理，直接回落成首字母。
  function addonIconSource(rawUrl) {
    var value = String(rawUrl || '').trim();
    if (!/^https:\/\/cdn\.modrinth\.com\//i.test(value)) return '';
    return 'mcdl-media://addon-icon/' + encodeURIComponent(value);
  }

  function renderAddonResults(kind) {
    var page = ADDON_PAGES[kind];
    if (!page || !page.grid) return;
    page.grid.innerHTML = '';

    if (page.loading || !page.loaded) {
      if (page.count) page.count.textContent = page.loading ? '搜索中…' : '';
      return;
    }

    if (page.items.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'download-empty';
      var strong = document.createElement('strong');
      strong.textContent = '没有匹配的内容';
      var span = document.createElement('span');
      span.textContent = '换个关键词，或把「版本 / 加载器」放宽到全部。';
      empty.appendChild(strong);
      empty.appendChild(span);
      page.grid.appendChild(empty);
      if (page.count) page.count.textContent = '';
      return;
    }

    var fragment = document.createDocumentFragment();

    page.items.forEach(function (item) {
      var card = document.createElement('button');
      card.type = 'button';
      card.className = 'addon-card';
      card.setAttribute('role', 'listitem');
      card.setAttribute('data-addon-id', item.id);
      card.setAttribute('data-addon-kind', kind);
      card.setAttribute('aria-label', item.title + ' · 选择版本');

      var icon = document.createElement('span');
      icon.className = 'addon-card__icon';
      var iconSrc = addonIconSource(item.iconUrl);
      if (iconSrc) {
        var img = document.createElement('img');
        img.src = iconSrc;
        img.alt = '';
        img.decoding = 'async';
        img.loading = 'lazy';
        img.referrerPolicy = 'no-referrer';
        img.addEventListener('error', function () {
          img.remove();
          icon.textContent = String(item.title || '?').charAt(0).toUpperCase();
        });
        icon.appendChild(img);
      } else {
        icon.textContent = String(item.title || '?').charAt(0).toUpperCase();
      }

      var body = document.createElement('span');
      body.className = 'addon-card__body';

      var title = document.createElement('span');
      title.className = 'addon-card__title';
      title.textContent = item.title;

      var meta = document.createElement('span');
      meta.className = 'addon-card__meta';
      meta.textContent = (item.author || '未知作者') + ' · ' + formatCount(item.downloads) + ' 次下载';

      var desc = document.createElement('span');
      desc.className = 'addon-card__desc';
      desc.textContent = item.description;

      var tags = document.createElement('span');
      tags.className = 'addon-card__tags';
      (item.categories || []).slice(0, 3).forEach(function (category) {
        var tag = document.createElement('span');
        tag.className = 'addon-card__tag';
        tag.textContent = category;
        tags.appendChild(tag);
      });

      body.appendChild(title);
      body.appendChild(meta);
      body.appendChild(desc);
      body.appendChild(tags);

      card.appendChild(icon);
      card.appendChild(body);
      fragment.appendChild(card);
    });

    page.grid.appendChild(fragment);
    if (page.count) {
      page.count.textContent = '显示 ' + page.items.length + ' / 共 ' + formatCount(page.total);
    }
  }

  function searchAddons(kind) {
    var page = ADDON_PAGES[kind];
    if (!page) return;

    var api = window.launcherAPI;
    if (!api || typeof api.searchAddons !== 'function') {
      setHint(page.status, '主进程桥接不可用，无法搜索', 'error');
      return;
    }
    if (page.loading) return;

    page.loading = true;
    setHint(page.status, '正在从 Modrinth 搜索…');
    renderAddonResults(kind);

    var instance = getSelectedInstance();
    var loader = '';
    if (kind === 'mods') {
      loader = page.loader ? page.loader.value : '';
      if (!loader && instance) loader = instanceLoaderKey(instance);
    }

    api.searchAddons({
      kind: kind,
      query: page.search ? page.search.value.trim() : '',
      gameVersion: page.version ? page.version.value : '',
      loader: loader,
      sort: page.sort ? page.sort.value : 'relevance',
      limit: ADDON_PAGE_SIZE,
      offset: 0
    })
      .then(function (data) {
        page.loading = false;
        page.loaded = true;
        page.items = (data && data.items) || [];
        page.total = (data && data.total) || page.items.length;
        renderAddonResults(kind);
        if (page.items.length === 0) {
          setHint(page.status, '没有匹配的内容，换个关键词或放宽筛选');
        } else {
          setHint(page.status, '找到 ' + formatCount(page.total) + ' 个结果 · 点击卡片选择版本', 'ok');
        }
      })
      .catch(function (error) {
        page.loading = false;
        page.loaded = true;
        page.items = [];
        page.total = 0;
        renderAddonResults(kind);
        console.error('[addons] search failed:', error);
        setHint(page.status, '搜索失败：' + (error && error.message ? error.message : error), 'error');
        if (page.count) page.count.textContent = '';
      });
  }

  function addonSelectedVersion() {
    return addonDialog.versions.filter(function (version) {
      return version.id === addonDialog.selectedId;
    })[0] || null;
  }

  function refreshAddonConfirmState() {
    if (!addonConfirm) return;
    var hasInstance = Boolean(getSelectedInstance());
    var hasVersion = Boolean(addonSelectedVersion());
    addonConfirm.disabled = addonDialog.busy || !hasInstance || !hasVersion;
    addonConfirm.textContent = addonDialog.busy ? '正在下载…' : '确定';
    if (addonSaveAsBtn) addonSaveAsBtn.disabled = addonDialog.busy || !hasVersion;
  }

  function selectAddonVersion(id) {
    addonDialog.selectedId = id;
    Array.prototype.forEach.call(document.querySelectorAll('#addonVersionList [data-addon-version]'), function (row) {
      row.classList.toggle('is-active', row.getAttribute('data-addon-version') === id);
    });

    var version = addonSelectedVersion();
    var required = version
      ? (version.dependencies || []).filter(function (dep) { return dep.type === 'required'; })
      : [];
    if (addonDepCount) addonDepCount.textContent = String(required.length);
    if (addonInstallDeps) {
      addonInstallDeps.checked = required.length > 0;
      addonInstallDeps.disabled = addonDialog.busy || required.length === 0;
    }
    refreshAddonConfirmState();
  }

  function renderAddonVersions() {
    if (!addonVersionList) return;
    addonVersionList.innerHTML = '';

    if (addonDialog.versions.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'download-empty';
      var strong = document.createElement('strong');
      strong.textContent = '没有可用版本';
      var span = document.createElement('span');
      span.textContent = '这个项目没有匹配当前游戏版本 / 加载器的文件，可以换个项目或在面板里放宽版本筛选。';
      empty.appendChild(strong);
      empty.appendChild(span);
      addonVersionList.appendChild(empty);
      if (addonDepCount) addonDepCount.textContent = '0';
      refreshAddonConfirmState();
      return;
    }

    var fragment = document.createDocumentFragment();
    addonDialog.versions.slice(0, 40).forEach(function (version) {
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'addon-version';
      row.setAttribute('role', 'listitem');
      row.setAttribute('data-addon-version', version.id);

      var main = document.createElement('span');
      main.className = 'addon-version__main';

      var name = document.createElement('span');
      name.className = 'addon-version__name';
      name.textContent = version.versionNumber || version.name || version.id;

      var meta = document.createElement('span');
      meta.className = 'addon-version__meta';
      var games = (version.gameVersions || []).slice(0, 3).join(' / ');
      var loaders = (version.loaders || []).join(' / ');
      meta.textContent = [games, loaders, version.file ? formatBytes(version.file.size) : '']
        .filter(Boolean).join(' · ');

      main.appendChild(name);
      main.appendChild(meta);

      var side = document.createElement('span');
      side.className = 'addon-version__side';
      var type = document.createElement('span');
      type.className = 'addon-version__type';
      type.textContent = version.versionType || 'release';
      var date = document.createElement('span');
      date.textContent = version.datePublished ? version.datePublished.slice(0, 10) : '';
      side.appendChild(type);
      side.appendChild(date);

      row.appendChild(main);
      row.appendChild(side);
      fragment.appendChild(row);
    });

    addonVersionList.appendChild(fragment);
    selectAddonVersion(addonDialog.versions[0].id);
  }

  function setAddonBusy(busy) {
    addonDialog.busy = Boolean(busy);
    if (addonInstallDeps) addonInstallDeps.disabled = addonDialog.busy;
    refreshAddonConfirmState();
  }

  function openAddonDialog(kind, projectId, trigger) {
    var page = ADDON_PAGES[kind];
    if (!page) return;

    var project = null;
    page.items.forEach(function (item) {
      if (item.id === projectId) project = item;
    });
    if (!project) return;

    addonDialog = { busy: false, kind: kind, project: project, versions: [], selectedId: '' };

    if (dlgAddonTitle) dlgAddonTitle.textContent = project.title;
    if (dlgAddonMeta) {
      dlgAddonMeta.textContent = (project.author || '未知作者')
        + ' · ' + formatCount(project.downloads) + ' 次下载'
        + ((project.categories || []).length ? ' · ' + project.categories.join(' · ') : '');
    }
    if (dlgAddonDesc) dlgAddonDesc.textContent = project.description;
    updateAddonTargets();
    if (addonDepCount) addonDepCount.textContent = '0';
    if (addonVersionList) {
      addonVersionList.innerHTML = '';
      var loading = document.createElement('div');
      loading.className = 'download-empty';
      var strong = document.createElement('strong');
      strong.textContent = '正在读取版本列表…';
      loading.appendChild(strong);
      addonVersionList.appendChild(loading);
    }
    setAddonBusy(false);
    setHint(dlgAddonStatus, '正在读取可用版本…');
    openDialog('addon', trigger);

    var api = window.launcherAPI;
    if (!api || typeof api.listAddonVersions !== 'function') {
      setHint(dlgAddonStatus, '主进程桥接不可用，无法读取版本', 'error');
      return;
    }

    var instance = getSelectedInstance();
    var gameVersion = instance && instance.versionName ? instance.versionName : '';
    var loader = kind === 'mods' ? instanceLoaderKey(instance) : '';
    var projectIdSafe = project.id;

    api.listAddonVersions({ projectId: projectIdSafe, gameVersion: gameVersion, loader: loader })
      .then(function (versions) {
        if (!addonDialog.project || addonDialog.project.id !== projectIdSafe) return;
        var list = Array.isArray(versions) ? versions : [];

        if (list.length === 0 && (gameVersion || loader)) {
          return api.listAddonVersions({ projectId: projectIdSafe, gameVersion: '', loader: '' })
            .then(function (fallback) {
              if (!addonDialog.project || addonDialog.project.id !== projectIdSafe) return;
              addonDialog.versions = Array.isArray(fallback) ? fallback : [];
              renderAddonVersions();
              setHint(dlgAddonStatus, '当前实例的版本 / 加载器没有对应文件，已列出全部版本', 'error');
            });
        }

        addonDialog.versions = list;
        renderAddonVersions();
        if (list.length === 0) {
          setHint(dlgAddonStatus, '这个项目没有可下载的文件', 'error');
        } else {
          setHint(dlgAddonStatus, '选好版本后点「确定」安装到当前实例');
        }
        return null;
      })
      .catch(function (error) {
        console.error('[addons] list versions failed:', error);
        addonDialog.versions = [];
        renderAddonVersions();
        setHint(dlgAddonStatus, '读取版本失败：' + (error && error.message ? error.message : error), 'error');
      });
  }

  function installAddon() {
    if (addonDialog.busy) return;

    var instance = getSelectedInstance();
    if (!instance) {
      setHint(dlgAddonStatus, '请先在右侧实例列表选一个实例', 'error');
      return;
    }

    var version = addonSelectedVersion();
    if (!version) {
      setHint(dlgAddonStatus, '还没有选择版本', 'error');
      return;
    }

    var api = window.launcherAPI;
    if (!api || typeof api.installAddon !== 'function') {
      setHint(dlgAddonStatus, '主进程桥接不可用，无法安装', 'error');
      return;
    }

    setAddonBusy(true);
    setHint(dlgAddonStatus, '正在下载 ' + (version.file ? version.file.filename : version.versionNumber) + ' …');

    api.installAddon({
      instanceId: instance.id,
      kind: addonDialog.kind,
      versionId: version.id,
      installDependencies: Boolean(addonInstallDeps && addonInstallDeps.checked)
    })
      .then(function (result) {
        setAddonBusy(false);
        var installed = (result && result.installed) || [];
        var failed = (result && result.failed) || [];
        var names = installed.map(function (item) { return item.filename; }).join('、');
        setHint(
          dlgAddonStatus,
          '已安装 ' + installed.length + ' 个文件' + (failed.length ? '（' + failed.length + ' 个前置失败）' : '')
            + (names ? '：' + names : ''),
          'ok'
        );

        var page = ADDON_PAGES[addonDialog.kind];
        if (page) {
          setHint(page.status, '已安装到 ' + (result.root || '实例内容目录'), 'ok');
        }
      })
      .catch(function (error) {
        setAddonBusy(false);
        console.error('[addons] install failed:', error);
        setHint(dlgAddonStatus, '安装失败：' + (error && error.message ? error.message : error), 'error');
      });
  }

  function saveAddonAs() {
    if (addonDialog.busy) return;
    var version = addonSelectedVersion();
    if (!version) return;

    var api = window.launcherAPI;
    if (!api || typeof api.saveAddon !== 'function') {
      setHint(dlgAddonStatus, '主进程桥接不可用，无法下载', 'error');
      return;
    }

    setAddonBusy(true);
    setHint(dlgAddonStatus, '正在下载到本地文件夹…');

    api.saveAddon({ kind: addonDialog.kind, versionId: version.id })
      .then(function (result) {
        setAddonBusy(false);
        if (!result) {
          setHint(dlgAddonStatus, '已取消');
          return;
        }
        var names = (result.installed || []).map(function (item) { return item.filename; }).join('、');
        setHint(dlgAddonStatus, '已保存到 ' + result.folder + (names ? '：' + names : ''), 'ok');
      })
      .catch(function (error) {
        setAddonBusy(false);
        console.error('[addons] save failed:', error);
        setHint(dlgAddonStatus, '下载失败：' + (error && error.message ? error.message : error), 'error');
      });
  }

  // ---- 内容页签事件 ----

  Array.prototype.forEach.call(document.querySelectorAll('[data-addon-search]'), function (button) {
    button.addEventListener('click', function () {
      var kind = button.getAttribute('data-addon-search');
      if (ADDON_PAGES[kind]) searchAddons(kind);
    });
  });

  ADDON_KINDS.forEach(function (kind) {
    var page = ADDON_PAGES[kind];
    if (!page) return;

    if (page.search) {
      page.search.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        searchAddons(kind);
      });
    }

    [page.version, page.sort, page.loader].forEach(function (select) {
      if (!select) return;
      select.addEventListener('change', function () {
        searchAddons(kind);
      });
    });

    if (page.grid) {
      page.grid.addEventListener('click', function (event) {
        var card = event.target && event.target.closest
          ? event.target.closest('[data-addon-id]')
          : null;
        if (!card) return;
        openAddonDialog(kind, card.getAttribute('data-addon-id'), card);
      });
    }
  });

  if (addonVersionList) {
    addonVersionList.addEventListener('click', function (event) {
      var row = event.target && event.target.closest
        ? event.target.closest('[data-addon-version]')
        : null;
      if (!row || addonDialog.busy) return;
      selectAddonVersion(row.getAttribute('data-addon-version'));
    });
  }

  if (addonConfirm) addonConfirm.addEventListener('click', installAddon);
  if (addonSaveAsBtn) addonSaveAsBtn.addEventListener('click', saveAddonAs);

  if (DIALOGS.addon) {
    DIALOGS.addon.addEventListener('click', function (event) {
      if (!addonDialog.busy) return;
      if (event.target && event.target.closest && event.target.closest('[data-dialog-close]')) {
        event.preventDefault();
        event.stopPropagation();
      }
    }, true);
  }

  if (window.launcherAPI && typeof window.launcherAPI.onAddonProgress === 'function') {
    window.launcherAPI.onAddonProgress(function (payload) {
      if (!payload || !payload.message) return;
      if (addonDialog.busy) setHint(dlgAddonStatus, payload.message);
      noteActiveTask(payload.message);
    });
  }

  window.addEventListener('launcher:instance-selected', function () {
    updateAddonTargets();
    refreshAddonConfirmState();
  });

  updateAddonTargets();

  setInstallBusy(false);
  setPackBusy(false);

  if (window.launcherAPI && typeof window.launcherAPI.getPreferences === 'function') {
    window.launcherAPI.getPreferences()
      .then(function (prefs) {
        applyAnimationPreference(prefs);
      })
      .catch(function (error) {
        console.warn('[settings] could not load preferences:', error);
      });
  }

  // 壁纸：开机第一帧就用 wallpaper:list 画好（它不触发 Java 扫描），
  // 不等 settings:get，否则会先看到几秒默认渐变再闪一下壁纸。
  wallRefresh();

  syncPages();
  switchHint();
})();
