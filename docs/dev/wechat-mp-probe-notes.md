# WeChat MP 后台侦察笔记 (v0.1)

侦察时间：2026-04-24
侦察账号：JS的养虾日记 (mp.weixin.qq.com backend)
侦察工具：@js-eyes/client-sdk 直接 `executeScript` + `performance.getEntriesByType('resource')` 采集历史 XHR

## 0. 通用前置

- 整个后台宿主：`https://mp.weixin.qq.com/`
- 鉴权：服务端 Session Cookie 托管（同域 XHR 自动附带），外加 URL 参数 `token=<7位数字>` 作为 CSRF-ish token。
- **所有数据接口都需要同时带 `token` 与 `fingerprint`** —— 后者是一串 32 位 hex，由页面初始化时塞进 inline script。
- 页面框架：`weui-desktop`（非 React/SPA），页面是服务端渲染 + 少量 jQuery/Highcharts。
- 图表：**Highcharts SVG**（`.highcharts-container`），**不是 canvas**，DOM/SVG 可读；但 `window.Highcharts` 未暴露到全局，不能走 `Highcharts.charts` 取数据。
- 语言：`lang=zh_CN` 可在 URL 里切换。
- `document.body.className` 含 `weui-desktop-page_base`，可作为"在后台主壳"的判据。

### 0.1 登录态判据

> 只读检查，不要触发登录流。

| 判据 | 通过条件 |
|---|---|
| `URL token 参数` | `new URLSearchParams(location.search).get('token')` 匹配 `^\d{5,}$` |
| `URL 不是登录页` | `location.pathname` 不以 `/misc/loginpage`、`/cgi-bin/loginpage`、`/cgi-bin/bizlogin` 开头 |
| `body 基础壳` | `document.body.className.includes('weui-desktop-page_base')` |
| `账号名` | `document.querySelector('.weui-desktop-account__nickname, .acct_nickname_wrp, .account_name')?.textContent` 非空（观察样本：`"JS的养虾日记"`） |

> 旧版可能是 `.goto_login` 存在表示未登录；但在已登录后台也能命中 footer 的 login link，不能作为判据。**以 URL token 为主**。

### 0.2 会话指纹 fingerprint

- 每个数据 XHR 都在 query 里带 `fingerprint=46acb58a83cc67b896c13990e4f42473` 之类（样本 32hex）。
- 提取方式：从 `performance.getEntriesByType('resource')` 里找任一带 `fingerprint=` 的 URL 读出来即可（页面初始化阶段就已经发过 XHR）。
- 备选：从 inline `<script>` 正则 `/fingerprint\s*[:=]\s*['"]([0-9a-f]{16,})['"]/`。

### 0.3 URL 常量（v0.1 范围）

| 分析板块 | URL (`&token=<T>&lang=zh_CN` 省略) | 说明 |
|---|---|---|
| 内容分析（图文） | `/misc/appmsganalysis?action=report&type=daily_v2` | 主入口，默认 30 天 |
| 内容分析（全部） | `/misc/appmsganalysis?action=all&type=daily_v2` | 含未通知/已通知切换 |
| 内容分析（单篇） | `/misc/appmsganalysis?action=detailpage&msgid=<msgid>&publish_date=<YYYY-MM-DD>&type=int&pageVersion=1` | `msgid` 形如 `2247484081_1` |
| 用户分析（增长） | `/misc/useranalysis?` | 默认 tab |
| 用户分析（属性） | `/misc/useranalysis?action=attr&begin_date=<YYYY-MM-DD>&end_date=<YYYY-MM-DD>` | 性别/年龄/地域 |
| 用户分析（常读） | `/misc/useranalysis?action=activity_analysis_page&attr_type=4` | v0.1 不做 |

非 v0.1 范围：菜单分析 `/misc/menuanalysis`、消息分析 `/misc/messageanalysis?type=daily`、接口分析 `/misc/interfaceanalysis?type=daily`、多媒体 `/misc/videoanalysis?action=stat_all_video_page`。

---

## 1. 内容分析 (`/misc/appmsganalysis`)

### 1.1 URL/识别

- `targetUrlFragment`: `mp.weixin.qq.com/misc/appmsganalysis`
- 子页识别：`action` 参数（`report` / `all` / `detailpage` / `download_summary_tendency`）

### 1.2 DOM 选择器（主列表页）

