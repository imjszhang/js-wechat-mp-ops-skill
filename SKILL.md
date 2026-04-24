---
name: js-wechat-mp-ops-skill
description: 微信公众号后台分析只读 skill，覆盖"用户分析 + 图文（内容）分析"两个板块。
version: 0.1.0
metadata:
  openclaw:
    emoji: "📊"
    homepage: https://github.com/imjszhang/js-eyes
    requires:
      skills:
        - js-eyes
      bins:
        - node
    platforms:
      - mp.weixin.qq.com
---

# js-wechat-mp-ops-skill

面向微信公众号后台 `mp.weixin.qq.com` 的**只读**分析 skill。首版覆盖：

- 用户分析（`/misc/useranalysis`）：用户增长 + 用户属性
- 内容分析（`/misc/appmsganalysis`）：近期图文列表 + 单篇图文详情

和 [js-wechat-ops-skill](../js-eyes/skills/js-wechat-ops-skill/) 形成 **reader / author backend** 互补：
- `js-wechat-ops-skill`：阅读者视角，读 `mp.weixin.qq.com/s/<id>` 文章页
- `js-wechat-mp-ops-skill`：作者后台视角，读 `mp.weixin.qq.com/misc|cgi-bin/...` 分析页

两者职责分明、并存不合并。

## 依赖与前置

- **JS Eyes Server**：已启动 (`js-eyes server start`)
- **浏览器扩展**：已安装并连上 server
- **登录态**：浏览器里已经**人工登录公众号后台**（扫码登录；本 skill 不做任何扫码自动化）
- **已打开目标分析页**：调用前至少打开下列之一：
  - `https://mp.weixin.qq.com/misc/appmsganalysis?...`（内容分析）
  - `https://mp.weixin.qq.com/misc/useranalysis?...`（用户分析）
- **双侧 `allowRawEval`**：bridge 首次注入时会走一次 `bot.executeScript(rawSource)`，之后每次工具调用只执行 `window.__jse_mp_*__.<method>()`。
  - 宿主：`~/.js-eyes/config/config.json` 里 `security.allowRawEval: true`
  - 扩展：js-eyes 扩展 popup 里 `Allow Raw Eval` 打开
  - 少一侧会返回 `RAW_EVAL_DISABLED`。

## 只读红线

v0.1 **不提供任何写工具**。本 skill 的所有 bridge 方法都只做：

- DOM 读取（表格、卡片、KPI 文本）
- `fetchCgiBin(path, params)` 重放已有登录凭证的 XHR（只做 GET，只取数据）

**不会**：发文、改菜单、改设置、点击"删除/取消关注"等任何 CTA。

Safe Default Mode 兼容声明：

- 本 skill 日常调用不触发 `js_eyes_execute_script: confirm` consent，除了首次 bridge 注入那一次
- 若后续 v0.2+ 要加写工具，将在 `skill.contract.js` 里把该工具标记为 `destructive: true`，并要求调用方显式 `--confirm`

## 提供的 AI 工具

| 工具 | 页面 | 说明 |
|---|---|---|
| `wechat_mp_user_overview` | `/misc/useranalysis?1=1` | 用户增长概况：每日新增/取消/净增关注 + 累计总数 |
| `wechat_mp_user_attrs` | `/misc/useranalysis?action=attr` | 用户属性：性别/年龄/地域/终端（关注数 < 100 时返回 `ready:false`） |
| `wechat_mp_content_list` | `/misc/appmsganalysis?action=report` | 近期发表图文列表 + 阅读人数/占比 + `msgid`/`publish_date` |
| `wechat_mp_content_detail` | `/misc/appmsganalysis?action=detailpage` | 单篇图文 KPI（阅读/完读率/分享/留言/收藏/阅读后关注）+ 地域表 |

全部工具都是 `optional: true`（按需加载），入参详见 `skill.contract.js::TOOL_DEFINITIONS`。

## CLI

```bash
cd /Volumes/home_x/github/my/js-wechat-mp-ops-skill
npm install

# 通路 + 登录态 + bridge 注入 + probe + state 一站诊断
node index.js doctor

# 用户增长（默认 --page user-analysis）
node index.js user-overview --range 30d

# 用户属性
node index.js user-attrs

# 近期图文列表
node index.js content-list --limit 10

# 单篇详情（先在浏览器里切到 detailpage URL）
node index.js content-detail 2247484081_1 2026-04-14

# 也可通过 js-eyes 统一入口
js-eyes skill run js-wechat-mp-ops-skill doctor
```

