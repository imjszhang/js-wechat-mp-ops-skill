// bridges/user-analysis-bridge.js
// ---------------------------------------------------------------------------
// 公众号后台 - 用户分析 bridge
// 独立 VERSION，改方法后 bump。
//
// 暴露 window.__jse_mp_user__:
//   probe() / state() / userOverview({range, dateFrom, dateTo}) / userAttrs({range, dateFrom, dateTo})
// ---------------------------------------------------------------------------

(function install(){
  'use strict';
  const VERSION = '0.1.1';

  // @@include ./common.js

  function detectSubTab(){
    const u = new URL(location.href);
    const action = u.searchParams.get('action');
    if (!action || action === '1') return { key: 'growth', label: '用户增长', action: action || null };
    if (action === 'attr') return { key: 'attrs', label: '用户属性', action };
    if (action === 'activity_analysis_page') return { key: 'activity', label: '常读用户分析', action };
    return { key: 'unknown', label: null, action };
  }

  function probe(){
    try {
      const login = readLoginState();
      const subTab = detectSubTab();
      const dates = readDateRangeFromDom();
      const tabs = Array.from(document.querySelectorAll('.tab_nav a, .weui-desktop-tab a'))
        .slice(0, 10).map((a) => ({ text: (a.textContent || '').trim(), href: a.href }))
        .filter((x) => x.text);
      const chartContainers = Array.from(document.querySelectorAll('[id*="chart"]'))
        .slice(0, 10).map((n) => ({ id: n.id, hasHighcharts: !!n.querySelector('.highcharts-container') }));
      const tableCount = document.querySelectorAll('table').length;
      const notReadyHint = (document.body.textContent || '')
        .match(/账号关注用户数需达到\s*100/) ? 'fans_lt_100_warning_visible' : null;

      return okResult({
        url: location.href,
        page: 'user-analysis',
        subTab,
        tabs,
        login,
        dateInputs: dates,
        chartContainers,
        tableCount,
        notReadyHint,
        fingerprint: detectFingerprint() ? 'present' : null,
        version: VERSION,
      });
    } catch (e) { return errResult(e && e.message || e, { stack: e && e.stack }); }
  }

  function state(){
    try {
      const login = readLoginState();
      if (!login.loggedIn) return okResult({ ready: false, reason: 'not_logged_in', login });
      const subTab = detectSubTab();
      const dates = readDateRangeFromDom();
      return okResult({
        ready: true,
        login,
        subTab,
        dateFrom: dates.rangeFrom,
        dateTo: dates.rangeTo,
        singleDay: dates.singleDay,
        tableCount: document.querySelectorAll('table').length,
      });
    } catch (e) { return errResult(e && e.message || e); }
  }

  /**
   * userOverview - 用户增长（粉丝总数 / 新增 / 取消 / 净增 / 累计）
   *
   * 数据来源：用户增长 tab 的主表格（列：时间 / 新增关注 / 取消关注 / 净增关注 / 累计关注）。
   * 若当前 tab 不是 growth，返回 { ready: false, reason: 'wrong_subtab' }。
   */
  async function userOverview(args){
    args = args || {};
    try {
      const login = readLoginState();
      if (!login.loggedIn) return errResult('not_logged_in', { login });
      const subTab = detectSubTab();
      if (subTab.key !== 'growth') {
        return okResult({
          ready: false,
          reason: 'wrong_subtab',
          subTab,
          hint: '请把 URL 切到 /misc/useranalysis?1=1&token=<T>&lang=zh_CN（默认用户增长 tab）',
        });
      }

      const table = findTableByHeader([/时间/, /新增关注|新增/]);
      if (!table) {
        return okResult({ ready: false, reason: 'table_not_found', subTab });
      }

      const rows = parseTableByHeaders(table, {
        date: [/时间|日期/],
        newFollow: [/新增关注/],
        cancelFollow: [/取消关注/],
        netFollow: [/净增关注/],
        cumulative: [/累计关注/],
      });

      const normalized = rows.map((r) => ({
        date: r.date || null,
        newFollow: textNum(r.newFollow),
        cancelFollow: textNum(r.cancelFollow),
        netFollow: textNum(r.netFollow),
        cumulative: textNum(r.cumulative),
      }));

      // 汇总（仅对显式日期行，忽略汇总 / 合计行）；统一按日期升序，避免 DOM 表格排序差异
      const dateRows = normalized
        .filter((r) => r.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date))
        .slice()
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      const totals = dateRows.reduce((acc, r) => ({
        newFollow: acc.newFollow + (r.newFollow || 0),
        cancelFollow: acc.cancelFollow + (r.cancelFollow || 0),
        netFollow: acc.netFollow + (r.netFollow || 0),
      }), { newFollow: 0, cancelFollow: 0, netFollow: 0 });

      const earliest = dateRows.length ? dateRows[0] : null;
      const latest = dateRows.length ? dateRows[dateRows.length - 1] : null;
      const dates = readDateRangeFromDom();

      return okResult({
        ready: true,
        login,
        subTab,
        visibleRange: { from: dates.rangeFrom, to: dates.rangeTo },
        latest,
        earliest,
        totals,
        rowCount: normalized.length,
        dateRowCount: dateRows.length,
        currentCumulative: latest ? latest.cumulative : null,
        rows: normalized,
      });
    } catch (e) { return errResult(e && e.message || e, { stack: e && e.stack }); }
  }

  /**
   * userAttrs - 用户属性（性别 / 年龄 / 地域 / 终端）
   *
   * v0.1 策略：
   *   - 要求当前 URL 在 action=attr tab
   *   - 扫描页面所有 table，按表头关键词归类
   *   - 未归类的表存到 rawTables 方便后续迭代
   */
  async function userAttrs(args){
    args = args || {};
    try {
      const login = readLoginState();
      if (!login.loggedIn) return errResult('not_logged_in', { login });
      const subTab = detectSubTab();
      if (subTab.key !== 'attrs') {
        return okResult({
          ready: false,
          reason: 'wrong_subtab',
          subTab,
          hint: '请把 URL 切到 /misc/useranalysis?action=attr&token=<T>&lang=zh_CN',
        });
      }
      if ((document.body.textContent || '').match(/账号关注用户数需达到\s*100/)) {
        return okResult({ ready: false, reason: 'fans_lt_100' });
      }

      const sections = {};

      // 性别分布
      const genderTable = findTableByHeader([/性别/, /占比|比例/]);
      if (genderTable) {
        sections.gender = parseTableByHeaders(genderTable, {
          label: [/性别|分类/],
          value: [/人数|数量/],
          percent: [/占比|比例/],
        });
      }
      // 年龄分布
      const ageTable = findTableByHeader([/年龄/, /占比|比例|人数/]);
      if (ageTable && ageTable !== genderTable) {
        sections.age = parseTableByHeaders(ageTable, {
          label: [/年龄段|年龄/],
          value: [/人数|数量/],
          percent: [/占比|比例/],
        });
      }
      // 地域（省 / 城市）
      const regionTable = findTableByHeader([/省份|地区|省|城市/, /占比|比例|人数/]);
      if (regionTable && regionTable !== ageTable && regionTable !== genderTable) {
        sections.region = parseTableByHeaders(regionTable, {
          label: [/省份|地区|城市|省|区/],
          value: [/人数|数量/],
          percent: [/占比|比例/],
        });
      }
      // 终端
      const terminalTable = findTableByHeader([/终端|机型|设备/, /占比|比例|人数/]);
      if (terminalTable && terminalTable !== regionTable && terminalTable !== ageTable && terminalTable !== genderTable) {
        sections.terminal = parseTableByHeaders(terminalTable, {
          label: [/终端|机型|设备/],
          value: [/人数|数量/],
          percent: [/占比|比例/],
        });
      }

      // 收集未归类表做 rawTables（每个 label 取前 5 行）
      const knownTables = new Set([genderTable, ageTable, regionTable, terminalTable].filter(Boolean));
      const rawTables = Array.from(document.querySelectorAll('table'))
        .filter((t) => !knownTables.has(t) && t.querySelectorAll('thead th').length > 0)
        .slice(0, 6)
        .map((t) => ({
          headers: Array.from(t.querySelectorAll('thead th')).map((th) => (th.textContent || '').replace(/\s+/g,'').trim()),
          rows: Array.from(t.querySelectorAll('tbody tr')).slice(0, 5).map((tr) => Array.from(tr.querySelectorAll('td'))
            .map((td) => (td.textContent || '').replace(/\s+/g,' ').trim())),
        }));

      const dates = readDateRangeFromDom();
      return okResult({
        ready: true,
        login,
        subTab,
        visibleRange: { from: dates.rangeFrom, to: dates.rangeTo },
        sections,
        sectionsFound: Object.keys(sections),
        rawTables,
      });
    } catch (e) { return errResult(e && e.message || e, { stack: e && e.stack }); }
  }

  const api = { probe, state, userOverview, userAttrs };
  Object.defineProperty(api, '__meta', {
    value: { version: VERSION, installedAt: new Date().toISOString() },
  });
  window.__jse_mp_user__ = api;
  return { ok: true, version: VERSION, installedAt: api.__meta.installedAt };
})()
