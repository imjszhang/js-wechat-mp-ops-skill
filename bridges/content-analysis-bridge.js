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
  const VERSION = '0.1.3';

  // @@include ./common.js

  function probe(){
    try {
      const login = readLoginState();
      const u = new URL(location.href);
      const action = u.searchParams.get('action');
      const type = u.searchParams.get('type');
      const fontType = u.searchParams.get('front_type');
      const tabLabels = {
        report: '已发表内容',
        all: action === 'all' && !fontType ? '全部' : action === 'all' ? '未开启通知内容' : null,
        detailpage: '单篇详情',
        download_summary_tendency: '下载数据明细',
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
          const title = titleMatch ? titleMatch[1] : titleText;
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
            readsRate: (tds[2].textContent || '').replace(/\s+/g,' ').trim(),
            detailHref,
          });
        }
      }

      const limit = args.limit ? Number(args.limit) : null;
      const limited = limit ? items.slice(0, limit) : items;

      // 可选：XHR 趋势 + 来源
      let tendency = null;
      if (args.range || args.dateFrom || args.dateTo) {
        const resp = await fetchCgiBin('/misc/appmsganalysis', {
          action: 'get_article_stat_tendency_and_source',
          begin_timestamp: String(range.beginTimestamp),
          end_timestamp: String(range.endTimestamp),
        });
        tendency = resp;
      }

      return okResult({
        login,
        range,
        listTableFound: !!table,
        listHeaders: table
          ? Array.from(table.querySelectorAll('thead th')).map((th) => (th.textContent || '').replace(/\s+/g,'').trim())
          : [],
        totalCount: items.length,
        items: limited,
        tendency,
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
        // ── 顶部 KPI（阅读、完读率、平均阅读时长、阅读后关注、听全文 等） ──────────
        const topTipsMap = {
          reads: [/^阅读\s/],
          avgReadSecs: [/平均阅读时长/],
          finishRate: [/完读率/],
          followAfterRead: [/阅读后关注/],
          listenCount: [/听全文/],
        };
        const tipEls = Array.from(document.querySelectorAll('.bottom_data_tips'));
        const topKpis = {};
        const topKpisRaw = tipEls.map((el) => {
          const raw = (el.textContent || '').replace(/\s+/g,' ').trim();
          const val = (el.querySelector('.tips_val_num')?.textContent || '').trim();
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

        // ── 互动指标（data_list：分享 / 赞赏 / 留言 / 收藏 等） ───────────────────
        const interactions = Array.from(document.querySelectorAll('.data_list')).map((row) => {
          const label = (row.querySelector('.list_left')?.textContent || '').replace(/\s+/g,' ').trim();
          const value = (row.querySelector('.list_right .data_num')?.textContent || '').trim();
          const unit = (row.querySelector('.list_right .data_unit')?.textContent || '').replace(/\s+/g,' ').trim();
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
        for (const row of interactions) {
          if (!row.label) continue;
          const key = labelToKey[row.label] || row.label;
          if (!(key in interactionMap)) interactionMap[key] = row.value;
        }

        // ── 地域/来源/终端 表格（只取有 thead 的） ─────────────────────────────
        const tables = Array.from(document.querySelectorAll('table'))
          .filter((t) => t.querySelectorAll('thead th').length > 0)
          .slice(0, 8);
        const tableSummaries = tables.map((t) => {
          const headers = Array.from(t.querySelectorAll('thead th'))
            .map((th) => (th.textContent || '').replace(/\s+/g,'').trim());
          const rowCount = t.querySelectorAll('tbody tr').length;
          const rows = Array.from(t.querySelectorAll('tbody tr')).slice(0, 10).map((tr) =>
            Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent || '').replace(/\s+/g,' ').trim()),
          );
          return { headers, rowCount, rows };
        });

        const title = (document.title || '').replace(/公众号|内容分析/g, '').trim() || null;

        return okResult({
          login,
          mode: 'in_detail_page',
          msgid: curMsgid,
          publish_date: curDate,
          title,
          kpis: topKpis,
          kpisRaw: topKpisRaw,
          interactions,
          interactionMap,
          tableSummaries,
        });
      }

      // 非详情页：返回候选 detail 链接，告诉调用方先导航
      const candidates = Array.from(document.querySelectorAll('a[href*="action=detailpage"]'))
        .map((a) => {
          try {
            const u2 = new URL(a.href);
            return {
              msgid: u2.searchParams.get('msgid'),
              publish_date: u2.searchParams.get('publish_date'),
              href: a.href,
              text: (a.textContent || '').trim().slice(0, 30),
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
        candidates: candidates.slice(0, 20),
      });
    } catch (e) { return errResult(e && e.message || e, { stack: e && e.stack }); }
  }

  const api = { probe, state, contentList, contentDetail };
  Object.defineProperty(api, '__meta', {
    value: { version: VERSION, installedAt: new Date().toISOString() },
  });
  window.__jse_mp_content__ = api;
  return { ok: true, version: VERSION, installedAt: api.__meta.installedAt };
})()
