'use strict';

const path = require('path');

const DEFAULT_WS_ENDPOINT = process.env.JS_EYES_SERVER_URL
  || (process.env.JS_EYES_SERVER_HOST || process.env.JS_EYES_SERVER_PORT
        ? `ws://${process.env.JS_EYES_SERVER_HOST || 'localhost'}:${process.env.JS_EYES_SERVER_PORT || 18080}`
        : 'ws://localhost:18080');

const DEFAULT_PAGE = process.env.JS_WECHAT_MP_DEFAULT_PAGE || 'content-analysis';

/**
 * PAGE_PROFILES: 每个板块独立 bridge + 独立 global + 独立 URL 指纹。
 *
 * 说明：
 * - `targetUrlFragment`: 只要浏览器 tab URL 包含此片段即命中，用于 resolveTarget 自动定位。
 * - `bridgeGlobal`: bridge 注入后挂在 window 上的全局对象名，必须 skill 内唯一。
 * - `bridgePath`: bridge 源文件绝对路径，session.ensureBridge 会读它的源码 + VERSION 做热更新。
 * - `routeLabel`: 用于人类可读日志。
 */
const PAGE_PROFILES = {
  'content-analysis': {
    name: 'content-analysis',
    targetUrlFragment: process.env.JS_WECHAT_MP_CONTENT_URL_FRAGMENT
      || 'mp.weixin.qq.com/misc/appmsganalysis',
    bridgePath: path.join(__dirname, '..', 'bridges', 'content-analysis-bridge.js'),
    bridgeGlobal: '__jse_mp_content__',
    routeLabel: '/misc/appmsganalysis',
    description: '公众号后台 - 内容分析（图文分析）',
  },
  'user-analysis': {
    name: 'user-analysis',
    targetUrlFragment: process.env.JS_WECHAT_MP_USER_URL_FRAGMENT
      || 'mp.weixin.qq.com/misc/useranalysis',
    bridgePath: path.join(__dirname, '..', 'bridges', 'user-analysis-bridge.js'),
    bridgeGlobal: '__jse_mp_user__',
    routeLabel: '/misc/useranalysis',
    description: '公众号后台 - 用户分析',
  },
};

function getPageProfile(name = DEFAULT_PAGE) {
  const profile = PAGE_PROFILES[name];
  if (!profile) {
    throw Object.assign(
      new Error(
        `未知 page profile: ${name}；可选: ${Object.keys(PAGE_PROFILES).join(' | ')}`,
      ),
      { code: 'E_BAD_ARG' },
    );
  }
  return profile;
}

module.exports = {
  DEFAULT_WS_ENDPOINT,
  DEFAULT_PAGE,
  PAGE_PROFILES,
  getPageProfile,
};
