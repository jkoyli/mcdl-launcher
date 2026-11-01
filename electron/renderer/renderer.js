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

      if ((action === 'back' || action === 'close-page') && isCreateOpen) {
        closeCreatePanel({ focus: true });
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
    var raw = error && error.message ? String(error.message) : String(error || '启动失败');
    // Electron 会给 IPC 错误加上 "Error invoking remote method '...': " 前缀。
    raw = raw.replace(/^Error invoking remote method '[^']+':\s*/, '');
    raw = raw.replace(/^Error:\s*/, '');
    return raw.split(/\r?\n/).filter(Boolean).pop() || '启动失败';
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

  function openCreatePanel() {
    if (!mainStage || !stageCreate) return;
    if (installInProgress) return;
    if (overlayPanel) closeOverlayPanel({ focus: false });

    isCreateOpen = true;
    mainStage.classList.add('is-create');
    stageCreate.removeAttribute('inert');
    stageCreate.setAttribute('aria-hidden', 'false');
    setHomeInert(true);

    if (instancesRailBtn) {
      instancesRailBtn.setAttribute('aria-expanded', 'true');
    }

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
    isCreateOpen = false;
    if (mainStage) mainStage.classList.remove('is-create');
    if (stageCreate) {
      stageCreate.setAttribute('inert', '');
      stageCreate.setAttribute('aria-hidden', 'true');
    }
    setHomeInert(false);

    if (instancesRailBtn) {
      instancesRailBtn.setAttribute('aria-expanded', 'false');
      if (options.focus !== false) instancesRailBtn.focus();
    }

    window.dispatchEvent(new CustomEvent('launcher:panel-change', {
      detail: { panel: 'stage-home' }
    }));
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

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && isCreateOpen) {
      closeCreatePanel({ focus: true });
    }
  });

  // 对照 ui-tree-controls.html：实例管理的 3 个 L2 直达控件
  Array.prototype.forEach.call(document.querySelectorAll('[data-instance-action]'), function (button) {
    button.addEventListener('click', function () {
      window.dispatchEvent(new CustomEvent('launcher:instance-action', {
        detail: {
          action: button.getAttribute('data-instance-action'),
          key: button.getAttribute('data-control-key'),
          instance: getSelectedInstance()
        }
      }));
    });
  });

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
      closeOverlayPanel({ focus: false });
      openCreatePanel();
    } else if (isRailButton && (target === 'account' || target === 'settings')) {
      closeCreatePanel({ focus: false });
      openOverlayPanel(target);
    } else if (isCreateOpen && isRailButton) {
      closeCreatePanel({ focus: false });
      closeOverlayPanel({ focus: false });
    } else if (isRailButton) {
      closeOverlayPanel({ focus: false });
    }

    window.dispatchEvent(new CustomEvent('launcher:navigate', {
      detail: { target: target }
    }));
  });

  // ---------------------------------------------------------
  // 账户面板：离线账号 / 微软账号
  // ---------------------------------------------------------
  var stageAccount = document.getElementById('stageAccount');
  var accountBack = document.getElementById('accountBack');
  var accountList = document.getElementById('accountList');
  var offlineName = document.getElementById('offlineName');
  var offlineSubmit = document.getElementById('offlineSubmit');
  var offlineNote = document.getElementById('offlineNote');
  var msaLogin = document.getElementById('msaLogin');
  var msaNote = document.getElementById('msaNote');
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
  var selectedAccountId = null;
  var msaBusy = false;
  var settingsLoaded = false;

  function setHint(node, text, isError) {
    if (!node) return;
    node.textContent = text || '';
    node.classList.toggle('is-error', Boolean(isError));
  }

  function selectedAccount() {
    for (var i = 0; i < ACCOUNTS.length; i += 1) {
      if (ACCOUNTS[i].id === selectedAccountId) return ACCOUNTS[i];
    }
    return null;
  }

  function syncAccountChrome() {
    var current = selectedAccount();
    var label = current ? current.name : '未接入';
    var kind = current ? (current.type === 'microsoft' ? 'MICROSOFT' : 'OFFLINE') : '未选择账号';

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

  function renderAccounts() {
    if (!accountList) return;
    accountList.innerHTML = '';

    if (ACCOUNTS.length === 0) {
      var empty = document.createElement('span');
      empty.className = 'account-list__empty';
      empty.textContent = '还没有账号。先创建一个离线账号即可进入单人游戏。';
      accountList.appendChild(empty);
      syncAccountChrome();
      return;
    }

    ACCOUNTS.forEach(function (account) {
      var item = document.createElement('div');
      item.className = 'account-item' + (account.id === selectedAccountId ? ' is-selected' : '');
      item.setAttribute('role', 'listitem');

      var main = document.createElement('div');
      main.className = 'account-item__main';

      var name = document.createElement('span');
      name.className = 'account-item__name';
      name.textContent = account.name;
      main.appendChild(name);

      var meta = document.createElement('span');
      meta.className = 'account-item__meta';
      meta.textContent = (account.type === 'microsoft' ? 'Microsoft' : 'Offline') +
        (account.id === selectedAccountId ? ' · 当前' : '');
      main.appendChild(meta);

      item.appendChild(main);

      var actions = document.createElement('div');
      actions.className = 'account-item__actions';

      if (account.id !== selectedAccountId) {
        var useBtn = document.createElement('button');
        useBtn.type = 'button';
        useBtn.className = 'account-mini';
        useBtn.textContent = '使用';
        useBtn.setAttribute('data-account-select', account.id);
        actions.appendChild(useBtn);
      }

      var removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'account-mini is-danger';
      removeBtn.textContent = '删除';
      removeBtn.setAttribute('data-account-remove', account.id);
      actions.appendChild(removeBtn);

      item.appendChild(actions);
      accountList.appendChild(item);
    });

    syncAccountChrome();
  }

  function applyAccountSnapshot(snapshot) {
    if (!snapshot) return;
    ACCOUNTS = Array.isArray(snapshot.accounts) ? snapshot.accounts : [];
    selectedAccountId = snapshot.selectedId || null;
    renderAccounts();
  }

  function loadAccounts() {
    var api = window.launcherAPI;
    if (!api || typeof api.getAccounts !== 'function') return;

    api.getAccounts()
      .then(function (snapshot) {
        applyAccountSnapshot(snapshot);
      })
      .catch(function (error) {
        console.error('[accounts] load failed:', error);
        setHint(offlineNote, describeLaunchError(error), true);
      });
  }

  function createOfflineAccount() {
    var api = window.launcherAPI;
    var name = offlineName ? offlineName.value.trim() : '';

    if (!api || typeof api.addOfflineAccount !== 'function') {
      setHint(offlineNote, '主进程桥接不可用', true);
      return;
    }
    if (!name) {
      setHint(offlineNote, '请输入玩家名', true);
      if (offlineName) offlineName.focus();
      return;
    }

    setHint(offlineNote, '正在创建…', false);
    api.addOfflineAccount(name)
      .then(function (snapshot) {
        applyAccountSnapshot(snapshot);
        if (offlineName) offlineName.value = '';
        setHint(offlineNote, '已创建并选中：' + name, false);
      })
      .catch(function (error) {
        setHint(offlineNote, describeLaunchError(error), true);
      });
  }

  function loginMicrosoft() {
    var api = window.launcherAPI;
    if (!api || typeof api.addMicrosoftAccount !== 'function') {
      setHint(msaNote, '主进程桥接不可用', true);
      return;
    }
    if (msaBusy) return;

    msaBusy = true;
    if (msaLogin) msaLogin.disabled = true;
    setHint(msaNote, '已打开登录窗口，请在其中完成微软登录…', false);

    api.addMicrosoftAccount()
      .then(function (snapshot) {
        applyAccountSnapshot(snapshot);
        var current = selectedAccount();
        setHint(msaNote, current ? '已登录：' + current.name : '登录完成', false);
      })
      .catch(function (error) {
        setHint(msaNote, describeLaunchError(error), true);
      })
      .then(function () {
        msaBusy = false;
        if (msaLogin) msaLogin.disabled = false;
      });
  }

  if (offlineSubmit) {
    offlineSubmit.addEventListener('click', createOfflineAccount);
  }

  if (offlineName) {
    offlineName.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        createOfflineAccount();
      }
    });
  }

  if (msaLogin) {
    msaLogin.addEventListener('click', loginMicrosoft);
  }

  if (accountList) {
    accountList.addEventListener('click', function (event) {
      var api = window.launcherAPI;
      var target = event.target;
      if (!target || !target.getAttribute) return;

      var selectId = target.getAttribute('data-account-select');
      if (selectId && api && typeof api.selectAccount === 'function') {
        api.selectAccount(selectId)
          .then(applyAccountSnapshot)
          .catch(function (error) {
            setHint(offlineNote, describeLaunchError(error), true);
          });
        return;
      }

      var removeId = target.getAttribute('data-account-remove');
      if (removeId && api && typeof api.removeAccount === 'function') {
        api.removeAccount(removeId)
          .then(applyAccountSnapshot)
          .catch(function (error) {
            setHint(offlineNote, describeLaunchError(error), true);
          });
      }
    });
  }

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
  // 二级页面切换：账户 / 设置
  // ---------------------------------------------------------
  var overlayPanel = null;

  function closeOverlayPanel(options) {
    if (!overlayPanel) return;
    options = options || {};

    var closing = overlayPanel;
    overlayPanel = null;

    if (mainStage) {
      mainStage.classList.remove('is-account', 'is-settings');
    }

    [stageAccount, stageSettings].forEach(function (node) {
      if (!node) return;
      node.setAttribute('inert', '');
      node.setAttribute('aria-hidden', 'true');
    });

    setHomeInert(false);

    if (options.focus !== false) {
      var rail = document.querySelector('.rail-btn[data-nav="' + closing + '"]');
      if (rail) rail.focus();
    }

    window.dispatchEvent(new CustomEvent('launcher:panel-change', {
      detail: { panel: 'stage-home' }
    }));
  }

  function openOverlayPanel(name) {
    var section = name === 'account' ? stageAccount : stageSettings;
    if (!mainStage || !section) return;

    closeOverlayPanel({ focus: false });

    overlayPanel = name;
    mainStage.classList.add(name === 'account' ? 'is-account' : 'is-settings');
    section.removeAttribute('inert');
    section.setAttribute('aria-hidden', 'false');
    setHomeInert(true);

    if (name === 'account') {
      loadAccounts();
      window.setTimeout(function () {
        if (offlineName) offlineName.focus();
      }, 240);
    } else {
      loadSettings();
    }

    window.dispatchEvent(new CustomEvent('launcher:panel-change', {
      detail: { panel: name }
    }));
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

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && overlayPanel) {
      closeOverlayPanel({ focus: true });
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
