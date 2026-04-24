'use strict';

const fs = require('fs');
const path = require('path');
const { BrowserAutomation } = require('./js-eyes-client');
const { getPageProfile, DEFAULT_WS_ENDPOINT } = require('./config');

const COMMON_BRIDGE_PATH = path.join(__dirname, '..', 'bridges', 'common.js');

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function expandBridgeSource(src) {
  // Inline `// @@include ./common.js` directive so every bridge shares helpers
  // without runtime module resolution (evaluated in the browser context).
  return src.replace(/^\s*\/\/\s*@@include\s+\.\/common\.js\s*$/m, () => {
    return fs.readFileSync(COMMON_BRIDGE_PATH, 'utf8');
  });
}

/**
 * Session
 *
 * 一个 Session 绑定一个 page profile + 一个 tab + 一个 bridge.
 * 调用顺序约定：
 *   1) new Session({ opts })
 *   2) await session.connect()
 *   3) await session.resolveTarget()
 *   4) await session.ensureBridge()
 *   5) await session.callApi('probe') / callApi('state') / ...
 *   6) await session.close()
 */
class Session {
  constructor({ opts = {} } = {}) {
    this.opts = opts;
    this.pageProfile = getPageProfile(opts.page);
    this.bot = null;
    this.target = null;
    this._bridgeSrcCache = null;
    this._bridgeVersionCache = null;
  }

  log(msg) {
    if (this.opts.verbose) process.stderr.write(`[mp-ops] ${msg}\n`);
  }

  async connect() {
    const wsEndpoint = this.opts.wsEndpoint || DEFAULT_WS_ENDPOINT;
    const logger = this.opts.verbose
      ? console
      : { info: () => {}, warn: (...a) => console.error(...a), error: (...a) => console.error(...a) };
    this.bot = new BrowserAutomation(wsEndpoint, { logger });
    try {
      await this.bot.connect();
    } catch (err) {
      throw Object.assign(
        new Error(
          `无法连接到 js-eyes server（${wsEndpoint}）。确认 server 已启动（js-eyes server status）。原始错误: ${err.message}`,
        ),
        { code: 'E_SERVER_CONNECT' },
      );
    }
    this.log(`connected to ${wsEndpoint}`);
  }

  async listTabs() {
    const data = await this.bot.getTabs();
    return Array.isArray(data) ? data : (data && data.tabs) || [];
  }

  async resolveTarget() {
    const explicit = this.opts.tab;
    if (explicit != null) {
      const rawId = parseInt(explicit, 10);
      if (!Number.isFinite(rawId)) {
        throw Object.assign(new Error(`--tab 值非法: ${explicit}`), { code: 'E_BAD_ARG' });
      }
      this.target = { id: String(rawId), rawId, url: '(explicit)' };
      this.log(`target: ${this.target.id} (explicit)`);
      return this.target;
    }

    const tabs = await this.listTabs();
    const fragment = this.pageProfile.targetUrlFragment;
    const hit = tabs.find((tab) => (tab.url || '').includes(fragment));
    if (!hit) {
      const listing = tabs.map((tab) => `  [${tab.id}] ${tab.url || ''}`).join('\n');
      throw Object.assign(
        new Error(
          `未找到包含 ${fragment} 的 tab。请在浏览器里打开 ${this.pageProfile.routeLabel}（${this.pageProfile.description}），并确保已登录公众号后台。当前 tabs:\n${listing || '  (empty)'}`,
        ),
        { code: 'E_NO_TAB' },
      );
    }
    this.target = { id: String(hit.id), rawId: parseInt(hit.id, 10), url: hit.url };
    this.log(`target: ${this.target.id} (${this.target.url})`);
    return this.target;
  }

  _readBridgeSrc() {
    if (this._bridgeSrcCache == null) {
      const raw = fs.readFileSync(this.pageProfile.bridgePath, 'utf8');
      const m = raw.match(/const\s+VERSION\s*=\s*['"]([\w.\-+]+)['"]/);
      if (!m) {
        throw Object.assign(
          new Error(`${this.pageProfile.bridgePath} 里没找到 VERSION 常量`),
          { code: 'E_BRIDGE_CORRUPT' },
        );
      }
      this._bridgeVersionCache = m[1];
      this._bridgeSrcCache = expandBridgeSource(raw);
    }
    return { src: this._bridgeSrcCache, version: this._bridgeVersionCache };
  }

  async callRaw(expression, options = {}) {
    if (!this.target) throw Object.assign(new Error('尚未 resolveTarget'), { code: 'E_NO_TAB' });
    const timeoutSec = Math.max(1, Math.ceil((options.timeoutMs || 30000) / 1000));
    const result = await this.bot.executeScript(this.target.rawId, expression, { timeout: timeoutSec });
    return parseMaybeJson(result);
  }

  async ensureBridge() {
    const { src, version } = this._readBridgeSrc();
    const cur = await this.callRaw(
      `(window.${this.pageProfile.bridgeGlobal}?.__meta?.version) || null`,
    );
    if (cur === version) {
      this.log(`bridge up-to-date (${version})`);
      return { version, reinstalled: false };
    }
    this.log(`bridge ${cur ? `stale ${cur}` : 'missing'}, installing ${version}...`);
    const installResult = await this.callRaw(src, { timeoutMs: 30000 });
    if (!installResult || installResult.ok !== true) {
      throw Object.assign(
        new Error(`bridge 注入失败: ${JSON.stringify(installResult)}`),
        { code: 'E_BRIDGE_INSTALL' },
      );
    }
    this.log(`bridge installed: version=${installResult.version}`);
    return { version, reinstalled: true };
  }

  /**
   * 调用 bridge 上的 method(...args)，返回结构化 { ok, data } 或直接 data。
   * 约定 bridge 方法都返回 { ok: true, data } 或 { ok: false, error }。
   */
  async callApi(method, args = [], options = {}) {
    const payload = JSON.stringify(args);
    const global = this.pageProfile.bridgeGlobal;
    const code = `Promise.resolve(
      (typeof window.${global} === 'undefined')
        ? { ok: false, error: 'bridge_not_installed' }
        : (typeof window.${global}.${method} !== 'function')
          ? { ok: false, error: 'method_not_found', method: ${JSON.stringify(method)} }
          : window.${global}.${method}(...${payload})
    ).then(r => JSON.stringify(r)).catch(e => JSON.stringify({ ok:false, error: String(e && e.message || e), stack: e && e.stack || null }))`;
    return await this.callRaw(code, options);
  }

  async close() {
    try { if (this.bot) this.bot.disconnect(); } catch (_) { /* best-effort */ }
    this.bot = null;
    this.target = null;
  }
}

module.exports = { Session };
