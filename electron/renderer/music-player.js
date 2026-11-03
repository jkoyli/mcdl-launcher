'use strict';

/**
 * 本地音乐播放器（右上角圆钮）。
 *
 * 交互：
 *   · 收起 = 58px 圆钮；鼠标悬停 110ms 后展开成面板
 *   · 面板右上角「图钉」：钉住后鼠标移开不收起，再点一次取消
 *   · 「列表」按钮把面板从 150px 拉高到 294px，露出播放列表
 *
 * 播放列表由主进程维护（<userData>/music-playlist.json），这里只通过
 * launcherAPI.music.* 增删查；音频 URL 是 mcdl-media://music/<id>，
 * 渲染层拿不到也读不了任意本地路径。
 *
 * 纯逻辑（文件名拆标题 / 时间格式 / 下一首）在 music-playlist.js，
 * 由 node --test 单独覆盖。
 */
(function () {
  'use strict';

  var dock = document.getElementById('musicDock');
  if (!dock) return;

  var helpers = window.MusicPlaylist || {};
  var parseTrackLabel = helpers.parseTrackLabel || function (name) {
    return { title: String(name || '未知曲目'), artist: '' };
  };
  var formatTime = helpers.formatTime || function () { return '0:00'; };
  var nextIndex = helpers.nextIndex || function () { return -1; };
  var progressRatio = helpers.progressRatio || function () { return 0; };

  var orb = document.getElementById('musicOrb');
  var panel = document.getElementById('musicPanel');
  var audio = document.getElementById('musicAudio');
  var orbBeat = document.getElementById('musicOrbBeat');
  var titleEl = document.getElementById('musicTitle');
  var subEl = document.getElementById('musicSub');
  var clockEl = document.getElementById('musicClock');
  var seekEl = document.getElementById('musicSeek');
  var volumeEl = document.getElementById('musicVolume');
  var playBtn = document.getElementById('musicPlay');
  var prevBtn = document.getElementById('musicPrev');
  var nextBtn = document.getElementById('musicNext');
  var shuffleBtn = document.getElementById('musicShuffle');
  var repeatBtn = document.getElementById('musicRepeat');
  var muteBtn = document.getElementById('musicMute');
  var addBtn = document.getElementById('musicAdd');
  var listBtn = document.getElementById('musicListBtn');
  var listEl = document.getElementById('musicList');
  var listCountEl = document.getElementById('musicListCount');
  var clearBtn = document.getElementById('musicClear');
  var pinBtn = document.getElementById('musicPin');

  var api = window.launcherAPI && window.launcherAPI.music;
  var STORAGE_KEY = 'mcdl.music.v1';
  var HOVER_DELAY = 110;
  var LEAVE_DELAY = 90;
  var HINT_MS = 4200;

  var state = {
    tracks: [],
    index: -1,
    // <audio> 上当前装载的曲目 id（不是「选中的」）。列表增删导致下标变化时，
    // 只要 id 没变就不重新赋值 src，避免正在播的歌被从头加载。
    loadedId: '',
    playing: false,
    expanded: false,
    pinned: false,
    listOpen: false,
    repeat: 'off',
    shuffle: false,
    volume: 0.7,
    muted: false,
    duration: 0,
    seeking: false,
    hint: '',
    hintError: false,
    busy: false,
    expandedAt: 0
  };

  var hoverTimer = 0;
  var leaveTimer = 0;
  var hintTimer = 0;

  // ---------------------------------------------------------
  // 偏好：音量 / 循环 / 随机 / 图钉 / 上次曲目
  // 只放 localStorage（和主题一样），不写主进程设置。
  // ---------------------------------------------------------
  function readPrefs() {
    try {
      var raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}');
      return raw && typeof raw === 'object' ? raw : {};
    } catch {
      return {};
    }
  }

  function savePrefs() {
    var track = currentTrack();
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        volume: state.volume,
        muted: state.muted,
        repeat: state.repeat,
        shuffle: state.shuffle,
        pinned: state.pinned,
        trackId: track ? track.id : ''
      }));
    } catch {
      // 隐私模式 / 存储被禁：不影响播放
    }
  }

  // ---------------------------------------------------------
  // 小工具
  // ---------------------------------------------------------
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function currentTrack() {
    return state.tracks[state.index] || null;
  }

  function setPressed(button, pressed) {
    if (button) button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
  }

  function setText(node, text) {
    if (node && node.textContent !== text) node.textContent = text;
  }

  function clamp01(value) {
    var number = Number(value);
    if (!isFinite(number)) return 0;
    if (number < 0) return 0;
    if (number > 1) return 1;
    return number;
  }

  function flashHint(text, isError) {
    state.hint = String(text || '');
    state.hintError = Boolean(isError);
    if (hintTimer) clearTimeout(hintTimer);
    hintTimer = window.setTimeout(function () {
      hintTimer = 0;
      state.hint = '';
      state.hintError = false;
      renderNow();
    }, HINT_MS);
    renderNow();
  }

  // ---------------------------------------------------------
  // 渲染
  // ---------------------------------------------------------
  function repeatLabel() {
    if (state.repeat === 'all') return '循环：列表';
    if (state.repeat === 'one') return '循环：单曲';
    return '循环：关';
  }

  function renderNow() {
    var track = currentTrack();
    var label = track ? parseTrackLabel(track.name) : null;
    var ratio = progressRatio(audio.currentTime, state.duration);

    if (label) {
      setText(titleEl, label.title || '未知曲目');
      if (state.hint) {
        setText(subEl, state.hint);
        subEl.classList.toggle('is-error', state.hintError);
      } else if (track.missing) {
        setText(subEl, '文件丢失 · 请重新添加');
        subEl.classList.add('is-error');
      } else {
        setText(subEl, label.artist || '本地文件');
        subEl.classList.remove('is-error');
      }
    } else {
      setText(titleEl, '还没有曲目');
      setText(subEl, state.hint || '点「+」添加本机音乐');
      subEl.classList.toggle('is-error', state.hintError);
    }

    setText(clockEl, formatTime(audio.currentTime) + ' / ' + (state.duration > 0 ? formatTime(state.duration) : '--:--'));

    if (!state.seeking) {
      seekEl.value = String(Math.round(ratio * 1000));
    }
    seekEl.style.setProperty('--p', String(ratio));
    if (orbBeat) orbBeat.style.strokeDashoffset = String(100 - ratio * 100);

    dock.classList.toggle('is-playing', state.playing);
    playBtn.setAttribute('aria-label', state.playing ? '暂停' : '播放');
    playBtn.title = state.playing ? '暂停' : '播放';

    setPressed(shuffleBtn, state.shuffle);
    setPressed(repeatBtn, state.repeat !== 'off');
    repeatBtn.setAttribute('data-mode', state.repeat);
    repeatBtn.title = repeatLabel();
    repeatBtn.setAttribute('aria-label', repeatLabel());

    setPressed(muteBtn, state.muted);
    if (volumeEl.value !== String(Math.round(state.volume * 100))) {
      volumeEl.value = String(Math.round(state.volume * 100));
    }

    setPressed(pinBtn, state.pinned);
    pinBtn.title = state.pinned ? '已固定：再点一次取消' : '固定：鼠标移开也不收起';
    listBtn.setAttribute('aria-expanded', state.listOpen ? 'true' : 'false');

    var hasTracks = state.tracks.length > 0;
    prevBtn.disabled = !hasTracks;
    nextBtn.disabled = !hasTracks;
    playBtn.disabled = !hasTracks;
    seekEl.disabled = !hasTracks;
    clearBtn.disabled = !hasTracks;
  }

  function renderList() {
    listEl.textContent = '';

    if (state.tracks.length === 0) {
      var empty = el('div', 'music-empty');
      empty.appendChild(el('b', '', '还没有本地音乐'));
      empty.appendChild(el('span', '', '点右上角「+」选择 mp3 / flac / wav…'));
      listEl.appendChild(empty);
    } else {
      for (var i = 0; i < state.tracks.length; i += 1) {
        listEl.appendChild(buildRow(state.tracks[i], i));
      }
    }

    setText(listCountEl, '播放列表 · ' + state.tracks.length + ' 首');
  }

  function buildRow(track, index) {
    var label = parseTrackLabel(track.name);
    var row = el('div', 'music-row');
    row.setAttribute('role', 'listitem');
    row.setAttribute('tabindex', '0');
    row.setAttribute('data-index', String(index));
    row.title = track.fileName || track.name;
    if (index === state.index) row.classList.add('is-active');
    if (track.missing) row.classList.add('is-missing');

    row.appendChild(el('span', 'music-row__index', String(index + 1).padStart(2, '0')));

    var text = el('span', 'music-row__text');
    text.appendChild(el('span', 'music-row__name', label.title || track.name));
    text.appendChild(el('span', 'music-row__artist', track.missing ? '文件丢失' : (label.artist || '本地文件')));
    row.appendChild(text);

    var remove = el('button', 'music-row__remove');
    remove.type = 'button';
    remove.setAttribute('aria-label', '从播放列表移除：' + (label.title || track.name));
    remove.title = '从播放列表移除';
    var removeIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    removeIcon.setAttribute('viewBox', '0 0 24 24');
    removeIcon.setAttribute('aria-hidden', 'true');
    var removePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    removePath.setAttribute('d', 'M7 7l10 10M17 7 7 17');
    removeIcon.appendChild(removePath);
    remove.appendChild(removeIcon);
    remove.addEventListener('click', function (event) {
      event.stopPropagation();
      removeTrack(track.id);
    });
    row.appendChild(remove);

    row.addEventListener('click', function () { playAt(index); });
    row.addEventListener('keydown', function (event) {
      // 焦点在行内的「×」上时，Enter/Space 是按钮的激活键，不能被行拦走
      // （否则按 Enter 不会删除，反而开始播放这一首）。
      if (event.target !== row) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      playAt(index);
    });

    return row;
  }

  function renderAll() {
    renderNow();
    renderList();
  }

  // ---------------------------------------------------------
  // 播放
  // ---------------------------------------------------------
  function loadSource(index, autoplay) {
    var track = state.tracks[index];
    if (!track) return;

    state.index = index;
    state.duration = 0;
    state.hint = '';

    if (!track.url) {
      state.loadedId = '';
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      state.playing = false;
      flashHint('文件丢失：' + (track.fileName || track.name), true);
      savePrefs();
      renderAll();
      return;
    }

    state.loadedId = track.id;
    audio.src = track.url;
    audio.volume = state.volume;
    audio.muted = state.muted;
    if (autoplay) playAudio();
    savePrefs();
    renderAll();
  }

  // 换掉 <audio> 上装载的曲目。loadedId 必须跟着走：
  // applyTracks 靠它区分「同一首歌、只是列表下标变了」——那种情况绝对不能重新
  // 给 src 赋值，否则媒体元素会重新加载，正在播的歌会从 0 开始。
  function unloadAudio() {
    state.loadedId = '';
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    state.playing = false;
  }

  function playAudio() {
    var track = currentTrack();
    if (!track) return;
    if (!track.url) {
      state.playing = false;
      flashHint('文件丢失：' + (track.fileName || track.name), true);
      renderNow();
      return;
    }
    var promise = audio.play();
    if (promise && typeof promise.catch === 'function') {
      promise.catch(function (error) {
        state.playing = false;
        flashHint('无法播放：' + describe(error), true);
        renderNow();
      });
    }
  }

  function describe(error) {
    if (!error) return '未知错误';
    if (error.name === 'NotSupportedError') return '格式不受支持';
    if (error.name === 'NotAllowedError') return '需要先点击页面';
    return error.message || String(error);
  }

  function playAt(index) {
    if (index < 0 || index >= state.tracks.length) return;
    if (index === state.index && audio.src) {
      if (audio.paused) playAudio();
      return;
    }
    loadSource(index, true);
  }

  function togglePlay() {
    var track = currentTrack();
    if (!track) return;
    if (!track.url) {
      flashHint('文件丢失：' + (track.fileName || track.name), true);
      renderNow();
      return;
    }
    if (audio.paused) playAudio();
    else audio.pause();
  }

  /**
   * 找下一首「真的能播」的曲目：文件丢失（url 为空）的条目直接跳过。
   *
   * 复用 music-playlist.js 的 nextIndex（循环 / 随机 / 到末尾停的规则都在那里），
   * 这里只在外层多绕几圈：撞到坏条目就把它当作新的起点继续找，最多绕列表一圈。
   *
   * @param {number} from 起点下标（-1 表示还没有当前曲目）
   * @param {{auto?:boolean, step?:number}} options auto = 当前这首刚播完
   * @returns {number} 目标下标；-1 表示没有可播的（该停）
   */
  function findPlayable(from, options) {
    var length = state.tracks.length;
    if (length === 0) return -1;

    var opts = options || {};
    var auto = Boolean(opts.auto);
    var step = opts.step === -1 ? -1 : 1;
    // 随机模式下撞到坏文件后改成顺序找，避免反复抽中同一首坏文件。
    var shuffle = state.shuffle;
    var index = from;

    // 自动播放（这首刚播完）+ 循环关闭：只往后找，找不到就停。
    // 不能像手动切歌那样回绕，否则「循环关」播到最后一首会莫名其妙回到第一首。
    if (auto && state.repeat === 'off' && !shuffle) {
      for (var i = from + 1; i < length; i += 1) {
        if (state.tracks[i] && state.tracks[i].url) return i;
      }
      return -1;
    }

    for (var guard = 0; guard < length; guard += 1) {
      index = nextIndex({
        index: index,
        length: length,
        repeat: state.repeat,
        shuffle: shuffle,
        step: step,
        auto: auto
      });
      if (index < 0) return -1;
      if (state.tracks[index] && state.tracks[index].url) return index;
      auto = false;
      shuffle = false;
    }

    return -1;
  }

  function step(direction) {
    var length = state.tracks.length;
    if (length === 0) return;

    // 还没有当前曲目时：下一首 = 第一首，上一首 = 最后一首。
    // （旧写法把 -1 夹成 0 再加 step，会从第二首开始。）
    var from = state.index;
    if (from < 0) from = direction > 0 ? length - 1 : 0;

    var index = findPlayable(from, { step: direction, auto: false });
    if (index >= 0) loadSource(index, true);
  }

  function advance(auto) {
    var index = findPlayable(state.index, { auto: auto });
    if (index < 0) {
      state.playing = false;
      audio.pause();
      renderNow();
      return;
    }
    loadSource(index, true);
  }

  // ---------------------------------------------------------
  // 列表增删（全部走主进程，渲染层只拿 id）
  // ---------------------------------------------------------
  function currentId() {
    var track = currentTrack();
    return track ? track.id : '';
  }

  function applyTracks(payload, options) {
    var wantedId = (options && options.keepId) || currentId();
    var list = payload && Array.isArray(payload.tracks) ? payload.tracks : [];

    state.tracks = list;

    var next = -1;
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].id === wantedId) { next = i; break; }
    }

    if (next < 0 && list.length > 0) next = 0;

    var target = next >= 0 ? list[next] : null;
    var wasPlaying = state.playing;
    state.index = next;

    if (!target) {
      unloadAudio();
    } else if (!target.url) {
      // 当前曲目文件丢了：把旧曲目从 <audio> 上摘掉，别让 currentSrc 还指着它。
      if (state.loadedId !== target.id) unloadAudio();
      state.playing = false;
    } else if (state.loadedId !== target.id || !audio.src) {
      // 换了另一首才重新赋值 src。同一首（只是列表下标变了，比如删掉前面一首）
      // 重新赋值会让媒体元素重新加载、把播放进度清零。
      state.loadedId = target.id;
      state.duration = 0;
      audio.src = target.url;
      audio.volume = state.volume;
      audio.muted = state.muted;
      if (wasPlaying) playAudio();
    } else if (wasPlaying && audio.paused) {
      playAudio();
    }

    if (options && typeof options.notice === 'string' && options.notice) {
      flashHint(options.notice, Boolean(options.noticeError));
    }

    savePrefs();
    renderAll();
  }

  function refresh() {
    if (!api) return Promise.resolve();
    return api.list().then(function (payload) {
      applyTracks(payload);
    }).catch(function (error) {
      flashHint('读取播放列表失败：' + describe(error), true);
    });
  }

  function pickFiles() {
    if (!api || state.busy) return;
    state.busy = true;
    addBtn.disabled = true;
    api.pick().then(function (result) {
      if (!result || result.canceled) return;
      var notice = '';
      var limit = result.limit || 500;
      if (result.added > 0) {
        notice = '已添加 ' + result.added + ' 首';
        if (result.dropped > 0) {
          notice += ' · 已达上限 ' + limit + ' 首，忽略 ' + result.dropped + ' 个文件';
        }
      } else if (result.dropped > 0) {
        notice = '播放列表已满（上限 ' + limit + ' 首），忽略 ' + result.dropped + ' 个文件';
      } else {
        notice = '没有新增曲目';
      }
      if (result.skipped && result.skipped.length > 0) {
        notice += ' · 跳过 ' + result.skipped.length + ' 个不支持的文件';
      }
      applyTracks(result, { notice: notice, noticeError: result.added === 0 });
      if (result.added > 0) expand();
    }).catch(function (error) {
      flashHint('添加失败：' + describe(error), true);
    }).then(function () {
      state.busy = false;
      addBtn.disabled = false;
    });
  }

  function removeTrack(id) {
    if (!api || !id) return;
    api.remove(id).then(function (payload) {
      if (id === currentId()) {
        // 删的是当前曲目：先摘掉 <audio>，applyTracks 会落到第一首（不自动播）。
        state.index = -1;
        unloadAudio();
      }
      applyTracks(payload);
    }).catch(function (error) {
      flashHint('移除失败：' + describe(error), true);
    });
  }

  function clearList() {
    if (!api || state.tracks.length === 0) return;
    api.clear().then(function (payload) {
      state.index = -1;
      unloadAudio();
      applyTracks(payload, { notice: '播放列表已清空' });
    }).catch(function (error) {
      flashHint('清空失败：' + describe(error), true);
    });
  }

  // ---------------------------------------------------------
  // 展开 / 收起 / 图钉
  // ---------------------------------------------------------
  function setPanelInert(inert) {
    if (!panel) return;
    if ('inert' in panel) panel.inert = Boolean(inert);
  }

  function expand() {
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = 0; }
    if (state.expanded) return;
    state.expanded = true;
    state.expandedAt = Date.now();
    dock.setAttribute('data-state', 'expanded');
    orb.setAttribute('aria-expanded', 'true');
    panel.setAttribute('aria-hidden', 'false');
    setPanelInert(false);
  }

  function collapse() {
    if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = 0; }
    if (!state.expanded || state.pinned) return;
    state.expanded = false;
    state.listOpen = false;
    dock.setAttribute('data-state', 'collapsed');
    dock.setAttribute('data-list', 'closed');
    orb.setAttribute('aria-expanded', 'false');
    panel.setAttribute('aria-hidden', 'true');
    setPanelInert(true);
    renderNow();
  }

  function togglePin() {
    state.pinned = !state.pinned;
    savePrefs();
    renderNow();
    if (!state.pinned) {
      // 取消固定时如果鼠标已经不在面板上，立刻收起（符合"没钉住就正常缩小"）。
      var hovered = dock.matches(':hover');
      if (!hovered && state.expanded) collapse();
    }
  }

  function toggleList() {
    if (!state.expanded) expand();
    state.listOpen = !state.listOpen;
    dock.setAttribute('data-list', state.listOpen ? 'open' : 'closed');
    listBtn.setAttribute('aria-expanded', state.listOpen ? 'true' : 'false');
  }

  dock.addEventListener('pointerenter', function () {
    if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = 0; }
    if (state.expanded) return;
    hoverTimer = window.setTimeout(function () {
      hoverTimer = 0;
      expand();
    }, HOVER_DELAY);
  });

  dock.addEventListener('pointerleave', function () {
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = 0; }
    if (!state.expanded || state.pinned) return;
    if (leaveTimer) return;
    leaveTimer = window.setTimeout(function () {
      leaveTimer = 0;
      collapse();
    }, LEAVE_DELAY);
  });

  // 键盘：Tab 进来就展开；焦点离开且没钉住就收起；Esc 收起并取消固定。
  dock.addEventListener('focusin', function () {
    expand();
  });

  dock.addEventListener('focusout', function (event) {
    if (dock.contains(event.relatedTarget)) return;
    if (state.pinned || dock.matches(':hover')) return;
    collapse();
  });

  dock.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    state.pinned = false;
    renderNow();
    savePrefs();
    collapse();
    if (orb && typeof orb.focus === 'function') orb.focus();
  });

  // ---------------------------------------------------------
  // 控件
  // ---------------------------------------------------------
  orb.addEventListener('click', function () {
    // 圆钮只负责展开：悬停 110ms 就会自动展开，点击时面板通常已经在了。
    expand();
  });

  playBtn.addEventListener('click', togglePlay);
  prevBtn.addEventListener('click', function () { step(-1); });
  nextBtn.addEventListener('click', function () { step(1); });
  addBtn.addEventListener('click', pickFiles);
  clearBtn.addEventListener('click', clearList);
  listBtn.addEventListener('click', toggleList);
  pinBtn.addEventListener('click', function () {
    // 悬停展开时，图钉正好长在圆钮原来的位置上：刚展开就点会误触。
    // 300ms 内的点击忽略，之后正常切换。
    if (Date.now() - state.expandedAt < 300) return;
    togglePin();
  });

  shuffleBtn.addEventListener('click', function () {
    state.shuffle = !state.shuffle;
    savePrefs();
    renderNow();
  });

  repeatBtn.addEventListener('click', function () {
    state.repeat = state.repeat === 'off' ? 'all' : (state.repeat === 'all' ? 'one' : 'off');
    savePrefs();
    renderNow();
  });

  muteBtn.addEventListener('click', function () {
    state.muted = !state.muted;
    audio.muted = state.muted;
    savePrefs();
    renderNow();
  });

  volumeEl.addEventListener('input', function () {
    state.volume = clamp01(Number(volumeEl.value) / 100);
    state.muted = false;
    audio.volume = state.volume;
    audio.muted = false;
    savePrefs();
    renderNow();
  });

  seekEl.addEventListener('input', function () {
    state.seeking = true;
    var ratio = clamp01(Number(seekEl.value) / 1000);
    seekEl.style.setProperty('--p', String(ratio));
    setText(clockEl, formatTime(ratio * state.duration) + ' / ' + (state.duration > 0 ? formatTime(state.duration) : '--:--'));
  });

  seekEl.addEventListener('change', function () {
    var ratio = clamp01(Number(seekEl.value) / 1000);
    state.seeking = false;
    if (state.duration > 0 && isFinite(audio.duration)) {
      try {
        audio.currentTime = ratio * audio.duration;
      } catch {
        // 还没加载出 metadata 时忽略
      }
    }
  });

  // ---------------------------------------------------------
  // 音频事件
  // ---------------------------------------------------------
  audio.addEventListener('loadedmetadata', function () {
    state.duration = isFinite(audio.duration) ? audio.duration : 0;
    renderNow();
  });

  audio.addEventListener('durationchange', function () {
    state.duration = isFinite(audio.duration) ? audio.duration : 0;
    renderNow();
  });

  audio.addEventListener('timeupdate', function () {
    renderNow();
  });

  audio.addEventListener('play', function () {
    state.playing = true;
    renderNow();
  });

  audio.addEventListener('pause', function () {
    state.playing = false;
    renderNow();
  });

  audio.addEventListener('ended', function () {
    advance(true);
  });

  audio.addEventListener('error', function () {
    if (!audio.src) return;
    state.playing = false;
    flashHint('播放失败：' + describe(audio.error), true);
  });

  // ---------------------------------------------------------
  // 初始化
  // ---------------------------------------------------------
  function init() {
    var prefs = readPrefs();

    state.volume = clamp01(typeof prefs.volume === 'number' ? prefs.volume : 0.7);
    state.muted = Boolean(prefs.muted);
    state.repeat = prefs.repeat === 'all' || prefs.repeat === 'one' ? prefs.repeat : 'off';
    state.shuffle = Boolean(prefs.shuffle);
    state.pinned = Boolean(prefs.pinned);

    audio.volume = state.volume;
    audio.muted = state.muted;

    renderAll();
    setPanelInert(true);

    if (state.pinned) {
      // 上次退出时钉住了：直接展开，并且不因为「鼠标不在上面」而收起。
      expand();
    }

    if (!api) {
      flashHint('音乐播放器不可用：preload 未注入 music API', true);
      return;
    }

    api.list().then(function (payload) {
      applyTracks(payload, { keepId: String(prefs.trackId || '') });
    }).catch(function (error) {
      flashHint('读取播放列表失败：' + describe(error), true);
    });
  }

  init();
})();
