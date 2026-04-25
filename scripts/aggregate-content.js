#!/usr/bin/env node
'use strict';

// scripts/aggregate-content.js
// ---------------------------------------------------------------------------
// 通用业务工具：把 batch-detail.js 输出的 *.json + _index.json 聚合成
// 可读对比表 + 一份 _aggregated.json。合并了原 aggregate-detail / aggregate-deep。
//
// 用法：
//   node scripts/aggregate-content.js [--in dir] [--out file]
//                                     [--sections kpi,interactions,gender,age,
//                                                 readChannel,shareChannel,
//                                                 region,sources,trend]
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const ALL_SECTIONS = [
  'kpi', 'interactions',
  'gender', 'age',
  'readChannel', 'shareChannel',
  'region', 'sources',
  'trend',
];

function parseArgs(argv) {
  const opts = {
    in: './_data/details',
    out: null,
    sections: 'all',
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--in') opts.in = argv[++i];
    else if (a.startsWith('--in=')) opts.in = a.slice('--in='.length);
    else if (a === '--out') opts.out = argv[++i];
    else if (a.startsWith('--out=')) opts.out = a.slice('--out='.length);
    else if (a === '--sections') opts.sections = argv[++i];
    else if (a.startsWith('--sections=')) opts.sections = a.slice('--sections='.length);
    else throw Object.assign(new Error(`unknown arg: ${a}`), { code: 'E_BAD_ARG' });
  }
  return opts;
}

function printHelp() {
  process.stdout.write([
    'aggregate-content - 聚合 batch-detail 输出，产对比表 + JSON',
    '',
    'Usage:',
    '  node scripts/aggregate-content.js [options]',
    '',
    'Options:',
    '  --in <dir>      输入目录，需含 _index.json + 各篇 *.json（默认 ./_data/details）',
    '  --out <file>    聚合 JSON 输出路径（默认 <in>/_aggregated.json）',
    `  --sections <s>  逗号分隔，子集 of: ${ALL_SECTIONS.join(',')}（默认 all）`,
    '  -h, --help',
    '',
  ].join('\n'));
}

function loadIndex(dir) {
  const idxFile = path.join(dir, '_index.json');
  if (!fs.existsSync(idxFile)) {
    throw new Error(`找不到 _index.json：${idxFile}（先跑 batch-detail.js）`);
  }
  return JSON.parse(fs.readFileSync(idxFile, 'utf8'));
}

