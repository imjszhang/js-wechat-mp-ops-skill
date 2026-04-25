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

## 安全红线（READ / INTERACTIVE / DESTRUCTIVE）

本 skill 的所有工具都会被归入以下三档之一。审计界线按「是否改微信侧业务数据」而非「是否触网」来划：

### READ（默认档）
纯读，不改任何 DOM、不改 URL、不触发任何业务写操作。
- 走 DOM 读取（表格 / KPI 卡 / KPI 文本）
- 走 `fetchCgiBin(path, params)` 重放已有登录凭证的 **GET** XHR（仅取数据）
- 日常调用不触发 `js_eyes_execute_script: confirm` consent（除首次 bridge 注入）
- 工具：`wechat_mp_user_overview` / `wechat_mp_user_attrs` / `wechat_mp_content_list` / `wechat_mp_content_list_all` / `wechat_mp_content_detail` / `wechat_mp_content_summary` / `wechat_mp_content_trend` / `wechat_mp_content_sources` / `wechat_mp_content_tables_dump`

### INTERACTIVE（v0.3+）
**只改浏览器自己筛选态/导航**，不改微信侧任何业务数据。实现硬约束：
- 只允许 `location.assign(newUrl)` 方式切换 URL / query，**禁止模拟点击任何 DOM CTA**
- 调用返回 `{from, to, hint}`，由调用方再 `state()` 做自校验
- `skill.contract.js` 里带 `interactive: true` / `destructive: false` 两个字段
- 工具：`wechat_mp_content_navigate`

### DESTRUCTIVE（永不做）
任何改微信侧业务数据、生成导出文件、触发订阅变化的操作，v0.1+ 一直不会做：
- 发文 / 删文 / 修改草稿 / 改菜单 / 改设置
- 关注 / 取关 / 拉黑 / 回复 / 删评
- 「下载数据明细」等导出 CTA（触发服务端生成文件）
- 任何扫码登录自动化
如果未来真的要做，将在 `skill.contract.js` 里把该工具标记 `destructive: true`，并要求调用方显式 `--confirm` 走 Safe Default Mode consent 流程。

## 提供的 AI 工具

| 档位 | 工具 | 页面 | 说明 |
|---|---|---|---|
| READ | `wechat_mp_user_overview` | `/misc/useranalysis?1=1` | 用户增长概况：每日新增/取消/净增关注 + 累计总数 |
| READ | `wechat_mp_user_attrs` | `/misc/useranalysis?action=attr` | 用户属性：性别/年龄/地域/终端（关注数 < 100 时返回 `ready:false`） |
| READ | `wechat_mp_content_list` | `/misc/appmsganalysis?action=report` | 近期发表图文列表 + 阅读人数/占比 + `msgid`/`publish_date` |
| READ | `wechat_mp_content_list_all` | `/misc/appmsganalysis?action=report` | 列表全量（不设 limit 默认）+ paginator 信息（总页/每页/总条数） |
| READ | `wechat_mp_content_summary` | `/misc/appmsganalysis` | 子 tab + 日期范围 + 顶部 KPI 卡 + paginator 摘要（用于快速自检） |
| READ | `wechat_mp_content_trend` | `/misc/appmsganalysis` | 走 `get_article_stat_tendency_and_source`：每日各场景 `read_uv` / `share_uv`（scene=9999 为合计） |
| READ | `wechat_mp_content_sources` | `/misc/appmsganalysis` | 复用同一 XHR 的 `all_article_stat_source.list`：各来源渠道聚合 |
| READ | `wechat_mp_content_tables_dump` | `/misc/appmsganalysis` | 调试用：按表头 + 前 N 行 dump 当前页所有表格，便于踩点改版 |
| READ | `wechat_mp_content_detail` | `/misc/appmsganalysis?action=detailpage` | 单篇图文 KPI（阅读/完读率/分享/留言/收藏/阅读后关注）+ 地域表 |
| INTERACTIVE | `wechat_mp_content_navigate` | `/misc/appmsganalysis` | 仅通过 `location.assign` 修改 URL 参数（切子 tab / 切日期 / 跳详情页）；绝不模拟点击 |

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

### 内存保护与大响应限制

bridge 注入后不注册事件监听器、定时器或 `MutationObserver`，只在 `window.__jse_mp_*__` 上挂载当前版本 API。为避免页面上下文和浏览器扩展之间传递过大的对象，当前版本做了以下限制：

- `detectToken()` / `detectFingerprint()` 按当前 URL 缓存结果；fallback 扫描 inline script 时逐个短路匹配，不再拼接全部脚本文本。
- `fetchCgiBin()` 优先按 JSON 解析响应；非 JSON 响应只返回短文本摘要，避免把完整 HTML/文本跨进程传出。
- 列表、趋势、来源、详情表格和调试 dump 都有默认返回上限和最大上限；响应会附带 `total*` / `returned*` 字段说明是否被截断。
- `content-list --range/--from/--to` 不再返回完整 XHR 原始响应，只返回 `tendencySummary`，完整趋势数据请使用 `content-trend` / `content-sources` 的结构化结果。

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

## 明确不做的事

这些是 skill 在任何版本都不会做的事（DESTRUCTIVE 档位），避免后续补能力时跑偏：

- 不模拟点击任何业务 CTA（发文 / 删文 / 改菜单 / 关注 / 拉黑 / 回复 / 删评）
- 不触发「下载数据明细」等服务端导出（哪怕只是点 CTA 不下载）
- 不尝试任何 POST / 写 XHR；`fetchCgiBin` 硬约束为 GET
- 不实现扫码登录自动化 / cookie 注入 / token 伪造
- 不使用未在浏览器里实际发生过的 XHR 端点；改版前先靠 DOM 兜底 + probe 侦察
- 不代替用户做决策性操作（例如批量跳转、连续 navigate 累计筛选状态）

## 路线图

- v0.2：视频号 / 菜单分析 / 流量来源（按同样模板增 profile + bridge）
- v0.2：接入 `@js-eyes/skill-recording`，给每次 tool 调用留调试记录
- v0.3：当前版本 — content-analysis 读全（summary / list-all / trend / sources / tables-dump）+ INTERACTIVE 档位的 `navigateContent`
- v0.4：user-analysis 同样补齐 trend / sources / navigate
- 一直不会做：见「明确不做的事」

## 故障排查

| 现象 | 可能原因 | 处理 |
|---|---|---|
| `E_NO_TAB` | 浏览器没打开对应分析页 | 在浏览器里打开 `/misc/appmsganalysis` 或 `/misc/useranalysis` |
| `RAW_EVAL_DISABLED` | 一侧 allowRawEval=false | 宿主 config + 扩展 popup 都要开 |
| `not_logged_in` | 登录态判据失败（URL token 缺失 / URL 在 login path / 无 `weui-desktop-page_base`） | 在浏览器里重新扫码登录 |
| `ready: false, reason: fans_lt_100` | 账号关注数 <100，后台未开放用户属性 | 后台原生限制，不是 bug |
| `ready: false, reason: wrong_subtab` | 当前 URL 不在目标 action 子 tab | 按 hint 提示的 URL 切换 tab |
| bridge 注入后仍 `method_not_found` | bridge VERSION 可能未 bump | 改 bridge 后 bump VERSION，CLI 会自动重注 |
