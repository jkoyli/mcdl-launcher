'use strict';

/**
 * version-manifest 测试：版本 JSON 的解析、rules 求值与库路径推导。
 *
 * 这一段是"启动参数从哪来"的源头，出错的后果是启动失败或加载到错误的库，
 * 所以重点覆盖：maven 坐标、rules 求值、inheritsFrom 合并、natives 识别，
 * 以及"版本 JSON 里带 .. 的库路径不能穿出 libraries"这条安全边界。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const vm = require('../version-manifest');

const OTHER_OS = vm.OS_NAME === 'windows' ? 'osx' : 'windows';

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcdl-version-manifest-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------- maven 坐标 ----------------

test('mavenToPath：group 的点转成目录，产物名带版本', () => {
  assert.equal(
    vm.mavenToPath('com.mojang:authlib:3.11.49'),
    'com/mojang/authlib/3.11.49/authlib-3.11.49.jar'
  );
  assert.equal(
    vm.mavenToPath('net.fabricmc:fabric-loader:0.15.11'),
    'net/fabricmc/fabric-loader/0.15.11/fabric-loader-0.15.11.jar'
  );
});

test('mavenToPath：classifier 拼在版本后面，@ext 覆盖默认扩展名', () => {
  assert.equal(
    vm.mavenToPath('org.lwjgl:lwjgl:3.3.1:natives-windows'),
    'org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-windows.jar'
  );
  assert.equal(
    vm.mavenToPath('org.lwjgl:lwjgl:2.9.4:natives-windows@zip'),
    'org/lwjgl/lwjgl/2.9.4/lwjgl-2.9.4-natives-windows.zip'
  );
});

test('mavenToPath：坐标不完整时返回 null 而不是抛错', () => {
  assert.equal(vm.mavenToPath('com.mojang:authlib'), null);
  assert.equal(vm.mavenToPath('bad'), null);
  assert.equal(vm.mavenToPath(''), null);
  assert.equal(vm.mavenToPath(undefined), null);
});

test('libraryArtifactPath：优先用 downloads.artifact.path，缺失时回退 maven 推导', () => {
  assert.equal(
    vm.libraryArtifactPath({ name: 'a:b:1', downloads: { artifact: { path: 'a/b/1/b-1.jar' } } }),
    'a/b/1/b-1.jar'
  );
  assert.equal(vm.libraryArtifactPath({ name: 'a:b:1' }), 'a/b/1/b-1.jar');
  assert.equal(vm.libraryArtifactPath(null), null);
});

// ---------------- rules 求值 ----------------

test('rulesAllow：没有 rules 视为允许', () => {
  assert.equal(vm.rulesAllow(undefined), true);
  assert.equal(vm.rulesAllow([]), true);
  assert.equal(vm.rulesAllow(null), true);
});

test('rulesAllow：最后一条匹配的规则决定结果', () => {
  assert.equal(vm.rulesAllow([{ action: 'allow' }, { action: 'disallow' }]), false);
  assert.equal(vm.rulesAllow([{ action: 'disallow' }, { action: 'allow' }]), true);
});

test('rulesAllow：只写了 disallow 且当前平台不匹配时按"无匹配即拒绝"处理', () => {
  // 这是本模块的既定语义（与官方启动器一致），用测试固定下来避免以后被"优化"掉
  assert.equal(vm.rulesAllow([{ action: 'disallow', os: { name: OTHER_OS } }], {}), false);
});

test('rulesAllow：按操作系统过滤', () => {
  assert.equal(vm.rulesAllow([{ action: 'allow', os: { name: vm.OS_NAME } }]), true);
  assert.equal(vm.rulesAllow([{ action: 'allow', os: { name: OTHER_OS } }]), false);
  assert.equal(
    vm.rulesAllow([{ action: 'allow' }, { action: 'disallow', os: { name: vm.OS_NAME } }]),
    false
  );
});

test('rulesAllow：按 features 过滤（demo / 自定义分辨率）', () => {
  const rules = [{ action: 'allow', features: { is_demo_user: true } }];
  assert.equal(vm.rulesAllow(rules, {}), false);
  assert.equal(vm.rulesAllow(rules, { is_demo_user: true }), true);

  const withDisallow = [
    { action: 'allow' },
    { action: 'disallow', features: { has_custom_resolution: true } }
  ];
  assert.equal(vm.rulesAllow(withDisallow, {}), true);
  assert.equal(vm.rulesAllow(withDisallow, { has_custom_resolution: true }), false);
});

test('rulesAllow：忽略形状不对的规则条目', () => {
  assert.equal(vm.rulesAllow([null, {}, { action: 42 }]), false);
  assert.equal(vm.rulesAllow([null, { action: 'allow' }]), true);
});

// ---------------- natives ----------------

test('nativeClassifier：把 ${arch} 换成位数，缺平台字段时为 null', () => {
  const base = { name: 'org.lwjgl:lwjgl:2.9.4' };
  const withNatives = { ...base, natives: { windows: 'natives-windows-${arch}' } };

  if (vm.OS_NAME === 'windows') {
    assert.equal(vm.nativeClassifier(withNatives), `natives-windows-${vm.ARCH_BITS}`);
  }
  assert.equal(vm.nativeClassifier(base), null);
  assert.equal(vm.nativeClassifier({ ...base, natives: {} }), null);
  assert.equal(vm.nativeClassifier(null), null);
});

test('nativeArtifactPath：旧版 natives 优先取 downloads.classifiers', () => {
  const library = {
    name: 'org.lwjgl:lwjgl:2.9.4',
    natives: { windows: 'natives-windows' },
    downloads: {
      classifiers: {
        'natives-windows': { path: 'org/lwjgl/lwjgl/2.9.4/lwjgl-2.9.4-natives-windows.jar' }
      }
    }
  };

  if (vm.OS_NAME !== 'windows') {
    assert.equal(vm.nativeArtifactPath(library), null);
    return;
  }

  assert.equal(
    vm.nativeArtifactPath(library),
    'org/lwjgl/lwjgl/2.9.4/lwjgl-2.9.4-natives-windows.jar'
  );
  // 没有 downloads.classifiers 时用 maven 推导
  assert.equal(
    vm.nativeArtifactPath({ name: 'org.lwjgl:lwjgl:2.9.4', natives: { windows: 'natives-windows' } }),
    'org/lwjgl/lwjgl/2.9.4/lwjgl-2.9.4-natives-windows.jar'
  );
});

test('nativeArtifactPath：没有 natives 字段的普通库返回 null', () => {
  assert.equal(vm.nativeArtifactPath({ name: 'com.mojang:authlib:3.11.49' }), null);
  assert.equal(vm.nativeArtifactPath(null), null);
});

test('isModernNativeLibrary：识别 1.19+ 独立 natives 库并按架构过滤', () => {
  const platformToken = vm.OS_NAME === 'osx' ? 'macos' : vm.OS_NAME;
  const lib = (classifier) => ({ name: `org.lwjgl:lwjgl:3.3.1:${classifier}` });

  assert.equal(vm.isModernNativeLibrary(lib(`natives-${platformToken}`)), true);

  // 少于四段（没有 classifier）不算现代 natives
  assert.equal(vm.isModernNativeLibrary({ name: 'org.lwjgl:lwjgl:3.3.1' }), false);
  assert.equal(vm.isModernNativeLibrary({ name: '' }), false);
  assert.equal(vm.isModernNativeLibrary(null), false);
  assert.equal(vm.isModernNativeLibrary(lib('natives-other-platform')), false);

  if (vm.OS_ARCH === 'arm64') {
    assert.equal(vm.isModernNativeLibrary(lib(`natives-${platformToken}-arm64`)), true);
    assert.equal(vm.isModernNativeLibrary(lib(`natives-${platformToken}-x86_64`)), false);
  } else if (vm.OS_ARCH === 'x86') {
    assert.equal(vm.isModernNativeLibrary(lib(`natives-${platformToken}-x86`)), true);
    assert.equal(vm.isModernNativeLibrary(lib(`natives-${platformToken}-x86_64`)), false);
  } else {
    assert.equal(vm.isModernNativeLibrary(lib(`natives-${platformToken}-x86_64`)), true);
    assert.equal(vm.isModernNativeLibrary(lib(`natives-${platformToken}-arm64`)), false);
  }
});

// ---------------- inheritsFrom 合并 ----------------

test('mergeChain：子版本覆盖 mainClass / id，父版本提供 assets 与非 arguments 字段', () => {
  const parent = {
    id: '1.20.1',
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assets: '5',
    assetIndex: { id: '5', sha1: 'abc' },
    javaVersion: { majorVersion: 17 },
    minimumLauncherVersion: 18,
    minecraftArguments: '--username ${auth_player_name} --gameDir ${game_directory}',
    libraries: [{ name: 'com.mojang:authlib:3.11.49' }]
  };
  const child = {
    id: 'fabric-loader-0.15.11-1.20.1',
    inheritsFrom: '1.20.1',
    mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
    libraries: [{ name: 'net.fabricmc:fabric-loader:0.15.11' }]
  };

  const merged = vm.mergeChain([
    { id: '1.20.1', manifest: parent },
    { id: child.id, manifest: child }
  ]);

  assert.equal(merged.id, child.id);
  assert.equal(merged.type, 'release');
  assert.equal(merged.mainClass, 'net.fabricmc.loader.impl.launch.knot.KnotClient');
  assert.equal(merged.assets, '5');
  assert.equal(merged.assetIndex.id, '5');
  assert.equal(merged.javaVersion.majorVersion, 17);
  assert.equal(merged.minimumLauncherVersion, 18);
  assert.deepEqual(merged.libraries.map((library) => library.name), [
    'com.mojang:authlib:3.11.49',
    'net.fabricmc:fabric-loader:0.15.11'
  ]);
});

test('mergeChain：同名库由子版本覆盖，且保持原有顺序', () => {
  const parent = {
    id: '1.20.1',
    libraries: [
      { name: 'a:a:1', origin: 'parent' },
      { name: 'b:b:1', origin: 'parent' }
    ]
  };
  const child = {
    id: 'child',
    libraries: [
      { name: 'a:a:1', origin: 'child' },
      { name: 'c:c:1', origin: 'child' }
    ]
  };

  const merged = vm.mergeChain([
    { id: '1.20.1', manifest: parent },
    { id: 'child', manifest: child }
  ]);

  assert.deepEqual(merged.libraries.map((library) => library.name), ['a:a:1', 'b:b:1', 'c:c:1']);
  assert.equal(merged.libraries[0].origin, 'child');
});

test('mergeChain：子版本有 arguments 对象时清掉父版本的 minecraftArguments', () => {
  const parent = { id: '1.12.2', minecraftArguments: '--username ${auth_player_name}' };
  const child = {
    id: 'child',
    arguments: { jvm: ['-Dfoo=bar'], game: ['--demo'] }
  };

  const merged = vm.mergeChain([
    { id: '1.12.2', manifest: parent },
    { id: 'child', manifest: child }
  ]);

  assert.equal(merged.minecraftArguments, null);
  assert.deepEqual(merged.arguments.jvm, ['-Dfoo=bar']);
  assert.deepEqual(merged.arguments.game, ['--demo']);
});

test('mergeChain：只有 1.12 式 minecraftArguments 时保留字符串', () => {
  const merged = vm.mergeChain([
    { id: '1.12.2', manifest: { id: '1.12.2', minecraftArguments: '--username ${auth_player_name}' } }
  ]);

  assert.equal(merged.minecraftArguments, '--username ${auth_player_name}');
  assert.deepEqual(merged.arguments.jvm, []);
});

test('mergeChain：空链不崩溃，给出可判定的空壳', () => {
  const merged = vm.mergeChain([]);
  assert.equal(merged.id, null);
  assert.equal(merged.mainClass, '');
  assert.deepEqual(merged.libraries, []);
  assert.equal(merged.minecraftArguments, null);
});

// ---------------- 库收集（含路径穿越防护） ----------------

test('collectLibraries：正常库与旧版 natives 分别进入 classpath / natives', () => {
  const gameDir = path.join(os.tmpdir(), 'mcdl-game');
  const merged = {
    libraries: [
      {
        name: 'com.mojang:authlib:3.11.49',
        downloads: { artifact: { path: 'com/mojang/authlib/3.11.49/authlib-3.11.49.jar' } }
      },
      {
        name: 'org.lwjgl:lwjgl:2.9.4',
        natives: { windows: 'natives-windows' },
        downloads: {
          artifact: { path: 'org/lwjgl/lwjgl/2.9.4/lwjgl-2.9.4.jar' },
          classifiers: {
            'natives-windows': { path: 'org/lwjgl/lwjgl/2.9.4/lwjgl-2.9.4-natives-windows.jar' }
          }
        }
      }
    ]
  };

  const result = vm.collectLibraries(merged, gameDir, {});
  const librariesDir = path.join(gameDir, 'libraries');

  assert.ok(result.classpath.includes(path.join(librariesDir, 'com/mojang/authlib/3.11.49/authlib-3.11.49.jar')));
  assert.ok(result.classpath.includes(path.join(librariesDir, 'org/lwjgl/lwjgl/2.9.4/lwjgl-2.9.4.jar')));

  if (vm.OS_NAME === 'windows') {
    assert.equal(result.natives.length, 1);
    assert.equal(
      result.natives[0].path,
      path.join(librariesDir, 'org/lwjgl/lwjgl/2.9.4/lwjgl-2.9.4-natives-windows.jar')
    );
  }
});

test('collectLibraries：artifact.path 带 .. 时被跳过，不能穿出 libraries', () => {
  const gameDir = path.join(os.tmpdir(), 'mcdl-game');
  const merged = {
    libraries: [
      { name: 'evil:evil:1.0', downloads: { artifact: { path: '..\\..\\evil.jar' } } },
      { name: 'evil2:evil2:1.0', downloads: { artifact: { path: '../../evil2.jar' } } }
    ]
  };

  const result = vm.collectLibraries(merged, gameDir, {});
  assert.deepEqual(result.classpath, []);
  assert.ok(result.skipped.includes('evil:evil:1.0'));
  assert.ok(result.skipped.includes('evil2:evil2:1.0'));
});

test('collectLibraries：被 rules 拒绝的库不进入 classpath', () => {
  const gameDir = path.join(os.tmpdir(), 'mcdl-game');
  const merged = {
    libraries: [
      {
        name: 'only-other-os:lib:1',
        rules: [{ action: 'allow', os: { name: OTHER_OS } }],
        downloads: { artifact: { path: 'only/other/lib.jar' } }
      }
    ]
  };

  const result = vm.collectLibraries(merged, gameDir, {});
  assert.deepEqual(result.classpath, []);
  assert.deepEqual(result.skipped, []);
});

// ---------------- 文件系统相关的读取 ----------------

test('readJson：能读掉 UTF-8 BOM', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'bom.json');
  await fs.writeFile(file, '\uFEFF{"id":"1.20.1"}', 'utf8');

  const parsed = await vm.readJson(file);
  assert.equal(parsed.id, '1.20.1');
});

test('loadVersionChain：沿 inheritsFrom 读取，父在前、子在后', async (t) => {
  const gameDir = await tempDir(t);
  const writeVersion = async (id, json) => {
    const dir = path.join(gameDir, 'versions', id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(json), 'utf8');
  };

  await writeVersion('1.20.1', { id: '1.20.1', mainClass: 'net.minecraft.client.main.Main' });
  await writeVersion('fabric-loader-0.15.11-1.20.1', {
    id: 'fabric-loader-0.15.11-1.20.1',
    inheritsFrom: '1.20.1',
    mainClass: 'net.fabricmc.KnotClient'
  });

  const chain = await vm.loadVersionChain(gameDir, 'fabric-loader-0.15.11-1.20.1');
  assert.deepEqual(chain.map((item) => item.id), ['1.20.1', 'fabric-loader-0.15.11-1.20.1']);

  const merged = vm.mergeChain(chain);
  assert.equal(merged.mainClass, 'net.fabricmc.KnotClient');

  // 不存在的版本返回空链，不抛错
  assert.deepEqual(await vm.loadVersionChain(gameDir, 'nope'), []);
});

test('resolveClientJar：优先子版本自己的 jar，缺失时标记 missing', async (t) => {
  const gameDir = await tempDir(t);
  const versionDir = path.join(gameDir, 'versions', '1.20.1');
  await fs.mkdir(versionDir, { recursive: true });
  const jar = path.join(versionDir, '1.20.1.jar');
  await fs.writeFile(jar, 'jar');

  const found = await vm.resolveClientJar(
    gameDir,
    [{ id: '1.20.1' }],
    { id: 'fabric-loader-0.15.11-1.20.1' }
  );
  assert.equal(found.id, '1.20.1');
  assert.equal(found.path, jar);
  assert.equal(found.missing, undefined);

  const missing = await vm.resolveClientJar(
    gameDir,
    [{ id: '1.21.4' }],
    { id: 'fabric-loader-0.15.11-1.21.4' }
  );
  assert.equal(missing.missing, true);
  assert.equal(missing.id, '1.21.4');
});
