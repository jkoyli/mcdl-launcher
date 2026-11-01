'use strict';

/**
 * 账户：离线账号 + 微软账号（Minecraft Live OAuth 授权码流程）。
 *
 * 微软流程（与 HMCL 等启动器一致，client_id 是 Minecraft 的公开客户端 id）：
 *   1. 在应用内浏览器窗口打开 login.live.com 授权页
 *   2. 拦截跳回的 oauth20_desktop.srf，取出 code
 *   3. code → access_token / refresh_token
 *   4. access_token → Xbox Live → XSTS → Minecraft access_token
 *   5. profile → 真实 UUID / 玩家名
 *
 * 令牌只保存在本机 userData 目录，不会上传到任何地方。
 */

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const MSA_CLIENT_ID = process.env.MCDL_MSA_CLIENT_ID || '00000000402b5328';
const MSA_SCOPE = 'service::user.auth.xboxlive.com::MBI_SSL';
const MSA_REDIRECT_URI = 'https://login.live.com/oauth20_desktop.srf';
const MSA_AUTHORIZE_URL = 'https://login.live.com/oauth20_authorize.srf';
const MSA_TOKEN_URL = 'https://login.live.com/oauth20_token.srf';
const XBL_AUTH_URL = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS_AUTH_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize';
const MC_AUTH_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox';
const MC_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';

const TOKEN_MARGIN_MS = 5 * 60 * 1000;

function offlineUuid(name) {
  const hash = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join('-');
}

function formatUuid(raw) {
  const value = String(raw || '').replace(/-/g, '');
  if (value.length !== 32) return String(raw || '');
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    value.slice(12, 16),
    value.slice(16, 20),
    value.slice(20, 32)
  ].join('-');
}

