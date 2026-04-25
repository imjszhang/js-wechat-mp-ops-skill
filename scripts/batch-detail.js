#!/usr/bin/env node
'use strict';

// scripts/batch-detail.js
// ---------------------------------------------------------------------------
// 通用业务工具：批量拉单篇图文详情 + trend + sources，按文章一份 JSON 落盘。
//
// 不与具体账号耦合：targets 既可来自 --list <jsonfile>，也可在不传时直接
// 调 contentListAll 拿当前页可见的全部图文。所有 msgid / publishDate 由调用方
// 或 list 接口提供，本脚本不做任何业务专属判断。
//
// 用法：
//   node scripts/batch-detail.js [--list path/to/list.json] [--out dir]
//                                [--include detail,trend,sources]
//                                [--range 30d]
//                                [--limit N]
//
// list.json 形态（--list 模式）：
//   [
//     { "msgid": "2247484081_1", "publishDate": "2026-04-14",
//       "tag": "boom-1", "title": "可选标题，仅用于日志/索引" },
//     ...
//   ]
//
// 默认行为（不传 --list）：
//   先连 content-analysis tab，跑一次 contentListAll，把每条 (msgid,
//   publishDate, title) 当 target；tag 自动按下标 0001/0002... 命名。
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { Session } = require('../lib/session');

const INCLUDE_KEYS = new Set(['detail', 'trend', 'sources']);

function parseArgs(argv) {
  const opts = {
    list: null,
    out: './_data/details',
    include: 'detail,trend,sources',
    range: '30d',
    limit: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--list') opts.list = argv[++i];
    else if (a.startsWith('--list=')) opts.list = a.slice('--list='.length);
    else if (a === '--out') opts.out = argv[++i];
    else if (a.startsWith('--out=')) opts.out = a.slice('--out='.length);
    else if (a === '--include') opts.include = argv[++i];
    else if (a.startsWith('--include=')) opts.include = a.slice('--include='.length);
    else if (a === '--range') opts.range = argv[++i];
    else if (a.startsWith('--range=')) opts.range = a.slice('--range='.length);
    else if (a === '--limit') opts.limit = Number(argv[++i]);
    else if (a.startsWith('--limit=')) opts.limit = Number(a.slice('--limit='.length));
    else throw Object.assign(new Error(`unknown arg: ${a}`), { code: 'E_BAD_ARG' });
  }
  return opts;
}

function printHelp() {
  process.stdout.write([
    'batch-detail - 批量拉单篇图文详情（content-analysis）',
    '',
    'Usage:',
    '  node scripts/batch-detail.js [options]',
    '',
    'Options:',
    '  --list <jsonfile>  目标列表 JSON：[{msgid, publishDate, tag?, title?}, ...]',
    '                     不传则连接浏览器跑 contentListAll 自动拿全部',
    '  --out <dir>        输出目录（默认 ./_data/details）',
    '  --include <list>   逗号分隔，子集 of: detail,trend,sources（默认全部）',
    '  --range <r>        透传给 trend / sources（默认 30d）',
    '  --limit <n>        --list 模式下截断 targets；默认走 contentListAll 全量',
    '  -h, --help',
    '',
    '前置：浏览器已登录公众号后台并打开 /misc/appmsganalysis 任意子 tab',
    '',
  ].join('\n'));
}

function loadListFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) throw new Error(`--list 文件必须是 JSON 数组：${file}`);
  return arr.map((it, idx) => ({
    msgid: it.msgid,
    publishDate: it.publishDate || it.publish_date || null,
    tag: it.tag || String(idx + 1).padStart(4, '0'),
    title: it.title || null,
  })).filter((t) => t.msgid);
}

function newSession() {
  return new Session({ opts: { page: 'content-analysis' } });
}

async function withSession(fn) {
  const session = newSession();
  await session.connect();
  await session.resolveTarget();
  await session.ensureBridge();
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}

async function targetsFromContentList(limit) {
  return withSession(async (session) => {
    const resp = await session.callApi('contentListAll', [{}]);
    if (!resp || !resp.ok) {
      throw new Error(`contentListAll 失败: ${JSON.stringify(resp)}`);
    }
    const items = (resp.data && resp.data.items) || [];
    const sliced = limit ? items.slice(0, limit) : items;
    return sliced.map((it, idx) => ({
      msgid: it.msgid,
      publishDate: it.publishDate || null,
      tag: String(idx + 1).padStart(4, '0'),
      title: it.title || null,
    })).filter((t) => t.msgid);
  });
}