## 架构概要

```text
CLI / Tool call
  └── skill.contract.js  (createRuntime / TOOL_DEFINITIONS)
        └── lib/session.js  (connect → resolveTarget → ensureBridge → callApi)
              ├── lib/config.js         PAGE_PROFILES
              ├── lib/js-eyes-client.js BrowserAutomation (token-auth)
              └── bridges/*-bridge.js   + bridges/common.js (@@include)
                      └── DOM read | fetchCgiBin replay
```

### Page profiles

| profile | targetUrlFragment | bridgeGlobal | bridgePath |
|---|---|---|---|
| `content-analysis` | `mp.weixin.qq.com/misc/appmsganalysis` | `__jse_mp_content__` | `bridges/content-analysis-bridge.js` |
| `user-analysis` | `mp.weixin.qq.com/misc/useranalysis` | `__jse_mp_user__` | `bridges/user-analysis-bridge.js` |

### Bridge 热更新

每个 bridge 顶部维护 `const VERSION = 'x.y.z'`。`session.ensureBridge()` 会读当前 bridge 版本，不一致时重注。共享 helpers 写在 `bridges/common.js`，通过 `// @@include ./common.js` 在注入前内联（不是运行时 require），所以所有 helpers 仍然是纯浏览器 JS。

### 为什么用 XHR 重放（v0.2+）

当前 v0.1 主要靠 DOM（表格 + KPI 卡）。未来要扩展趋势图（Highcharts SVG），会在 `bridges/common.js::fetchCgiBin` 里重放 `/misc/appmsganalysis` 的 `action=get_article_stat_tendency_and_source` 等接口。DOM 读不到的数据走 XHR；可以读到就优先 DOM。

## 启用方式

1. `cd /Volumes/home_x/github/my/js-wechat-mp-ops-skill && npm install`
2. `js-eyes skills link /Volumes/home_x/github/my/js-wechat-mp-ops-skill`
   - 会追加到 `~/.js-eyes/config/config.json` 的 `extraSkillDirs`
   - 会把 `skillsEnabled["js-wechat-mp-ops-skill"] = true`
3. `js-eyes skills reload`（OpenClaw 插件 300ms 内热载）
4. `js-eyes skills list` 应看到 `Source: extra (/Volumes/home_x/github/my/js-wechat-mp-ops-skill)`
5. **浏览器里登录公众号后台并打开目标分析页**（否则 tool 返回 `E_NO_TAB`）
6. `js-eyes doctor` 确认整体安全态

卸载：`js-eyes skills unlink /Volumes/home_x/github/my/js-wechat-mp-ops-skill`

## 路线图

- v0.2：视频号 / 菜单分析 / 流量来源（按同样模板增 profile + bridge）
- v0.2：接入 `@js-eyes/skill-recording`，给每次 tool 调用留调试记录
- v0.3：Highcharts 趋势图走 `fetchCgiBin` 重放，返回时间序列
- 一直不会做：写操作（发文 / 改菜单 / 关注管理）、任何扫码登录自动化

## 故障排查

| 现象 | 可能原因 | 处理 |
|---|---|---|
| `E_NO_TAB` | 浏览器没打开对应分析页 | 在浏览器里打开 `/misc/appmsganalysis` 或 `/misc/useranalysis` |
| `RAW_EVAL_DISABLED` | 一侧 allowRawEval=false | 宿主 config + 扩展 popup 都要开 |
| `not_logged_in` | 登录态判据失败（URL token 缺失 / URL 在 login path / 无 `weui-desktop-page_base`） | 在浏览器里重新扫码登录 |
| `ready: false, reason: fans_lt_100` | 账号关注数 <100，后台未开放用户属性 | 后台原生限制，不是 bug |
| `ready: false, reason: wrong_subtab` | 当前 URL 不在目标 action 子 tab | 按 hint 提示的 URL 切换 tab |
| bridge 注入后仍 `method_not_found` | bridge VERSION 可能未 bump | 改 bridge 后 bump VERSION，CLI 会自动重注 |
