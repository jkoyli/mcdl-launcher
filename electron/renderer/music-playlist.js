'use strict';

/**
 * 音乐播放器的纯逻辑（不碰 DOM / 音频 / IPC）。
 *
 * 渲染层用 <script src> 直接加载（挂到 window.MusicPlaylist），
 * tests/ 里用 require('../renderer/music-playlist') 加载同一份实现。
 *
 * 放在这里而不是塞进 renderer.js，是为了让「文件名拆标题 / 时间格式 / 上一首下一首」
 * 这些容易写错的规则可以被 node --test 直接覆盖。
 */
(function (root) {
  'use strict';

  /**
   * "Artist - Title.mp3" → { artist, title }。
   * 常见下载文件名还有 "01 - Title"（前面的数字是曲目号，不是歌手）和纯 "Title"。
   *
   * @param {string} fileName
   * @returns {{title:string, artist:string}}
   */
  function parseTrackLabel(fileName) {
    var name = String(fileName == null ? '' : fileName);
    name = name.replace(/^.*[\\/]/, '');          // 去掉路径
    name = name.replace(/\.[a-z0-9]{1,6}$/i, ''); // 去掉扩展名
    name = name.trim();

    if (!name) return { title: '未知曲目', artist: '' };

    // 只认 " - "（带空格），避免把 "AC-DC" 这种名字拆开。
    var parts = name.split(/\s+-\s+/);
    if (parts.length >= 2) {
      var left = parts.shift().trim();
      var title = parts.join(' - ').trim();
      if (/^\d{1,3}$/.test(left)) {
        // "01 - Title"：数字是曲目号
        return { title: title || name, artist: '' };
      }
      return { title: title || left, artist: left };
    }

    return { title: name, artist: '' };
  }

  /**
   * 秒 → "m:ss"；非法 / 负数 / 未知一律 "0:00"。
   * @param {number} seconds
   */
  function formatTime(seconds) {
    var total = Math.floor(Number(seconds));
    if (!isFinite(total) || total < 0) return '0:00';
    var minutes = Math.floor(total / 60);
    var rest = total % 60;
    return minutes + ':' + (rest < 10 ? '0' : '') + rest;
  }

  /**
   * 计算下一首 / 上一首。
   *
   * repeat: 'off' | 'all' | 'one'
   * step:   +1 下一首、-1 上一首（auto 时不看）
   * auto:   true 表示是「当前这首播完了」自动切换（决定 repeat=one 与到结尾时是否停）
   * shuffle / random: 打乱时随机挑一首不同的（random 可注入，测试用）
   *
   * @param {{index:number,length:number,repeat?:string,shuffle?:boolean,step?:number,auto?:boolean,random?:Function}} options
   * @returns {number} 目标下标；-1 表示停止（播到列表末尾且不循环）
   */
  function nextIndex(options) {
    var opts = options || {};
    var index = Number(opts.index);
    var length = Number(opts.length);
    if (!isFinite(index) || index < 0) index = 0;
    if (!isFinite(length) || length <= 0) return -1;

    var repeat = opts.repeat === 'all' || opts.repeat === 'one' ? opts.repeat : 'off';
    var auto = Boolean(opts.auto);
    var step = opts.step === -1 ? -1 : 1;
    var random = typeof opts.random === 'function' ? opts.random : Math.random;

    // 单曲循环：只在「自动播完」时原地重播；手动点下一首仍然换歌。
    if (auto && repeat === 'one') return index;

    if (opts.shuffle) {
      if (length === 1) return auto && repeat === 'off' ? -1 : 0;
      var pick = index;
      for (var guard = 0; guard < 32 && pick === index; guard += 1) {
        pick = Math.floor(random() * length);
      }
      if (pick === index) pick = (index + 1) % length;
      return pick;
    }

    var next = index + step;
    if (next >= length) return auto && repeat !== 'all' ? -1 : 0;
    if (next < 0) return length - 1;
    return next;
  }

  /**
   * 进度条 → 0..1（用于圆环 / 进度条），非法值一律 0。
   * @param {number} current
   * @param {number} duration
   */
  function progressRatio(current, duration) {
    var now = Number(current);
    var total = Number(duration);
    if (!isFinite(now) || !isFinite(total) || total <= 0 || now <= 0) return 0;
    if (now >= total) return 1;
    return now / total;
  }

  var api = {
    parseTrackLabel: parseTrackLabel,
    formatTime: formatTime,
    nextIndex: nextIndex,
    progressRatio: progressRatio
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MusicPlaylist = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
