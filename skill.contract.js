'use strict';

const pkg = require('./package.json');
const { Session } = require('./lib/session');
const { PAGE_PROFILES } = require('./lib/config');

const CLI_COMMANDS = [
  { name: 'doctor', description: '连通性 / 登录态 / bridge 注入 / probe / state 汇总' },
  { name: 'probe', description: '页面指纹 + 控件定位（支持 --page）' },
  { name: 'state', description: '当前筛选态（支持 --page）' },
  { name: 'user-overview', description: '用户增长：粉丝总数/新增/取消/净增（基于 DOM 表格）' },
  { name: 'user-attrs', description: '用户属性：性别/年龄/地域/终端（需关注数≥100）' },
  { name: 'content-list', description: '近期图文列表 + 核心指标（阅读/分享/点赞/留言）' },
  { name: 'content-detail', description: '单篇图文详情，需要先把 tab 切到 action=detailpage 的 URL' },
  { name: 'content-summary', description: '内容分析页状态摘要（子 tab + 日期 + KPI + paginator）' },
  { name: 'content-list-all', description: '图文列表全量 + paginator' },
  { name: 'content-trend', description: '日趋势（XHR 重放）' },
  { name: 'content-sources', description: '来源/渠道分布（XHR 重放，复用同一响应）' },
  { name: 'content-tables-dump', description: '当前页所有表格 dump（调试/踩点用）' },
  { name: 'content-navigate', description: 'INTERACTIVE：改 URL 切子 tab / 切日期 / 跳详情页（不模拟点击）' },
];

function makeLogger(logger) {
  return {
    info: typeof logger?.info === 'function' ? logger.info.bind(logger) : console.log.bind(console),
    warn: typeof logger?.warn === 'function' ? logger.warn.bind(logger) : console.warn.bind(console),
    error: typeof logger?.error === 'function' ? logger.error.bind(logger) : console.error.bind(console),
  };
}

function resolveWsEndpoint(config = {}) {
  return config.serverUrl
    || config.jsEyesServerUrl
    || process.env.JS_EYES_SERVER_URL
    || `ws://${config.serverHost || process.env.JS_EYES_SERVER_HOST || 'localhost'}:${config.serverPort || process.env.JS_EYES_SERVER_PORT || 18080}`;
}

/**
 * runToolPipeline(pageKey, method, args)
 *
 * 统一的 tool 执行流水线：
 *   1) 新建 Session（page = pageKey）
 *   2) connect → resolveTarget → ensureBridge
 *   3) callApi(method, args)
 *   4) close
 *
 * Session 每次一次性创建和销毁，避免长连接。BrowserAutomation 自带重连，
 * 但 tool 粒度短，单次往返更安全。
 */
function createRuntime(config = {}, logger) {
  const log = makeLogger(logger);
  const wsEndpoint = resolveWsEndpoint(config);

  async function runTool(pageKey, method, params = {}) {
    const { tabId, target, ...rest } = params || {};
    const session = new Session({
      opts: {
        page: pageKey,
        tab: tabId != null ? tabId : null,
        wsEndpoint,
        verbose: false,
      },
    });
    try {
      await session.connect();
      await session.resolveTarget();
      await session.ensureBridge();
      const response = await session.callApi(method, [rest || {}]);
      return response;
    } finally {
      await session.close();
    }
  }

  return {
    config: { serverUrl: wsEndpoint, pages: Object.keys(PAGE_PROFILES) },
    logger: log,
    runTool,
    async dispose() {
      // Sessions are short-lived; nothing persistent to tear down.
    },
  };
}

