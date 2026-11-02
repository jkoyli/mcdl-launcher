'use strict';

/**
 * 崩溃恢复页的脚本。
 *
 * 这里是**故意写成零依赖**的：不 require 任何模块、不用打包产物、不碰主包的全局状态。
 * 主界面崩溃的原因可能就在主包里，恢复页只要能读 query 串、点三个按钮就够了。
 *
 * query 由主进程在 loadFile(..., { query }) 时传入：
 *   reason=crash-loop|did-fail-load|load-failed|crash
 *   at / crashes / exitCode / errorCode / errorDescription
 */
(function () {
  var api = window.launcherAPI || {};

  var els = {
    headline: document.getElementById('headline'),
    explain: document.getElementById('explain'),
    meta: document.getElementById('meta'),
    reload: document.getElementById('reload'),
    reset: document.getElementById('reset'),
    export: document.getElementById('export'),
    status: document.getElementById('status')
  };

  var REASONS = {
    'crash-loop': {
      headline: '界面连续崩溃，已进入恢复模式',
      explain: '一分钟内界面崩溃了 3 次以上，为了不让窗口一直白屏，启动器切到了这个页面。' +
        '通常是界面缓存或显卡相关状态坏了，先试「重新加载界面」，还不行就用「重置工作区」。'
    },
    'did-fail-load': {
      headline: '界面文件没能加载',
      explain: '主界面的 HTML 没有加载成功，可能是文件被杀毒软件隔离、磁盘读取出错，或者数据目录权限异常。' +
        '可以先「重新加载界面」，失败再用「重置工作区」。'
    },
    'load-failed': {
      headline: '界面启动失败',
      explain: '启动器尝试打开主界面时出错。可以先「重新加载界面」；如果反复失败，请「导出诊断」后反馈给开发者。'
    },
    crashed: {
      headline: '启动器界面崩溃了',
      explain: '主界面进程意外退出，已经切到恢复模式。多数情况下「重新加载界面」就能恢复。'
    }
  };

  function params() {
    var search = window.location.search || '';
    var out = {};
    search.replace(/^\?/, '').split('&').forEach(function (pair) {
      if (!pair) return;
      var index = pair.indexOf('=');
      var key = index === -1 ? pair : pair.slice(0, index);
      var value = index === -1 ? '' : pair.slice(index + 1);
      try {
        out[decodeURIComponent(key)] = decodeURIComponent(value.replace(/\+/g, ' '));
      } catch (error) {
        out[key] = value;
      }
    });
    return out;
  }

  var query = params();
  var reason = query.reason || 'crashed';
  var copy = REASONS[reason] || REASONS.crashed;

  if (els.headline) els.headline.textContent = copy.headline;
  if (els.explain) els.explain.textContent = copy.explain;

  var metaLines = [];
  metaLines.push('原因：' + reason);
  if (query.at) {
    var at = new Date(Number(query.at));
    metaLines.push('时间：' + (isNaN(at.getTime()) ? query.at : at.toLocaleString()));
  }
  if (query.crashes) metaLines.push('本窗口崩溃次数：' + query.crashes);
  if (query.exitCode) metaLines.push('退出码：' + query.exitCode);
  if (query.errorCode) metaLines.push('错误码：' + query.errorCode + (query.errorDescription ? '（' + query.errorDescription + '）' : ''));
  if (els.meta) els.meta.textContent = metaLines.join('\n');

  function setStatus(text, tone) {
    if (!els.status) return;
    els.status.textContent = text || '';
    if (tone) els.status.setAttribute('data-tone', tone);
    else els.status.removeAttribute('data-tone');
  }

  function disableAll(disabled) {
    [els.reload, els.reset, els.export].forEach(function (button) {
      if (button) button.disabled = Boolean(disabled);
    });
  }

  function call(method) {
    if (typeof api[method] !== 'function') {
      return Promise.reject(new Error('主进程桥接不可用，请关闭启动器后重新打开'));
    }
    return Promise.resolve(api[method]());
  }

  if (els.reload) {
    els.reload.addEventListener('click', function () {
      setStatus('正在重新加载界面…');
      disableAll(true);
      call('reloadFromRecovery')
        .then(function () {
          // 成功的话页面已经被主进程换掉，这里几乎不会执行到。
          setStatus('已发起重新加载，如果界面没有变化请稍等几秒。', 'ok');
        })
        .catch(function (error) {
          setStatus('重新加载失败：' + (error && error.message ? error.message : String(error)), 'error');
        })
        .then(function () { disableAll(false); });
    });
  }

  if (els.reset) {
    els.reset.addEventListener('click', function () {
      setStatus('正在重置工作区（只清缓存与界面状态，不动游戏与账号）…');
      disableAll(true);
      call('resetWorkspace')
        .then(function (result) {
          var removed = result && result.removed ? result.removed.length : 0;
          var failed = result && result.failed ? result.failed.length : 0;
          setStatus(
            '已清理 ' + removed + ' 项缓存' + (failed ? '，' + failed + ' 项失败' : '') + '。正在重新加载界面…',
            failed ? 'error' : 'ok'
          );
        })
        .catch(function (error) {
          setStatus('重置失败：' + (error && error.message ? error.message : String(error)), 'error');
        })
        .then(function () { disableAll(false); });
    });
  }

  if (els.export) {
    els.export.addEventListener('click', function () {
      setStatus('正在生成诊断文件…');
      disableAll(true);
      call('exportDiagnostics')
        .then(function (result) {
          if (!result) {
            setStatus('已取消导出。');
            return;
          }
          setStatus('诊断已保存到：' + result.file, 'ok');
        })
        .catch(function (error) {
          setStatus('导出失败：' + (error && error.message ? error.message : String(error)), 'error');
        })
        .then(function () { disableAll(false); });
    });
  }
})();
