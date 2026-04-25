// bridges/content-analysis-bridge.js
// ---------------------------------------------------------------------------
// 公众号后台 - 内容分析（图文分析）bridge
// 独立 VERSION，修改任意方法后请 bump VERSION，下次 session.ensureBridge 自动重装。
//
// 暴露 window.__jse_mp_content__ API:
//   probe() / state() / contentList({range, dateFrom, dateTo, limit}) / contentDetail({msgid, publishDate})
// ---------------------------------------------------------------------------

(function install(){
  'use strict';
  const VERSION = '0.4.0';

  // @@include ./common.js

  const DEFAULT_LIST_LIMIT = 100;
  const MAX_LIST_LIMIT = 200;
  const MAX_TABLE_DUMP_LIMIT = 8;
  const MAX_TABLE_ROW_LIMIT = 20;
  const MAX_TREND_SERIES_LIMIT = 120;
  const MAX_CHANNEL_LIMIT = 200;
  const MAX_CHART_POINTS = 400;

  // detailpage 9 个 Highcharts 容器 → 语义键映射（v0.4 新增）
  const DETAIL_CHART_IDS = {
    readTrend: 'js_read_trend_chart',
    readChannel: 'js_read_channel_chart',
    subscribeFunnel: 'js_subscribe_trans_chart',
    shareTrans: 'js_share_trans_chart',
    shareTrend: 'js_share_trend_chart',
    shareChannel: 'js_share_channel_chart',
    gender: 'js_gender_chart',
    age: 'js_age_chart',
    map: 'js_map_chart',
  };

  /**
   * readHighchartsByElementId - 通过容器 id 读 Highcharts 实例数据。
   *
   * detailpage 不发任何 ajax，全部图表数据 SSR 进 HTML 后由 Highcharts 在客户端
   * 实例化。每个 chart container 上挂 `data-highcharts-chart="N"`（N 是
   * `Highcharts.charts` 数组下标）。直接读实例避免重复解析 SVG。
   */
  /**
   * readChartSvg - 解析 Highcharts 渲染的 SVG。
   *
   * detailpage 上同时引用 Highcharts 7/11 两套，且都用 ESM 包裹未暴露在 window，
   * 所以拿不到 chart 实例。但 SVG 本身可读：每个 axis label / data label / 标题
   * 都以 `<text>` 节点存在，class 名规则稳定（`highcharts-axis-labels`、
   * `highcharts-data-label`、`highcharts-title` 等）。
   *
   * 每个 chart 类型的解析委托给具体 parser（按容器 id 派发）。
   */
  function readChartSvg(id){
    try {
      const el = document.getElementById(id);
      if (!el) return { container: id, present: false };
      const svg = el.querySelector('svg');
      if (!svg) return { container: id, present: true, hasSvg: false };
      const title = (svg.querySelector('.highcharts-title')?.textContent || '').replace(/\s+/g,' ').trim() || null;
      const subtitle = (svg.querySelector('.highcharts-subtitle')?.textContent || '').replace(/\s+/g,' ').trim() || null;
      const xLabels = readSvgGroupTexts(svg, '.highcharts-xaxis-labels');
      const yLabels = readSvgGroupTexts(svg, '.highcharts-yaxis-labels');
      const dataLabels = readSvgGroupTexts(svg, '.highcharts-data-labels, .highcharts-data-label');
      const legend = readSvgGroupTexts(svg, '.highcharts-legend-item');
      return {
        container: id,
        present: true,
        hasSvg: true,
        title: shortText(title || '', 120).text || null,
        subtitle: shortText(subtitle || '', 120).text || null,
        xAxisLabels: xLabels,
        yAxisLabels: yLabels,
        dataLabels,
        legend,
      };
    } catch (e) {
      return { container: id, error: String((e && e.message) || e) };
    }
  }

  // 单 `<text>` 的 textContent 在 Highcharts 11 里偶尔会出现 "X X" / "X92.33%X92.33%" 这样的
  // ABAB 重复（描边 + 填充两个 `<tspan>` 拼成一个 textContent）。如果整段的前半 == 后半，
  // 只保留前半。同时移除零宽空格 / NBSP。
  function normalizeSvgText(raw){
    let s = String(raw || '').replace(/\u200B|\u00A0/g, '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    if (s.length % 2 === 0) {
      const half = s.length / 2;
      if (s.slice(0, half) === s.slice(half)) s = s.slice(0, half);
    }
    return s;
  }

  function readSvgGroupTexts(svg, groupSelector){
    const out = [];
    const groups = svg.querySelectorAll(groupSelector);
    groups.forEach((g) => {
      const texts = (g.tagName && g.tagName.toLowerCase() === 'text') ? [g] : g.querySelectorAll('text');
      texts.forEach((t) => {
        const s = normalizeSvgText(t.textContent);
        if (s) out.push(shortText(s, 80).text);
      });
    });
    // HC11 抗锯齿会渲染两份 `<text>`（描边 + 填充）叠在一起。出现形态：
    // (a) 整组镜像 [A,B,C,A,B,C] —— 把后半切掉；
    // (b) 双倍紧邻 [A,A,B,B] —— 折叠成 [A,B]。
    // 注意不要无脑做紧邻 dedup，否则会误删合法的连续相同值（如 "0人 / 0人"）。
    if (out.length >= 2 && out.length % 2 === 0) {
      const half = out.length / 2;
      let mirrored = true;
      for (let i = 0; i < half; i++) {
        if (out[i] !== out[i + half]) { mirrored = false; break; }
      }
      if (mirrored) return out.slice(0, half).slice(0, MAX_CHART_POINTS);
      let pairwise = true;
      for (let i = 0; i < out.length; i += 2) {
        if (out[i] !== out[i + 1]) { pairwise = false; break; }
      }
      if (pairwise) {
        const folded = [];
        for (let i = 0; i < out.length; i += 2) folded.push(out[i]);
        return folded.slice(0, MAX_CHART_POINTS);
      }
    }
    return out.slice(0, MAX_CHART_POINTS);
  }

  /**
   * 各 chart 的结构化二次解析。
   *
   * SVG `<text>` 顺序在 Highcharts 渲染时是稳定的（按 axis 顺序、series 顺序、data
   * label 顺序输出），所以可以按 chart 类型把 xAxisLabels / dataLabels 配对。
   * 这里只做"低危"配对：长度匹配才输出 paired，否则只回 raw。
   */
  function structureChartByKind(kind, raw){
    if (!raw || !raw.hasSvg) return raw;
    const out = Object.assign({}, raw);
    if (kind === 'readChannel' || kind === 'shareChannel') {
      // category 在 detailpage 渠道图里以 legend 形式出现（HC11 horizontal bar），
      // 旧版 detailpage 也可能在 xAxisLabels 或 yAxisLabels —— 三处都尝试。
      const cats = (raw.legend && raw.legend.length) ? raw.legend
        : (raw.xAxisLabels && raw.xAxisLabels.length) ? raw.xAxisLabels
        : (raw.yAxisLabels || []);
      const labels = (raw.dataLabels || []).filter((s) => /\d/.test(s));
      if (cats && cats.length && labels.length === cats.length) {
        out.paired = cats.map((c, i) => ({ category: c, label: labels[i] }));
      }
    } else if (kind === 'gender') {
      const labels = (raw.dataLabels || []);
      const slices = [];
      for (const s of labels) {
        const m = /^(.+?)\s*([\d.]+)\s*%$/.exec(s);
        if (m) slices.push({ name: m[1].trim(), percent: Number(m[2]) });
      }
      if (slices.length) out.slices = slices;
    } else if (kind === 'age') {
      const cats = raw.xAxisLabels || [];
      const labels = (raw.dataLabels || []).map((s) => s.replace(/\u200B/g, ''));
      if (cats.length && labels.length >= cats.length) {
        out.paired = cats.map((c, i) => ({ ageRange: c, label: labels[i] }));
      }
    } else if (kind === 'readTrend' || kind === 'shareTrend') {
      out.dateAxis = raw.xAxisLabels || [];
      out.seriesNames = raw.legend || [];
    } else if (kind === 'subscribeFunnel' || kind === 'shareTrans') {
      out.seriesNames = raw.legend || [];
      out.dataLabelValues = raw.dataLabels || [];
    } else if (kind === 'map') {
      out.colorAxisLabels = raw.xAxisLabels || raw.yAxisLabels || [];
    }
    return out;
  }

  /**
   * readDetailCharts - 一次性读 detailpage 全部 9 个 chart 的 SVG 结构化数据。
   * 缺失的 chart（如视频 detailpage 没有 share_trend_chart）返回 present: false。
   */
  function readDetailCharts(_args){
    const out = {};
    for (const key of Object.keys(DETAIL_CHART_IDS)) {
      const raw = readChartSvg(DETAIL_CHART_IDS[key]);
      out[key] = structureChartByKind(key, raw);
    }
    return out;
  }

  function probe(){
    try {
      const login = readLoginState();
      const u = new URL(location.href);
      const action = u.searchParams.get('action');
      const type = u.searchParams.get('type');
      const fontType = u.searchParams.get('front_type');
      // v0.4: action=all 子 tab 字典（来自 Stage A 实测的 sub-tab navigation anchor）
      // - action=all 不带 front_type → "已通知内容"（默认 sub tab）
      // - action=all&front_type=without_notice → "未开启通知内容"
      // - action=report&type=daily_v2 → "已发表内容"（顶部主 tab）
      // - action=report 不带 type → "全部"（顶部主 tab）
      // 跨页面的"多媒体" sub tab 跳到 /misc/videoanalysis，不在本 bridge 范围。
      let allLabel = null;
      if (action === 'all') {
        allLabel = !fontType ? '已通知内容'
          : fontType === 'without_notice' ? '未开启通知内容'
          : '未知 front_type';
      }
      const reportLabel = (action === 'report' && !type) ? '全部'
        : (action === 'report') ? '已发表内容'
        : null;
      const tabLabels = {
        report: reportLabel,
        all: allLabel,
        detailpage: '单篇详情',
        download_summary_tendency: '下载数据明细（请勿用 navigateContent 触发，属写操作）',
      };
      const subTab = {
        action: action || null,
        type: type || null,
        label: tabLabels[action] || null,
        front_type: fontType || null,
      };
      const dates = readDateRangeFromDom();
      const chartContainers = Array.from(document.querySelectorAll('[id*="chart"]'))
        .slice(0, 10).map((n) => ({ id: n.id, hasHighcharts: !!n.querySelector('.highcharts-container') }));
      const tables = document.querySelectorAll('table').length;
      const detailLinks = Array.from(document.querySelectorAll('a[href*="action=detailpage"]'))
        .slice(0, 5).map((a) => {
          const href = a.href;
          try {
            const u2 = new URL(href);
            return {
              text: (a.textContent || '').trim().slice(0, 30),
              msgid: u2.searchParams.get('msgid'),
              publish_date: u2.searchParams.get('publish_date'),
              href,
            };
          } catch(_){ return { href }; }
        });
      return okResult({
        url: location.href,
        page: 'content-analysis',
        subTab,
        login,
        dateInputs: dates,
        chartContainers,
        tableCount: tables,
        sampleDetailLinks: detailLinks,
        fingerprint: detectFingerprint() ? 'present' : null,
        version: VERSION,
      });
    } catch (e) { return errResult(e && e.message || e, { stack: e && e.stack }); }
  }

  function state(){
    try {
      const login = readLoginState();
      if (!login.loggedIn) return okResult({ ready: false, reason: 'not_logged_in', login });
      const dates = readDateRangeFromDom();
      const u = new URL(location.href);
      const tableCount = document.querySelectorAll('table').length;
      return okResult({
        ready: true,
        login,
        action: u.searchParams.get('action'),
        type: u.searchParams.get('type'),
        front_type: u.searchParams.get('front_type'),
        dateFrom: dates.rangeFrom,
        dateTo: dates.rangeTo,
        singleDay: dates.singleDay,
        tableCount,
      });
    } catch (e) { return errResult(e && e.message || e); }
  }

  /**
   * contentList - 近期图文列表 + 核心指标
   *
   * 策略：
   *   1) 优先从 DOM 列表表格解析（表头含 "时间" 或 "标题" 或 "阅读"）
   *   2) 若 --range / --from --to 给定，通过 fetchCgiBin(get_article_stat_tendency_and_source) 拉趋势数据
   */
  /**
   * contentList - 近期图文列表（阅读人数 / 阅读人数占比）
   *
   * 表格结构（/misc/appmsganalysis?action=report&type=daily_v2）：
   *   headers = [内容标题, 阅读人数, 阅读人数占比, 操作]
   *   每篇图文 = 3 tr：
   *     tr[0] class=weui-desktop-table__row_current  // 6 td，首 td 是聚合长文本
   *     tr[1] class=""                                // 4 td，clean 行
   *     tr[2] class=weui-desktop-table__fold-row     // 展开占位
   *   → 只取 trClass === '' && tdCount === 4 的行。
   */
  async function contentList(args){
    args = args || {};
    try {
      const login = readLoginState();
      if (!login.loggedIn) return errResult('not_logged_in', { login });

      const range = rangeToTimestamps(args.range, args.dateFrom, args.dateTo);

      const table = findTableByHeader([/内容标题|标题/, /阅读人数|阅读数|阅读/]);
      const items = [];
      if (table) {
        const rows = Array.from(table.querySelectorAll('tbody tr'));
        for (const tr of rows) {
          const tds = tr.querySelectorAll('td');
          if (tr.className) continue;              // 聚合行 / fold 行
          if (tds.length !== 4) continue;
          const titleCell = tds[0];
          const titleText = (titleCell.textContent || '').replace(/\s+/g, ' ').trim();
          const titleMatch = titleText.match(/^(.*?)\s*发表时间[：:]\s*(\d{4}\/\d{2}\/\d{2})/);
          const title = shortText(titleMatch ? titleMatch[1] : titleText, 160).text;
          const publishDate = titleMatch ? titleMatch[2].replace(/\//g, '-') : null;
          const a = tr.querySelector('a[href*="action=detailpage"]');
          let msgid = null, publish_date_url = null, detailHref = null;
          if (a) {
            try {
              const u = new URL(a.href);
              msgid = u.searchParams.get('msgid');
              publish_date_url = u.searchParams.get('publish_date');
              detailHref = a.href;
            } catch(_){}
          }
          items.push({
            msgid,
            title,
            publishDate: publish_date_url || publishDate,
            reads: textNum(tds[1].textContent),
            readsRate: shortText((tds[2].textContent || '').replace(/\s+/g,' ').trim(), 80).text,
            detailHref,
          });
        }
      }

      const limit = clampLimit(args.limit, Math.min(items.length, DEFAULT_LIST_LIMIT), MAX_LIST_LIMIT);
      const limited = items.slice(0, limit);

      // 可选：XHR 趋势 + 来源
      let tendencySummary = null;
      if (args.range || args.dateFrom || args.dateTo) {
        const resp = await fetchCgiBin('/misc/appmsganalysis', {
          action: 'get_article_stat_tendency_and_source',
          begin_timestamp: String(range.beginTimestamp),
          end_timestamp: String(range.endTimestamp),
        });
        tendencySummary = summarizeCgiResponse(resp);
      }

      return okResult({
        login,
        range,
        listTableFound: !!table,
        listHeaders: table
          ? Array.from(table.querySelectorAll('thead th')).map((th) => (th.textContent || '').replace(/\s+/g,'').trim())
          : [],
        totalCount: items.length,
        returnedCount: limited.length,
        items: limited,
        tendencySummary,
      });
    } catch (e) { return errResult(e && e.message || e, { stack: e && e.stack }); }
  }

  /**
   * contentDetail - 单篇图文详情
   *
   * v0.1 实现策略：
   *   - 若 URL 已经在 action=detailpage&msgid=... 上：直接读 DOM
   *   - 否则：只返回当前页可见的"详情"链接样本 + 提示用户先手动切到 detail 页
   *     （不自动触发导航，避免打断 Agent 正在进行的观察）
   */
  /**
   * contentDetail - 单篇图文详情
   *
   * DOM 结构：
   *   顶部 KPI：.bottom_data_tips → 文本类似 "阅读 11,438 人" / "完读率 45%" / "平均阅读时长 1.03 分钟"
   *   互动数据：.data_list 每行 `.list_left` 是 label，`.list_right > .data_num + .data_unit`
   *   地域/来源表：<table> with headers 地域/占比 等
   *
   * 策略：在详情页就地采集；若当前 tab 不在 detailpage，则返回候选 msgid 列表。
   */
  async function contentDetail(args){
    args = args || {};
    try {
      const login = readLoginState();
      if (!login.loggedIn) return errResult('not_logged_in', { login });
      const u = new URL(location.href);
      const isDetail = u.searchParams.get('action') === 'detailpage';
      const curMsgid = u.searchParams.get('msgid');
      const curDate = u.searchParams.get('publish_date');

      if (isDetail && (!args.msgid || args.msgid === curMsgid)) {
        const topTipsMap = {
          reads: [/^阅读\s/],
          avgReadSecs: [/平均阅读时长/],
          finishRate: [/完读率/],
          followAfterRead: [/阅读后关注/],
          listenCount: [/听全文/],
        };
        const tipEls = Array.from(document.querySelectorAll('.bottom_data_tips')).slice(0, 40);
        const topKpis = {};
        const topKpisRaw = tipEls.map((el) => {
          const raw = shortText((el.textContent || '').replace(/\s+/g,' ').trim(), 160).text;
          const val = shortText((el.querySelector('.tips_val_num')?.textContent || '').trim(), 80).text;
          return { raw, val };
        });
        for (const item of topKpisRaw) {
          for (const key of Object.keys(topTipsMap)) {
            if (topKpis[key] != null) continue;
            if (topTipsMap[key].some((p) => p.test(item.raw))) {
              topKpis[key] = item.val;
              break;
            }
          }
        }

        const interactions = Array.from(document.querySelectorAll('.data_list')).slice(0, 40).map((row) => {
          const label = shortText((row.querySelector('.list_left')?.textContent || '').replace(/\s+/g,' ').trim(), 80).text;
          const value = (row.querySelector('.list_right .data_num')?.textContent || '').trim();
          const unit = shortText((row.querySelector('.list_right .data_unit')?.textContent || '').replace(/\s+/g,' ').trim(), 40).text;
          return { label: label || null, value: value ? textNum(value) : null, unit: unit || null };
        }).filter((r) => r.value != null);
        const interactionMap = {};
        const labelToKey = {
          '分享': 'share',
          '点赞': 'like',
          '在看': 'wow',
          '赞赏': 'reward',
          '留言': 'comment',
          '收藏': 'favorite',
          '转发': 'forward',
        };
        const positionalFallbackKeys = ['share', 'like', 'wow', 'reward', 'comment', 'favorite'];
        const interactionMeta = [];
        interactions.forEach((row, idx) => {
          let key = null;
          let source = null;
          if (row.label) {
            key = labelToKey[row.label] || row.label;
            source = 'label';
          } else if (positionalFallbackKeys[idx]) {
            // detailpage `.data_list` 里点赞/在看的 list_left 只有 SVG icon 没文字。
            // 已知图文 detailpage 的固定顺序是 [share, like, wow, reward, comment, favorite]，
            // 用位置回退（每行带 source: 'positional' 标识，便于上层区分）。
            key = positionalFallbackKeys[idx];
            source = 'positional';
          }
          interactionMeta.push({ idx, label: row.label, value: row.value, unit: row.unit, key, source });
          if (key && !(key in interactionMap)) interactionMap[key] = row.value;
        });

        const tableLimit = clampLimit(args.tableLimit, MAX_TABLE_DUMP_LIMIT, MAX_TABLE_DUMP_LIMIT);
        const rowLimit = clampLimit(args.rowLimit, 10, MAX_TABLE_ROW_LIMIT);
        const tables = Array.from(document.querySelectorAll('table'))
          .filter((t) => t.querySelectorAll('thead th').length > 0)
          .slice(0, tableLimit);
        const tableSummaries = tables.map((t) => {
          const headers = Array.from(t.querySelectorAll('thead th'))
            .map((th) => shortText((th.textContent || '').replace(/\s+/g,'').trim(), 80).text);
          const rowCount = t.querySelectorAll('tbody tr').length;
          const rows = Array.from(t.querySelectorAll('tbody tr')).slice(0, rowLimit).map((tr) =>
            Array.from(tr.querySelectorAll('td')).map((td) => shortText((td.textContent || '').replace(/\s+/g,' ').trim(), 160).text),
          );
          return { headers, rowCount, returnedRows: rows.length, rows };
        });

        const charts = readDetailCharts(args);

        const title = (document.title || '').replace(/公众号|内容分析/g, '').trim() || null;

        return okResult({
          login,
          mode: 'in_detail_page',
          msgid: curMsgid,
          publish_date: curDate,
          title: shortText(title, 160).text || null,
          kpis: topKpis,
          kpisRaw: topKpisRaw,
          interactions: interactionMeta,
          interactionMap,
          tableSummaries,
          charts,
        });
      }

      // 非详情页：返回候选 detail 链接，告诉调用方先导航
      const candidateLimit = clampLimit(args.candidateLimit, 20, 100);
      const candidates = Array.from(document.querySelectorAll('a[href*="action=detailpage"]'))
        .map((a) => {
          try {
            const u2 = new URL(a.href);
            return {
              msgid: u2.searchParams.get('msgid'),
              publish_date: u2.searchParams.get('publish_date'),
              href: a.href,
              text: shortText((a.textContent || '').trim(), 80).text,
            };
          } catch(_){ return null; }
        }).filter(Boolean);
      const hit = args.msgid ? candidates.find((c) => c.msgid === args.msgid) : null;
      return okResult({
        login,
        mode: 'list_page',
        hint: '请先在浏览器中把 tab 切换到 action=detailpage&msgid=<id>&publish_date=<YYYY-MM-DD> 的 URL，或重新调用 CLI 并附带 --tab <id>。',
        requested: { msgid: args.msgid, publishDate: args.publishDate },
        candidate: hit,
        totalCandidates: candidates.length,
        returnedCandidates: Math.min(candidates.length, candidateLimit),
        candidates: candidates.slice(0, candidateLimit),
      });
    } catch (e) { return errResult(e && e.message || e, { stack: e && e.stack }); }
  }

  // ── v0.3 新增：列表页页顶 KPI + 状态摘要 ────────────────────────────────────
  /**
   * contentSummary - 列表/汇总页的快速自检：subTab + 日期 + KPI + paginator
   *
   * 不依赖 XHR，纯 DOM。用于：
   *   - AI 快速判断"我现在在哪张子页 / 能看到多少条图文"
   *   - doctor 心跳
   */
  function contentSummary(){
    try {
      const login = readLoginState();
      if (!login.loggedIn) return okResult({ ready: false, reason: 'not_logged_in', login });

      const u = new URL(location.href);
      const action = u.searchParams.get('action');
      const type = u.searchParams.get('type');
      const front_type = u.searchParams.get('front_type');
      const subTabLabel = {
        report: '已发表内容',
        all: front_type ? '全部' : '未开启通知内容',
        detailpage: '单篇详情',
        download_summary_tendency: '下载数据明细',
      }[action] || null;

      const dates = readDateRangeFromDom();

      // 尝试抓顶部 KPI：.bottom_data_tips（详情页常见）或 .overview_* / .data_card 等
      const kpiSelectors = [
        '.bottom_data_tips',
        '.overview_box .num',
        '.data_card',
        '.weui-desktop-chart__legend li',
      ];
      const seen = new Set();
      const kpiCards = [];
      for (const sel of kpiSelectors){
        const nodes = Array.from(document.querySelectorAll(sel));
        for (const el of nodes){
          const raw = shortText((el.textContent || '').replace(/\s+/g, ' ').trim(), 160).text;
          if (!raw || seen.has(raw)) continue;
          seen.add(raw);
          const numMatch = raw.match(/([\d,.]+)\s*([%人次元篇天分秒]*)/);
          kpiCards.push({
            raw,
            label: raw.replace(/[\d,%人次元篇天分秒\s.]+$/, '').trim().slice(0, 40) || null,
            value: numMatch ? textNum(numMatch[1]) : null,
            unit: numMatch && numMatch[2] ? numMatch[2] : null,
            selector: sel,
          });
          if (kpiCards.length >= 20) break;
        }
        if (kpiCards.length >= 20) break;
      }

      return okResult({
        ready: true,
        login,
        subTab: { action: action || null, type: type || null, front_type: front_type || null, label: subTabLabel },
        dateFrom: dates.rangeFrom,
        dateTo: dates.rangeTo,
        singleDay: dates.singleDay,
        kpiCards,
        pagination: readPaginator(),
        tableCount: document.querySelectorAll('table').length,
        version: VERSION,
      });
    } catch (e) { return errResult(e && e.message || e, { stack: e && e.stack }); }
  }

  // ── v0.3 新增：列表全量（去 limit 默认）+ paginator ────────────────────────
  /**
   * contentListAll - 复用 contentList 表格选择 + 行过滤逻辑，但不设默认 limit，
   * 并附带 paginator 信息，供调用方判断是否需要 navigateContent 翻页。
   */
  function contentListAll(args){
    args = args || {};
    try {
      const login = readLoginState();
      if (!login.loggedIn) return errResult('not_logged_in', { login });

      const table = findTableByHeader([/内容标题|标题/, /阅读人数|阅读数|阅读/]);
      const items = [];
      if (table) {
        const rows = Array.from(table.querySelectorAll('tbody tr'));
        for (const tr of rows) {
          const tds = tr.querySelectorAll('td');
          if (tr.className) continue;
          if (tds.length !== 4) continue;
          const titleCell = tds[0];
          const titleText = (titleCell.textContent || '').replace(/\s+/g, ' ').trim();
          const titleMatch = titleText.match(/^(.*?)\s*发表时间[：:]\s*(\d{4}\/\d{2}\/\d{2})/);
          const title = shortText(titleMatch ? titleMatch[1] : titleText, 160).text;
          const publishDate = titleMatch ? titleMatch[2].replace(/\//g, '-') : null;
          const a = tr.querySelector('a[href*="action=detailpage"]');
          let msgid = null, publish_date_url = null, detailHref = null;
          if (a) {
            try {
              const u2 = new URL(a.href);
              msgid = u2.searchParams.get('msgid');
              publish_date_url = u2.searchParams.get('publish_date');
              detailHref = a.href;
            } catch(_){}
          }
          items.push({
            msgid,
            title,
            publishDate: publish_date_url || publishDate,
            reads: textNum(tds[1].textContent),
            readsRate: shortText((tds[2].textContent || '').replace(/\s+/g,' ').trim(), 80).text,
            detailHref,
          });
        }
      }

      const limit = clampLimit(args.limit, Math.min(items.length, MAX_LIST_LIMIT), MAX_LIST_LIMIT);
      const limited = items.slice(0, limit);
      return okResult({
        login,
        listTableFound: !!table,
        listHeaders: table
          ? Array.from(table.querySelectorAll('thead th')).map((th) => (th.textContent || '').replace(/\s+/g,'').trim())
          : [],
        totalCount: items.length,
        returnedCount: limited.length,
        items: limited,
        pagination: readPaginator(),
      });
    } catch (e) { return errResult(e && e.message || e, { stack: e && e.stack }); }
  }

  // ── v0.3 新增：所有表格 dump（调试/踩点用） ─────────────────────────────────
  function contentTablesDump(args){
    args = args || {};
    try {
      const limit = clampLimit(args.limit, 8, MAX_TABLE_DUMP_LIMIT);
      const rowLimit = clampLimit(args.rowLimit, 10, MAX_TABLE_ROW_LIMIT);
      const allTables = Array.from(document.querySelectorAll('table'))
        .filter((t) => t.querySelectorAll('thead th').length > 0);
      const tables = allTables.slice(0, limit);
      const tableSummaries = tables.map((t, idx) => {
        const headers = Array.from(t.querySelectorAll('thead th'))
          .map((th) => shortText((th.textContent || '').replace(/\s+/g,'').trim(), 80).text);
        const rowCount = t.querySelectorAll('tbody tr').length;
        const rows = Array.from(t.querySelectorAll('tbody tr')).slice(0, rowLimit).map((tr) =>
          Array.from(tr.querySelectorAll('td')).map((td) => shortText((td.textContent || '').replace(/\s+/g,' ').trim(), 160).text),
        );
        return { index: idx, headers, rowCount, returnedRows: rows.length, rows };
      });
      return okResult({
        totalTablesWithHead: allTables.length,
        returnedTablesWithHead: tableSummaries.length,
        totalTables: document.querySelectorAll('table').length,
        tables: tableSummaries,
      });
    } catch (e) { return errResult(e && e.message || e, { stack: e && e.stack }); }
  }

  // ── v0.3 新增：共享 XHR 调用 + scene 映射 ──────────────────────────────────
  // 来源 scene 代号 → 可读标签。未知 scene 在调用方侧回退为 `scene_<n>`。
  // 参考后台 i18n，非官方文档；改版后可能需要调整。
  const SCENE_LABELS = {
    0:    '公众号会话',
    1:    '朋友圈',
    2:    '好友转发',
    3:    '历史消息',
    4:    '看一看',
    5:    '搜一搜',
    6:    '推荐流',
    7:    '其他',
    8:    '付费内容',
    9:    '视频号',
    10:   '专辑',
    11:   'AI 搜索',
    9999: '合计',
  };
  function labelForScene(n){
    if (SCENE_LABELS[n]) return SCENE_LABELS[n];
    return 'scene_' + n;
  }

  async function fetchTendencyRaw(args){
    const range = rangeToTimestamps(args.range, args.dateFrom, args.dateTo);
    // v0.4: 当传入 msgid（可选搭配 publishDate），把端点的查询粒度从"全部图文"
    // 切到"单篇图文"。后端是否真的吃 msgid 由 Stage A 实测决定；不吃也无副作用，
    // 端点会忽略未识别参数。
    const params = {
      action: 'get_article_stat_tendency_and_source',
      begin_timestamp: String(range.beginTimestamp),
      end_timestamp: String(range.endTimestamp),
    };
    if (args && args.msgid) params.msgid = String(args.msgid);
    if (args && args.publishDate) params.publish_date = String(args.publishDate);
    const resp = await fetchCgiBin('/misc/appmsganalysis', params);
    return { range, resp, params };
  }

  /**
   * contentTrend - 日趋势（每天各 scene 的 read_uv / share_uv；scene=9999 为合计）
   */
  async function contentTrend(args){
    args = args || {};
    try {
      const login = readLoginState();
      if (!login.loggedIn) return errResult('not_logged_in', { login });
      const { range, resp, params } = await fetchTendencyRaw(args);
      if (!resp || !resp.ok || !resp.data) {
        return okResult({ ready: false, reason: 'xhr_failed', range, params, raw: summarizeCgiResponse(resp) });
      }
      const base = resp.data.base_resp || {};
      if (base.ret !== 0) {
        return okResult({ ready: false, reason: 'base_resp_err', retCode: base.ret, retMsg: base.err_msg || null, range, params });
      }
      const rawList = ((resp.data.all_article_stat_tendency || {}).list) || [];
      // 结构化成 byDate：{ [dateIso]: { total: {...}, bySceneList: [...] } }
      const byDate = {};
      for (const row of rawList){
        const ts = row.date;
        const iso = new Date(ts * 1000).toISOString().slice(0, 10);
        if (!byDate[iso]) byDate[iso] = { date: iso, timestamp: ts, total: null, scenes: [] };
        const enriched = Object.assign({}, row, { sceneLabel: labelForScene(row.scene) });
        if (row.scene === 9999) byDate[iso].total = enriched;
        else byDate[iso].scenes.push(enriched);
      }
      const seriesLimit = clampLimit(args.limit, MAX_TREND_SERIES_LIMIT, MAX_TREND_SERIES_LIMIT);
      const sceneLimit = clampLimit(args.sceneLimit, 50, 100);
      const allSeries = Object.values(byDate).sort((a, b) => a.timestamp - b.timestamp);
      const series = allSeries.slice(-seriesLimit).map((day) => Object.assign({}, day, {
        totalSceneCount: day.scenes.length,
        scenes: day.scenes.slice(0, sceneLimit),
      }));
      return okResult({
        ready: true,
        range,
        params,
        series,
        totalSeries: allSeries.length,
        returnedSeries: series.length,
        totalPoints: rawList.length,
        url: resp.url || null,
      });
    } catch (e) { return errResult(e && e.message || e, { stack: e && e.stack }); }
  }

  /**
   * contentChannelBreakdown - 时段聚合的来源/渠道分布（复用同一 XHR 响应）
   */
  async function contentChannelBreakdown(args){
    args = args || {};
    try {
      const login = readLoginState();
      if (!login.loggedIn) return errResult('not_logged_in', { login });
      const { range, resp, params } = await fetchTendencyRaw(args);
      if (!resp || !resp.ok || !resp.data) {
        return okResult({ ready: false, reason: 'xhr_failed', range, params, raw: summarizeCgiResponse(resp) });
      }
      const base = resp.data.base_resp || {};
      if (base.ret !== 0) {
        return okResult({ ready: false, reason: 'base_resp_err', retCode: base.ret, retMsg: base.err_msg || null, range, params });
      }
      const src = (resp.data.all_article_stat_source || {}).list;
      if (!Array.isArray(src) || src.length === 0) {
        return okResult({ ready: false, reason: 'no_source_in_response', range, params });
      }
      const channels = src.map((row) => Object.assign({}, row, { sceneLabel: labelForScene(row.scene) }));
      const totalReadUv = channels.reduce((s, r) => s + (Number(r.read_uv) || 0), 0);
      const withShare = channels.map((r) => Object.assign({}, r, {
        readUvShare: totalReadUv > 0 ? Number((r.read_uv / totalReadUv * 100).toFixed(2)) : null,
      }));
      const sorted = withShare.sort((a, b) => (b.read_uv || 0) - (a.read_uv || 0));
      const channelLimit = clampLimit(args.limit, 100, MAX_CHANNEL_LIMIT);
      return okResult({
        ready: true,
        range,
        params,
        totalReadUv,
        totalChannels: sorted.length,
        returnedChannels: Math.min(sorted.length, channelLimit),
        channels: sorted.slice(0, channelLimit),
        url: resp.url || null,
      });
    } catch (e) { return errResult(e && e.message || e, { stack: e && e.stack }); }
  }

  // ── v0.3 新增：INTERACTIVE 导航（仅改 URL，不模拟点击） ────────────────────
  /**
   * navigateContent - 通过 location.assign 切换筛选态 / 子 tab / 跳详情页
   *
   * 支持参数：
   *   action     -> ?action=report | all | detailpage | download_summary_tendency
   *   type       -> ?type=daily_v2 等
   *   front_type -> ?front_type=...
   *   msgid, publishDate -> 跳详情页时用
   *   clear      -> true 时把 msgid / publish_date 从 URL 中清掉（回列表）
   *
   * 不支持：点击 CTA / 触发下载 / 自动翻页。翻页请多次调用自己，带 offset/page。
   */
  // v0.4 新增：navigateContent 接受的 action / front_type 白名单
  // - action 必须是 content-analysis 自身页面接受的值；download_summary_tendency
  //   是会触发下载的写操作，被显式拒绝（与 SKILL.md 安全策略一致）
  // - front_type 当前已发现唯一合法取值是 without_notice（"未开启通知内容"）
  // - "多媒体" tab 跳到 /misc/videoanalysis 是另一个 page profile，不归 navigateContent 管
  const NAV_ALLOWED_ACTIONS = ['report', 'all', 'detailpage'];
  const NAV_ALLOWED_FRONT_TYPES = [null, '', 'without_notice'];
  const NAV_BLOCKED_ACTIONS = {
    download_summary_tendency: 'action_is_destructive',
  };

  function navigateContent(args){
    args = args || {};
    try {
      const login = readLoginState();
      if (!login.loggedIn) return errResult('not_logged_in', { login });
      const fromUrl = location.href;
      if (args.action != null) {
        if (NAV_BLOCKED_ACTIONS[args.action]) {
          return errResult('action_not_allowed', {
            allowedActions: NAV_ALLOWED_ACTIONS,
            blocked: { action: args.action, reason: NAV_BLOCKED_ACTIONS[args.action] },
          });
        }
        if (!NAV_ALLOWED_ACTIONS.includes(args.action)) {
          return errResult('action_not_allowed', {
            allowedActions: NAV_ALLOWED_ACTIONS,
            requested: args.action,
          });
        }
      }
      if (args.front_type != null && !NAV_ALLOWED_FRONT_TYPES.includes(args.front_type)) {
        return errResult('front_type_not_allowed', {
          allowedFrontTypes: NAV_ALLOWED_FRONT_TYPES.filter(Boolean),
          requested: args.front_type,
          hint: 'action=all 仅默认（已通知内容）和 without_notice（未开启通知内容）两种子 tab；其余 sub tab 走自己的 page profile。',
        });
      }
      const patch = {};
      if (args.action != null) patch.action = args.action;
      if (args.type != null) patch.type = args.type;
      if (args.front_type != null) patch.front_type = args.front_type;
      if (args.msgid != null) patch.msgid = args.msgid;
      if (args.publishDate != null) patch.publish_date = args.publishDate;
      if (args.clear) { patch.msgid = null; patch.publish_date = null; }
      if (Object.keys(patch).length === 0) {
        return okResult({ ready: false, reason: 'empty_patch', from: { url: fromUrl } });
      }
      const toUrl = buildQueryPatch(patch);
      if (toUrl === fromUrl) {
        return okResult({ ready: true, noop: true, from: { url: fromUrl }, to: { url: toUrl } });
      }
      // 只改 URL，不点击。reload 由浏览器自己做；bridge 会在新页面被自动重注。
      location.assign(toUrl);
      return okResult({
        ready: true,
        from: { url: fromUrl },
        to: { url: toUrl },
        patch,
        hint: '页面已发起导航；调用方应在新页面上再 state() 做自校验（session 层会自动重注 bridge）。',
      });
    } catch (e) { return errResult(e && e.message || e, { stack: e && e.stack }); }
  }

  // ── v0.4 内部踩点工具：detailDomDump / xhrLog ──────────────────────────────
  // 仅供 CLI 调试用，不暴露在 skill.contract.js（即不作为 AI tool）。
  // 都是纯只读：detailDomDump 一次性遍历 DOM 拿结构概览；xhrLog 直接读浏览器
  // PerformanceObserver 的 resource buffer，不 hook XMLHttpRequest / fetch。

  /**
   * detailDomDump - detailpage / 任意子页 DOM 结构快照（踩点用）
   *
   * 收集 [id*=js_]、<dl>、<table>、.data_list、[class*=card] / [class*=panel]
   * 等节点，输出 tag/class/id/textPreview/childTagCounts/hasHighcharts。
   * 同节点去重；总条数受 args.limit（默认 80，最大 200）截断。
   */
  function detailDomDump(args){
    args = args || {};
    try {
      const limit = clampLimit(args.limit, 80, 200);
      const textLimit = clampLimit(args.textLimit, 240, 2000);
      const collectAnchors = !!args.collectAnchors;
      const includeOuterHTML = !!args.includeOuterHTML;
      const htmlLimit = clampLimit(args.htmlLimit, 600, 4000);
      const selectors = [
        '[id*="js_"]',
        'dl',
        'table',
        '.data_list',
        '[class*="card"]',
        '[class*="panel"]',
        '[class*="tab_"]',
        '.bottom_data_tips',
        '.weui-desktop-tab',
        '.tendency_chart',
      ];
      const seen = new Set();
      const nodes = [];
      for (const sel of selectors) {
        try {
          const found = Array.from(document.querySelectorAll(sel));
          for (const n of found) {
            if (seen.has(n)) continue;
            seen.add(n);
            nodes.push({ node: n, matchedBy: sel });
            if (nodes.length >= limit) break;
          }
        } catch(_){}
        if (nodes.length >= limit) break;
      }
      const items = nodes.slice(0, limit).map((entry, idx) => {
        const n = entry.node;
        const tag = (n.tagName || '').toLowerCase();
        const id = n.id || null;
        const cls = (typeof n.className === 'string')
          ? n.className.replace(/\s+/g, ' ').trim().slice(0, 200)
          : null;
        const role = (n.getAttribute && n.getAttribute('role')) || null;
        const dataKeys = (n.dataset && Object.keys(n.dataset).slice(0, 8)) || [];
        const text = shortText((n.textContent || '').replace(/\s+/g, ' ').trim(), textLimit).text;
        let hasHighcharts = false;
        try { hasHighcharts = !!(n.querySelector && n.querySelector('.highcharts-container, svg.highcharts-root')); } catch(_){}
        const childTagCounts = {};
        const children = (n.children && n.children.length) ? Array.from(n.children).slice(0, 16) : [];
        for (const c of children) {
          const t = (c.tagName || '').toLowerCase();
          childTagCounts[t] = (childTagCounts[t] || 0) + 1;
        }
        let anchors;
        if (collectAnchors) {
          try {
            const aNodes = Array.from(n.querySelectorAll('a')).slice(0, 12);
            anchors = aNodes.map((a) => ({
              text: shortText((a.textContent || '').replace(/\s+/g, ' ').trim(), 60).text,
              href: shortText(a.getAttribute('href') || '', 300).text,
              cls: (typeof a.className === 'string') ? a.className.replace(/\s+/g, ' ').trim().slice(0, 120) : '',
            }));
          } catch(_) { anchors = []; }
        }
        return {
          idx,
          matchedBy: entry.matchedBy,
          tag,
          id,
          cls,
          role,
          dataKeys,
          textPreview: text,
          hasHighcharts,
          childCount: n.children ? n.children.length : 0,
          childTagCounts,
          ...(collectAnchors ? { anchors } : {}),
          ...(includeOuterHTML ? { outerHTML: shortText((n.outerHTML || '').replace(/\s+/g, ' '), htmlLimit).text } : {}),
        };
      });
      const u = new URL(location.href);
      return okResult({
        url: location.href,
        action: u.searchParams.get('action') || null,
        type: u.searchParams.get('type') || null,
        front_type: u.searchParams.get('front_type') || null,
        msgid: u.searchParams.get('msgid') || null,
        publish_date: u.searchParams.get('publish_date') || null,
        totalNodes: nodes.length,
        returnedNodes: items.length,
        items,
      });
    } catch (e) { return errResult(e && e.message || e, { stack: e && e.stack }); }
  }

  /**
   * xhrLog - 已经发过的 appmsganalysis 资源请求历史（踩点用）
   *
   * 直接读 performance.getEntriesByType('resource')，**不** hook XHR/fetch。
   * 也就是说本工具只能看到当前 buffer 里保留的请求；如果 buffer 满了
   * 浏览器会自己丢弃最老的（默认 250 条）。要看新触发的，可在浏览器侧
   * 操作页面（切日期 / 切子 tab）后再跑一次。
   */
  function xhrLog(args){
    args = args || {};
    try {
      const filterRaw = args.filter || 'mp.weixin.qq.com/misc/appmsganalysis';
      const filterRegex = (filterRaw instanceof RegExp)
        ? filterRaw
        : new RegExp(String(filterRaw).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const limit = clampLimit(args.limit, 100, 500);
      const all = (performance.getEntriesByType('resource') || [])
        .filter((e) => e && e.name && filterRegex.test(e.name));
      const byAction = {};
      for (const e of all) {
        try {
          const u = new URL(e.name);
          const a = u.searchParams.get('action') || '<no_action>';
          byAction[a] = (byAction[a] || 0) + 1;
        } catch(_){}
      }
      const records = all.slice(-limit).map((e) => {
        let parsed = null;
        try {
          const u = new URL(e.name);
          const params = {};
          let pcount = 0;
          u.searchParams.forEach((v, k) => {
            if (pcount >= 30) return;
            params[k] = v;
            pcount++;
          });
          parsed = {
            path: u.pathname,
            action: u.searchParams.get('action'),
            params,
          };
        } catch(_){}
        return {
          url: shortText(e.name, 600).text,
          initiatorType: e.initiatorType || null,
          startTime: Math.round(e.startTime || 0),
          duration: Math.round(e.duration || 0),
          transferSize: e.transferSize || null,
          parsed,
        };
      });
      return okResult({
        url: location.href,
        filter: String(filterRaw),
        totalEntries: all.length,
        returnedEntries: records.length,
        byAction,
        records,
        hint: 'performance resource buffer 仅保留最近若干条；想看新 XHR 可在浏览器里操作页面（切日期/切 tab/翻页）后再跑一次。',
      });
    } catch (e) { return errResult(e && e.message || e, { stack: e && e.stack }); }
  }

  const api = {
    probe, state, contentList, contentDetail,
    contentSummary, contentListAll, contentTablesDump,
    contentTrend, contentChannelBreakdown,
    navigateContent,
    detailDomDump, xhrLog,
  };
  Object.defineProperty(api, '__meta', {
    value: { version: VERSION, installedAt: new Date().toISOString() },
  });
  window.__jse_mp_content__ = api;
  return { ok: true, version: VERSION, installedAt: api.__meta.installedAt };
})()