function loadOne(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function extractRow(record) {
  const t = record.target || {};
  const detail = (record.detail && record.detail.data) || {};
  const trend = (record.trend && record.trend.data) || {};
  const sources = (record.sources && record.sources.data) || {};

  const kpis = detail.kpis || {};
  const interactionMap = detail.interactionMap || {};
  const charts = detail.charts || {};
  const tableSummaries = detail.tableSummaries || [];

  const readChannel = charts.readChannel?.paired || charts.readChannel?.legend || [];
  const shareChannel = charts.shareChannel?.paired || charts.shareChannel?.legend || [];
  const gender = charts.gender?.slices || [];
  const age = charts.age?.paired || [];
  const subscribeFunnel = charts.subscribeFunnel || {};
  const shareTrans = charts.shareTrans || {};

  const sourceChannels = (sources.channels || []).map((s) => ({
    sceneLabel: s.sceneLabel,
    read_uv: s.read_uv,
    readUvShare: s.readUvShare,
  }));

  const trendSeries = trend.series || [];
  const trendTotals = trendSeries.map((s) => ({
    date: s.date,
    read_uv: s.total?.read_uv || 0,
    share_uv: s.total?.share_uv || 0,
  }));
  const trendSum = trendTotals.reduce(
    (acc, d) => ({ read_uv: acc.read_uv + d.read_uv, share_uv: acc.share_uv + d.share_uv }),
    { read_uv: 0, share_uv: 0 },
  );
  const trendTop5 = trendTotals.slice().sort((a, b) => b.read_uv - a.read_uv).slice(0, 5);

  const region = tableSummaries[0]?.rows || [];

  return {
    tag: t.tag || null,
    title: t.title || null,
    msgid: t.msgid || null,
    publishDate: t.publishDate || null,
    reads: kpis.reads ?? null,
    avgReadSecs: kpis.avgReadSecs ?? null,
    finishRate: kpis.finishRate ?? null,
    followAfterRead: kpis.followAfterRead ?? null,
    listenCount: kpis.listenCount ?? null,
    interactionMap,
    readChannelChart: readChannel,
    shareChannelChart: shareChannel,
    gender,
    age,
    subscribeFunnel,
    shareTrans,
    sourceChannels,
    region,
    trendSum,
    trendTop5,
    trendTotals,
  };
}

function pad(s, n) { return String(s == null ? '-' : s).padEnd(n); }

function printKpi(rows) {
  console.log('# KPI 对比表');
  console.log('Tag\tReads\tFinish%\tAvgReadSec\tFollow\tListen\tShare\tLike\tWow\tComment\tFav\tTitle');
  for (const r of rows) {
    const im = r.interactionMap || {};
    console.log([
      r.tag, r.reads, r.finishRate, r.avgReadSecs, r.followAfterRead, r.listenCount,
      im.share, im.like, im.wow, im.comment, im.favorite, r.title,
    ].map((x) => x == null ? '-' : x).join('\t'));
  }
  console.log('');
}

function printInteractions(rows) {
  console.log('# 互动详情（每篇）');
  for (const r of rows) {
    console.log(`\n## ${r.tag} | ${r.title || '(no title)'}`);
    console.log('  interactionMap:', JSON.stringify(r.interactionMap));
    console.log('  阅读后关注漏斗 dataLabels:', JSON.stringify(r.subscribeFunnel.dataLabelValues || r.subscribeFunnel.dataLabels));
    console.log('  分享转化 dataLabels:', JSON.stringify(r.shareTrans.dataLabelValues || r.shareTrans.dataLabels));
  }
  console.log('');
}

function printGender(rows) {
  console.log('# 性别分布');
  for (const r of rows) {
    console.log(`  ${pad(r.tag, 10)} ${JSON.stringify(r.gender)}`);
  }
  console.log('');
}

function printAge(rows) {
  console.log('# 年龄分布');
  for (const r of rows) {
    console.log(`  ${pad(r.tag, 10)} ${JSON.stringify(r.age)}`);
  }
  console.log('');
}

function printReadChannel(rows) {
  console.log('# 阅读渠道占比（charts.readChannel）');
  for (const r of rows) {
    console.log(`\n## ${r.tag} | ${r.title || ''}`);
    if (!r.readChannelChart.length) { console.log('  (none)'); continue; }
    for (const c of r.readChannelChart) {
      const cat = c.category || c;
      const label = c.label || '';
      console.log(`  ${pad(cat, 10)} ${label}`);
    }
  }
  console.log('');
}

function printShareChannel(rows) {
  console.log('# 分享渠道占比（charts.shareChannel）');
  for (const r of rows) {
    console.log(`\n## ${r.tag} | ${r.title || ''}`);
    if (!r.shareChannelChart.length) { console.log('  (none)'); continue; }
    for (const c of r.shareChannelChart) {
      const cat = c.category || c;
      const label = c.label || '';
      console.log(`  ${pad(cat, 10)} ${label}`);
    }
  }
  console.log('');
}

function printRegion(rows) {
  console.log('# 地域 Top（detail.tableSummaries[0]）');
  for (const r of rows) {
    console.log(`\n## ${r.tag} | ${r.title || ''}`);
    if (!r.region.length) { console.log('  (none)'); continue; }
    for (const row of r.region) console.log(`  ${pad(row[0] || '', 10)} ${row[1] || ''}`);
  }
  console.log('');
}

function printSources(rows) {
  console.log('# XHR 来源渠道（content-sources, scene 维度）');
  for (const r of rows) {
    console.log(`\n## ${r.tag} | ${r.title || ''} (reads=${r.reads ?? '-'})`);
    if (!r.sourceChannels.length) { console.log('  (no source breakdown)'); continue; }
    for (const c of r.sourceChannels) {
      console.log(`  ${pad(c.sceneLabel, 8)} read_uv=${String(c.read_uv).padStart(6)} (${c.readUvShare}%)`);
    }
  }
  console.log('');
}

function printTrend(rows) {
  console.log('# 单篇 trend totals + Top5 阅读日');
  for (const r of rows) {
    console.log(`\n## ${r.tag} | ${r.title || ''}`);
    if (!r.trendTotals.length) { console.log('  (empty trend)'); continue; }
    console.log(`  totals: read_uv=${r.trendSum.read_uv}, share_uv=${r.trendSum.share_uv}`);
    console.log(`  TOP5 阅读日:`);
    r.trendTop5.forEach((d) => console.log(`    ${d.date}: read=${d.read_uv}, share=${d.share_uv}`));
  }
  console.log('');
}

const SECTION_PRINTERS = {
  kpi: printKpi,
  interactions: printInteractions,
  gender: printGender,
  age: printAge,
  readChannel: printReadChannel,
  shareChannel: printShareChannel,
  region: printRegion,
  sources: printSources,
  trend: printTrend,
};

(function main() {
  const argv = process.argv.slice(2);
  let opts;
  try { opts = parseArgs(argv); }
  catch (e) { process.stderr.write(`ERROR: ${e.message}\n`); process.exit(2); }
  if (opts.help) { printHelp(); process.exit(0); }

  const inDir = path.resolve(opts.in);
  const outFile = opts.out ? path.resolve(opts.out) : path.join(inDir, '_aggregated.json');

  const sections = opts.sections === 'all'
    ? ALL_SECTIONS.slice()
    : opts.sections.split(',').map((s) => s.trim()).filter(Boolean);
  for (const s of sections) {
    if (!SECTION_PRINTERS[s]) {
      process.stderr.write(`ERROR: --sections 项不识别: ${s}（候选：${ALL_SECTIONS.join(',')}）\n`);
      process.exit(2);
    }
  }

  const idx = loadIndex(inDir);
  const rows = idx.map((it) => extractRow(loadOne(it.file)));

  for (const s of sections) SECTION_PRINTERS[s](rows);

  fs.writeFileSync(outFile, JSON.stringify(rows, null, 2));
  process.stderr.write(`\nSaved -> ${outFile}\n`);
})();
