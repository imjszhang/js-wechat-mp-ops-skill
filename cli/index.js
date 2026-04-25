'use strict';

const { Session } = require('../lib/session');
const { COMMANDS, parseArgv, printHelp } = require('../lib/commands');
const { PAGE_PROFILES, DEFAULT_PAGE } = require('../lib/config');

function pickPage(commandName, opts) {
  if (opts.page) return opts.page;
  const def = COMMANDS[commandName];
  if (def && def.defaultPage) return def.defaultPage;
  if (def && def.pages && def.pages.length === 1) return def.pages[0];
  return DEFAULT_PAGE;
}

function printJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

async function runCallCommand(commandName, def, opts, positional) {
  const session = new Session({ opts: Object.assign({}, opts, { page: pickPage(commandName, opts) }) });
  try {
    await session.connect();
    await session.resolveTarget();
    await session.ensureBridge();
    const args = def.toArgs ? def.toArgs(opts, positional) : positional;
    const response = await session.callApi(def.api, args);
    printJson(response);
  } finally {
    await session.close();
  }
}

async function runDoctor(opts) {
  const pages = [opts.page].filter(Boolean);
  const targetPages = pages.length ? pages : Object.keys(PAGE_PROFILES);
  const results = [];
  for (const pageName of targetPages) {
    const section = { page: pageName };
    const pageOpts = Object.assign({}, opts, { page: pageName });
    const session = new Session({ opts: pageOpts });
    try {
      await session.connect();
      section.connected = true;
      try {
        await session.resolveTarget();
        section.target = session.target;
      } catch (err) {
        section.target = null;
        section.targetError = { code: err.code || null, message: err.message };
        results.push(section);
        continue;
      }
      try {
        const bridgeInfo = await session.ensureBridge();
        section.bridge = bridgeInfo;
      } catch (err) {
        section.bridgeError = { code: err.code || null, message: err.message };
        results.push(section);
        continue;
      }
      try {
        section.probe = await session.callApi('probe');
      } catch (err) {
        section.probeError = { message: err.message };
      }
      try {
        section.state = await session.callApi('state');
      } catch (err) {
        section.stateError = { message: err.message };
      }
      // v0.3 心跳：content-analysis 页面额外跑一次 contentSummary；
      // 失败只记录不中断，用于尽早发现后台改版。
      if (pageName === 'content-analysis') {
        try {
          section.summary = await session.callApi('contentSummary');
        } catch (err) {
          section.summaryError = { message: err.message };
        }
      }
    } catch (err) {
      section.connectError = { code: err.code || null, message: err.message };
    } finally {
      await session.close();
    }
    results.push(section);
  }

  const summary = results.map((r) => ({
    page: r.page,
    connected: !!r.connected,
    tab: r.target ? r.target.id : null,
    bridgeVersion: r.bridge ? r.bridge.version : null,
    loggedIn: r.state && r.state.data ? !!r.state.data.login?.loggedIn : null,
    error: r.connectError || r.targetError || r.bridgeError || null,
  }));
  printJson({ ok: results.every((r) => !r.connectError && !r.targetError && !r.bridgeError), summary, results });
}

async function runContentDetail(opts, positional) {
  const [msgid, publishDate] = positional;
  if (!msgid) {
    throw Object.assign(
      new Error('content-detail 用法: content-detail <msgid> [publishDate]'),
      { code: 'E_BAD_ARG' },
    );
  }
  const session = new Session({ opts: Object.assign({}, opts, { page: 'content-analysis' }) });
  try {
    await session.connect();
    await session.resolveTarget();
    await session.ensureBridge();
    const response = await session.callApi('contentDetail', [{ msgid, publishDate: publishDate || null }]);
    printJson(response);
  } finally {
    await session.close();
  }
}

/**
 * content-navigate：INTERACTIVE 档位，仅改 URL，不点击。
 * 调用 bridge 的 navigateContent 后 reload 触发 bridge 丢失；
 * 通过 session.awaitBridgeAfterNav 等重注 + 自校验后返回新 state。
 */
async function runContentNavigate(opts) {
  const navArgs = {
    action: opts.toAction || null,
    type: opts.toType || null,
    front_type: opts.toFrontType || null,
    msgid: opts.msgid || null,
    publishDate: opts.publishDate || null,
    clear: !!opts.clear,
  };
  const hasAny = Object.values(navArgs).some((v) => v != null && v !== false && v !== '');
  if (!hasAny) {
    throw Object.assign(
      new Error('content-navigate 至少要提供一个改参参数：--to-action/--to-type/--msgid/--publish-date/--clear'),
      { code: 'E_BAD_ARG' },
    );
  }
  const session = new Session({ opts: Object.assign({}, opts, { page: 'content-analysis' }) });
  try {
    await session.connect();
    await session.resolveTarget();
    await session.ensureBridge();
    const navResp = await session.callApi('navigateContent', [navArgs]);
    if (!navResp || !navResp.ok) {
      printJson({ nav: navResp, postState: null });
      return;
    }
    const noop = navResp.data && navResp.data.noop === true;
    const fromUrl = navResp.data && navResp.data.from && navResp.data.from.url;
    const expectedUrl = navResp.data && navResp.data.to && navResp.data.to.url;
    const postState = noop
      ? { ready: true, attempts: 0, currentUrl: fromUrl || null, state: null, skipped: 'noop' }
      : await session.awaitBridgeAfterNav({
          timeoutMs: 20000,
          intervalMs: 500,
          initialDelayMs: 400,
          fromUrl: fromUrl || null,
          expectedUrl: expectedUrl || null,
        });
    printJson({ nav: navResp, postState });
  } finally {
    await session.close();
  }
}

async function main(argv) {
  const { opts, positional } = parseArgv(argv);
  const command = positional.shift();

  if (!command || opts.help) {
    printHelp();
    return 0;
  }

  const def = COMMANDS[command];
  if (!def) {
    process.stderr.write(`未知命令: ${command}\n`);
    printHelp();
    return 2;
  }

  if (command === 'doctor') {
    await runDoctor(opts);
    return 0;
  }
  if (command === 'content-detail') {
    await runContentDetail(opts, positional);
    return 0;
  }
  if (command === 'content-navigate') {
    await runContentNavigate(opts);
    return 0;
  }
  if (def.kind === 'call') {
    await runCallCommand(command, def, opts, positional);
    return 0;
  }
  throw new Error(`command kind 不支持: ${def.kind}`);
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code || 0)).catch((err) => {
    process.stderr.write(`ERROR: ${err.message}\n`);
    if (process.env.JS_WECHAT_MP_DEBUG) process.stderr.write((err.stack || '') + '\n');
    process.exit(1);
  });
}

module.exports = { main };
