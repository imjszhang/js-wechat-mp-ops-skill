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
    })),
  },
  createRuntime,
  createOpenClawAdapter,
};