async function navigateTo(t) {
  return withSession(async (session) => {
    const navResp = await session.callApi('navigateContent', [{
      action: 'detailpage',
      type: null,
      front_type: null,
      msgid: t.msgid,
      publishDate: t.publishDate,
    }]);
    if (!navResp || !navResp.ok) return { nav: navResp, postState: null };
    const noop = navResp.data && navResp.data.noop === true;
    const fromUrl = navResp.data?.from?.url;
    const expectedUrl = navResp.data?.to?.url;
    const postState = noop
      ? { ready: true, attempts: 0, currentUrl: fromUrl, state: null, skipped: 'noop' }
      : await session.awaitBridgeAfterNav({
          timeoutMs: 25000,
          intervalMs: 600,
          initialDelayMs: 600,
          fromUrl: fromUrl || null,
          expectedUrl: expectedUrl || null,
        });
    return { nav: navResp, postState };
  });
}

async function fetchDetail(t) {
  return withSession((session) =>
    session.callApi('contentDetail', [{ msgid: t.msgid, publishDate: t.publishDate }])
  );
}

async function fetchTrend(t, range) {
  return withSession((session) =>
    session.callApi('contentTrend', [{
      range,
      msgid: t.msgid,
      publishDate: t.publishDate,
    }])
  );
}

async function fetchSources(t, range) {
  return withSession((session) =>
    session.callApi('contentChannelBreakdown', [{
      range,
      msgid: t.msgid,
      publishDate: t.publishDate,
    }])
  );
}

(async () => {
  const argv = process.argv.slice(2);
  let opts;
  try { opts = parseArgs(argv); }
  catch (e) { process.stderr.write(`ERROR: ${e.message}\n`); process.exit(2); }
  if (opts.help) { printHelp(); process.exit(0); }

  const includes = new Set(opts.include.split(',').map((s) => s.trim()).filter(Boolean));
  for (const k of includes) {
    if (!INCLUDE_KEYS.has(k)) {
      process.stderr.write(`ERROR: --include 项不识别: ${k}（只支持 detail|trend|sources）\n`);
      process.exit(2);
    }
  }

  const outDir = path.resolve(opts.out);
  fs.mkdirSync(outDir, { recursive: true });

  let targets;
  if (opts.list) {
    targets = loadListFile(path.resolve(opts.list));
    process.stderr.write(`loaded ${targets.length} target(s) from --list\n`);
  } else {
    process.stderr.write(`no --list, fetching contentListAll from browser...\n`);
    targets = await targetsFromContentList(opts.limit);
    process.stderr.write(`got ${targets.length} target(s) from contentListAll\n`);
  }
  if (opts.list && opts.limit) targets = targets.slice(0, opts.limit);
  if (!targets.length) {
    process.stderr.write('no targets, exit.\n');
    process.exit(1);
  }

  const summary = [];
  for (const t of targets) {
    process.stderr.write(`\n=== ${t.tag} | ${t.msgid} | ${t.title || '(no title)'}\n`);
    const record = { target: t, detail: null, trend: null, sources: null };
    try {
      if (includes.has('detail') || includes.has('trend') || includes.has('sources')) {
        const navRes = await navigateTo(t);
        process.stderr.write(`  nav: ${navRes.nav?.ok ? 'ok' : 'fail'} attempts=${navRes.postState?.attempts ?? '-'}\n`);
      }
      if (includes.has('detail')) record.detail = await fetchDetail(t);
      if (includes.has('trend')) record.trend = await fetchTrend(t, opts.range);
      if (includes.has('sources')) record.sources = await fetchSources(t, opts.range);
    } catch (e) {
      process.stderr.write(`  ERR ${e.message}\n`);
    }
    const file = path.join(outDir, `${t.tag}-${t.msgid}.json`);
    fs.writeFileSync(file, JSON.stringify(record, null, 2));
    process.stderr.write(`  saved -> ${file}\n`);
    summary.push({
      tag: t.tag,
      msgid: t.msgid,
      title: t.title,
      publishDate: t.publishDate,
      file,
      detailOk: !!(record.detail && record.detail.ok),
      trendOk: !!(record.trend && record.trend.ok),
      sourcesOk: !!(record.sources && record.sources.ok),
    });
  }
  fs.writeFileSync(path.join(outDir, '_index.json'), JSON.stringify(summary, null, 2));
  process.stdout.write(JSON.stringify({ ok: true, count: summary.length, outDir, summary }, null, 2) + '\n');
})().catch((e) => {
  process.stderr.write(`FATAL: ${e.stack || e.message}\n`);
  process.exit(1);
});
