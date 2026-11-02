'use strict';

/**
 * 测试基建自检：确认这批被测模块确实"不需要 Electron 就能加载"。
 *
 * 整个 electron/tests 的前提是：纯逻辑模块不 require('electron')，
 * 因此可以直接用 node:test 跑。这一条如果失败，说明有人把 app / dialog
 * 引入了纯逻辑层——那会让所有用例一夜之间跑不起来，值得单独守一条。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

/** 本轮覆盖（或至少加载过）的模块，全部是纯逻辑。 */
const PURE_MODULES = [
  'path-guard',
  'nbt',
  'nbt-editor',
  'modpack-guard',
  'version-manifest',
  'launch-spec',
  'game-directories',
  'java-install',
  'instance-store',
  'modpack-export',
  // 更新通道：纯逻辑部分（配置解析 / 版本比较 / createUpdater 的惰性封装）
  // 必须能在没有 electron-updater、没有 electron 的 node 进程里加载。
  'updater',
  // 打包路径 / 内置 JRE 解析也必须是纯 node 可加载的：
  // 它们靠 main.js 注入 isPackaged / resourcesPath，而不 require('electron')。
  'java-runtime',
  'mcdl-service'
];

test('纯逻辑模块都能被 node 直接加载（不依赖 Electron 运行时）', () => {
  for (const name of PURE_MODULES) {
    const loaded = require(path.join('..', name));
    assert.equal(typeof loaded, 'object', `${name} 应导出对象`);
    assert.ok(loaded, `${name} 加载失败`);
  }
});

test('加载纯逻辑模块不会把 electron 拉进进程', () => {
  // 只要上面的 require 成功，且 require.cache 里没有 electron / electron-updater，
  // 就说明这些模块没有把 Electron 或更新器当成「加载即依赖」的东西。
  // updater.js 尤其关键：更新通道默认关闭，require 它本身不能把 electron-updater 拉进来。
  const electronEntries = Object.keys(require.cache).filter((file) => {
    const normalized = file.split(path.sep).join('/');
    return /\/node_modules\/electron(-updater|-builder)?\//.test(normalized) ||
      /\/electron\/main\.js$/.test(normalized);
  });

  assert.deepEqual(electronEntries, []);
});
