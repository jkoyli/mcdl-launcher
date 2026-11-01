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
    button.addEventListener('click', function () {
      var action = button.getAttribute('data-titlebar-action');

      window.dispatchEvent(new CustomEvent('launcher:titlebar-action', {
        detail: { action: action }
      }));

      if (action === 'back' || action === 'close-page') {
        closeActivePanel({ focus: true });
      }

      if (action === 'refresh') {
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
  var instancesRailBtn = document.getElementById('instancesRailBtn');
  var isCreateOpen = false;

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
    return version ? version + ' · 原版' : '新实例 · 原版';
  }

  function updateSuggestedName(force) {
    if (!createName) return;
    var suggestion = defaultInstanceName();
    if (force || !createName.value.trim() || createName.value === lastSuggestedName) {
      createName.value = suggestion;
      lastSuggestedName = suggestion;
    }
  }

  function setCreateBusy(busy) {
    installInProgress = !!busy;

    if (createVersionType) createVersionType.disabled = installInProgress || versionsLoading;
    if (createVersion) createVersion.disabled = installInProgress || versionsLoading;
    if (createLoader) createLoader.disabled = installInProgress;
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
    create: 'stageCreate',
    gamedir: 'stageGameDir',
    account: 'stageAccount',
    settings: 'stageSettings'
  };
  var PANEL_STATES = {
    instances: 'is-instances',
    create: 'is-create',
    gamedir: 'is-gamedir',
    account: 'is-account',
    settings: 'is-settings'
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

    // 游戏目录页是从实例列表进来的，返回时回到列表而不是主视区。
    if (activePanel === 'gamedir') {
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
    window.setTimeout(function () {
      if (newInstanceBtn) newInstanceBtn.focus();
    }, 220);
  }

  function openCreatePanel() {
    if (!mainStage || !stageCreate) return;
    if (installInProgress) return;

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
      loader: 'Vanilla',
      name: name
    })
      .then(function (snapshot) {
        setCreateBusy(false);
        instanceLoadState = 'ready';
        instanceLoadError = '';
        updateInstanceUI(snapshot);
        updateScanMeta(snapshot);

        if (createForm) createForm.reset();
        if (createVersionType) createVersionType.value = 'release';
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
  var settingsStatus = document.getElementById('settingsStatus');
  var settingsSubmit = document.getElementById('settingsSubmit');

  var ACCOUNTS = [];
  var SERVERS = [];
  var selectedAccountId = null;
  var settingsLoaded = false;

  /** 提示行：tone = 'error' | 'ok' | 省略 */
  function setHint(node, text, tone) {
    if (!node) return;
    node.textContent = text || '';
    node.classList.toggle('is-error', tone === 'error');
    node.classList.toggle('is-ok', tone === 'ok');
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

  // ---------------- 弹窗管理（L5 层） ----------------

  var dialogLayer = document.getElementById('dialogLayer');
  var DIALOGS = {
    microsoft: document.getElementById('dlgMicrosoft'),
    offline: document.getElementById('dlgOffline'),
    server: document.getElementById('dlgServer'),
    skin: document.getElementById('dlgSkin'),
    confirm: document.getElementById('dlgConfirm'),
    instance: document.getElementById('dlgInstance')
  };
  var openDialogName = null;
  var dialogReturnFocus = null;
  var confirmCallback = null;

  function openDialog(name, trigger) {
    var pane = DIALOGS[name];
    if (!pane || !dialogLayer) return;

    if (openDialogName && DIALOGS[openDialogName] && openDialogName !== name) {
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
    confirmCallback = null;
  }

  if (dialogLayer) {
    dialogLayer.addEventListener('click', function (event) {
      var closer = event.target && event.target.closest ? event.target.closest('[data-dialog-close]') : null;
      if (closer) closeDialog();
    });
  }

  var confirmText = document.getElementById('confirmText');
  var confirmOk = document.getElementById('confirmOk');

  function askConfirm(text, onConfirm, confirmLabel) {
    if (confirmText) confirmText.textContent = text;
    if (confirmOk) confirmOk.textContent = confirmLabel || '确定';
    confirmCallback = onConfirm;
    openDialog('confirm');
  }

  if (confirmOk) {
    confirmOk.addEventListener('click', function () {
      var callback = confirmCallback;
      confirmCallback = null;
      closeDialog();
      if (typeof callback === 'function') callback();
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

  function loadSettings() {
    var api = window.launcherAPI;
    if (!api || typeof api.getSettings !== 'function') return;

    if (settingsStatus) {
      settingsStatus.textContent = settingsLoaded ? '已就绪' : '正在读取 Java 列表…';
      settingsStatus.classList.remove('is-error');
    }

    api.getSettings()
      .then(function (data) {
        var settings = (data && data.settings) || {};
        if (settingsMemory) settingsMemory.value = settings.memoryMb || '';
        if (settingsWidth) settingsWidth.value = settings.width || '';
        if (settingsHeight) settingsHeight.value = settings.height || '';
        if (settingsJvmArgs) settingsJvmArgs.value = settings.jvmArgs || '';
        fillJavaOptions(data && data.javaRuntimes, settings.javaPath || '');

        var count = data && data.javaRuntimes ? data.javaRuntimes.length : 0;
        if (settingsStatus) {
          settingsStatus.textContent = '检测到 ' + count + ' 个 Java 运行时 · 默认内存 ' +
            ((data && data.defaultMemoryMb) || '-') + ' MB';
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
        javaPath: settingsJava ? settingsJava.value : ''
      })
        .then(function (saved) {
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
      loadSettings();
    }
  }

  /** 「全局游戏设置」= 一次跳转，落到设置页的游戏设置区。 */
  function openGlobalGameSettings() {
    openOverlayPanel('settings');
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
    { action: 'test', label: '测试游戏' },
    { action: 'script', label: '生成启动脚本' },
    { action: 'rename', label: '重命名该实例' },
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

  function renderInstancePanel() {
    var rows = document.getElementById('instanceRows');
    if (!rows) return;

    var count = document.getElementById('instancePanelCount');
    if (count) count.textContent = String(INSTANCES.length);

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
      avatar.textContent = instanceLabel(instance).slice(0, 1).toUpperCase();

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

      var versionBadge = document.createElement('span');
      versionBadge.className = 'badge';
      versionBadge.textContent = instance.versionName || '—';
      badges.appendChild(versionBadge);

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

      if (selected) {
        var currentBadge = document.createElement('span');
        currentBadge.className = 'badge badge--current';
        currentBadge.textContent = '当前';
        badges.appendChild(currentBadge);
      }

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

    if (action === 'test') {
      launchInstanceFlow(instance, true);
      return;
    }

    if (action === 'script') {
      createLaunchScript(instance);
      return;
    }

    if (action === 'rename') {
      openInstanceDialog(id);
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
        setInstancePanelStatus('已生成 ' + name, 'ok');
        if (result && result.dir && api.openInstanceFolder) {
          api.openInstanceFolder({ path: result.dir }).catch(function () {});
        }
      })
      .catch(function (error) {
        setInstancePanelStatus(describeLaunchError(error), 'error');
      });
  }

  function duplicateInstance(instance) {
    var api = window.launcherAPI;
    if (!api || typeof api.duplicateInstance !== 'function') return;

    setInstancePanelStatus('正在复制 ' + instanceLabel(instance) + ' …');

    api.duplicateInstance({ instanceId: instance.id })
      .then(function (snapshot) {
        updateInstanceUI(snapshot);
        setInstancePanelStatus('已复制为副本', 'ok');
      })
      .catch(function (error) {
        setInstancePanelStatus(describeLaunchError(error), 'error');
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
    var nameInput = document.getElementById('instanceNameInput');
    var status = document.getElementById('instanceDialogStatus');
    var del = document.getElementById('instanceDelete');

    if (meta) {
      meta.textContent = instanceLabel(instance) + ' · ' + (instance.versionName || '—') +
        (loaderLabel(instance) !== 'Vanilla' ? ' · ' + loaderLabel(instance) : '') +
        (instance.origin === 'external' ? ' · 外部目录' : '');
    }
    if (nameInput) nameInput.value = instance.displayName || instance.versionName || '';
    if (status) setHint(status, '');
    if (del) del.disabled = false;

    openDialog('instance');
  }

  var instanceRenameApply = document.getElementById('instanceRenameApply');
  var instanceDuplicateBtn = document.getElementById('instanceDuplicate');
  var instanceDeleteBtn = document.getElementById('instanceDelete');
  var instanceNameInput = document.getElementById('instanceNameInput');
  var instanceDialogStatus = document.getElementById('instanceDialogStatus');

  function applyInstanceRename() {
    var api = window.launcherAPI;
    var instance = instanceById(dialogInstanceId);
    if (!instance || !api || typeof api.renameInstance !== 'function') return;

    var name = instanceNameInput ? instanceNameInput.value.trim() : '';
    if (!name) {
      setHint(instanceDialogStatus, '名称不能为空', 'error');
      if (instanceNameInput) instanceNameInput.focus();
      return;
    }

    setHint(instanceDialogStatus, '正在重命名…');

    api.renameInstance({ instanceId: instance.id, name: name })
      .then(function (snapshot) {
        updateInstanceUI(snapshot);
        setHint(instanceDialogStatus, '已重命名为 ' + name, 'ok');
        var meta = document.getElementById('instanceDialogMeta');
        if (meta) meta.textContent = name + ' · ' + (instance.versionName || '—');
      })
      .catch(function (error) {
        setHint(instanceDialogStatus, describeLaunchError(error), 'error');
      });
  }

  if (instanceRenameApply) {
    instanceRenameApply.addEventListener('click', applyInstanceRename);
  }

  if (instanceNameInput) {
    instanceNameInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        applyInstanceRename();
      }
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

  function renderGameDirList() {
    var list = document.getElementById('gameDirList');
    if (!list) return;

    list.innerHTML = '';

    gameDirCache.forEach(function (entry) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'gamedir-item' + (entry.id === gameDirEditingId ? ' is-selected' : '');
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
      list.appendChild(item);
    });
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

  var gameDirList = document.getElementById('gameDirList');
  if (gameDirList) {
    gameDirList.addEventListener('click', function (event) {
      var item = event.target.closest ? event.target.closest('[data-gamedir-id]') : null;
      if (!item) return;
      gameDirEditingId = item.getAttribute('data-gamedir-id');
      gameDirAddMode = false;
      renderGameDirList();
      applyGameDirForm();
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

    instanceRowsEl.addEventListener('dblclick', function (event) {
      var row = event.target.closest ? event.target.closest('[data-instance-row]') : null;
      if (!row) return;
      var instance = instanceById(row.getAttribute('data-instance-row'));
      if (instance) launchInstanceFlow(instance, false);
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

  // 静态截图用：打开 #stack 定格在左上拉伸
  if (window.location.hash === '#stack') {
    applyStack(-0.8, -0.8);
    ring.style.transition = 'none';
    void ring.offsetWidth;
  }

  syncPages();
  switchHint();
})();