const TOOL_DEFINITIONS = [
  {
    name: 'wechat_mp_user_overview',
    label: 'WeChat MP: 用户增长概况',
    description: '读取公众号后台"用户分析 → 用户增长"页的增长表（新增/取消/净增/累计关注）。需浏览器已登录 mp.weixin.qq.com 且打开 /misc/useranalysis。READ-ONLY。',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: '可选：强制指定浏览器 tab id；不给则自动匹配 /misc/useranalysis tab' },
        range: { type: 'string', description: '时间窗口，仅用作元信息提示；实际日期以页面当前选择为准（7d | 30d | 90d）' },
        dateFrom: { type: 'string', description: '可选开始日期 YYYY-MM-DD（元信息）' },
        dateTo: { type: 'string', description: '可选结束日期 YYYY-MM-DD（元信息）' },
      },
    },
    optional: true,
    pageKey: 'user-analysis',
    method: 'userOverview',
  },
  {
    name: 'wechat_mp_user_attrs',
    label: 'WeChat MP: 用户属性分布',
    description: '读取"用户分析 → 用户属性"页的性别/年龄/地域/终端分布表。若账号关注数 < 100 返回 ready:false 而不报错。READ-ONLY。',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: '可选：强制指定浏览器 tab id' },
        range: { type: 'string', description: '时间窗口（元信息）' },
        dateFrom: { type: 'string' },
        dateTo: { type: 'string' },
      },
    },
    optional: true,
    pageKey: 'user-analysis',
    method: 'userAttrs',
  },
  {
    name: 'wechat_mp_content_list',
    label: 'WeChat MP: 近期图文列表',
    description: '读取"内容分析"页（/misc/appmsganalysis）近期发表图文及核心指标：阅读/分享/点赞/留言，附带可用于 content-detail 的 msgid/publish_date 候选。READ-ONLY。',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        range: { type: 'string', description: '7d | 30d | 90d，触发 fetchCgiBin 趋势数据拉取' },
        dateFrom: { type: 'string' },
        dateTo: { type: 'string' },
        limit: { type: 'number', description: '返回表格行数上限' },
      },
    },
    optional: true,
    pageKey: 'content-analysis',
    method: 'contentList',
  },
  {
    name: 'wechat_mp_content_detail',
    label: 'WeChat MP: 单篇图文详情',
    description: '读取单篇图文的阅读/分享/点赞/留言/来源分布。若当前 tab 不是 action=detailpage 则返回候选 msgid 列表供调用方选择导航。msgid 形如 2247484081_1。READ-ONLY。',
    parameters: {
      type: 'object',
      properties: {
        msgid: { type: 'string', description: '单篇文章 msgid（从 wechat_mp_content_list 的 candidate 中拿）' },
        publishDate: { type: 'string', description: 'YYYY-MM-DD（与 msgid 对应的发布日期，可选）' },
        tabId: { type: 'number' },
      },
      required: ['msgid'],
    },
    optional: true,
    pageKey: 'content-analysis',
    method: 'contentDetail',
  },
  {
    name: 'wechat_mp_content_summary',
    label: 'WeChat MP: 内容分析页状态摘要',
    description: '快速自检：当前子 tab + 日期范围 + 顶部 KPI 卡 + paginator + bridge version。适合做心跳、写指令前先确认状态。READ-ONLY。',
    parameters: {
      type: 'object',
      properties: { tabId: { type: 'number' } },
    },
    optional: true,
    pageKey: 'content-analysis',
    method: 'contentSummary',
  },
  {
    name: 'wechat_mp_content_list_all',
    label: 'WeChat MP: 图文列表全量',
    description: '同 wechat_mp_content_list 但不设 limit 默认，并附带 paginator 信息（总页/每页/总条数），便于调用方判断是否需要翻页。READ-ONLY。',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        limit: { type: 'number', description: '结果条数上限；不传返回所有可见行' },
      },
    },
    optional: true,
    pageKey: 'content-analysis',
    method: 'contentListAll',
  },
  {
    name: 'wechat_mp_content_trend',
    label: 'WeChat MP: 内容趋势（日）',
    description: '重放 /misc/appmsganalysis?action=get_article_stat_tendency_and_source，返回每日按 scene 分组的 read_uv/share_uv；scene=9999 行是合计。READ-ONLY。',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        range: { type: 'string', description: '7d | 30d | 90d' },
        dateFrom: { type: 'string' },
        dateTo: { type: 'string' },
      },
    },
    optional: true,
    pageKey: 'content-analysis',
    method: 'contentTrend',
  },
  {
    name: 'wechat_mp_content_sources',
    label: 'WeChat MP: 内容来源分布',
    description: '复用同一 XHR 的 all_article_stat_source.list，按 scene 汇总 read_uv/share_uv 并给出占比。READ-ONLY。',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        range: { type: 'string' },
        dateFrom: { type: 'string' },
        dateTo: { type: 'string' },
      },
    },
    optional: true,
    pageKey: 'content-analysis',
    method: 'contentChannelBreakdown',
  },
  {
    name: 'wechat_mp_content_tables_dump',
    label: 'WeChat MP: 页面表格 dump（调试）',
    description: '把当前页所有带 thead 的 <table> 的表头 + 前 N 行 dump 出来，用于改版后踩点。READ-ONLY。',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        limit: { type: 'number', description: '最多返回几张表（默认 8）' },
        rowLimit: { type: 'number', description: '每张表保留多少行（默认 10）' },
      },
    },
    optional: true,
    pageKey: 'content-analysis',
    method: 'contentTablesDump',
  },
  {
    name: 'wechat_mp_content_navigate',
    label: 'WeChat MP: 内容分析页导航（INTERACTIVE）',
    description: 'INTERACTIVE：仅通过 location.assign 改 URL 参数，切子 tab / 换日期 / 跳详情页；不模拟任何 DOM 点击。不触发微信侧业务写操作。调用后应再 state() 自校验。',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        action: { type: 'string', description: 'report | all | detailpage | download_summary_tendency' },
        type: { type: 'string', description: '如 daily_v2；与 action 语义挂钩' },
        front_type: { type: 'string' },
        msgid: { type: 'string', description: '跳详情页时传' },
        publishDate: { type: 'string', description: 'YYYY-MM-DD，与 msgid 搭配' },
        clear: { type: 'boolean', description: '为 true 时清掉 msgid / publish_date（回列表）' },
      },
    },
    optional: true,
    interactive: true,
    destructive: false,
    pageKey: 'content-analysis',
    method: 'navigateContent',
  },
];

function createOpenClawAdapter(config = {}, logger) {
  const runtime = createRuntime(config, logger);
  return {
    runtime,
    tools: TOOL_DEFINITIONS.map((tool) => ({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters,
      optional: tool.optional,
      interactive: tool.interactive === true,
      destructive: tool.destructive === true,
      async execute(toolCallId, params) {
        const result = await runtime.runTool(tool.pageKey, tool.method, params || {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      },
    })),
  };
}

module.exports = {
  id: pkg.name,
  name: 'JS WeChat MP Ops Skill',
  version: pkg.version,
  description: pkg.description,
  runtime: {
    requiresServer: true,
    requiresBrowserExtension: true,
    requiresLogin: true,
    platforms: ['mp.weixin.qq.com'],
  },
  cli: {
    entry: './cli/index.js',
    commands: CLI_COMMANDS,
  },
  openclaw: {
    tools: TOOL_DEFINITIONS.map((tool) => ({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters,
      optional: tool.optional,
      interactive: tool.interactive === true,
      destructive: tool.destructive === true,
    })),
  },
  createRuntime,
  createOpenClawAdapter,
};