async function httpJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(options.timeout || 20000)
  });

  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  if (!response.ok) {
    const detail = body && (body.error_description || body.errorMessage || body.error || body.XErr);
    const error = new Error(detail ? String(detail) : `${response.status} ${response.statusText}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body;
}

function postForm(url, data) {
  return httpJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(data).toString()
  });
}

function postJson(url, data) {
  return httpJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(data)
  });
}

function explainXstsError(error) {
  const body = error && error.body ? error.body : null;
  const xerr = body && body.XErr ? String(body.XErr) : '';

  if (xerr === '2148916233') return '这个微软账号还没有 Xbox 档案，请先在 Xbox 官网创建';
  if (xerr === '2148916235') return '这个微软账号所在地区不支持 Xbox Live';
  if (xerr === '2148916236' || xerr === '2148916237') return '这个微软账号需要先完成成人验证';
  if (xerr === '2148916238') return '这是未成年账号，需要家长先加入 Microsoft 家庭组';
  return error && error.message ? error.message : 'Xbox Live 验证失败';
}

/**
 * 打开应用内登录窗口，拿到授权码。
 * @returns {Promise<string>} authorization code
 */
function requestAuthorizationCode(parentWindow) {
  // 延迟 require，方便在没有 Electron 的环境里做单元测试。
  const { BrowserWindow } = require('electron');

  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      client_id: MSA_CLIENT_ID,
      response_type: 'code',
      scope: MSA_SCOPE,
      redirect_uri: MSA_REDIRECT_URI,
      prompt: 'select_account'
    });

    const authWindow = new BrowserWindow({
      width: 520,
      height: 720,
      parent: parentWindow && !parentWindow.isDestroyed() ? parentWindow : undefined,
      modal: Boolean(parentWindow),
      show: true,
      autoHideMenuBar: true,
      title: '登录微软账号',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition: 'persist:mcdl-msa'
      }
    });

    let settled = false;

    const finish = (error, code) => {
      if (settled) return;
      settled = true;
      try {
        if (!authWindow.isDestroyed()) authWindow.destroy();
      } catch {
        // 忽略关闭异常
      }
      if (error) reject(error);
      else resolve(code);
    };

    const inspect = (url) => {
      if (!url || !url.startsWith(MSA_REDIRECT_URI)) return false;

      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        return false;
      }

      const error = parsed.searchParams.get('error');
      const errorDescription = parsed.searchParams.get('error_description');
      const code = parsed.searchParams.get('code');

      if (error) {
        finish(new Error(errorDescription || `微软登录失败：${error}`));
        return true;
      }
      if (code) {
        finish(null, code);
        return true;
      }
      return false;
    };

    // 授权页会把结果 302 到 oauth20_desktop.srf，拦下这次跳转即可。
    authWindow.webContents.on('will-redirect', (event, url) => {
      if (inspect(url)) event.preventDefault();
    });

    authWindow.webContents.on('will-navigate', (event, url) => {
      if (inspect(url)) event.preventDefault();
    });

    authWindow.webContents.on('did-navigate', (_event, url) => {
      inspect(url);
    });

    authWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      if (errorCode === -3) return; // 被我们自己取消的导航
      if (validatedURL && validatedURL.startsWith(MSA_REDIRECT_URI)) return;
      finish(new Error(`登录页加载失败：${errorDescription || errorCode}`));
    });

    authWindow.on('closed', () => {
      if (!settled) finish(new Error('已取消登录'));
    });

    const url = `${MSA_AUTHORIZE_URL}?${params.toString()}`;
    authWindow.loadURL(url).catch((error) => {
      finish(new Error(`无法打开微软登录页：${error.message}`));
    });
  });
}

async function exchangeCodeForTokens(code) {
  return postForm(MSA_TOKEN_URL, {
    client_id: MSA_CLIENT_ID,
    code,
    grant_type: 'authorization_code',
    redirect_uri: MSA_REDIRECT_URI,
    scope: MSA_SCOPE
  });
}

async function refreshMicrosoftTokens(refreshToken) {
  return postForm(MSA_TOKEN_URL, {
    client_id: MSA_CLIENT_ID,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    redirect_uri: MSA_REDIRECT_URI,
    scope: MSA_SCOPE
  });
}

async function xboxLiveAuthenticate(msAccessToken) {
  return postJson(XBL_AUTH_URL, {
    Properties: {
      AuthMethod: 'RPS',
      SiteName: 'user.auth.xboxlive.com',
      RpsTicket: `d=${msAccessToken}`
    },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT'
  });
}

async function xstsAuthorize(xblToken) {
  return postJson(XSTS_AUTH_URL, {
    Properties: {
      SandboxId: 'RETAIL',
      UserTokens: [xblToken]
    },
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType: 'JWT'
  });
}

async function loginWithXbox(uhs, xstsToken) {
  return postJson(MC_AUTH_URL, {
    identityToken: `XBL3.0 x=${uhs};${xstsToken}`
  });
}

async function fetchMinecraftProfile(accessToken) {
  return httpJson(MC_PROFILE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json'
    }
  });
}

/** 一次完整的微软登录：code → Minecraft 令牌 + 档案。 */
async function completeMicrosoftLogin(code) {
  const tokens = await exchangeCodeForTokens(code);
  return finishMicrosoftSession(tokens);
}

async function finishMicrosoftSession(tokens) {
  const xbl = await xboxLiveAuthenticate(tokens.access_token);
  const xblToken = xbl && xbl.Token;
  const uhs = xbl && xbl.DisplayClaims && xbl.DisplayClaims.xui && xbl.DisplayClaims.xui[0]
    ? xbl.DisplayClaims.xui[0].uhs
    : null;
  if (!xblToken || !uhs) throw new Error('Xbox Live 没有返回令牌');

  let xsts;
  try {
    xsts = await xstsAuthorize(xblToken);
  } catch (error) {
    throw new Error(explainXstsError(error));
  }

  const xstsToken = xsts && xsts.Token;
  const xstsUhs = xsts && xsts.DisplayClaims && xsts.DisplayClaims.xui && xsts.DisplayClaims.xui[0]
    ? xsts.DisplayClaims.xui[0].uhs
    : uhs;
  if (!xstsToken) throw new Error('XSTS 没有返回令牌');

  const mc = await loginWithXbox(xstsUhs, xstsToken);
  if (!mc || !mc.access_token) throw new Error('Minecraft 没有返回访问令牌');

  let profile;
  try {
    profile = await fetchMinecraftProfile(mc.access_token);
  } catch (error) {
    if (error.status === 404) {
      throw new Error('这个微软账号没有拥有 Minecraft: Java Edition');
    }
    throw error;
  }

  if (!profile || !profile.id || !profile.name) {
    throw new Error('无法读取 Minecraft 档案');
  }

  const skin = pickProfileSkin(profile);

  return {
    name: profile.name,
    uuid: formatUuid(profile.id),
    accessToken: mc.access_token,
    refreshToken: tokens.refresh_token || null,
    expiresAt: Date.now() + Math.max(0, (Number(mc.expires_in) || 86400) * 1000),
    xuid: xstsUhs,
    clientId: MSA_CLIENT_ID,
    skinUrl: skin.url,
    skinModel: skin.model,
    skinFetchedAt: Date.now()
  };
}

/** 从 `/minecraft/profile` 的 skins 数组里取当前皮肤。 */
function pickProfileSkin(profile) {
  const skins = profile && Array.isArray(profile.skins) ? profile.skins : [];
  const active = skins.find((entry) => entry && entry.state === 'ACTIVE') || skins[0] || null;
  if (!active || !active.url) return { url: '', model: 'classic' };
  return {
    url: String(active.url),
    model: String(active.variant || '').toLowerCase() === 'slim' ? 'slim' : 'classic'
  };
}

/**
 * 只刷新微软账号的皮肤信息（用于老账号或手动刷新）。
 * 令牌失效时会先续期。
 */
async function refreshMicrosoftSkin(account) {
  if (!account || account.type !== 'microsoft') return null;
  const fresh = await ensureFreshToken(account);
  if (!fresh.accessToken) throw new Error('微软账号缺少访问令牌，请重新登录');
  const profile = await fetchMinecraftProfile(fresh.accessToken);
  const skin = pickProfileSkin(profile);
  return { skinUrl: skin.url, skinModel: skin.model, skinFetchedAt: Date.now(), accessToken: fresh.accessToken };
}

/**
 * 第三方服务器：从 session server 的 textures 属性里取皮肤地址。
 * 注意 uuid 要去掉横杠。
 */
async function fetchAuthlibSkin(apiRoot, uuid) {
  const root = normalizeApiRoot(apiRoot);
  const trimmed = String(uuid || '').replace(/-/g, '');
  if (!trimmed) return { url: '', model: 'classic' };

  const body = await httpJson(`${root}sessionserver/session/minecraft/profile/${trimmed}`, {
    headers: { Accept: 'application/json' },
    timeout: 15000
  });

  const properties = body && Array.isArray(body.properties) ? body.properties : [];
  const textures = properties.find((entry) => entry && entry.name === 'textures');
  if (!textures || !textures.value) return { url: '', model: 'classic' };

  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(String(textures.value), 'base64').toString('utf8'));
  } catch {
    return { url: '', model: 'classic' };
  }

  const skin = decoded && decoded.textures ? decoded.textures.SKIN : null;
  if (!skin || !skin.url) return { url: '', model: 'classic' };

  return {
    url: String(skin.url),
    model: skin.metadata && String(skin.metadata.model).toLowerCase() === 'slim' ? 'slim' : 'classic'
  };
}

/** 令牌过期前自动续期。 */
async function ensureFreshToken(account) {
  if (!account || account.type !== 'microsoft') return account;
  if (account.refreshToken && account.expiresAt && account.expiresAt - TOKEN_MARGIN_MS > Date.now()) {
    return account;
  }
  if (!account.refreshToken) return account;

  const tokens = await refreshMicrosoftTokens(account.refreshToken);
  const refreshed = await finishMicrosoftSession(tokens);
  return { ...account, ...refreshed };
}

// ---------------- authlib-injector 第三方认证服务器 ----------------

/** 统一 API 根地址：去掉首尾空白，补上结尾斜杠（后续都按 `${apiRoot}authserver/...` 拼）。 */
function normalizeApiRoot(raw) {
  const value = String(raw || '').trim();
  if (!value) throw new Error('请填写认证服务器地址');
  if (!/^https?:\/\//i.test(value)) throw new Error('认证服务器地址必须以 http:// 或 https:// 开头');
  return value.endsWith('/') ? value : `${value}/`;
}

/** 读取 Yggdrasil API 元数据，用来确认这个地址真的是 authlib-injector 服务器。 */
async function fetchAuthlibMeta(rawApiRoot) {
  const apiRoot = normalizeApiRoot(rawApiRoot);
  let body;
  try {
    body = await httpJson(apiRoot, { headers: { Accept: 'application/json' } });
  } catch (error) {
    throw new Error(`无法连接认证服务器：${error.message}`);
  }

  if (!body || typeof body !== 'object') {
    throw new Error('该地址没有返回 Yggdrasil API 信息，可能不是 authlib-injector 服务器');
  }
  if (!body.signaturePublickey && !body.meta) {
    throw new Error('该地址不是 authlib-injector 服务器（缺少 signaturePublickey / meta）');
  }

  const meta = body.meta && typeof body.meta === 'object' ? body.meta : {};
  let name = String(meta.serverName || '').trim();
  if (!name) {
    try {
      name = new URL(apiRoot).host;
    } catch {
      name = apiRoot;
    }
  }

  return {
    apiRoot,
    name,
    implementationName: String(meta.implementationName || 'authlib-injector'),
    implementationVersion: String(meta.implementationVersion || ''),
    serverName: name,
    skinDomains: Array.isArray(body.skinDomains) ? body.skinDomains.map(String) : []
  };
}

/** 用用户名 / 密码登录第三方认证服务器。 */
async function authlibAuthenticate(apiRoot, { username, password }) {
  const root = normalizeApiRoot(apiRoot);
  const name = String(username || '').trim();
  if (!name) throw new Error('请输入用户名');
  if (!password) throw new Error('请输入密码');

  let body;
  try {
    body = await postJson(`${root}authserver/authenticate`, {
      username: name,
      password: String(password),
      clientToken: crypto.randomUUID().replace(/-/g, ''),
      agent: { name: 'Minecraft', version: 1 },
      requestUser: false
    });
  } catch (error) {
    const message = String(error.message || '');
    if (/ForbiddenOperationException|Invalid credentials/i.test(message)) {
      throw new Error('用户名或密码错误');
    }
    throw new Error(`登录失败：${message}`);
  }

  if (!body || !body.accessToken) throw new Error('认证服务器没有返回 accessToken');

  const profile = body.selectedProfile || (Array.isArray(body.availableProfiles) ? body.availableProfiles[0] : null);
  if (!profile || !profile.id || !profile.name) {
    throw new Error('该账号还没有创建游戏角色，请先在服务器网站上创建角色');
  }

  return {
    accessToken: body.accessToken,
    clientToken: body.clientToken || null,
    uuid: formatUuid(profile.id),
    name: String(profile.name)
  };
}

/**
 * 账户存储：一个 JSON 文件 + 当前选中的账号 id。
 */
function createAccountStore(storeDir) {
  const file = path.join(storeDir, 'accounts.json');
  const skinsDir = path.join(storeDir, 'skins');
  let state = { accounts: [], selectedId: null, servers: [] };
  let loaded = false;

  async function load() {
    if (loaded) return state;
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      state = {
        accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
        selectedId: typeof parsed.selectedId === 'string' ? parsed.selectedId : null,
        servers: Array.isArray(parsed.servers) ? parsed.servers : []
      };
    } catch {
      state = { accounts: [], selectedId: null, servers: [] };
    }
    loaded = true;
    return state;
  }

  async function persist() {
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(state, null, 2), 'utf8');
    } catch (error) {
      // 常见原因：目录被禁用/只读、另一个启动器实例正占用同一份 profile、安全软件拦截。
      throw new Error(
        `无法写入账号文件（${error.code || 'ERROR'}）：${file}\n` +
        '请确认该目录可写，并关闭其他正在运行的启动器实例后重试'
      );
    }
  }

  /** 对外暴露时去掉令牌，避免渲染进程拿到敏感数据。 */
  function publicView(account, selectedId) {
    if (!account) return null;
    return {
      id: account.id,
      type: account.type,
      name: account.name,
      uuid: account.uuid,
      selected: account.id === selectedId,
      hasToken: account.type === 'microsoft'
        ? Boolean(account.accessToken)
        : account.type === 'authlib'
          ? Boolean(account.accessToken)
          : true,
      expiresAt: account.expiresAt || null,
      addedAt: account.addedAt || null,
      lastUsedAt: account.lastUsedAt || null,
      serverId: account.serverId || null,
      serverName: account.serverName || null,
      hasSkin: Boolean((account.skin && account.skin.file) || account.skinUrl),
      hasLocalSkin: Boolean(account.skin && account.skin.file),
      hasRemoteSkin: Boolean(account.skinUrl),
      skinModel: (account.skin && account.skin.model) || account.skinModel || 'classic',
      skinUrl: account.skinUrl || ''
    };
  }

  function skinFileName(accountId) {
    return String(accountId).replace(/[^A-Za-z0-9_-]/g, '_') + '.png';
  }

  function accountSnapshot() {
    return {
      accounts: state.accounts.map((account) => publicView(account, state.selectedId)),
      selectedId: state.selectedId,
      servers: state.servers.map((server) => ({ ...server }))
    };
  }

  return {
    async list() {
      const current = await load();
      return {
        accounts: current.accounts.map((account) => publicView(account, current.selectedId)),
        selectedId: current.selectedId,
        selected: current.accounts.find((account) => account.id === current.selectedId) || null,
        servers: current.servers.map((server) => ({ ...server }))
      };
    },

    async listServers() {
      const current = await load();
      return current.servers.map((server) => ({ ...server }));
    },

    /** 添加认证服务器：先验证地址，再落盘（同域名不重复添加）。 */
    async addServer(rawApiRoot) {
      const meta = await fetchAuthlibMeta(rawApiRoot);
      const current = await load();

      const existing = current.servers.find((server) => server.apiRoot === meta.apiRoot);
      if (existing) {
        existing.name = meta.name || existing.name;
        existing.updatedAt = new Date().toISOString();
        await persist();
        return { server: { ...existing }, servers: current.servers.map((item) => ({ ...item })) };
      }

      const server = {
        id: crypto.createHash('sha1').update(meta.apiRoot).digest('hex').slice(0, 12),
        apiRoot: meta.apiRoot,
        name: meta.name,
        implementationName: meta.implementationName,
        implementationVersion: meta.implementationVersion,
        addedAt: new Date().toISOString()
      };

      current.servers.push(server);
      await persist();
      return { server: { ...server }, servers: current.servers.map((item) => ({ ...item })) };
    },

    async removeServer(id) {
      const current = await load();
      current.servers = current.servers.filter((server) => server.id !== id);
      // 依赖该服务器的账户一并移除，避免留下无法验证的账号。
      current.accounts = current.accounts.filter((account) => account.serverId !== id);
      if (!current.accounts.some((account) => account.id === current.selectedId)) {
        current.selectedId = current.accounts.length > 0 ? current.accounts[0].id : null;
      }
      await persist();
      return accountSnapshot();
    },

    /** 第三方认证服务器登录：成功后写入并选中该账户。 */
    async addAuthlib({ serverId, username, password }) {
      const current = await load();
      const server = current.servers.find((item) => item.id === serverId);
      if (!server) throw new Error('请先选择认证服务器');

      const session = await authlibAuthenticate(server.apiRoot, { username, password });
      const id = `authlib:${server.id}:${String(session.uuid).toLowerCase()}`;

      const account = {
        id,
        type: 'authlib',
        name: session.name,
        uuid: session.uuid,
        accessToken: session.accessToken,
        clientToken: session.clientToken,
        serverId: server.id,
        serverName: server.name,
        serverApiRoot: server.apiRoot,
        addedAt: new Date().toISOString(),
        lastUsedAt: null
      };

      const index = current.accounts.findIndex((item) => item.id === id);
      if (index >= 0) {
        // 保留原有皮肤等本地数据。
        current.accounts[index] = { ...current.accounts[index], ...account };
      } else {
        current.accounts.push(account);
      }

      current.selectedId = id;
      await persist();
      return { account: publicView(current.accounts.find((item) => item.id === id), current.selectedId), ...accountSnapshot() };
    },

    /** 离线皮肤：把用户选的图片复制到数据目录，供 UI 预览（暂不注入游戏）。 */
    async setSkin(id, { sourcePath, model }) {
      const current = await load();
      const account = current.accounts.find((item) => item.id === id);
      if (!account) throw new Error('账户不存在');

      await fs.mkdir(skinsDir, { recursive: true });
      const file = skinFileName(account.id);
      await fs.copyFile(sourcePath, path.join(skinsDir, file));

      account.skin = {
        file,
        model: model === 'slim' ? 'slim' : 'classic',
        updatedAt: new Date().toISOString()
      };
      await persist();
      return publicView(account, current.selectedId);
    },

    async clearSkin(id) {
      const current = await load();
      const account = current.accounts.find((item) => item.id === id);
      if (!account) throw new Error('账户不存在');
      if (account.skin && account.skin.file) {
        await fs.rm(path.join(skinsDir, account.skin.file), { force: true }).catch(() => {});
      }
      delete account.skin;
      await persist();
      return publicView(account, current.selectedId);
    },

    /** 只改皮肤模型（经典 / 纤细），不动图片。 */
    async setSkinModel(id, model) {
      const current = await load();
      const account = current.accounts.find((item) => item.id === id);
      if (!account) throw new Error('账户不存在');
      if (account.skin) {
        account.skin.model = model === 'slim' ? 'slim' : 'classic';
      }
      account.skinModel = model === 'slim' ? 'slim' : 'classic';
      await persist();
      return publicView(account, current.selectedId);
    },

    /** 丢掉缓存的远程皮肤地址，下次读取时重新向服务器要。 */
    async clearRemoteSkin(id) {
      const current = await load();
      const account = current.accounts.find((item) => item.id === id);
      if (!account) throw new Error('账户不存在');
      delete account.skinUrl;
      delete account.skinFetchedAt;
      await persist();
      return publicView(account, current.selectedId);
    },

    /** 供主进程读取皮肤 PNG（预览 / 后续注入）。 */
    async getSkinPath(id) {
      const current = await load();
      const account = current.accounts.find((item) => item.id === id);
      if (!account || !account.skin || !account.skin.file) return null;
      const file = path.join(skinsDir, account.skin.file);
      try {
        await fs.access(file);
        return file;
      } catch {
        return null;
      }
    },

    async getSelected() {
      const current = await load();
      return current.accounts.find((account) => account.id === current.selectedId) || null;
    },

    async getById(id) {
      const current = await load();
      return current.accounts.find((account) => account.id === id) || null;
    },

    async addOffline(name) {
      const playerName = String(name || '').trim();
      if (!playerName) throw new Error('请输入玩家名');
      if (playerName.length > 16) throw new Error('玩家名不能超过 16 个字符');
      if (!/^[A-Za-z0-9_]+$/.test(playerName)) {
        throw new Error('玩家名只能使用英文字母、数字和下划线');
      }

      const current = await load();
      const id = `offline:${playerName.toLowerCase()}`;
      const existing = current.accounts.find((account) => account.id === id);
      if (existing) {
        current.selectedId = id;
        await persist();
        return publicView(existing, current.selectedId);
      }

      const account = {
        id,
        type: 'offline',
        name: playerName,
        uuid: offlineUuid(playerName),
        addedAt: new Date().toISOString(),
        lastUsedAt: null
      };

      current.accounts.push(account);
      current.selectedId = id;
      await persist();
      return publicView(account, current.selectedId);
    },

    async addMicrosoft(details) {
      const current = await load();
      const id = `msa:${details.uuid}`;
      const account = {
        id,
        type: 'microsoft',
        name: details.name,
        uuid: details.uuid,
        accessToken: details.accessToken,
        refreshToken: details.refreshToken,
        expiresAt: details.expiresAt,
        xuid: details.xuid,
        clientId: details.clientId,
        skinUrl: details.skinUrl || '',
        skinModel: details.skinModel || 'classic',
        skinFetchedAt: details.skinFetchedAt || 0,
        addedAt: new Date().toISOString(),
        lastUsedAt: null
      };

      const index = current.accounts.findIndex((item) => item.id === id);
      if (index >= 0) {
        // 重新登录时保留本地皮肤等既有数据。
        current.accounts[index] = { ...current.accounts[index], ...account };
      } else {
        current.accounts.push(account);
      }

      current.selectedId = id;
      await persist();
      return publicView(account, current.selectedId);
    },

    async save(account) {
      const current = await load();
      const index = current.accounts.findIndex((item) => item.id === account.id);
      if (index >= 0) {
        current.accounts[index] = { ...current.accounts[index], ...account };
        await persist();
      }
      return current.accounts[index] || account;
    },

    async remove(id) {
      const current = await load();
      const removed = current.accounts.find((account) => account.id === id);
      if (removed && removed.skin && removed.skin.file) {
        await fs.rm(path.join(skinsDir, removed.skin.file), { force: true }).catch(() => {});
      }
      current.accounts = current.accounts.filter((account) => account.id !== id);
      if (current.selectedId === id) {
        current.selectedId = current.accounts.length > 0 ? current.accounts[0].id : null;
      }
      await persist();
      return accountSnapshot();
    },

    async select(id) {
      const current = await load();
      const exists = current.accounts.some((account) => account.id === id);
      if (!exists) throw new Error('账号不存在');
      current.selectedId = id;
      await persist();
      return accountSnapshot();
    },

    async markUsed(id) {
      const current = await load();
      const account = current.accounts.find((item) => item.id === id);
      if (!account) return;
      account.lastUsedAt = new Date().toISOString();
      await persist();
    }
  };
}

module.exports = {
  createAccountStore,
  requestAuthorizationCode,
  completeMicrosoftLogin,
  ensureFreshToken,
  refreshMicrosoftSkin,
  fetchAuthlibSkin,
  offlineUuid,
  formatUuid,
  normalizeApiRoot,
  fetchAuthlibMeta,
  authlibAuthenticate,
  MSA_CLIENT_ID
};
