'use strict';

const { PAGE_PROFILES, DEFAULT_PAGE } = require('./config');

/**
 * COMMANDS 表
 *
 * kind:
 *   - 'special': 在 CLI 层单独处理（doctor / content-detail 等需要额外装饰）
 *   - 'call':    直接翻译为 `session.callApi(api, toArgs(opts, positional))`
 *
 * `pages` 是该命令允许的 page profile 列表；
 * `defaultPage` 是未显式 --page 时默认绑定的 page profile。
 * CLI 会根据 command 自动推导 --page，避免用户手写。
 */
const COMMANDS = {
  doctor: {
    kind: 'special',
    help: '连通性 + 登录态 + bridge 注入 + probe + state 汇总（诊断）',
    pages: ['content-analysis', 'user-analysis'],
  },
  probe: {
    kind: 'call',
    api: 'probe',
    argSpec: [],
    toArgs: () => [],
    help: '采集页面指纹、关键控件、登录态判据',
    pages: ['content-analysis', 'user-analysis'],
  },
  state: {
    kind: 'call',
    api: 'state',
    argSpec: [],
    toArgs: () => [],
    help: '读取当前筛选态（日期范围、子 tab、已加载数据摘要）',
    pages: ['content-analysis', 'user-analysis'],
  },

  // user-analysis
  'user-overview': {
    kind: 'call',
    api: 'userOverview',
    argSpec: [],
    toArgs: (o) => [{ range: o.range || null, dateFrom: o.dateFrom || null, dateTo: o.dateTo || null }],
    help: '用户增长概况：累计/新增/取消关注（基于当前页 DOM 表格）',
    pages: ['user-analysis'],
    defaultPage: 'user-analysis',
  },
  'user-attrs': {
    kind: 'call',
    api: 'userAttrs',
    argSpec: [],
    toArgs: (o) => [{ range: o.range || null, dateFrom: o.dateFrom || null, dateTo: o.dateTo || null }],
    help: '用户属性分布：性别/年龄/地域/终端（需账号关注数≥100，否则返回 ready:false）',
    pages: ['user-analysis'],
    defaultPage: 'user-analysis',
  },

  // content-analysis
  'content-list': {
    kind: 'call',
    api: 'contentList',
    argSpec: [],
    toArgs: (o) => [{ range: o.range || null, dateFrom: o.dateFrom || null, dateTo: o.dateTo || null, limit: o.limit ? Number(o.limit) : null }],
    help: '近期图文列表 + 核心指标（阅读/分享/点赞/留言），默认读当前页可见表格',
    pages: ['content-analysis'],
    defaultPage: 'content-analysis',
  },
  'content-detail': {
    kind: 'special',
    argSpec: [{ name: 'msgid', required: true }, { name: 'publishDate', required: false }],
    help: '单篇图文详情：阅读/分享/点赞/留言/来源分布；msgid 形如 2247484081_1，publishDate YYYY-MM-DD',
    pages: ['content-analysis'],
    defaultPage: 'content-analysis',
  },
};

/**
 * parseArgv
 *
 * 仅实现 v0.1 需要的 flag；对齐 js-newidea-cli-test 的风格，但裁剪掉不必要的部分。
 */
