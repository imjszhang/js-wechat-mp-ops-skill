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

const __mpOpsCommonCache = {
  tokenHref: null,
  token: null,
  fingerprintHref: null,
  fingerprint: null,
};

function clampLimit(value, defaultValue, maxValue){
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return defaultValue;
  return Math.min(Math.floor(n), maxValue);
}

function shortText(value, maxLen){
  const text = String(value == null ? '' : value);
  const limit = clampLimit(maxLen, 2000, 20000);
  if (text.length <= limit) return { text, truncated: false, length: text.length };
  return { text: text.slice(0, limit), truncated: true, length: text.length };
}

function scanInlineScripts(pattern){
  const scripts = document.querySelectorAll('script:not([src])');
  for (const script of scripts){
    const text = script.textContent || '';
    const m = pattern.exec(text);
    if (m) return m[1];
  }
  return null;
}

function detectToken(){
  const href = location.href;
  if (__mpOpsCommonCache.tokenHref === href) return __mpOpsCommonCache.token;
  let token = null;
  try {
    const t = new URLSearchParams(location.search).get('token');
    if (t && /^\d{5,}$/.test(t)) token = t;
  } catch(_){}
  if (!token) {
    try { token = scanInlineScripts(/token\s*[:=]\s*['"]?(\d{5,})/); } catch(_){}
  }
  __mpOpsCommonCache.tokenHref = href;
  __mpOpsCommonCache.token = token || null;
  return __mpOpsCommonCache.token;
}

function detectFingerprint(){
  const href = location.href;
  if (__mpOpsCommonCache.fingerprintHref === href) return __mpOpsCommonCache.fingerprint;
  let fingerprint = null;
  try {
    const entries = performance.getEntriesByType('resource') || [];
    for (const e of entries) {
      const m = /[?&]fingerprint=([0-9a-f]{16,})/i.exec(e.name);
      if (m) { fingerprint = m[1]; break; }
    }
  } catch(_){}
  if (!fingerprint) {
    try { fingerprint = scanInlineScripts(/fingerprint\s*[:=]\s*['"]([0-9a-f]{16,})['"]/i); } catch(_){}
  }
  __mpOpsCommonCache.fingerprintHref = href;
  __mpOpsCommonCache.fingerprint = fingerprint || null;
  return __mpOpsCommonCache.fingerprint;
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
  let res, data = null;
  try {
    res = await fetch(url, {
      method: options.method || 'GET',
      credentials: 'include',
      headers: Object.assign({
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json, text/javascript, */*',
      }, options.headers || {}),
    });
    const contentType = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
    if (/json|javascript/i.test(contentType)) {
      data = await res.json();
    } else {
      const snippet = shortText(await res.text(), options.textLimit || 2000);
      data = { text: snippet.text, truncated: snippet.truncated, length: snippet.length };
    }
  } catch (e) {
    return { ok: false, error: 'network_error', message: String((e && e.message) || e) };
  }
  return { ok: res.ok, httpStatus: res.status, url, data };
}

function summarizeCgiResponse(resp){
  if (!resp) return null;
  const data = resp.data;
  const out = {
    ok: !!resp.ok,
    httpStatus: resp.httpStatus || null,
    url: resp.url || null,
  };
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    out.base_resp = data.base_resp || null;
    out.dataKeys = Object.keys(data).slice(0, 20);
    const tendencyList = data.all_article_stat_tendency && data.all_article_stat_tendency.list;
    const sourceList = data.all_article_stat_source && data.all_article_stat_source.list;
    if (Array.isArray(tendencyList)) out.tendencyCount = tendencyList.length;
    if (Array.isArray(sourceList)) out.sourceCount = sourceList.length;
    if (typeof data.text === 'string') out.text = shortText(data.text, 512);
  } else if (typeof data === 'string') {
    out.text = shortText(data, 512);
  }
  if (resp.error) out.error = resp.error;
  if (resp.message) out.message = resp.message;
  return out;
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

function parseTableByHeaders(table, headerMap, options){
  if (!table) return [];
  options = options || {};
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
  const rows = Array.from(table.querySelectorAll('tbody tr'))
    .slice(0, clampLimit(options.rowLimit, 1000, 5000));
  return rows.map((tr) => {
    const tds = Array.from(tr.querySelectorAll('td'));
    const row = { __raw: tds.map((td) => shortText((td.textContent || '').replace(/\s+/g,' ').trim(), 160).text) };
    for (const k of Object.keys(colIdx)){
      const td = tds[colIdx[k]];
      if (!td) continue;
      row[k] = shortText((td.textContent || '').replace(/\s+/g,' ').trim(), 160).text;
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