| 目标 | 选择器 | 样本 / 说明 |
|---|---|---|
| 页面标题 | `h2, .weui-desktop-page__title` | "内容分析" |
| 顶部 tab（已发表内容/多媒体） | `.weui-desktop-tab a` | `已发表内容 / 多媒体` |
| 全部/已通知/未通知 radio | `a[href*="front_type=without_notice"]` 等 | 通过 URL 参数识别 |
| 日期范围输入 | `input.weui-desktop-form__input[placeholder="开始日期"]`、`placeholder="结束日期"` | v0.1 **只读** 不改 |
| 单日切换输入 | `input.weui-desktop-form__input[placeholder="请选择日期"]` | 只读 |
| 趋势图容器 | `#js_trend_chart .highcharts-container` | Highcharts SVG |
| 渠道/来源图 | `#js_channel_chart .highcharts-container` | 同上 |
| 列表表格 | `table` (body 内倒数第 1 张含 `时间` 列的 table；v0.1 可按 DOM 顺序 + 列头匹配取) | 列：`时间 / 阅读 / 分享 / 点赞 / 留言 / 操作` 等 |
| 单篇"详情"链接 | `a[href*="action=detailpage"]` | `msgid` + `publish_date` 就在 URL |

### 1.3 XHR 接口（从 performance entries 实采）

| 用途 | Path | Query 样本 |
|---|---|---|
| 图文趋势+来源 | `/misc/appmsganalysis` | `action=get_article_stat_tendency_and_source&begin_timestamp=<ts>&end_timestamp=<ts>&fingerprint=<32hex>&token=<T>&lang=zh_CN&f=json&ajax=1` |
| 数据立方查询（卡片聚合） | `/misc/datacubequery` | `action=mgr_list&ids=677;685&fingerprint=<32hex>&token=<T>&lang=zh_CN&f=json&ajax=1` |
| 账号列表（探活用） | `/cgi-bin/switchacct` | `action=get_acct_list&fingerprint=<32hex>&token=<T>&lang=zh_CN&f=json&ajax=1` |

调用示意（bridge 里用 `fetch(url, { credentials: 'include' })`，无需手动塞 Cookie）：

```text
GET https://mp.weixin.qq.com/misc/appmsganalysis
  ?action=get_article_stat_tendency_and_source
  &begin_timestamp=1774437231
  &end_timestamp=1776942831
  &fingerprint=46acb58a83cc67b896c13990e4f42473
  &token=523441114
  &lang=zh_CN
  &f=json
  &ajax=1
```

返回格式：JSON（未采样，但按 WeChat 惯例是 `{ base_resp: { ret: 0, err_msg: "ok" }, ...payload }`）。

> **v0.1 数据路径选择**：列表 + 卡片 + 单篇详情 **全部走 DOM**，足够覆盖 Agent 常见问答；趋势图数据 **走 XHR replay**（`get_article_stat_tendency_and_source`），因为 Highcharts SVG 反解效率低。

### 1.4 单篇详情页（`action=detailpage`）

- 入口：从列表"详情"链接跳转，URL 已自带 `msgid` + `publish_date`。
- DOM：顶部展示文章标题 + 发布时间，下方多个 Highcharts 趋势 + 表格。
- v0.1 数据点：阅读人数/次数、分享人数、在看人数、留言数、完读率、来源分布（单篇版本）。
- 实现策略：bridge 收到 `contentDetail({ msgid, publishDate })` 时，用 `resolveTarget` 驱动浏览器导航到 detailpage URL，等待 DOM 稳定后解析。

---

## 2. 用户分析 (`/misc/useranalysis`)

### 2.1 URL/识别

- `targetUrlFragment`: `mp.weixin.qq.com/misc/useranalysis`
- 子 tab 由 `action` 参数区分：
  - `undefined` 或 `1=1`: **用户增长** (默认)
  - `attr`: **用户属性**
  - `activity_analysis_page`: **常读用户分析**

### 2.2 DOM 选择器（用户增长）

| 目标 | 选择器 | 样本 |
|---|---|---|
| 页面标题 | `h2, .weui-desktop-page__title` | "用户分析" |
| 子 tab | `.tab_nav a, .weui-desktop-tab a` | `用户增长 / 用户属性 / 常读用户分析` |
| 账号名（登录态） | `.weui-desktop-account__nickname` 或 `.account_nickname` | `JS的养虾日记` |
| 日期范围 | `input.weui-desktop-form__input[placeholder="开始日期"/"结束日期"]` | 默认最近 30 天 |
| 趋势图 | `#js_trend_chart .highcharts-container` | Highcharts SVG |
| 渠道分布图 | `#js_channel_chart .highcharts-container` | Highcharts SVG |
| 增长表（主数据） | `table`（找含 `时间` 或 `新增关注` 列头的那张） | 列：`时间 / 新增关注 / 取消关注 / 净增关注 / 累计关注` |
| 样本一行 | `tbody tr` | `2026-04-23 / 6 / 0 / 6 / 990` |