function parseArgv(argv) {
  const opts = {
    tab: null,
    page: null,
    json: false,
    verbose: false,
    help: false,
    range: null,      // 7d | 30d | 90d
    dateFrom: null,   // YYYY-MM-DD
    dateTo: null,     // YYYY-MM-DD
    limit: null,
    visual: false,
    visualMs: null,
    visualDetail: 'staged',
    wsEndpoint: null,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '-v' || a === '--verbose') opts.verbose = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--visual') opts.visual = true;
    else if (a === '--no-visual') opts.visual = false;
    else if (a === '--visual-ms') opts.visualMs = argv[++i];
    else if (a.startsWith('--visual-ms=')) opts.visualMs = a.slice('--visual-ms='.length);
    else if (a === '--visual-detail') opts.visualDetail = argv[++i] || 'staged';
    else if (a.startsWith('--visual-detail=')) opts.visualDetail = a.slice('--visual-detail='.length);
    else if (a === '--tab') opts.tab = argv[++i];
    else if (a.startsWith('--tab=')) opts.tab = a.slice('--tab='.length);
    else if (a === '--page') opts.page = argv[++i];
    else if (a.startsWith('--page=')) opts.page = a.slice('--page='.length);
    else if (a === '--range') opts.range = argv[++i];
    else if (a.startsWith('--range=')) opts.range = a.slice('--range='.length);
    else if (a === '--from') opts.dateFrom = argv[++i];
    else if (a.startsWith('--from=')) opts.dateFrom = a.slice('--from='.length);
    else if (a === '--to') opts.dateTo = argv[++i];
    else if (a.startsWith('--to=')) opts.dateTo = a.slice('--to='.length);
    else if (a === '--limit') opts.limit = argv[++i];
    else if (a.startsWith('--limit=')) opts.limit = a.slice('--limit='.length);
    else if (a === '--server' || a === '--ws-endpoint') opts.wsEndpoint = argv[++i];
    else if (a.startsWith('--server=') || a.startsWith('--ws-endpoint=')) {
      opts.wsEndpoint = a.slice(a.indexOf('=') + 1);
    } else {
      positional.push(a);
    }
  }
  return { opts, positional };
}

function printHelp() {
  const pageList = Object.keys(PAGE_PROFILES).join(' | ');
  const lines = [
    'js-wechat-mp-ops-skill - 公众号后台（用户分析 + 图文分析）只读查询 CLI',
    '',
    'Usage: node index.js <command> [args] [options]',
    '',
    'Commands:',
  ];
  for (const [name, def] of Object.entries(COMMANDS)) {
    const args = (def.argSpec || []).map((s) => (s.required ? `<${s.name}>` : `[${s.name}]`)).join(' ');
    const pageHint = def.defaultPage ? ` [page=${def.defaultPage}]` : def.pages && def.pages.length === 1 ? ` [page=${def.pages[0]}]` : '';
    lines.push(`  ${name.padEnd(16)} ${args.padEnd(24)} ${(def.help || '') + pageHint}`);
  }
  lines.push(
    '',
    'Options:',
    `  --page <name>    page profile (${pageList}; 默认按 command 推导，fallback 到 ${DEFAULT_PAGE})`,
    '  --tab <id>       强制指定浏览器 tab id（默认按 page profile 的 URL 片段匹配）',
    '  --range 7d|30d|90d  查询时间窗口（bridge 内部换算）',
    '  --from YYYY-MM-DD   开始日期（优先级高于 --range）',
    '  --to   YYYY-MM-DD   结束日期',
    '  --limit <n>      结果条数上限',
    '  --json           打印完整 JSON（默认就是 JSON；保留为可选未来切换人类可读格式）',
    '  -v, --verbose    打印 session 流转日志到 stderr',
    '  --server <url>   js-eyes WS endpoint（默认 ws://localhost:18080，可用 JS_EYES_SERVER_URL 覆盖）',
    '  --no-visual      关闭页面内视觉反馈（bridge 若支持）',
    '  -h, --help       显示帮助',
    '',
    '示例:',
    '  node index.js doctor',
    '  node index.js user-overview --range 30d',
    '  node index.js content-list --range 7d --limit 10',
    '  node index.js content-detail 2247484081_1 2026-04-14',
    '',
    '注意:',
    '  * 需先在浏览器里登录 mp.weixin.qq.com 公众号后台并打开目标分析页',
    '  * 本 skill 为 READ-ONLY，不做任何写操作',
  );
  console.log(lines.join('\n'));
}

module.exports = {
  COMMANDS,
  parseArgv,
  printHelp,
};
