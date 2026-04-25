// bridges/common.js
// ---------------------------------------------------------------------------
// 本文件是纯浏览器代码，不要被 Node require。
// 每个 bridge 文件的顶部包含一行：
//   // @@include ./common.js
// session.js 在注入 bridge 前会把这一行替换为本文件全部内容，从而实现 helpers 单一来源。
// ---------------------------------------------------------------------------

function parseTokenFromUrl(url){
  try { return new URL(url).searchParams.get('token'); } catch(_) { return null; }
}

function detectToken(){
  try {
    const t = new URLSearchParams(location.search).get('token');
    if (t && /^\d{5,}$/.test(t)) return t;
  } catch(_){}
  try {
    const scripts = Array.from(document.querySelectorAll('script:not([src])'))
      .map(s => s.textContent).join('\n');
    const m = /token\s*[:=]\s*['"]?(\d{5,})/.exec(scripts);
    if (m) return m[1];
  } catch(_){}
  return null;
}

function detectFingerprint(){
  try {
    const entries = performance.getEntriesByType('resource') || [];
    for (const e of entries) {
      const m = /[?&]fingerprint=([0-9a-f]{16,})/i.exec(e.name);
      if (m) return m[1];
    }
  } catch(_){}
  try {
    const scripts = Array.from(document.querySelectorAll('script:not([src])'))
      .map(s => s.textContent).join('\n');
    const m = /fingerprint\s*[:=]\s*['"]([0-9a-f]{16,})['"]/i.exec(scripts);
    if (m) return m[1];
  } catch(_){}
  return null;
}

function buildCgiUrl(path, params){
  const token = detectToken();
  const fingerprint = detectFingerprint();
  const q = new URLSearchParams(Object.assign({}, params || {}));
  if (token && !q.get('token')) q.set('token', token);
  if (!q.get('lang')) q.set('lang', 'zh_CN');
  if (!q.get('f')) q.set('f', 'json');
  if (!q.get('ajax')) q.set('ajax', '1');
  if (fingerprint && !q.get('fingerprint')) q.set('fingerprint', fingerprint);
  return 'https://mp.weixin.qq.com' + path + '?' + q.toString();
}

async function fetchCgiBin(path, params, options){
  options = options || {};
  const token = detectToken();
  if (!token && options.requireToken !== false) {
    return { ok: false, error: 'not_logged_in', reason: 'no_token_in_url' };
  }
  const url = buildCgiUrl(path, params || {});
  let res, txt;
  try {
    res = await fetch(url, {
      method: options.method || 'GET',
      credentials: 'include',
      headers: Object.assign({
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json, text/javascript, */*',
      }, options.headers || {}),
    });
    txt = await res.text();
  } catch (e) {
    return { ok: false, error: 'network_error', message: String((e && e.message) || e) };
  }
  let data = null;
  try { data = JSON.parse(txt); } catch(_) { data = txt; }
  return { ok: res.ok, httpStatus: res.status, url, data };
}

function readAccountInfo(){
  const candidates = [
    '.weui-desktop-account__nickname',
    '.weui-desktop-account__info .nickname',
    '.weui-desktop-account__profile .weui-desktop-account__nickname',
    '.weui-desktop-account_switch .weui-desktop-account__nickname',
    '.account_nickname',
    '.acct_nickname_wrp',
    '.account_name',
    '.weui-desktop-account__mobile-name',
    '[class*="account"][class*="nickname"]',
  ];
  for (const s of candidates){
    const n = document.querySelector(s);
    if (n && n.textContent) {
      const t = n.textContent.replace(/\s+/g,' ').trim();
      if (t) return t.slice(0, 80);
    }
  }
  return null;
}

/**
 * readPaginator - 通用分页信息解析（失败返回 null，不抛）
 * 尝试解析 weui-desktop-pagination / 兼容旧 pagination 结构
 */
function readPaginator(){
  const containers = Array.from(document.querySelectorAll(
    '.weui-desktop-pagination, .pagination, [class*="pagination"]'
  ));
  for (const c of containers){
    const text = (c.textContent || '').replace(/\s+/g, '');
    if (!text) continue;
    const total = /共(\d+)[条项]/.exec(text);
    const totalPages = /共(\d+)页/.exec(text);
    const currentLi = c.querySelector('.weui-desktop-pagination__num_current, .current, .active');
    const numLis = Array.from(c.querySelectorAll('.weui-desktop-pagination__num, li a, a'))
      .map((a) => (a.textContent || '').trim())
      .filter((t) => /^\d+$/.test(t));
    const current = currentLi
      ? parseInt((currentLi.textContent || '').trim(), 10)
      : null;
    if (total || totalPages || numLis.length) {
      return {
        totalItems: total ? parseInt(total[1], 10) : null,
        totalPages: totalPages ? parseInt(totalPages[1], 10)
          : (numLis.length ? parseInt(numLis[numLis.length - 1], 10) : null),
        currentPage: Number.isFinite(current) ? current : null,
        rawText: text.slice(0, 200),
      };
    }
  }
  return null;
}

/**
 * buildQueryPatch - 基于 location.search 合并 patch，产出新的 URL（不触网、不导航）
 *   - null / undefined 值 => 删除该 key
 *   - 其他值 => 强制转 String 写入
 * 调用方负责决定是否 location.assign(newUrl)。
 */
function buildQueryPatch(patch){
  const u = new URL(location.href);
  const p = u.searchParams;
  const input = patch || {};
  for (const k of Object.keys(input)){
    const v = input[k];
    if (v == null || v === '') {
      p.delete(k);
    } else {
      p.set(k, String(v));
    }
  }
  return u.origin + u.pathname + '?' + p.toString();
}

function readLoginState(){
  const token = detectToken();
  const path = location.pathname || '';
  const isLoginPath = /^\/(misc|cgi-bin)\/(login|biz[a-z]*login)/i.test(path);
  const hasShell = (document.body.className || '').includes('weui-desktop-page_base');
  const nickname = readAccountInfo();
  const loggedIn = !!token && !isLoginPath && hasShell;
  return {
    loggedIn,
    token: token ? (token.length > 3 ? token.slice(0,2) + '***' + token.slice(-2) : '***') : null,
    path,
    nickname,
    reasons: {
      hasToken: !!token,
      notOnLoginPath: !isLoginPath,
      hasDesktopShell: hasShell,
    },
  };
}

function textNum(s){
  if (s == null) return null;
  const cleaned = String(s).replace(/[,，\s]/g,'').replace(/[^-\d.eE+]/g,'');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseTableByHeaders(table, headerMap){
  if (!table) return [];
  const ths = Array.from(table.querySelectorAll('thead th'));
  const colIdx = {};
  for (const k of Object.keys(headerMap || {})){
    const candidates = headerMap[k];
    const pats = (Array.isArray(candidates) ? candidates : [candidates])
      .map((c) => c instanceof RegExp ? c : new RegExp(c));
    const idx = ths.findIndex((th) => {
      const txt = (th.textContent || '').replace(/\s+/g,'').trim();
      return pats.some((p) => p.test(txt));
    });
    if (idx >= 0) colIdx[k] = idx;
  }
  const rows = Array.from(table.querySelectorAll('tbody tr'));
  return rows.map((tr) => {
    const tds = Array.from(tr.querySelectorAll('td'));
    const row = { __raw: tds.map((td) => (td.textContent || '').replace(/\s+/g,' ').trim()) };
    for (const k of Object.keys(colIdx)){
      const td = tds[colIdx[k]];
      if (!td) continue;
      row[k] = (td.textContent || '').replace(/\s+/g,' ').trim();
    }
    return row;
  });
}

function findTableByHeader(keywordPatterns){
  const patterns = (Array.isArray(keywordPatterns) ? keywordPatterns : [keywordPatterns])
    .map((p) => p instanceof RegExp ? p : new RegExp(p));
  const tables = Array.from(document.querySelectorAll('table'));
  for (const t of tables){
    const headers = Array.from(t.querySelectorAll('thead th'))
      .map((th) => (th.textContent || '').replace(/\s+/g,'').trim());
    if (!headers.length) continue;
    if (patterns.every((p) => headers.some((h) => p.test(h)))) return t;
  }
  return null;
}

function rangeToTimestamps(range, dateFrom, dateTo){
  const toTs = (d) => Math.floor(new Date(d + 'T00:00:00+08:00').getTime() / 1000);
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2,'0');
  const dd = String(today.getDate()).padStart(2,'0');
  const todayStr = `${yyyy}-${mm}-${dd}`;
  let from = dateFrom || null;
  let to = dateTo || todayStr;
  if (!from) {
    let days = 30;
    if (range === '7d') days = 7;
    else if (range === '30d') days = 30;
    else if (range === '90d') days = 90;
    const d = new Date(today);
    d.setDate(d.getDate() - (days - 1));
    const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
    from = `${y}-${m}-${day}`;
  }
  return {
    dateFrom: from,
    dateTo: to,
    beginTimestamp: toTs(from),
    endTimestamp: toTs(to) + 86399,
  };
}

function readDateRangeFromDom(){
  const inputs = Array.from(document.querySelectorAll('input.weui-desktop-form__input'));
  const start = inputs.find((i) => /^\d{4}-\d{2}-\d{2}$/.test(i.value || '') && /开始/.test(i.placeholder || ''));
  const end = inputs.find((i) => /^\d{4}-\d{2}-\d{2}$/.test(i.value || '') && /结束/.test(i.placeholder || ''));
  const single = inputs.find((i) => /^\d{4}-\d{2}-\d{2}$/.test(i.value || '') && /请选择/.test(i.placeholder || ''));
  return {
    rangeFrom: (start && start.value) || null,
    rangeTo: (end && end.value) || null,
    singleDay: (single && single.value) || null,
  };
}

function okResult(data){ return { ok: true, data }; }
function errResult(error, extra){ return Object.assign({ ok: false, error: String(error) }, extra || {}); }