### 2.3 DOM 选择器（用户属性 `action=attr`）

- 性别：饼图 + 百分比文本节点。
- 年龄：柱图 + 表格。
- 地域：省/市列表 + 柱图。
- 终端：iPhone / Android / 其他 分布。
- **v0.1 取数**：优先从表格 tbody 取，表格缺失时从 SVG `text` 元素聚合文本。
- 前置条件：**账号关注用户数 ≥ 100** 才展示；未达标时页面出现提示 `账号关注用户数需达到100，达到后第二天将自动展示...`，bridge 应返回结构化 `{ ready: false, reason: 'fans_lt_100' }`。

### 2.4 XHR 接口

- 本次侦察时，用户分析页默认只加载了表格（SSR），未触发独立 XHR；若后续切换日期范围会触发 `datacubequery` 或 `useranalysis?action=xxx&ajax=1` 类 GET（待 v0.2 补充实采）。
- v0.1 **全部走 DOM**。

---

## 3. 会话指纹 fingerprint 提取 helper (bridge 复用)

```js
function detectFingerprint() {
  try {
    const entries = performance.getEntriesByType('resource') || [];
    for (const e of entries) {
      const m = /[?&]fingerprint=([0-9a-f]{16,})/i.exec(e.name);
      if (m) return m[1];
    }
  } catch (_) {}
  const scripts = Array.from(document.querySelectorAll('script:not([src])'))
    .map(s => s.textContent).join('\n');
  const m2 = /fingerprint\s*[:=]\s*['"]([0-9a-f]{16,})['"]/i.exec(scripts);
  return m2 ? m2[1] : null;
}
```

## 4. token 提取 helper

```js
function detectToken() {
  const p = new URLSearchParams(location.search);
  const t = p.get('token');
  if (t && /^\d{5,}$/.test(t)) return t;
  const scripts = Array.from(document.querySelectorAll('script:not([src])'))
    .map(s => s.textContent).join('\n');
  const m = /token\s*[:=]\s*['"]?(\d{5,})/.exec(scripts);
  return m ? m[1] : null;
}
```

## 5. fetchCgiBin helper（bridge/common.js 用）

```js
async function fetchCgiBin(path, params = {}) {
  const token = detectToken();
  const fingerprint = detectFingerprint();
  if (!token) throw new Error('not_logged_in');
  const q = new URLSearchParams({
    ...params,
    token,
    lang: 'zh_CN',
    f: 'json',
    ajax: '1',
  });
  if (fingerprint) q.set('fingerprint', fingerprint);
  const url = `https://mp.weixin.qq.com${path}?${q.toString()}`;
  const res = await fetch(url, { credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
  if (!res.ok) throw new Error(`http_${res.status}`);
  const data = await res.json().catch(() => null);
  return { url, httpStatus: res.status, data };
}
```

## 6. 侦察过程未验证的前提

- **未实测 XHR 返回体字段**：只观察到 URL + 200 响应，具体 payload schema 待 bridge 真正调用时确认。bridge 先把 raw JSON 透传给 CLI，等首轮调通再迭代 schema。
- **未测 date range 切换**：v0.1 只读现有默认 range（30 天），CLI 的 `--range` flag 是 bridge 侧计算 timestamp 后丢进 `fetchCgiBin`，不触发 DOM 上的 date picker。
- **单篇详情的完整 DOM 结构**：只看到"详情"链接，未真正进入 detailpage。`contentDetail` 实现时先 smoke test，必要时再回填本文档。
- **关注数 < 100 的用户属性页**：当前账号已 990 关注，属性页能正常显示；边界提示文字已记录，未触发。

## 7. v0.1 之外不碰的东西

- 视频号弹幕 / 多媒体分析 (`/misc/videoanalysis`)
- 菜单分析、消息分析、接口分析
- 任何写操作（发文、定时、关注管理）
- cgi-bin **写** 类接口（`action=save_*`、`action=delete_*`）—— 白名单策略禁止
