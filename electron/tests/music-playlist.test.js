'use strict';

/**
 * 音乐播放器纯逻辑测试。
 *
 * renderer/music-playlist.js 既被 index.html 用 <script> 加载（挂 window.MusicPlaylist），
 * 也能被 node --test 直接 require —— 这里守的就是「本地播放」里最容易写错的三件事：
 * 文件名拆标题、时间格式、上一首/下一首（含循环与随机）。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const music = require('../renderer/music-playlist');

test('parseTrackLabel：Artist - Title', () => {
  assert.deepEqual(music.parseTrackLabel('Daft Punk - Get Lucky.mp3'), {
    artist: 'Daft Punk',
    title: 'Get Lucky'
  });
});

test('parseTrackLabel：带曲目号的 "01 - Title" 不把数字当歌手', () => {
  assert.deepEqual(music.parseTrackLabel('01 - Opening Theme.flac'), {
    artist: '',
    title: 'Opening Theme'
  });
});

test('parseTrackLabel：标题里还有 " - " 时保留后半段', () => {
  assert.deepEqual(music.parseTrackLabel('Artist - Part 1 - Part 2.ogg'), {
    artist: 'Artist',
    title: 'Part 1 - Part 2'
  });
});

test('parseTrackLabel：没有 " - " 时整段当标题，AC-DC 不被拆开', () => {
  assert.deepEqual(music.parseTrackLabel('AC-DC Thunderstruck.mp3'), {
    artist: '',
    title: 'AC-DC Thunderstruck'
  });
});

test('parseTrackLabel：去路径、去扩展名；空名字有兜底', () => {
  assert.deepEqual(music.parseTrackLabel('C:\\Music\\A - B.wav'), { artist: 'A', title: 'B' });
  assert.deepEqual(music.parseTrackLabel('   '), { artist: '', title: '未知曲目' });
  assert.deepEqual(music.parseTrackLabel(''), { artist: '', title: '未知曲目' });
});

test('formatTime：分秒、补零、非法值', () => {
  assert.equal(music.formatTime(0), '0:00');
  assert.equal(music.formatTime(5), '0:05');
  assert.equal(music.formatTime(65), '1:05');
  assert.equal(music.formatTime(3599), '59:59');
  assert.equal(music.formatTime(12.9), '0:12');
  assert.equal(music.formatTime(NaN), '0:00');
  assert.equal(music.formatTime(-3), '0:00');
  assert.equal(music.formatTime(undefined), '0:00');
});

test('nextIndex：顺序播放，手动下一首到末尾会回到第一首', () => {
  assert.equal(music.nextIndex({ index: 0, length: 3, step: 1 }), 1);
  assert.equal(music.nextIndex({ index: 2, length: 3, step: 1 }), 0);
  assert.equal(music.nextIndex({ index: 0, length: 3, step: -1 }), 2);
  assert.equal(music.nextIndex({ index: 1, length: 3, step: -1 }), 0);
});

test('nextIndex：循环关闭时，播完最后一首自动停止（-1）', () => {
  assert.equal(music.nextIndex({ index: 1, length: 3, auto: true }), 2);
  assert.equal(music.nextIndex({ index: 2, length: 3, auto: true }), -1);
  assert.equal(music.nextIndex({ index: 0, length: 1, auto: true }), -1);
});

test('nextIndex：循环列表时，播完最后一首回到第一首', () => {
  assert.equal(music.nextIndex({ index: 2, length: 3, auto: true, repeat: 'all' }), 0);
});

test('nextIndex：单曲循环只在自动播完时原地重播，手动下一首仍换歌', () => {
  assert.equal(music.nextIndex({ index: 1, length: 3, auto: true, repeat: 'one' }), 1);
  assert.equal(music.nextIndex({ index: 1, length: 3, auto: false, repeat: 'one' }), 2);
});

test('nextIndex：随机播放不会选中当前这首', () => {
  assert.equal(music.nextIndex({ index: 0, length: 3, shuffle: true, random: () => 0.9 }), 2);
  // random 永远返回 0（一直等于 index）时要有兜底，不能死循环。
  assert.equal(music.nextIndex({ index: 0, length: 3, shuffle: true, random: () => 0 }), 1);
  assert.equal(music.nextIndex({ index: 2, length: 3, shuffle: true, random: () => 0.5 }), 1);
});

test('nextIndex：空列表 / 非法下标有兜底', () => {
  assert.equal(music.nextIndex({ index: 0, length: 0 }), -1);
  assert.equal(music.nextIndex({}), -1);
  assert.equal(music.nextIndex({ index: -5, length: 2, step: 1 }), 1);
});

test('progressRatio：0..1，非法值归 0', () => {
  assert.equal(music.progressRatio(0, 100), 0);
  assert.equal(music.progressRatio(50, 100), 0.5);
  assert.equal(music.progressRatio(100, 100), 1);
  assert.equal(music.progressRatio(120, 100), 1);
  assert.equal(music.progressRatio(-1, 100), 0);
  assert.equal(music.progressRatio(10, 0), 0);
  assert.equal(music.progressRatio(NaN, 100), 0);
});
