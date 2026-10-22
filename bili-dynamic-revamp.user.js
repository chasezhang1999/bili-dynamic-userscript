// ==UserScript==
// @name         B站动态页重构：关注列表 + 新视频墙
// @namespace    chase.bili-dynamic-revamp
// @version      1.3.0
// @description  t.bilibili.com 动态首页：横排头像换成 YouTube 式关注列表（放在左侧原「正在直播」处）；新视频集中成一面墙，优先关注的 UP 排最前；直播收进右侧折叠卡片。播放页顶栏加 YouTube 式可展开的关注菜单。全站顶栏精简。
// @author       Chase
// @match        https://t.bilibili.com/*
// @match        https://www.bilibili.com/*
// @match        https://search.bilibili.com/*
// @match        https://space.bilibili.com/*
// @icon         https://www.bilibili.com/favicon.ico
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-start
// @noframes
// ==/UserScript==

/*
 * 三种页面：
 *   动态页（t.bilibili.com/）                  完整布局：左侧关注列表、中间新视频墙、右侧直播卡片
 *   播放页（www.bilibili.com/video/、/list/）  顶栏最左边加一个 ≡，点开是同一份关注列表（抽屉）
 *   其余 B 站页面                              只精简顶栏（纯 CSS）
 *   动态页和播放页共用油猴存储里的缓存（关注、视频、观看历史、优先关注），在哪边刷新过另一边都能直接用。
 *
 * 代码结构（从上到下）：
 *   1. 小工具、存储、设置      优先关注、已看记录、各种缓存都存在油猴自己的存储里（换浏览器不跟着走）
 *   2. 接口与数据加载          全是 B 站网页版自己在用的接口，带登录 cookie 直接请求
 *                              关注列表缓存最多 2 小时，关注数一变就重拉；视频动态增量拉取
 *   3. 计算                    哪些视频算「新」、每个 UP 有几个新视频、排序
 *   4. 操作                    标为已看、优先关注（同步 B 站特别关注）、切换 UP
 *   5. 渲染                    关注列表 / 新视频墙 / 直播卡片 / 播放页抽屉 / 设置弹窗
 *   6. 挂载                    等 B 站页面画好后插进去；原生的横排头像、直播栏等用 CSS 藏起来
 *
 * 「新视频」= 最近 N 天发布 + 不在观看历史里（手机上看过也算看过）+ 没在这里点开过 / 标为已看过。
 * 第一次安装时只把最近 24 小时的算作新视频。
 */

(function () {
  'use strict';

  if (window.top !== window.self) return;
  // dyn = 动态首页；play = 视频播放页；other = 其余 B 站页面（含动态详情页 t.bilibili.com/123…），只精简顶栏
  const PAGE = location.hostname === 't.bilibili.com' && /^\/?$/.test(location.pathname) ? 'dyn'
    : location.hostname === 'www.bilibili.com' && /^\/(video|list)\//.test(location.pathname) ? 'play'
    : 'other';
  // 调试时重复注入：先拆掉上一份
  if (typeof window.__bdrTeardown === 'function') { try { window.__bdrTeardown(); } catch (e) { /* 忽略 */ } }

  /* ========================= 1. 小工具、存储、设置 ========================= */

  const VERSION = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '1.3.0';
  const LOG = '[动态页重构]';
  const API = 'https://api.bilibili.com';
  const WL = 'web_location=333.1365';
  const FEED = `/x/polymer/web-dynamic/v1/feed/all?timezone_offset=-480&type=video&platform=web&features=itemOpusStyle&${WL}`;
  const CARD_MIN = 200; // 视频卡片最小宽度，和 CSS 里的 minmax(200px, 1fr) 一致
  const CARD_GAP = 12;

  const now = () => Math.floor(Date.now() / 1000);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const pad = n => String(n).padStart(2, '0');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function img(url, spec) {
    if (!url) return '';
    url = String(url).replace(/^http:\/\//, 'https://');
    if (url.startsWith('//')) url = 'https:' + url;
    return url.split('/').pop().includes('@') ? url : `${url}@${spec}.webp`;
  }
  function fmtNum(x) {
    const s = String(x == null ? '' : x).trim();
    if (!/^\d+$/.test(s)) return s || '-';
    const n = Number(s);
    if (n >= 1e8) return (n / 1e8).toFixed(1).replace(/\.0$/, '') + '亿';
    if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, '') + '万';
    return s;
  }
  const hm = ts => { const d = new Date(ts * 1000); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  const fullTime = ts => { const d = new Date(ts * 1000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm(ts)}`; };
  function ago(ts) {
    const d = now() - ts;
    if (d < 60) return '刚刚';
    if (d < 3600) return Math.floor(d / 60) + '分钟前';
    if (d < 86400) return Math.floor(d / 3600) + '小时前';
    const y = new Date(); y.setDate(y.getDate() - 1);
    if (new Date(ts * 1000).toDateString() === y.toDateString()) return '昨天 ' + hm(ts);
    if (d < 7 * 86400) return Math.floor(d / 86400) + '天前';
    const t = new Date(ts * 1000);
    return `${t.getMonth() + 1}-${t.getDate()}`;
  }

  // 装了油猴用油猴的存储；调试时直接注入页面就退回 localStorage
  const hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
  const store = {
    get(key, def) {
      try {
        if (hasGM) { const v = GM_getValue(key); return v === undefined || v === null ? def : v; }
        const raw = localStorage.getItem('bdr:' + key);
        return raw == null ? def : JSON.parse(raw);
      } catch (e) { return def; }
    },
    set(key, val) {
      try {
        if (hasGM) GM_setValue(key, val);
        else localStorage.setItem('bdr:' + key, JSON.stringify(val));
      } catch (e) { console.warn(LOG, '存储失败', key, e); }
    },
  };

  const DEFAULTS = {
    windowDays: 3, // 新视频看最近几天
    starToSpecial: true, // 点 ☆ 时同时设为 / 取消 B 站特别关注
    syncSpecial: true, // B 站「特别关注」自动算优先关注
    useHistory: true, // 观看历史里有的不算新
    mergeUp: true, // 「新视频」里同一 UP 的多个视频合并成一张卡
    hideCharge: false, // 隐藏充电专属
    hidePublish: true, // 隐藏「发动态」输入框
    hideLiveCards: true, // 动态流里隐藏「直播了」卡片
    hideBanner: true, // 隐藏右侧「社区中心」横幅
    hideOldBtn: true, // 隐藏右下角「回到旧版」
    slimHeader: true, // 全站顶栏去掉游戏中心、会员购、赛事、活动入口、下载客户端、创作中心、投稿
    playDrawer: true, // 播放页顶栏最左边加 ≡ 关注菜单
    livePlace: 'right', // right 右侧折叠 / hide 隐藏 / native 放回原位
    wallRows: 2, // 新视频墙折叠时显示几行
    allSort: 'attention', // 其他关注排序：attention 最常访问 / recent 最近投稿 / follow 最近关注
    autoRefresh: 10, // 分钟，0 = 关
  };
  const settings = Object.assign({}, DEFAULTS, store.get('settings', {}));
  const saveSettings = () => store.set('settings', settings);

  let priority = store.get('priority', {}); // 手动设的优先关注 mid -> {uname, face, t}
  let priorityOff = store.get('priorityOff', {}); // 特别关注里被手动取消优先的 mid -> 1
  let seen = store.get('seen', {}); // 点开过 / 标为已看的视频 bvid -> 时间
  let clearedAt = store.get('clearedAt', 0); // 早于这个时间发布的都不算新（第一次安装 = 24 小时前）
  if (!clearedAt) { clearedAt = now() - 86400; store.set('clearedAt', clearedAt); }

  const S = {
    me: '',
    follows: new Map(), // mid -> {mid, uname, face, mtime, sp, tags, rank}
    tags: [], // 关注分组 [{id, name, count}]
    upList: [], // B 站原生「最近更新」横排里的 UP
    hasUpdate: new Set(), // 原生横排里带蓝点的 UP
    live: [], liveCount: 0, liveMap: new Map(),
    videos: [], // 最近 N 天关注 UP 的视频（按发布时间倒序）
    history: new Map(), // bvid -> {p 进度秒, d 时长秒, at}
    upVideos: new Map(), // 单个 UP 的最近投稿
    activeMid: null, // 正在看哪个 UP
    activeTag: store.get('activeTag', null), // 分组筛选
    wallMode: 'new', // new 只看新视频 / all 最近 N 天全部
    wallExpanded: false,
    wallCollapsed: store.get('wallCollapsed', false),
    liveOpen: store.get('liveOpen', false),
    search: '', allExpanded: false,
    keep: new Set(), // 本次点开过的视频：先留在墙上（变暗），下次刷新再拿掉，免得卡片乱跳
    loading: new Set(), errors: {}, feedPage: 0,
    followingCount: null, // 个人信息里的关注数：和上次拉关注列表时不一样，就说明关注 / 取关过
    pending: new Set(), // 正在写 B 站特别关注的 UP
    drawerOpen: false,
    playing: '', // 播放页上正在放的视频（B 站切合集、自动连播时不刷新页面，只改地址）
    lastRefresh: 0, refreshing: false, baseTitle: '',
    el: {}, timers: [], dead: false,
  };

  /* ========================= 2. 接口与数据加载 ========================= */

  async function api(path) {
    const res = await fetch(path.startsWith('http') ? path : API + path, { credentials: 'include' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    if (j.code !== 0) throw new Error(`${j.message || j.msg || '接口报错'}（${j.code}）`);
    return j.data || {};
  }
  async function apiPost(path, data) {
    const csrf = (document.cookie.match(/(?:^|;\s*)bili_jct=([^;]+)/) || [])[1];
    if (!csrf) throw new Error('没读到登录凭证，刷新页面再试');
    const res = await fetch(API + path, { method: 'POST', credentials: 'include', body: new URLSearchParams(Object.assign({}, data, { csrf })) });
    const j = await res.json();
    if (j.code !== 0) throw new Error(j.message || ('错误 ' + j.code));
    return j.data;
  }

  const horizon = () => now() - settings.windowDays * 86400;

  function normVideo(it) {
    const m = (it && it.modules) || {};
    const a = m.module_author || {};
    const ar = ((m.module_dynamic || {}).major || {}).archive;
    if (!ar || !ar.bvid) return null;
    const st = ar.stat || {};
    return {
      id: String(it.id_str || ar.bvid), bvid: ar.bvid, aid: String(ar.aid || ''),
      title: ar.title || '', cover: ar.cover || '', dur: ar.duration_text || '',
      play: st.play || '', dm: st.danmaku || '', badge: (ar.badge && ar.badge.text) || '',
      mid: String(a.mid || ''), uname: a.name || '', face: a.face || '',
      ts: Number(a.pub_ts) || 0,
    };
  }

  // 视频动态：和缓存接上就停（平时只拉 1 页）；缓存覆盖不到时间范围时整段重拉
  async function loadFeed() {
    const cache = store.get('videos', null);
    const valid = !!(cache && cache.mid === S.me && Array.isArray(cache.items));
    const old = valid ? cache.items : [];
    const known = new Set(old.map(v => v.id));
    const hz = horizon();
    const full = !valid || !(cache.from <= hz + 3600);
    const fresh = [];
    let offset = '', page = 1, oldest = Infinity, overlapped = false, exhausted = false, capped = false;
    for (;;) {
      const d = await api(FEED + '&page=' + page + (offset ? '&offset=' + encodeURIComponent(offset) : ''));
      const items = d.items || [];
      for (const it of items) {
        const v = normVideo(it);
        if (!v) continue;
        if (known.has(v.id)) overlapped = true;
        fresh.push(v);
        if (v.ts && v.ts < oldest) oldest = v.ts;
      }
      if (!full && overlapped) break;
      if (!items.length || !d.has_more || !d.offset) { exhausted = true; break; }
      if (oldest < hz) break;
      if (page >= 30) { capped = true; break; } // 关注的人太多翻不完：到此为止
      offset = d.offset; page++;
      S.feedPage = page; renderSoon();
      await sleep(300);
    }
    let from;
    if (!full && overlapped) from = cache.from;
    else if (exhausted) from = 0;
    else if (capped) from = hz;
    else from = oldest;
    const map = new Map(old.map(v => [v.id, v]));
    for (const v of fresh) map.set(v.id, v);
    const keepFrom = hz - 86400; // 多留一天，范围改小再改回来不用重拉
    const items = [...map.values()].filter(v => v.ts >= keepFrom).sort((a, b) => b.ts - a.ts).slice(0, 1500);
    store.set('videos', { mid: S.me, at: now(), from: Math.max(from, keepFrom), items });
    S.videos = items;
    S.feedPage = 0;
  }

  // 「最近更新」横排（带蓝点）+ 正在直播 + 自己的关注数
  async function loadPortal() {
    const d = await api(`/x/polymer/web-dynamic/v1/portal?up_list_more=1&${WL}`);
    const lu = d.live_users || {};
    const live = (lu.items || []).map(x => ({
      mid: String(x.mid), uname: x.uname, face: x.face, title: x.title || '',
      url: x.jump_url || ('https://live.bilibili.com/' + x.room_id),
    }));
    const c = {
      mid: S.me, at: now(),
      upList: ((d.up_list && d.up_list.items) || []).map(x => ({ mid: String(x.mid), uname: x.uname, face: x.face, has: !!x.has_update })),
      live, liveCount: lu.count || live.length,
    };
    const fc = Number(d.my_info && d.my_info.following); // 接口给的是字符串 "199"
    S.followingCount = Number.isFinite(fc) ? fc : null;
    store.set('portal', c);
    applyPortal(c);
  }
  function applyPortal(c) {
    S.upList = c.upList || [];
    S.hasUpdate = new Set(S.upList.filter(x => x.has).map(x => x.mid));
    S.live = c.live || [];
    S.liveCount = c.liveCount || S.live.length;
    S.liveMap = new Map(S.live.map(x => [x.mid, x]));
  }

  // 全部关注（按「最常访问」排）+ 关注分组。缓存最多 2 小时；关注数一变（关注 / 取关了谁）就立刻重拉
  async function loadFollows(force) {
    const c = store.get('follows', null);
    const valid = !!(c && c.mid === S.me && Array.isArray(c.list));
    const changed = valid && S.followingCount != null && c.portalCount !== S.followingCount; // 旧缓存没记关注数，也重拉一次
    if (!force && valid && !changed && now() - c.at < 2 * 3600) { applyFollows(c); return; }
    const list = [];
    for (let pn = 1; pn <= 50; pn++) {
      const d = await api(`/x/relation/followings?vmid=${S.me}&pn=${pn}&ps=50&order=desc&order_type=attention`);
      const arr = d.list || [];
      for (const x of arr) {
        list.push({ mid: String(x.mid), uname: x.uname, face: x.face, mtime: x.mtime || 0, sp: x.special ? 1 : 0, tags: (x.tag || []).map(Number) });
      }
      if (arr.length < 50 || list.length >= (d.total || 0)) break;
      await sleep(250);
    }
    let tags = [];
    try { tags = (await api('/x/relation/tags')).map(t => ({ id: Number(t.tagid), name: t.name, count: t.count || 0 })); } catch (e) { /* 分组拿不到不影响主功能 */ }
    const data = { mid: S.me, at: now(), list, tags, portalCount: S.followingCount };
    if (valid) { // 取关了的人：连同 TA 的视频、优先标记一起清掉
      const still = new Set(list.map(f => f.mid));
      const gone = c.list.filter(f => !still.has(f.mid)).map(f => f.mid);
      if (gone.length) purgeUps(gone);
    }
    store.set('follows', data);
    applyFollows(data);
  }
  function purgeUps(mids) {
    const gone = new Set(mids);
    S.videos = S.videos.filter(v => !gone.has(v.mid));
    const vc = store.get('videos', null);
    if (vc && Array.isArray(vc.items)) { vc.items = vc.items.filter(v => !gone.has(v.mid)); store.set('videos', vc); }
    for (const m of gone) { delete priority[m]; delete priorityOff[m]; S.upVideos.delete(m); }
    store.set('priority', priority);
    store.set('priorityOff', priorityOff);
    if (S.activeMid && gone.has(S.activeMid)) S.activeMid = null;
  }
  function applyFollows(c) {
    S.follows = new Map(c.list.map((f, i) => [f.mid, Object.assign({ rank: i }, f)]));
    S.tags = c.tags || [];
    // 筛选的分组没了、或者人都移走了（空分组不显示标签，筛选会卡住看不出来）：回到全部
    if (S.activeTag != null && S.tags.length && !S.tags.some(t => t.id === S.activeTag && t.count > 0)) {
      S.activeTag = null; store.set('activeTag', null);
    }
  }

  // 观看历史：只用来判断「看过没」和画进度条，同样和缓存接上就停
  async function loadHistory() {
    if (!settings.useHistory) { S.history = new Map(); return; }
    const c = store.get('history', null);
    const map = (c && c.mid === S.me && c.map) ? c.map : {};
    const stopAt = horizon() - 86400;
    let max = 0, viewAt = 0, business = '';
    for (let i = 0; i < 6; i++) {
      const d = await api(`/x/web-interface/history/cursor?ps=30&type=archive&max=${max}&view_at=${viewAt}${business ? '&business=' + business : ''}`);
      const list = d.list || [];
      let overlap = false;
      for (const h of list) {
        const bv = h.history && h.history.bvid;
        if (!bv) continue;
        if (map[bv] && map[bv].at === h.view_at) overlap = true;
        map[bv] = { p: h.progress, d: h.duration, at: h.view_at };
      }
      const last = list[list.length - 1];
      if (!last || overlap || !d.cursor || !d.cursor.max || last.view_at < stopAt) break;
      max = d.cursor.max; viewAt = d.cursor.view_at; business = d.cursor.business || '';
      await sleep(250);
    }
    for (const k of Object.keys(map)) if (map[k].at < stopAt) delete map[k];
    store.set('history', { mid: S.me, map });
    S.history = new Map(Object.entries(map));
  }

  // 单个 UP 的最近投稿（点左侧列表里的 UP 时用）
  async function loadUpVideos(mid, force) {
    const cur = S.upVideos.get(mid);
    if (cur && cur.loading) return;
    if (!force && cur && cur.items && now() - cur.at < 300) return;
    S.upVideos.set(mid, Object.assign({}, cur, { loading: true, error: '' }));
    renderSoon();
    try {
      const d = await api(FEED + '&host_mid=' + mid + '&page=1');
      S.upVideos.set(mid, { items: (d.items || []).map(normVideo).filter(Boolean), at: now() });
    } catch (e) {
      S.upVideos.set(mid, Object.assign({}, cur, { loading: false, error: (e && e.message) || String(e) }));
    }
    renderSoon();
  }

  const TASK_NAMES = { portal: '直播和更新列表', follows: '关注列表', history: '观看历史', feed: '视频动态' };
  async function task(name, fn) {
    S.loading.add(name); renderSoon();
    try { await fn(); delete S.errors[name]; }
    catch (e) { S.errors[name] = (e && e.message) || String(e); console.warn(LOG, TASK_NAMES[name] || name, e); }
    finally { S.loading.delete(name); renderSoon(); }
  }

  // manual = 点了刷新按钮：关注列表也强制重拉
  async function refresh(manual) {
    if (S.refreshing || S.dead) return;
    S.refreshing = true;
    S.keep.clear();
    await task('portal', loadPortal); // 先拿到关注数，才知道关注列表要不要重拉
    await task('follows', () => loadFollows(!!manual)); // 先清掉取关的人，再拉视频
    await Promise.all([task('history', loadHistory), task('feed', loadFeed)]);
    if (S.activeMid) loadUpVideos(S.activeMid, true);
    S.refreshing = false;
    S.lastRefresh = now();
    store.set('lastRefreshAt', S.lastRefresh);
    renderSoon();
  }

  /* ========================= 3. 计算 ========================= */

  const isCharge = v => /充电/.test(v.badge || '');
  const isNew = v => v.ts > clearedAt && v.ts >= horizon() && !seen[v.bvid] && !S.history.has(v.bvid);
  function watchInfo(v) {
    const h = S.history.get(v.bvid);
    if (h) return { watched: true, ratio: h.p === -1 ? 1 : (h.d > 0 ? Math.min(1, Math.max(0, h.p / h.d)) : 0) };
    return { watched: !!seen[v.bvid], ratio: 0 };
  }

  function isPriority(mid) {
    if (priorityOff[mid]) return false;
    if (priority[mid]) return true;
    const f = S.follows.get(mid);
    return !!(f && f.sp && (settings.syncSpecial || settings.starToSpecial));
  }

  function inGroup(mid) {
    const t = S.activeTag;
    if (t == null) return true;
    const f = S.follows.get(mid);
    if (!f) return false;
    if (t === -10) return !!f.sp || f.tags.includes(-10);
    if (t === 0) return !f.tags.length || f.tags.includes(0);
    return f.tags.includes(t);
  }

  // 时间范围内、没被「隐藏充电专属」过滤掉的视频
  function baseVideos() {
    const hz = horizon();
    return S.videos.filter(v => v.ts >= hz && !(settings.hideCharge && isCharge(v)));
  }
  const visibleVideos = () => baseVideos().filter(v => inGroup(v.mid));

  const ZERO = { n: 0, last: 0, lastNew: 0 };
  function upStats() {
    const m = new Map();
    for (const v of baseVideos()) {
      let s = m.get(v.mid);
      if (!s) m.set(v.mid, s = { n: 0, last: 0, lastNew: 0 });
      if (v.ts > s.last) s.last = v.ts;
      if (isNew(v)) { s.n++; if (v.ts > s.lastNew) s.lastNew = v.ts; }
    }
    return m;
  }

  // 关注列表 + 视频作者 + 横排里的 UP + 手动优先的 UP，合成一张表
  function collectUps() {
    const m = new Map(S.follows);
    const add = (mid, uname, face) => {
      if (mid && !m.has(mid)) m.set(mid, { mid, uname, face, rank: 1e6, mtime: 0, sp: 0, tags: [], extra: true });
    };
    for (const u of S.upList) add(u.mid, u.uname, u.face);
    for (const v of S.videos) add(v.mid, v.uname, v.face);
    for (const mid of Object.keys(priority)) add(mid, priority[mid].uname, priority[mid].face);
    return m;
  }
  const upInfo = mid => collectUps().get(mid) || { mid, uname: 'UID ' + mid, face: '' };

  function cmpByNew(stats) {
    return (a, b) => {
      const sa = stats.get(a.mid) || ZERO, sb = stats.get(b.mid) || ZERO;
      return (sb.n > 0) - (sa.n > 0) || sb.lastNew - sa.lastNew || sb.last - sa.last || a.rank - b.rank;
    };
  }
  function cmpRest(stats) {
    if (settings.allSort === 'recent') return (a, b) => (stats.get(b.mid) || ZERO).last - (stats.get(a.mid) || ZERO).last || a.rank - b.rank;
    if (settings.allSort === 'follow') return (a, b) => (b.mtime || 0) - (a.mtime || 0) || a.rank - b.rank;
    return (a, b) => a.rank - b.rank;
  }

  /* ========================= 4. 操作 ========================= */

  function pruneSeen() {
    const cut = now() - 10 * 86400; // 最长只看 7 天，10 天前标的已看早就没用了
    for (const k of Object.keys(seen)) if (seen[k] < cut) delete seen[k];
  }
  // 动态页和几个播放页可能同时开着，各自都会改已看记录：改之前先读一遍最新的，免得拿旧的一份把别人的覆盖掉
  function markSeen(bvids, keepVisible) {
    seen = store.get('seen', {});
    const t = now();
    for (const b of bvids) { if (!b) continue; seen[b] = t; if (keepVisible) S.keep.add(b); }
    pruneSeen();
    store.set('seen', seen);
    renderSoon();
  }
  function unmarkSeen(bvids) {
    seen = store.get('seen', {});
    for (const b of bvids) delete seen[b];
    store.set('seen', seen);
    renderSoon();
  }
  function dismiss(bvid) {
    markSeen([bvid]);
    toast('已标为已看', '撤销', () => unmarkSeen([bvid]));
  }
  function markAll() {
    const ids = visibleVideos().filter(isNew).map(v => v.bvid);
    if (!ids.length) return;
    S.keep.clear();
    markSeen(ids);
    toast(`已把 ${ids.length} 个新视频标为已看`, '撤销', () => unmarkSeen(ids));
  }
  function markUp(mid) {
    const st = S.upVideos.get(mid);
    const ids = [...new Set([...((st && st.items) || []), ...S.videos].filter(v => v.mid === mid && isNew(v)).map(v => v.bvid))];
    if (!ids.length) return;
    markSeen(ids);
    toast(`已把 ${ids.length} 个视频标为已看`, '撤销', () => unmarkSeen(ids));
  }

  // 设为 / 取消 B 站特别关注。照 B 站自己「设置分组」的做法：先读出 TA 现在所在的全部分组，改好后整份交回去（一个分组都不剩就交 0）
  async function setSpecial(mid, on) {
    const rel = await api(`/x/relation?fid=${mid}&${WL}`);
    if (!rel.attribute || rel.attribute === 128) throw new Error('你没有关注 TA');
    const tags = (rel.tag || []).map(Number);
    const was = tags.includes(-10) || rel.special === 1;
    const next = tags.filter(t => t && t !== -10);
    if (on) next.push(-10);
    await apiPost('/x/relation/tags/addUsers', { fids: mid, tagids: (next.length ? next : [0]).join(',') });
    // 本地数据跟着改，不用等下次重拉关注列表
    const f = S.follows.get(mid);
    if (f) { f.sp = on ? 1 : 0; f.tags = next; }
    const c = store.get('follows', null);
    if (c && Array.isArray(c.list)) {
      const x = c.list.find(y => y.mid === mid);
      if (x) { x.sp = on ? 1 : 0; x.tags = next; }
      const t = (c.tags || []).find(y => y.id === -10);
      if (t && was !== on) t.count = Math.max(0, t.count + (on ? 1 : -1));
      store.set('follows', c);
      S.tags = c.tags || S.tags;
    }
  }

  async function togglePriority(mid) {
    if (S.pending.has(mid)) return;
    const f = S.follows.get(mid);
    const was = isPriority(mid);
    if (settings.starToSpecial && f) {
      S.pending.add(mid);
      renderSoon();
      try {
        if (was && f.sp) await setSpecial(mid, false);
        else if (!was && !f.sp) await setSpecial(mid, true);
        delete priority[mid];
        delete priorityOff[mid];
        toast(was ? '已取消优先关注，B 站特别关注也一并取消了' : '已设为优先关注，并加入了 B 站特别关注');
      } catch (e) {
        toast('没改成 B 站特别关注：' + ((e && e.message) || e));
      } finally {
        S.pending.delete(mid);
      }
    } else if (was) {
      delete priority[mid];
      if (f && f.sp) priorityOff[mid] = 1;
      toast('已取消优先关注');
    } else {
      delete priorityOff[mid];
      if (!(f && f.sp && settings.syncSpecial)) {
        const u = upInfo(mid);
        priority[mid] = { uname: u.uname, face: u.face, t: now() };
      }
      toast('已设为优先关注：有新视频会排在最前面');
    }
    store.set('priority', priority);
    store.set('priorityOff', priorityOff);
    renderAll();
  }

  // 以前只存在本浏览器里的优先关注，一次性设成 B 站特别关注
  async function migratePriority() {
    const mids = Object.keys(priority).filter(m => { const f = S.follows.get(m); return f && !f.sp; });
    let ok = 0, fail = 0;
    for (const m of mids) {
      try { await setSpecial(m, true); delete priority[m]; ok++; } catch (e) { fail++; }
      await sleep(400);
    }
    store.set('priority', priority);
    toast(`已把 ${ok} 位设为 B 站特别关注` + (fail ? `，${fail} 位没成功` : ''));
    renderAll();
  }

  function setTag(v) {
    const t = v === '' || v == null ? null : Number(v);
    S.activeTag = t === S.activeTag ? null : t;
    store.set('activeTag', S.activeTag);
    S.wallExpanded = false;
    renderAll();
  }

  // 让 B 站原生动态流也切到这个 UP（原生横排藏起来了，但还在页面里，可以替它点）
  const nativeItems = () => [...document.querySelectorAll('.bili-dyn-up-list__item')];
  function findNative(uname) {
    return nativeItems().find(x => {
      const n = x.querySelector('.bili-dyn-up-list__item__name');
      return n && n.textContent.trim() === uname;
    });
  }
  function clickNativeAll() {
    const el = nativeItems().find(x => x.querySelector('.bili-dyn-up-list__item__face.all'));
    if (el && !el.classList.contains('active')) el.click();
  }
  function selectUp(mid) {
    if (mid && S.activeMid === mid) mid = null; // 再点一次 = 回到全部
    S.activeMid = mid;
    S.wallExpanded = false;
    if (mid) {
      loadUpVideos(mid);
      const el = findNative(upInfo(mid).uname);
      if (el) { if (!el.classList.contains('active')) el.click(); } else clickNativeAll();
      S.hasUpdate.delete(mid);
    } else {
      clickNativeAll();
    }
    renderAll();
    const w = S.el.wall;
    if (w && w.getBoundingClientRect().top < 60) window.scrollTo({ top: Math.max(0, w.getBoundingClientRect().top + window.scrollY - 80), behavior: 'smooth' });
  }

  async function addWatchLater(el) {
    if (el.classList.contains('is-done')) return;
    try {
      await apiPost('/x/v2/history/toview/add', { aid: el.dataset.aid });
      el.classList.add('is-done');
      el.innerHTML = ICON.check;
      el.title = '已在稍后再看';
      toast('已加入稍后再看');
    } catch (e) {
      toast('没加上：' + ((e && e.message) || e));
    }
  }

  /* ========================= 5. 渲染 ========================= */

  const svg = (body, filled) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="${filled ? 'currentColor' : 'none'}" stroke="${filled ? 'none' : 'currentColor'}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const STAR = 'M12 3.6l2.55 5.17 5.7.83-4.12 4.02.97 5.68L12 16.6l-5.1 2.7.97-5.68L3.75 9.6l5.7-.83z';
  const ICON = {
    star: svg(`<path d="${STAR}"/>`),
    starFill: svg(`<path d="${STAR}"/>`, true),
    clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
    check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
    refresh: svg('<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>'),
    gear: svg('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>'),
    down: svg('<path d="M6 9l6 6 6-6"/>'),
    up: svg('<path d="M6 15l6-6 6 6"/>'),
    back: svg('<path d="M15 5l-7 7 7 7"/>'),
    close: svg('<path d="M7 7l10 10M17 7L7 17"/>'),
    search: svg('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>'),
    ext: svg('<path d="M14 5h5v5M19 5l-8 8M17 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h4"/>'),
    play: svg('<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10.5 9.5v5l4.2-2.5z" fill="currentColor" stroke="none"/>'),
    dm: svg('<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M7.5 10h5M7.5 14h8"/>'),
    live: svg('<circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/><path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8"/>'),
    feed: svg('<path d="M12 12c0-4.2 1.6-7.1 4.6-7.6.6 3.3-1 6.3-4.6 7.6zM12 12c4.2 0 7.1 1.6 7.6 4.6-3.3.6-6.3-1-7.6-4.6zM12 12c0 4.2-1.6 7.1-4.6 7.6-.6-3.3 1-6.3 4.6-7.6zM12 12c-4.2 0-7.1-1.6-7.6-4.6 3.3-.6 6.3 1 7.6 4.6z" fill="currentColor" stroke="none"/>'),
    menu: svg('<path d="M4 7h16M4 12h16M4 17h16"/>'),
    home: svg('<path d="M4 10.5L12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z"/>'),
    history: svg('<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5V8H8"/><path d="M12 8v4l2.8 1.8"/>'),
    folder: svg('<path d="M4 7.5A1.5 1.5 0 0 1 5.5 6H10l2 2h6.5A1.5 1.5 0 0 1 20 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/>'),
  };

  let rafId = 0;
  function renderSoon() {
    if (rafId || S.dead) return;
    rafId = requestAnimationFrame(() => { rafId = 0; renderAll(); });
  }
  function renderAll() {
    if (S.dead || !S.el.side) return;
    renderSide();
    if (PAGE === 'dyn') { renderWall(); renderLive(); updateTitle(); } else renderDrawer();
  }

  /* ---------- 左侧关注列表 ---------- */

  function rowHTML(u, s) {
    const pri = isPriority(u.mid);
    const live = S.liveMap.get(u.mid);
    const n = s ? s.n : 0;
    let meta = '';
    if (live) meta += `<span class="bdr-pill bdr-pill-live" title="直播中：${esc(live.title)}">直播</span>`;
    if (n) meta += `<span class="bdr-dot is-new" title="${n} 个新视频"></span>`; // 有新视频：实心小蓝点，个数在悬停提示里
    else if (S.hasUpdate.has(u.mid)) meta += '<span class="bdr-dot" title="有新动态（图文、转发等）"></span>'; // 只有别的动态：空心灰圈
    // 点一下：动态页在中间、播放页在菜单里看 TA 的投稿。中键 / Ctrl+点击才走这个链接：动态页开 TA 的空间，播放页开动态页里 TA 的视图
    const href = PAGE === 'dyn' ? `https://space.bilibili.com/${u.mid}` : `https://t.bilibili.com/?bdr_up=${u.mid}`;
    const sp = settings.starToSpecial && S.follows.has(u.mid) ? '（同时' + (pri ? '取消' : '设为') + ' B 站特别关注）' : '';
    return `<a class="bdr-row${S.activeMid === u.mid ? ' is-active' : ''}${n ? ' has-new' : ''}" href="${href}" target="_blank" data-act="up" data-mid="${u.mid}" title="${esc(u.uname)}">`
      + `<img class="bdr-face" src="${esc(img(u.face, '64w_64h'))}" loading="lazy" alt="">`
      + `<span class="bdr-name">${esc(u.uname)}</span>`
      + `<span class="bdr-meta">${meta}</span>`
      + `<span class="bdr-star${pri ? ' is-on' : ''}${S.pending.has(u.mid) ? ' is-busy' : ''}" data-act="star" data-mid="${u.mid}" title="${(pri ? '取消优先关注' : '设为优先关注') + sp}">${pri ? ICON.starFill : ICON.star}</span>`
      + '</a>';
  }
  const secHTML = (label, n) => `<div class="bdr-sec">${label}<em>${n}</em></div>`;
  const skelRows = n => Array.from({ length: n }, () => '<div class="bdr-row bdr-skel"><span class="bdr-face"></span><span class="bdr-skel-line"></span></div>').join('');

  function renderSide() {
    const stats = upStats();
    const ups = collectUps();
    const cand = [...ups.values()].filter(u => inGroup(u.mid));
    let totalNew = 0;
    for (const u of cand) totalNew += (stats.get(u.mid) || ZERO).n;

    S.el.sideHead.innerHTML = `<span class="bdr-h">关注</span><span class="bdr-h-count">${S.follows.size || ''}</span>`;

    const tags = S.tags.filter(t => t.count > 0 && t.id !== 0); // 「默认分组」几乎就是全部，不单列
    S.el.chips.style.display = tags.length ? '' : 'none';
    S.el.chips.innerHTML = tags.length
      ? `<span class="bdr-chip${S.activeTag == null ? ' is-on' : ''}" data-act="tag" data-tag="">全部</span>`
        + tags.map(t => `<span class="bdr-chip${S.activeTag === t.id ? ' is-on' : ''}" data-act="tag" data-tag="${t.id}" title="${esc(t.name)}：${t.count} 位">${esc(t.name)}</span>`).join('')
      : '';

    const out = [];
    out.push(`<div class="bdr-row bdr-row-all${S.activeMid ? '' : ' is-active'}" data-act="all">`
      + `<span class="bdr-face bdr-face-icon">${ICON.feed}</span><span class="bdr-name">全部动态</span>`
      + `<span class="bdr-meta">${totalNew ? `<span class="bdr-dot is-new" title="${totalNew} 个新视频"></span>` : ''}</span></div>`);

    const q = S.search.trim().toLowerCase();
    if (!S.follows.size && S.loading.has('follows')) {
      out.push(skelRows(8));
    } else if (q) {
      const hit = cand.filter(u => (u.uname || '').toLowerCase().includes(q))
        .sort((a, b) => (isPriority(b.mid) - isPriority(a.mid)) || cmpByNew(stats)(a, b)).slice(0, 100);
      out.push(secHTML('搜索结果', hit.length));
      out.push(hit.length ? hit.map(u => rowHTML(u, stats.get(u.mid))).join('') : '<div class="bdr-none">没有匹配的 UP</div>');
    } else {
      const pri = [], fresh = [], rest = [];
      for (const u of cand) {
        const s = stats.get(u.mid);
        if (isPriority(u.mid)) pri.push(u);
        else if (s && s.n) fresh.push(u);
        else if (!u.extra) rest.push(u);
      }
      pri.sort(cmpByNew(stats));
      fresh.sort(cmpByNew(stats));
      rest.sort(cmpRest(stats));
      if (pri.length) out.push(secHTML('优先关注', pri.length), pri.map(u => rowHTML(u, stats.get(u.mid))).join(''));
      if (fresh.length) out.push(secHTML('有新视频', fresh.length), fresh.map(u => rowHTML(u, stats.get(u.mid))).join(''));
      if (rest.length) {
        const LIMIT = 10;
        out.push(secHTML(pri.length || fresh.length ? '其他关注' : '全部关注', rest.length));
        out.push((S.allExpanded ? rest : rest.slice(0, LIMIT)).map(u => rowHTML(u, stats.get(u.mid))).join(''));
        if (rest.length > LIMIT) {
          out.push(`<div class="bdr-more" data-act="more">${S.allExpanded ? ICON.up + '收起' : ICON.down + `展开全部（还有 ${rest.length - LIMIT} 位）`}</div>`);
        }
      }
      if (!pri.length && !fresh.length && !rest.length && S.activeTag != null) out.push('<div class="bdr-none">这个分组里还没有人</div>');
    }
    const top = S.el.list.scrollTop; // 重画时保住滚动位置（刷新、点 ☆ 都会重画）
    S.el.list.innerHTML = out.join('');
    S.el.list.scrollTop = top;
  }

  /* ---------- 中间新视频墙 ---------- */

  function cols() {
    const w = S.el.wall ? S.el.wall.clientWidth - 32 : 0;
    return w > 0 ? Math.max(1, Math.floor((w + CARD_GAP) / (CARD_MIN + CARD_GAP))) : 3;
  }
  const skelCards = n => Array.from({ length: n }, () => '<div class="bdr-card bdr-skel"><div class="bdr-cover"></div><div class="bdr-skel-line"></div><div class="bdr-skel-line is-short"></div></div>').join('');

  // 同一 UP 合并：取最新一条没看过的做代表，其余新视频算进「+N」
  function toUnits(list, merge) {
    if (!merge) return list.map(v => ({ v, more: 0 }));
    const groups = new Map();
    for (const v of list) {
      const g = groups.get(v.mid);
      if (g) g.push(v); else groups.set(v.mid, [v]);
    }
    return [...groups.values()].map(g => {
      const v = g.find(x => isNew(x)) || g[0];
      return { v, more: g.filter(x => x !== v && isNew(x)).length };
    });
  }

  function cardHTML(v, opt) {
    opt = opt || {};
    const w = watchInfo(v);
    const fresh = isNew(v);
    const url = `https://www.bilibili.com/video/${v.bvid}/`;
    const badge = isCharge(v) ? `<span class="bdr-badge">${esc(v.badge)}</span>`
      : (w.watched && !w.ratio ? '<span class="bdr-badge is-gray">已看</span>' : '');
    return `<div class="bdr-card${w.watched ? ' is-watched' : ''}${opt.more ? ' is-stack' : ''}">`
      + `<a class="bdr-cover" href="${url}" target="_blank" data-act="open" data-bvid="${v.bvid}">`
      + `<img src="${esc(img(v.cover, '480w_270h_1c'))}" loading="lazy" alt="">`
      + `<span class="bdr-cover-bar"><span>${ICON.play}${fmtNum(v.play)}</span><span>${ICON.dm}${fmtNum(v.dm)}</span><span class="bdr-flex"></span><span>${esc(v.dur)}</span></span>`
      + badge
      + (w.ratio ? `<span class="bdr-prog"><i style="width:${Math.max(4, w.ratio * 100).toFixed(1)}%"></i></span>` : '')
      + '<span class="bdr-acts">'
      + `<span class="bdr-act" data-act="later" data-aid="${v.aid}" title="稍后再看">${ICON.clock}</span>`
      + (fresh ? `<span class="bdr-act" data-act="dismiss" data-bvid="${v.bvid}" title="标为已看（不看了）">${ICON.check}</span>` : '')
      + '</span></a>'
      + `<a class="bdr-title" href="${url}" target="_blank" data-act="open" data-bvid="${v.bvid}" title="${esc(v.title)}">`
      + (fresh && (S.wallMode === 'all' || S.activeMid) ? '<i class="bdr-newdot" title="新视频"></i>' : '')
      + `${esc(v.title)}</a>`
      + '<div class="bdr-info">'
      + (opt.hideUp ? '' : `<span class="bdr-up" data-act="up" data-mid="${v.mid}" title="只看 ${esc(v.uname)}">${isPriority(v.mid) ? ICON.starFill : ''}${esc(v.uname)}</span><span class="bdr-sep">·</span>`)
      + `<span class="bdr-time" title="${fullTime(v.ts)}">${ago(v.ts)}</span>`
      + (opt.more ? `<span class="bdr-stack-n" data-act="up" data-mid="${v.mid}" title="还有 ${opt.more} 个新视频，点开看 TA 的全部">+${opt.more}</span>` : '')
      + '</div></div>';
  }

  function statusHTML() {
    const errs = Object.keys(S.errors);
    if (errs.length) {
      const detail = errs.map(k => `${TASK_NAMES[k] || k}：${S.errors[k]}`).join('\n');
      return `<span class="bdr-err" title="${esc(detail)}">有数据没加载出来</span> <span class="bdr-link" data-act="refresh">重试</span>`;
    }
    if (S.loading.has('feed') && S.feedPage > 1) return `正在拉取视频（第 ${S.feedPage} 页）…`;
    if (S.loading.size) return '更新中…';
    if (S.lastRefresh) return hm(S.lastRefresh) + ' 更新';
    return '';
  }

  function wallHeadHTML(newCount, allCount) {
    const tag = S.activeTag != null ? S.tags.find(t => t.id === S.activeTag) : null;
    return '<div class="bdr-wall-head"><div class="bdr-tabs">'
      + `<span class="bdr-tab${S.wallMode === 'new' ? ' is-on' : ''}" data-act="mode" data-mode="new">新视频<em>${newCount}</em></span>`
      + `<span class="bdr-tab${S.wallMode === 'all' ? ' is-on' : ''}" data-act="mode" data-mode="all">最近 ${settings.windowDays} 天<em>${allCount}</em></span>`
      + '</div>'
      + (tag ? `<span class="bdr-chip is-on" data-act="tag" data-tag="" title="取消分组筛选">${esc(tag.name)}${ICON.close}</span>` : '')
      + '<span class="bdr-flex"></span>'
      + `<span class="bdr-status">${statusHTML()}</span>`
      + (S.wallMode === 'new' && newCount && !S.wallCollapsed ? `<span class="bdr-btn" data-act="mark-all" title="把现在这些新视频都标为已看">${ICON.check}全部标为已看</span>` : '')
      + `<span class="bdr-icon-btn${S.loading.size ? ' is-spin' : ''}" data-act="refresh" title="刷新">${ICON.refresh}</span>`
      + `<span class="bdr-icon-btn" data-act="settings" title="设置">${ICON.gear}</span>`
      + `<span class="bdr-icon-btn" data-act="collapse" title="${S.wallCollapsed ? '展开' : '收起'}">${S.wallCollapsed ? ICON.down : ICON.up}</span>`
      + '</div>';
  }

  function renderWall() {
    const el = S.el.wall;
    if (S.activeMid) { el.classList.remove('is-collapsed'); el.innerHTML = upWallHTML(S.activeMid); return; }
    const vis = visibleVideos();
    const newCount = vis.filter(isNew).length;
    const list = S.wallMode === 'new' ? vis.filter(v => isNew(v) || S.keep.has(v.bvid)) : vis;
    const head = wallHeadHTML(newCount, vis.length);
    el.classList.toggle('is-collapsed', S.wallCollapsed);
    if (S.wallCollapsed) { el.innerHTML = head; return; }

    let body;
    if (!list.length) {
      const days = settings.windowDays;
      if (S.loading.has('feed') && !S.videos.length) body = `<div class="bdr-grid">${skelCards(cols() * settings.wallRows)}</div>`;
      else if (S.errors.feed && !S.videos.length) body = `<div class="bdr-empty">视频动态没加载出来：${esc(S.errors.feed)} · <span class="bdr-link" data-act="refresh">重试</span></div>`;
      else if (S.wallMode === 'new' && vis.length) body = `<div class="bdr-empty">新视频都看完了 · <span class="bdr-link" data-act="mode" data-mode="all">看看最近 ${days} 天的 ${vis.length} 个视频</span></div>`;
      else body = `<div class="bdr-empty">最近 ${days} 天${S.activeTag != null ? '这个分组' : '关注的 UP'}没有发视频</div>`;
    } else {
      const merged = settings.mergeUp && S.wallMode === 'new';
      const units = toUnits(list, merged);
      const pri = units.filter(u => isPriority(u.v.mid));
      const rest = units.filter(u => !isPriority(u.v.mid));
      let showPri = pri, showRest = rest;
      if (!S.wallExpanded) {
        const c = cols(), rows = settings.wallRows;
        const priRows = Math.min(rows, Math.ceil(pri.length / c));
        showPri = pri.slice(0, priRows * c);
        showRest = rest.slice(0, Math.max(1, rows - priRows) * c); // 优先的再多，也至少留一行给其他人
      }
      const hidden = units.length - showPri.length - showRest.length;
      const card = u => cardHTML(u.v, { more: u.more });
      let html = '<div class="bdr-grid">';
      if (showPri.length) html += `<div class="bdr-grid-label is-pri">${ICON.starFill}优先关注<em>${pri.length}</em></div>` + showPri.map(card).join('');
      if (showRest.length) html += (showPri.length ? `<div class="bdr-grid-label">其他<em>${rest.length}</em></div>` : '') + showRest.map(card).join('');
      html += '</div>';
      if (hidden > 0 || S.wallExpanded) {
        html += `<div class="bdr-expand" data-act="expand">${S.wallExpanded ? ICON.up + '收起' : ICON.down + `展开全部（还有 ${hidden} ${merged ? '位 UP' : '个'}）`}</div>`;
      }
      body = html;
    }
    el.innerHTML = head + body;
  }

  // 某位 UP 的视频：TA 自己的第一页投稿 + 主视频流里 TA 的视频合在一起（第一页不一定装得下全部新视频）
  function upItems(mid) {
    const st = S.upVideos.get(mid) || {};
    const byId = new Map();
    for (const v of [...(st.items || []), ...S.videos.filter(x => x.mid === mid)]) if (!byId.has(v.bvid)) byId.set(v.bvid, v);
    return [...byId.values()].filter(v => !(settings.hideCharge && isCharge(v))).sort((a, b) => b.ts - a.ts);
  }

  function upWallHTML(mid) {
    const u = upInfo(mid);
    const st = S.upVideos.get(mid) || {};
    const pri = isPriority(mid);
    const live = S.liveMap.get(mid);
    const items = upItems(mid);
    const newN = items.filter(isNew).length;
    let body;
    if (st.loading && !items.length) body = `<div class="bdr-grid">${skelCards(cols())}</div>`;
    else if (st.error && !items.length) body = `<div class="bdr-empty">没加载出来：${esc(st.error)} · <span class="bdr-link" data-act="up-retry" data-mid="${mid}">重试</span></div>`;
    else if (!items.length) body = '<div class="bdr-empty">TA 最近没有投稿视频</div>';
    else body = `<div class="bdr-grid">${items.map(v => cardHTML(v, { hideUp: true })).join('')}</div>`;
    const note = findNative(u.uname) ? '' : '<div class="bdr-note">TA 不在 B 站的「最近更新」名单里，下方动态流没法单独筛选 TA，仍显示全部动态。</div>';
    return '<div class="bdr-wall-head">'
      + `<span class="bdr-icon-btn" data-act="all" title="返回新视频">${ICON.back}</span>`
      + `<a class="bdr-up-head" href="https://space.bilibili.com/${mid}" target="_blank" title="打开 TA 的空间">`
      + `<img class="bdr-face" src="${esc(img(u.face, '64w_64h'))}" alt=""><span class="bdr-up-name">${esc(u.uname)}</span></a>`
      + (live ? `<a class="bdr-pill bdr-pill-live" href="${esc(live.url)}" target="_blank" title="${esc(live.title)}">直播中</a>` : '')
      + `<span class="bdr-sub">${newN ? newN + ' 个新视频' : '最近投稿'}</span>`
      + '<span class="bdr-flex"></span>'
      + (newN ? `<span class="bdr-btn" data-act="mark-up" data-mid="${mid}">${ICON.check}标为已看</span>` : '')
      + `<span class="bdr-btn${pri ? ' is-pri' : ''}" data-act="star" data-mid="${mid}">${pri ? ICON.starFill + '已优先关注' : ICON.star + '设为优先关注'}</span>`
      + `<a class="bdr-btn" href="https://space.bilibili.com/${mid}/video" target="_blank">全部投稿${ICON.ext}</a>`
      + '</div>' + note + body;
  }

  /* ---------- 右侧直播卡片 ---------- */

  function renderLive() {
    const el = S.el.live;
    if (!el) return;
    if (settings.livePlace !== 'right' || !S.live.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
    el.style.display = '';
    el.classList.toggle('is-open', S.liveOpen);
    el.innerHTML = `<div class="bdr-live-head" data-act="live-toggle" title="${S.liveOpen ? '收起' : '展开'}">`
      + `<span class="bdr-live-icon">${ICON.live}</span><span class="bdr-live-title">正在直播<em>${S.liveCount}</em></span>`
      + `<span class="bdr-live-faces">${S.live.slice(0, 5).map(u => `<img src="${esc(img(u.face, '48w_48h'))}" alt="" title="${esc(u.uname)}">`).join('')}</span>`
      + `<span class="bdr-chev">${ICON.down}</span></div>`
      + '<div class="bdr-live-body">'
      + S.live.map(u => `<a class="bdr-live-row" href="${esc(u.url)}" target="_blank" title="${esc(u.title)}">`
        + `<img src="${esc(img(u.face, '72w_72h'))}" alt=""><span class="bdr-live-text"><span class="bdr-live-name">${esc(u.uname)}</span>`
        + `<span class="bdr-live-sub">${esc(u.title)}</span></span></a>`).join('')
      + '<a class="bdr-live-more" href="https://link.bilibili.com/p/center/index#/user-center/follow/1" target="_blank">全部关注的直播</a>'
      + '</div>';
  }

  function updateTitle() {
    if (!S.baseTitle) S.baseTitle = document.title.replace(/^\(\d+\+?\)\s*/, '');
    const n = baseVideos().filter(isNew).length;
    const t = (n ? `(${n > 99 ? '99+' : n}) ` : '') + S.baseTitle;
    if (document.title !== t) document.title = t;
  }

  /* ---------- 设置弹窗 ---------- */

  const SETTING_ROWS = [
    ['starToSpecial', 'check', '点 ☆ 时同时设为 B 站特别关注', '取消 ☆ 也会同时取消；手机和别的电脑都同步，B 站会推送特别关注的更新提醒'],
    ['syncSpecial', 'check', 'B 站「特别关注」自动算优先关注', '在 B 站设的特别关注直接排最前'],
    ['useHistory', 'check', '看过的视频不算新', '读取 B 站观看历史，手机、电视上看过的也算'],
    ['mergeUp', 'check', '同一 UP 的多个新视频合并成一张卡', '卡片右下角显示「+N」，点它看这位 UP 的全部新视频'],
    ['hideCharge', 'check', '隐藏充电专属视频', ''],
    ['hidePublish', 'check', '隐藏「发动态」输入框', ''],
    ['hideLiveCards', 'check', '动态流里隐藏「直播了」卡片', ''],
    ['hideBanner', 'check', '隐藏右侧「社区中心」横幅', ''],
    ['hideOldBtn', 'check', '隐藏右下角「回到旧版」按钮', ''],
    ['slimHeader', 'check', '精简顶栏', '去掉游戏中心、会员购、赛事、活动入口（如 S16）、下载客户端、创作中心、投稿；B 站所有页面都生效'],
    ['playDrawer', 'check', '播放页顶栏左边显示 ≡ 关注菜单', '点开就是这份关注列表，像 YouTube 播放页的左侧菜单'],
    ['livePlace', 'select', '「正在直播」放哪', '', [['right', '右侧折叠卡片'], ['hide', '完全隐藏'], ['native', '放回左侧原位']]],
    ['windowDays', 'select', '新视频看最近几天', '范围越大，第一次加载越慢', [[1, '1 天'], [2, '2 天'], [3, '3 天'], [5, '5 天'], [7, '7 天']]],
    ['wallRows', 'select', '新视频墙默认显示', '', [[1, '1 行'], [2, '2 行'], [3, '3 行'], [4, '4 行']]],
    ['allSort', 'select', '列表里「其他关注」怎么排', '', [['attention', '最常访问'], ['recent', '最近投稿'], ['follow', '最近关注']]],
    ['autoRefresh', 'select', '自动刷新', '只在页面开着的时候刷', [[0, '关闭'], [5, '每 5 分钟'], [10, '每 10 分钟'], [30, '每 30 分钟']]],
  ];

  function openSettings() {
    closeSettings();
    const nLocal = Object.keys(priority).length;
    const nSpecial = [...S.follows.values()].filter(f => f.sp).length;
    const nMigrate = Object.keys(priority).filter(m => { const f = S.follows.get(m); return f && !f.sp; }).length;
    const rows = SETTING_ROWS.map(([key, type, label, hint, opts]) => {
      const ctl = type === 'check'
        ? `<span class="bdr-switch"><input type="checkbox" data-set="${key}"${settings[key] ? ' checked' : ''}><i></i></span>`
        : `<select data-set="${key}">${opts.map(([v, t]) => `<option value="${v}"${String(settings[key]) === String(v) ? ' selected' : ''}>${t}</option>`).join('')}</select>`;
      return `<label class="bdr-set"><span class="bdr-set-text">${label}${hint ? `<small>${hint}</small>` : ''}</span>${ctl}</label>`;
    }).join('');
    const mask = document.createElement('div');
    mask.className = 'bdr-modal-mask';
    mask.innerHTML = '<div class="bdr-modal" role="dialog" aria-label="动态页设置">'
      + `<div class="bdr-modal-head"><b>动态页设置</b><span class="bdr-flex"></span><span class="bdr-icon-btn" data-act="close" title="关闭">${ICON.close}</span></div>`
      + rows
      + '<div class="bdr-modal-tip">优先关注：把鼠标移到关注列表里的 UP 上，点右边的 ☆。'
      + (settings.starToSpecial
        ? `会同时设为 B 站特别关注，现在共 ${nSpecial} 位。`
          + (nMigrate ? `本机还有 ${nMigrate} 位以前只存在这个浏览器里，<span class="bdr-link" data-act="migrate">一键设成特别关注</span>。` : '')
        : `现在本机设了 ${nLocal} 位，只存在这个浏览器里` + (settings.syncSpecial ? `；另有 B 站特别关注 ${nSpecial} 位。` : '。'))
      + '</div>'
      + '<div class="bdr-modal-foot">'
      + '<span class="bdr-btn" data-act="reload-all">重新拉取全部数据</span>'
      + '<span class="bdr-btn" data-act="reset-seen">清空已看记录</span>'
      + `<span class="bdr-flex"></span><span class="bdr-ver">v${esc(VERSION)}</span>`
      + '</div></div>';
    mask.addEventListener('click', e => {
      if (e.target === mask) return closeSettings();
      const t = e.target.closest('[data-act]');
      if (!t) return;
      const act = t.dataset.act;
      if (act === 'close') closeSettings();
      else if (act === 'reload-all') {
        store.set('videos', null); store.set('follows', null); store.set('history', null);
        S.videos = []; S.history = new Map(); S.upVideos.clear();
        closeSettings();
        toast('正在重新拉取…');
        renderAll();
        refresh(true);
      } else if (act === 'migrate') {
        closeSettings();
        migratePriority();
      } else if (act === 'reset-seen') {
        if (!confirm('清空后，最近 24 小时里没看过的视频会重新算作新视频。确定？')) return;
        seen = {}; store.set('seen', seen);
        clearedAt = now() - 86400; store.set('clearedAt', clearedAt);
        S.keep.clear();
        closeSettings();
        toast('已清空已看记录');
        renderAll();
      }
    });
    mask.addEventListener('change', e => {
      const t = e.target.closest('[data-set]');
      if (!t) return;
      const key = t.dataset.set;
      let val = t.type === 'checkbox' ? t.checked : t.value;
      if (typeof DEFAULTS[key] === 'number') val = Number(val);
      settings[key] = val;
      saveSettings();
      if (key === 'windowDays') { S.keep.clear(); task('feed', loadFeed); task('history', loadHistory); }
      if (key === 'useHistory') task('history', loadHistory);
      applyLayout();
      renderAll();
    });
    document.body.appendChild(mask);
    S.escHandler = e => { if (e.key === 'Escape') closeSettings(); };
    document.addEventListener('keydown', S.escHandler);
  }
  function closeSettings() {
    document.querySelectorAll('.bdr-modal-mask').forEach(e => e.remove());
    if (S.escHandler) { document.removeEventListener('keydown', S.escHandler); S.escHandler = null; }
  }

  function toast(msg, actionText, actionFn) {
    document.querySelectorAll('.bdr-toast').forEach(e => e.remove());
    const el = document.createElement('div');
    el.className = 'bdr-toast';
    el.innerHTML = `<span>${esc(msg)}</span>` + (actionText ? `<b>${esc(actionText)}</b>` : '');
    if (actionText) el.querySelector('b').addEventListener('click', () => { el.remove(); if (actionFn) actionFn(); });
    document.body.appendChild(el);
    setTimeout(() => el.classList.add('is-out'), 4000);
    setTimeout(() => el.remove(), 4400);
  }

  /* ---------- 事件 ---------- */

  function onSideClick(e) {
    const t = e.target.closest('[data-act]');
    if (!t || !S.el.side.contains(t)) return;
    const act = t.dataset.act;
    if (act === 'star') { e.preventDefault(); e.stopPropagation(); togglePriority(t.dataset.mid); return; }
    if (act === 'up') {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return; // 中键 / Ctrl+点击：照常在新标签打开
      e.preventDefault();
      if (PAGE === 'dyn') selectUp(t.dataset.mid); else openDrawerUp(t.dataset.mid); // 播放页：在菜单里就地切到 TA 的投稿
      return;
    }
    if (act === 'all' && PAGE === 'dyn') selectUp(null);
    else if (act === 'more') { S.allExpanded = !S.allExpanded; renderSide(); }
    else if (act === 'tag') setTag(t.dataset.tag);
  }

  function onWallClick(e) {
    const t = e.target.closest('[data-act]');
    if (!t || !S.el.wall.contains(t)) return;
    const act = t.dataset.act;
    switch (act) {
      case 'open': markSeen([t.dataset.bvid], true); return; // 不拦截，浏览器照常在新标签打开
      case 'later': e.preventDefault(); e.stopPropagation(); addWatchLater(t); return;
      case 'dismiss': e.preventDefault(); e.stopPropagation(); dismiss(t.dataset.bvid); return;
      case 'up': e.preventDefault(); selectUp(t.dataset.mid); return;
      case 'all': selectUp(null); return;
      case 'mode': S.wallMode = t.dataset.mode; S.wallExpanded = false; S.keep.clear(); renderWall(); return;
      case 'mark-all': markAll(); return;
      case 'mark-up': markUp(t.dataset.mid); return;
      case 'star': togglePriority(t.dataset.mid); return;
      case 'refresh': refresh(true); return;
      case 'settings': openSettings(); return;
      case 'collapse': S.wallCollapsed = !S.wallCollapsed; store.set('wallCollapsed', S.wallCollapsed); renderWall(); return;
      case 'expand': S.wallExpanded = !S.wallExpanded; renderWall(); return;
      case 'tag': setTag(''); return;
      case 'up-retry': loadUpVideos(t.dataset.mid, true); return;
      default:
    }
  }
  function onWallAuxClick(e) {
    if (e.button !== 1) return;
    const t = e.target.closest('[data-act="open"]');
    if (t) markSeen([t.dataset.bvid], true);
  }

  /* ========================= 6. 挂载 ========================= */

  function buildSide() {
    const el = document.createElement('section');
    el.id = 'bdr-side';
    el.innerHTML = '<div class="bdr-side-head"></div>'
      + `<label class="bdr-search">${ICON.search}<input type="search" placeholder="搜索关注的 UP" autocomplete="off" spellcheck="false"></label>`
      + '<div class="bdr-chips"></div><div class="bdr-list"></div>';
    S.el.side = el;
    S.el.sideHead = el.querySelector('.bdr-side-head');
    S.el.chips = el.querySelector('.bdr-chips');
    S.el.list = el.querySelector('.bdr-list');
    const input = el.querySelector('input');
    input.addEventListener('input', () => { S.search = input.value; renderSide(); });
    input.addEventListener('keydown', e => {
      if (e.key === 'Escape') { input.value = ''; S.search = ''; renderSide(); return; }
      e.stopPropagation(); // 播放页：打字时别触发播放器快捷键（空格暂停、F 全屏……）
    });
    el.addEventListener('click', onSideClick);
  }
  function buildWall() {
    const el = document.createElement('section');
    el.id = 'bdr-wall';
    el.addEventListener('click', onWallClick);
    el.addEventListener('auxclick', onWallAuxClick);
    S.el.wall = el;
  }
  function buildLive() {
    const el = document.createElement('section');
    el.id = 'bdr-live';
    el.style.display = 'none';
    el.addEventListener('click', e => {
      if (!e.target.closest('[data-act="live-toggle"]')) return;
      S.liveOpen = !S.liveOpen;
      store.set('liveOpen', S.liveOpen);
      renderLive();
    });
    S.el.live = el;
  }

  // 精简顶栏只靠 <html> 上的一个 class + CSS，不碰顶栏本身（播放页顶栏一碰就崩，见 mountPlay 的说明）
  function applyHeader() {
    if (document.documentElement) document.documentElement.classList.toggle('bdr-slim-header', !!settings.slimHeader);
  }

  function applyLayout() {
    const c = document.documentElement.classList;
    applyHeader();
    c.add('bdr-on');
    c.toggle('bdr-hide-publish', !!settings.hidePublish);
    c.toggle('bdr-hide-livecard', !!settings.hideLiveCards);
    c.toggle('bdr-hide-banner', !!settings.hideBanner);
    c.toggle('bdr-hide-oldbtn', !!settings.hideOldBtn);
    c.toggle('bdr-no-drawer', !settings.playDrawer);
    c.remove('bdr-live-right', 'bdr-live-hide', 'bdr-live-native');
    c.add('bdr-live-' + settings.livePlace);
  }

  function mount() {
    const home = document.querySelector('.bili-dyn-home--member');
    if (!home) return false;
    const left = home.querySelector(':scope > aside.left');
    const main = home.querySelector(':scope > main');
    const right = home.querySelector(':scope > aside.right');
    if (!left || !main) return false;
    if (!S.el.side) { buildSide(); buildWall(); buildLive(); }
    if (S.el.side.parentElement !== left) {
      const nl = left.querySelector(':scope > .bili-dyn-live-users');
      if (nl) nl.after(S.el.side); else left.appendChild(S.el.side);
    }
    if (S.el.wall.parentElement !== main) main.prepend(S.el.wall);
    if (right && S.el.live.parentElement !== right) right.prepend(S.el.live);
    applyLayout();
    markOldBtn();
    return true;
  }

  // 动态流里「直播了」的卡片打标记，开关打开时由 CSS 藏起来
  function scanLiveCards() {
    for (const it of document.querySelectorAll('.bili-dyn-list__item')) {
      const t = it.querySelector('.bili-dyn-time');
      const txt = t ? t.textContent.trim() : '';
      if (it.dataset.bdrT === txt) continue;
      it.dataset.bdrT = txt;
      it.classList.toggle('bdr-live-card', /直播了$/.test(txt));
    }
  }

  function guard() {
    if (S.dead) return;
    if (!S.el.side.isConnected || !S.el.wall.isConnected || !S.el.live.isConnected) { if (mount()) renderAll(); }
    if (settings.hideLiveCards) scanLiveCards();
    markOldBtn();
  }
  // 右下角「回到旧版」：按文字认出来打标记，开关打开时由 CSS 藏起来（「顶部」按钮不动）
  function markOldBtn() {
    for (const b of document.querySelectorAll('.bili-dyn-sidebar__btn')) b.classList.toggle('bdr-old-btn', /旧版/.test(b.textContent));
  }
  function autoTick() {
    if (!settings.autoRefresh || document.visibilityState !== 'visible') return;
    if (now() - S.lastRefresh >= settings.autoRefresh * 60) refresh();
  }
  function onVisible() {
    if (document.visibilityState !== 'visible') return;
    updateTitle();
    autoTick();
  }

  function waitFor(fn, timeout) {
    return new Promise(resolve => {
      const t0 = Date.now();
      (function poll() {
        let v = null;
        try { v = fn(); } catch (e) { /* 页面还没好 */ }
        if (v) return resolve(v);
        if (Date.now() - t0 > timeout) return resolve(null);
        setTimeout(poll, 120);
      })();
    });
  }

  function injectStyle() {
    const parent = document.head || document.documentElement;
    if (!parent) { document.addEventListener('DOMContentLoaded', injectStyle, { once: true }); return; }
    const style = document.createElement('style');
    style.id = 'bdr-style';
    style.textContent = CSS;
    parent.appendChild(style);
  }

  // 先拿缓存把界面画出来，再去拉新的。油猴存储两个页面共用，播放页直接用动态页攒下的数据
  function loadCaches() {
    const fc = store.get('follows', null);
    if (fc && fc.mid === S.me && Array.isArray(fc.list)) applyFollows(fc);
    const vc = store.get('videos', null);
    if (vc && vc.mid === S.me && Array.isArray(vc.items)) S.videos = vc.items;
    const hc = store.get('history', null);
    if (settings.useHistory && hc && hc.mid === S.me && hc.map) S.history = new Map(Object.entries(hc.map));
    const pc = store.get('portal', null);
    if (pc && pc.mid === S.me) applyPortal(pc);
    S.lastRefresh = store.get('lastRefreshAt', 0);
  }

  async function initDyn() {
    injectStyle();
    applyHeader();
    const home = await waitFor(() => document.querySelector('.bili-dyn-home--member') || document.querySelector('.bili-dyn-home--visitor'), 30000);
    if (!home || !home.classList.contains('bili-dyn-home--member')) return; // 没登录：不动页面
    try {
      const nav = await api('/x/web-interface/nav');
      if (!nav.isLogin) return;
      S.me = String(nav.mid);
    } catch (e) { console.warn(LOG, '读取登录信息失败，脚本不生效', e); return; }
    if (S.dead) return;
    loadCaches();
    if (!mount()) { console.warn(LOG, '没找到页面结构，B 站可能改版了'); return; }
    renderAll();
    S.timers.push(setInterval(guard, 1500), setInterval(autoTick, 30000));
    document.addEventListener('visibilitychange', onVisible);
    if (!store.get('onboarded', false)) {
      store.set('onboarded', true);
      setTimeout(() => toast('提示：鼠标移到左侧列表的 UP 上，点 ☆ 就能设为优先关注'), 1500);
    }
    // 从播放页菜单点进来的（t.bilibili.com/?bdr_up=UID）：直接打开这位 UP 的视图
    const qs = new URLSearchParams(location.search);
    const want = qs.get('bdr_up');
    if (want) {
      qs.delete('bdr_up');
      history.replaceState(history.state, '', location.pathname + (qs.toString() ? '?' + qs : '') + location.hash);
      waitFor(() => document.querySelectorAll('.bili-dyn-up-list__item').length > 1, 8000).then(() => { if (!S.dead) selectUp(want); });
    }
    await refresh();
  }

  /* ---------- 播放页：顶栏 ≡ + 左侧抽屉 ---------- */

  function buildDrawer() {
    const burger = document.createElement('div');
    burger.id = 'bdr-burger';
    burger.title = '关注列表';
    burger.innerHTML = ICON.menu + '<i class="bdr-burger-dot"></i>';
    burger.addEventListener('click', () => toggleDrawer());
    const scrim = document.createElement('div');
    scrim.id = 'bdr-scrim';
    scrim.addEventListener('click', () => toggleDrawer(false));
    const dr = document.createElement('aside');
    dr.id = 'bdr-drawer';
    const links = [
      ['https://www.bilibili.com/', ICON.home, '首页'],
      ['https://t.bilibili.com/', ICON.feed, '动态'],
      ['https://www.bilibili.com/history', ICON.history, '历史记录'],
      ['https://www.bilibili.com/watchlater/#/list', ICON.clock, '稍后再看'],
      [`https://space.bilibili.com/${S.me}/favlist`, ICON.folder, '我的收藏'],
    ];
    dr.innerHTML = '<div class="bdr-dr-head">'
      + `<span class="bdr-icon-btn" data-act="close" title="收起菜单">${ICON.menu}</span>`
      + '<a class="bdr-dr-logo" href="https://www.bilibili.com/" target="_blank" data-act="link" title="哔哩哔哩首页"></a></div>'
      + '<nav class="bdr-dr-nav">'
      + links.map(([href, icon, label]) => `<a class="bdr-dr-link" href="${href}" target="_blank" data-act="link">${icon}<span>${label}</span>`
        + (label === '动态' ? '<i class="bdr-dot is-new bdr-dr-count"></i>' : '') + '</a>').join('')
      + '</nav>';
    buildSide(); // 和动态页左栏是同一个组件
    dr.appendChild(S.el.side);
    const upPanel = document.createElement('div'); // 点了某位 UP 以后，就在这里显示 TA 的投稿
    upPanel.className = 'bdr-dr-up';
    dr.appendChild(upPanel);
    S.el.drUp = upPanel;
    const foot = document.createElement('div');
    foot.className = 'bdr-dr-foot';
    foot.innerHTML = '<span class="bdr-dr-status"></span><span class="bdr-flex"></span>'
      + `<span class="bdr-icon-btn" data-act="refresh" title="刷新">${ICON.refresh}</span>`
      + `<span class="bdr-icon-btn" data-act="settings" title="设置">${ICON.gear}</span>`;
    dr.appendChild(foot);
    dr.addEventListener('click', e => {
      const t = e.target.closest('[data-act]');
      if (!t || S.el.side.contains(t)) return;
      const act = t.dataset.act;
      if (act === 'close') toggleDrawer(false);
      else if (act === 'refresh') refresh(true);
      else if (act === 'settings') openSettings();
      else if (act === 'link') setTimeout(() => toggleDrawer(false), 0);
      else if (act === 'up-back') { S.activeMid = null; renderAll(); }
      else if (act === 'star') { e.preventDefault(); togglePriority(t.dataset.mid); }
      else if (act === 'mark-up') markUp(t.dataset.mid);
      else if (act === 'up-retry') loadUpVideos(t.dataset.mid, true);
      else if (act === 'open') markSeen([t.dataset.bvid], true); // 不拦截：照 B 站推荐视频的规矩，在当前页打开
    });
    dr.addEventListener('auxclick', e => {
      if (e.button !== 1) return;
      const t = e.target.closest('[data-act="open"]');
      if (t) markSeen([t.dataset.bvid], true);
    });
    S.el.burger = burger;
    S.el.scrim = scrim;
    S.el.drawer = dr;
  }

  // 播放页的顶栏是服务器先渲染好、再由 B 站前端「接管」的，接管前往里面插任何东西都会让整条顶栏崩掉（实测会被清空）。
  // 所以 ≡ 不放进顶栏，而是挂在 body 上、用定位盖在顶栏左边（CSS 给顶栏左边留了空位），顶栏的结构一点不碰
  function mountPlay() {
    if (!S.el.burger.isConnected) document.body.append(S.el.burger);
    if (!S.el.drawer.isConnected) document.body.append(S.el.scrim, S.el.drawer);
    placeBurger();
    fillLogo();
    applyLayout();
  }
  // 顶栏上的 B 站 logo 借过来用。顶栏往往比菜单晚画好：拿不到就先写字，guardPlay 里再补
  function fillLogo() {
    const box = S.el.drawer && S.el.drawer.querySelector('.bdr-dr-logo');
    if (!box || box.querySelector('svg')) return;
    const logo = document.querySelector('.bili-header .big-logo__logo, .bili-header .left-entry__title svg');
    if (logo) box.replaceChildren(logo.cloneNode(true));
    else if (!box.textContent) box.textContent = '哔哩哔哩';
  }
  function placeBurger() {
    const b = S.el.burger;
    const bar = document.querySelector('.bili-header__bar');
    const r = bar && bar.getBoundingClientRect();
    if (!r || !r.height) { b.style.display = 'none'; return; }
    const fixed = getComputedStyle(bar).position === 'fixed';
    b.style.display = '';
    b.style.position = fixed ? 'fixed' : 'absolute';
    b.style.top = Math.round(r.top + (fixed ? 0 : window.scrollY) + (r.height - 40) / 2) + 'px';
    b.style.left = Math.round(r.left + 14) + 'px';
  }

  function toggleDrawer(open) {
    S.drawerOpen = open == null ? !S.drawerOpen : !!open;
    document.documentElement.classList.toggle('bdr-drawer-open', S.drawerOpen);
    if (!S.drawerOpen) return;
    renderAll();
    if (now() - store.get('lastRefreshAt', 0) > 180) refresh(); // 三分钟内刷新过就直接用缓存
  }

  // 播放页：点列表里的 UP，在菜单里就地切到 TA 的投稿，不离开当前页面
  function openDrawerUp(mid) {
    S.activeMid = mid;
    S.hasUpdate.delete(mid);
    loadUpVideos(mid);
    renderAll();
  }

  // 正在播放的视频算看过：菜单里不再给它挂新视频的蓝点，≡ 上的蓝点也跟着准
  const playingBvid = () => (location.pathname.match(/\/video\/(BV\w+)/) || [])[1] || new URLSearchParams(location.search).get('bvid') || '';
  function notePlaying() {
    const bv = playingBvid();
    if (bv && bv !== S.playing) { S.playing = bv; markSeen([bv]); }
  }

  function drItemHTML(v, current) {
    const w = watchInfo(v);
    const fresh = isNew(v);
    return `<a class="bdr-dr-vid${w.watched ? ' is-watched' : ''}${current ? ' is-current' : ''}" href="https://www.bilibili.com/video/${v.bvid}/" data-act="open" data-bvid="${v.bvid}" title="${esc(v.title)}">`
      + `<span class="bdr-dr-thumb"><img src="${esc(img(v.cover, '320w_180h_1c'))}" loading="lazy" alt="">`
      + (v.dur ? `<span class="bdr-dr-dur">${esc(v.dur)}</span>` : '')
      + (w.ratio ? `<span class="bdr-dr-prog"><i style="width:${Math.max(4, w.ratio * 100).toFixed(1)}%"></i></span>` : '')
      + '</span><span class="bdr-dr-vtext">'
      + `<span class="bdr-dr-vtitle">${fresh ? '<i class="bdr-dot is-new"></i>' : ''}${esc(v.title)}</span>`
      + `<span class="bdr-dr-vmeta">${current ? '正在播放' : ago(v.ts) + ' · ' + fmtNum(v.play) + '播放'}</span>`
      + '</span></a>';
  }

  function upDrawerHTML(mid) {
    const u = upInfo(mid);
    const st = S.upVideos.get(mid) || {};
    const items = upItems(mid);
    const newN = items.filter(isNew).length;
    const pri = isPriority(mid);
    const live = S.liveMap.get(mid);
    const cur = playingBvid();
    let body;
    if (st.loading && !items.length) {
      body = Array.from({ length: 6 }, () => '<div class="bdr-dr-vid bdr-skel"><span class="bdr-dr-thumb"></span>'
        + '<span class="bdr-dr-vtext"><span class="bdr-skel-line"></span><span class="bdr-skel-line is-short"></span></span></div>').join('');
    } else if (st.error && !items.length) {
      body = `<div class="bdr-none">没加载出来：${esc(st.error)} · <span class="bdr-link" data-act="up-retry" data-mid="${mid}">重试</span></div>`;
    } else if (!items.length) {
      body = '<div class="bdr-none">TA 最近没有投稿视频</div>';
    } else {
      body = items.map(v => drItemHTML(v, v.bvid === cur)).join('');
    }
    return '<div class="bdr-dr-up-head">'
      + `<span class="bdr-icon-btn" data-act="up-back" title="返回关注列表">${ICON.back}</span>`
      + `<a class="bdr-dr-up-user" href="https://space.bilibili.com/${mid}" target="_blank" data-act="link" title="打开 TA 的空间">`
      + `<img class="bdr-face" src="${esc(img(u.face, '64w_64h'))}" alt=""><span class="bdr-dr-up-name">${esc(u.uname)}</span></a>`
      + `<span class="bdr-icon-btn bdr-dr-star${pri ? ' is-on' : ''}${S.pending.has(mid) ? ' is-busy' : ''}" data-act="star" data-mid="${mid}" title="${pri ? '取消优先关注' : '设为优先关注'}">${pri ? ICON.starFill : ICON.star}</span>`
      + '</div><div class="bdr-dr-up-sub">'
      + (live ? `<a class="bdr-pill bdr-pill-live" href="${esc(live.url)}" target="_blank" data-act="link" title="${esc(live.title)}">直播中</a>` : '')
      + `<span>${newN ? newN + ' 个新视频' : '最近投稿'}</span><span class="bdr-flex"></span>`
      + (newN ? `<span class="bdr-link" data-act="mark-up" data-mid="${mid}">全部标为已看</span>` : '')
      + `</div><div class="bdr-dr-up-list">${body}`
      + `<a class="bdr-dr-up-more" href="https://space.bilibili.com/${mid}/video" target="_blank" data-act="link">在 TA 的空间看全部投稿</a></div>`;
  }

  function renderDrawer() {
    const total = baseVideos().filter(isNew).length;
    if (S.el.burger) {
      S.el.burger.classList.toggle('has-new', total > 0);
      S.el.burger.title = total ? `关注列表 · ${total} 个新视频` : '关注列表';
    }
    if (!S.el.drawer) return;
    const cnt = S.el.drawer.querySelector('.bdr-dr-count');
    if (cnt) { cnt.title = `${total} 个新视频`; cnt.style.display = total ? '' : 'none'; }
    const st = S.el.drawer.querySelector('.bdr-dr-status');
    if (st) st.innerHTML = statusHTML();
    // 菜单中间：关注列表、某位 UP 的投稿，二选一
    const up = S.activeMid;
    S.el.drawer.classList.toggle('is-up', !!up);
    if (!up) { S.el.drUp.innerHTML = ''; S.el.drUp.dataset.mid = ''; return; }
    const old = S.el.drUp.querySelector('.bdr-dr-up-list');
    const keep = old && S.el.drUp.dataset.mid === up ? old.scrollTop : 0; // 重画时保住滚动位置
    S.el.drUp.innerHTML = upDrawerHTML(up);
    S.el.drUp.dataset.mid = up;
    const list = S.el.drUp.querySelector('.bdr-dr-up-list');
    if (list) list.scrollTop = keep;
  }

  function guardPlay() {
    if (S.dead) return;
    if (!S.el.burger.isConnected || !S.el.drawer.isConnected) mountPlay(); else { placeBurger(); fillLogo(); }
    notePlaying(); // 切合集、自动连播时地址会变
  }
  function onKey(e) {
    if (e.key !== 'Escape' || !S.drawerOpen || document.querySelector('.bdr-modal-mask')) return; // 设置弹窗开着时 Esc 只关弹窗
    toggleDrawer(false);
  }

  async function initPlay() {
    injectStyle();
    applyHeader();
    document.documentElement.classList.add('bdr-play'); // CSS 据此给顶栏左边留出 ≡ 的位置
    // 等页面解析完再往 body 里挂东西（见 mountPlay 的说明）
    const bar = await waitFor(() => document.readyState !== 'loading' && document.querySelector('.bili-header__bar'), 30000);
    if (!bar || S.dead) return;
    S.me = (document.cookie.match(/(?:^|;\s*)DedeUserID=(\d+)/) || [])[1] || '';
    if (!S.me) { document.documentElement.classList.remove('bdr-play'); return; } // 没登录：不加菜单
    loadCaches();
    notePlaying();
    buildDrawer();
    mountPlay();
    renderAll();
    S.timers.push(setInterval(guardPlay, 1500));
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', placeBurger);
    // 数据超过 10 分钟没刷新：等视频先加载几秒，再在后台刷一次，≡ 上的蓝点才准
    if (now() - store.get('lastRefreshAt', 0) > 600) setTimeout(() => { if (!S.dead && !S.refreshing) refresh(); }, 4000);
  }

  // 其余 B 站页面：只精简顶栏
  function initOther() {
    injectStyle();
    applyHeader();
  }

  window.__bdrTeardown = function () {
    S.dead = true;
    S.timers.forEach(clearInterval);
    document.removeEventListener('visibilitychange', onVisible);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', placeBurger);
    closeSettings();
    ['side', 'wall', 'live', 'burger', 'scrim', 'drawer'].forEach(k => S.el[k] && S.el[k].remove());
    document.querySelectorAll('#bdr-style, .bdr-toast').forEach(e => e.remove());
    document.documentElement.classList.remove('bdr-on', 'bdr-hide-publish', 'bdr-hide-livecard', 'bdr-hide-banner', 'bdr-hide-oldbtn',
      'bdr-no-drawer', 'bdr-drawer-open', 'bdr-play', 'bdr-slim-header', 'bdr-live-right', 'bdr-live-hide', 'bdr-live-native');
    document.querySelectorAll('.bdr-live-card, .bdr-old-btn').forEach(e => e.classList.remove('bdr-live-card', 'bdr-old-btn'));
    document.querySelectorAll('[data-bdr-t]').forEach(e => e.removeAttribute('data-bdr-t'));
    if (S.baseTitle) document.title = S.baseTitle;
  };

  /* ========================= 样式 ========================= */
  // 颜色全部用 B 站自己的 CSS 变量（--bg1、--text1、--brand_blue…），深色模式自动跟着变

  const CSS = `
html.bdr-on .bili-dyn-home--member main > section:has(> .bili-dyn-up-list) { display: none !important; }
html.bdr-on.bdr-hide-publish .bili-dyn-home--member main > section:has(> .bili-dyn-publishing) { display: none !important; }
html.bdr-on:not(.bdr-live-native) .bili-dyn-home--member .bili-dyn-live-users { display: none !important; }
html.bdr-on.bdr-hide-livecard .bili-dyn-list__item.bdr-live-card { display: none !important; }
html.bdr-on.bdr-hide-banner .bili-dyn-home--member aside.right > section:has(> .bili-dyn-banner) { display: none !important; }
html.bdr-on.bdr-hide-oldbtn .bili-dyn-sidebar__btn.bdr-old-btn { display: none !important; }

/* 精简顶栏。前一半是页面加载完的顶栏（div.left-entry__item），后一半是播放页刚打开时服务器渲染的那版（li），
   都按链接地址或固定 class 认；「首页」那项的下拉里也有各站链接，所以按后代链接认时要把它排除 */
html.bdr-slim-header .bili-header .left-entry__item.game-download-notify-entry-wrap,
html.bdr-slim-header .bili-header .left-entry__item:not(.home-page-panel-entry):has(a[href*="game.bilibili.com"]),
html.bdr-slim-header .bili-header .left-entry__item:has(> a[href*="show.bilibili.com"]),
html.bdr-slim-header .bili-header .left-entry__item:has(> a[href*="/match/"]),
html.bdr-slim-header .bili-header .left-entry__item.left-loc-entry,
html.bdr-slim-header .bili-header .left-entry__item:has(> a[href*="app.bilibili.com"]),
html.bdr-slim-header .bili-header .right-entry__item.upload-entry,
html.bdr-slim-header .bili-header .right-entry__item:has(> a[href*="member.bilibili.com/platform/home"]),
html.bdr-slim-header .bili-header .left-entry > li:has(> a[href*="game.bilibili.com"]),
html.bdr-slim-header .bili-header .left-entry > li:has(> a[href*="show.bilibili.com"]),
html.bdr-slim-header .bili-header .left-entry > li:has(> a[href*="/match/"]),
html.bdr-slim-header .bili-header .left-entry > li:has(> a[href*="app.bilibili.com"]),
html.bdr-slim-header .bili-header .right-entry-item--upload,
html.bdr-slim-header .bili-header .right-entry-item:has(> a[href*="member.bilibili.com/platform/home"]) { display: none !important; }

#bdr-side, #bdr-wall, #bdr-live, .bdr-modal-mask, .bdr-toast {
  font-family: inherit; color: var(--text1, #18191c); -webkit-font-smoothing: antialiased; text-align: left;
}
#bdr-side *, #bdr-wall *, #bdr-live *, .bdr-modal-mask * { box-sizing: border-box; }
#bdr-side svg, #bdr-wall svg, #bdr-live svg, .bdr-modal-mask svg { display: block; flex: none; }
#bdr-side a, #bdr-wall a, #bdr-live a { text-decoration: none; }

.bdr-flex { flex: 1 1 auto; min-width: 0; }
.bdr-link { color: var(--brand_blue, #00aeec); cursor: pointer; }
.bdr-link:hover { text-decoration: underline; }
.bdr-err { color: var(--Re5, #f85a54); cursor: help; }
.bdr-icon-btn {
  width: 28px; height: 28px; flex: none; display: inline-flex; align-items: center; justify-content: center;
  border-radius: 6px; color: var(--text2, #61666d); cursor: pointer; transition: background .15s, color .15s;
}
.bdr-icon-btn:hover { background: var(--graph_bg_regular, #f1f2f3); color: var(--brand_blue, #00aeec); }
.bdr-icon-btn svg { width: 18px; height: 18px; }
.bdr-icon-btn.is-spin svg { animation: bdr-spin 1s linear infinite; }
@keyframes bdr-spin { to { transform: rotate(360deg); } }
.bdr-btn {
  display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 10px; flex: none;
  border-radius: 6px; font-size: 13px; color: var(--text2, #61666d) !important; background: var(--graph_bg_regular, #f1f2f3);
  cursor: pointer; white-space: nowrap; transition: color .15s;
}
.bdr-btn:hover { color: var(--brand_blue, #00aeec) !important; }
.bdr-btn svg { width: 15px; height: 15px; }
.bdr-btn.is-pri svg { color: var(--Ye5, #ffb027); }
.bdr-pill {
  display: inline-block; flex: none; min-width: 18px; height: 18px; padding: 0 6px; border-radius: 9px;
  font-size: 11px; line-height: 18px; font-weight: 600; text-align: center; color: #fff !important;
}
.bdr-pill-live { background: var(--brand_pink, #ff6699); }
/* 实心小蓝点 = 有新视频；空心灰圈 = 只有图文、转发等别的动态 */
.bdr-dot { display: inline-block; flex: none; width: 8px; height: 8px; margin-right: 6px; border-radius: 50%; box-sizing: border-box; border: 1.5px solid var(--graph_weak, #c9ccd0); }
.bdr-dot.is-new { border: 0; background: var(--brand_blue, #00aeec); }
.bdr-chip {
  display: inline-flex; align-items: center; gap: 2px; height: 24px; padding: 0 8px; border-radius: 12px;
  font-size: 12px; color: var(--text2, #61666d); background: var(--graph_bg_regular, #f1f2f3); cursor: pointer; white-space: nowrap;
}
.bdr-chip em { font-style: normal; color: var(--text3, #9499a0); margin-left: 2px; }
.bdr-chip:hover { color: var(--brand_blue, #00aeec); }
.bdr-chip.is-on { color: var(--brand_blue, #00aeec); background: var(--brand_blue_thin, #dff6fd); }
.bdr-chip.is-on em { color: inherit; }
.bdr-chip svg { width: 13px; height: 13px; margin-left: 2px; }

/* 骨架屏 */
.bdr-skel .bdr-cover, .bdr-skel .bdr-face, .bdr-skel .bdr-dr-thumb, .bdr-skel-line {
  background: linear-gradient(90deg, var(--graph_bg_regular, #f1f2f3) 25%, var(--graph_bg_thick, #e3e5e7) 40%, var(--graph_bg_regular, #f1f2f3) 60%);
  background-size: 400% 100%; animation: bdr-shimmer 1.4s ease infinite;
}
.bdr-skel-line { display: block; height: 12px; border-radius: 4px; margin-top: 10px; width: 90%; }
.bdr-skel-line.is-short { width: 55%; }
.bdr-row.bdr-skel .bdr-skel-line { margin: 0; width: 60%; }
@keyframes bdr-shimmer { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }

/* ---------- 左侧关注列表 ---------- */
#bdr-side {
  position: sticky; top: 72px; z-index: 1; margin: 0 0 8px; display: flex; flex-direction: column;
  max-height: calc(100vh - 88px); background: var(--bg1, #fff); border-radius: 6px; overflow: hidden;
}
html.bdr-live-native #bdr-side { margin-top: 8px; }
#bdr-side .bdr-side-head { display: flex; align-items: baseline; gap: 6px; padding: 16px 16px 10px; }
#bdr-side .bdr-h { font-size: 17px; font-weight: 600; line-height: 24px; color: var(--text1, #18191c); }
#bdr-side .bdr-h-count { font-size: 15px; color: var(--text3, #9499a0); }
#bdr-side .bdr-search { position: relative; display: block; margin: 0 12px 10px; }
#bdr-side .bdr-search svg { position: absolute; left: 9px; top: 8px; width: 16px; height: 16px; color: var(--text3, #9499a0); pointer-events: none; }
#bdr-side .bdr-search input {
  width: 100%; height: 32px; padding: 0 10px 0 31px; border: 1px solid transparent; border-radius: 6px; outline: none;
  font: inherit; font-size: 13px; color: var(--text1, #18191c); background: var(--graph_bg_regular, #f1f2f3);
  transition: border-color .15s, background .15s;
}
#bdr-side .bdr-search input::placeholder { color: var(--text3, #9499a0); }
#bdr-side .bdr-search input:focus { border-color: var(--brand_blue, #00aeec); background: var(--bg1, #fff); }
#bdr-side .bdr-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 12px 8px; }
#bdr-side .bdr-list {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 0 6px 10px;
  scrollbar-width: thin; scrollbar-color: transparent transparent;
}
#bdr-side .bdr-list:hover { scrollbar-color: var(--graph_weak, #c9ccd0) transparent; }
#bdr-side .bdr-sec { display: flex; align-items: center; gap: 4px; padding: 12px 10px 4px; font-size: 12px; color: var(--text3, #9499a0); }
#bdr-side .bdr-sec em { font-style: normal; }
#bdr-side .bdr-row {
  position: relative; display: flex; align-items: center; gap: 10px; height: 38px; padding: 0 6px 0 10px;
  border-radius: 6px; color: var(--text1, #18191c); cursor: pointer; transition: background .12s;
}
#bdr-side .bdr-row:hover { background: var(--graph_bg_regular, #f1f2f3); }
#bdr-side .bdr-row.is-active { background: var(--brand_blue_thin, #dff6fd); }
#bdr-side .bdr-row.is-active .bdr-name { color: var(--brand_blue, #00aeec); font-weight: 600; }
#bdr-side .bdr-face { width: 28px; height: 28px; flex: none; border-radius: 50%; object-fit: cover; background: var(--graph_bg_thick, #e3e5e7); }
#bdr-side .bdr-face-icon { display: flex; align-items: center; justify-content: center; color: var(--brand_blue, #00aeec); background: var(--brand_blue_thin, #dff6fd); }
#bdr-side .bdr-face-icon svg { width: 18px; height: 18px; }
#bdr-side .bdr-name { flex: 1 1 auto; min-width: 0; font-size: 14px; line-height: 20px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#bdr-side .bdr-row.has-new .bdr-name { font-weight: 600; }
#bdr-side .bdr-meta { display: flex; align-items: center; gap: 4px; flex: none; }
#bdr-side .bdr-star {
  display: none; width: 24px; height: 24px; flex: none; align-items: center; justify-content: center;
  border-radius: 5px; color: var(--text3, #9499a0);
}
#bdr-side .bdr-row:hover .bdr-star { display: flex; }
#bdr-side .bdr-star:hover { background: var(--graph_bg_thick, #e3e5e7); color: var(--Ye5, #ffb027); }
#bdr-side .bdr-star.is-on { color: var(--Ye5, #ffb027); }
#bdr-side .bdr-star.is-busy { display: flex; opacity: .4; pointer-events: none; }
#bdr-side .bdr-star svg { width: 16px; height: 16px; }
#bdr-side .bdr-more {
  display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 14px; margin-top: 2px;
  border-radius: 6px; font-size: 13px; color: var(--text2, #61666d); cursor: pointer;
}
#bdr-side .bdr-more:hover { background: var(--graph_bg_regular, #f1f2f3); color: var(--brand_blue, #00aeec); }
#bdr-side .bdr-more svg { width: 16px; height: 16px; }
#bdr-side .bdr-none { padding: 14px 10px; font-size: 13px; color: var(--text3, #9499a0); }

/* ---------- 中间新视频墙 ---------- */
#bdr-wall { margin: 0 0 8px; padding: 0 16px; background: var(--bg1, #fff); border-radius: 6px; }
#bdr-wall .bdr-wall-head { display: flex; align-items: center; gap: 8px; height: 52px; }
#bdr-wall .bdr-tabs { display: flex; align-items: stretch; gap: 22px; height: 100%; margin-right: 4px; }
#bdr-wall .bdr-tab {
  position: relative; display: flex; align-items: center; font-size: 15px; color: var(--text2, #61666d);
  cursor: pointer; white-space: nowrap; transition: color .15s;
}
#bdr-wall .bdr-tab em { font-style: normal; font-size: 12px; color: var(--text3, #9499a0); margin-left: 4px; }
#bdr-wall .bdr-tab:hover { color: var(--brand_blue, #00aeec); }
#bdr-wall .bdr-tab.is-on { color: var(--brand_blue, #00aeec); font-weight: 600; }
#bdr-wall .bdr-tab.is-on em { color: var(--brand_blue, #00aeec); font-weight: 400; }
#bdr-wall .bdr-tab.is-on::after {
  content: ''; position: absolute; left: 50%; bottom: 8px; width: 14px; height: 2px; margin-left: -7px;
  border-radius: 1px; background: var(--brand_blue, #00aeec);
}
#bdr-wall .bdr-status { font-size: 12px; color: var(--text3, #9499a0); white-space: nowrap; }
#bdr-wall .bdr-up-head { display: flex; align-items: center; gap: 8px; min-width: 0; color: var(--text1, #18191c); }
#bdr-wall .bdr-up-head:hover .bdr-up-name { color: var(--brand_blue, #00aeec); }
#bdr-wall .bdr-up-head .bdr-face { width: 30px; height: 30px; border-radius: 50%; object-fit: cover; background: var(--graph_bg_thick, #e3e5e7); }
#bdr-wall .bdr-up-name { font-size: 16px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 180px; }
#bdr-wall .bdr-sub { font-size: 13px; color: var(--text3, #9499a0); white-space: nowrap; }
#bdr-wall .bdr-note { margin: -4px 0 10px; font-size: 12px; color: var(--text3, #9499a0); }
#bdr-wall .bdr-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(${CARD_MIN}px, 1fr)); gap: 20px ${CARD_GAP}px; padding: 8px 0 16px; }
#bdr-wall .bdr-grid-label { grid-column: 1 / -1; display: flex; align-items: center; gap: 4px; margin-bottom: -8px; font-size: 13px; color: var(--text3, #9499a0); }
#bdr-wall .bdr-grid-label em { font-style: normal; }
#bdr-wall .bdr-grid-label svg { width: 14px; height: 14px; color: var(--Ye5, #ffb027); }
#bdr-wall .bdr-grid-label:not(:first-child) { margin-top: 4px; }
#bdr-wall .bdr-card { position: relative; min-width: 0; }
#bdr-wall .bdr-cover {
  position: relative; display: block; aspect-ratio: 16 / 9; overflow: hidden; border-radius: 6px;
  background: var(--graph_bg_thick, #e3e5e7);
}
#bdr-wall .bdr-cover img { display: block; width: 100%; height: 100%; object-fit: cover; transition: transform .25s, opacity .2s; }
#bdr-wall .bdr-card:hover .bdr-cover img { transform: scale(1.04); }
#bdr-wall .bdr-cover-bar {
  position: absolute; left: 0; right: 0; bottom: 0; display: flex; align-items: center; gap: 10px;
  height: 34px; padding: 10px 8px 0; font-size: 12px; color: #fff; pointer-events: none;
  background: linear-gradient(rgba(0,0,0,0), rgba(0,0,0,.65));
}
#bdr-wall .bdr-cover-bar span { display: inline-flex; align-items: center; gap: 3px; white-space: nowrap; }
#bdr-wall .bdr-cover-bar svg { width: 15px; height: 15px; }
#bdr-wall .bdr-badge {
  position: absolute; top: 6px; left: 6px; height: 18px; padding: 0 6px; border-radius: 4px;
  font-size: 11px; line-height: 18px; color: #fff; background: var(--brand_pink, #ff6699);
}
#bdr-wall .bdr-badge.is-gray { background: rgba(0,0,0,.6); }
#bdr-wall .bdr-prog { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: rgba(255,255,255,.35); }
#bdr-wall .bdr-prog i { display: block; height: 100%; background: var(--brand_pink, #ff6699); }
#bdr-wall .bdr-acts { position: absolute; top: 6px; right: 6px; display: flex; flex-direction: column; gap: 6px; opacity: 0; transition: opacity .15s; }
#bdr-wall .bdr-card:hover .bdr-acts { opacity: 1; }
#bdr-wall .bdr-act {
  display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 6px;
  color: #fff; background: rgba(0,0,0,.6); cursor: pointer; transition: background .15s;
}
#bdr-wall .bdr-act:hover { background: rgba(0,0,0,.85); }
#bdr-wall .bdr-act.is-done { background: var(--brand_blue, #00aeec); }
#bdr-wall .bdr-act svg { width: 17px; height: 17px; }
#bdr-wall .bdr-title {
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  height: 44px; margin-top: 8px; font-size: 15px; line-height: 22px; color: var(--text1, #18191c); word-break: break-all;
  transition: color .15s;
}
#bdr-wall .bdr-title:hover { color: var(--brand_blue, #00aeec); }
#bdr-wall .bdr-newdot { display: inline-block; width: 7px; height: 7px; margin: 0 6px 2px 0; border-radius: 50%; vertical-align: middle; background: var(--brand_blue, #00aeec); }
#bdr-wall .bdr-info { display: flex; align-items: center; min-width: 0; margin-top: 4px; font-size: 13px; line-height: 18px; color: var(--text3, #9499a0); }
#bdr-wall .bdr-up { display: inline-flex; align-items: center; gap: 2px; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; cursor: pointer; transition: color .15s; }
#bdr-wall .bdr-up:hover { color: var(--brand_blue, #00aeec); }
#bdr-wall .bdr-up svg { width: 13px; height: 13px; color: var(--Ye5, #ffb027); }
#bdr-wall .bdr-sep { margin: 0 5px; flex: none; }
#bdr-wall .bdr-time { flex: none; white-space: nowrap; }
#bdr-wall .bdr-card.is-watched .bdr-cover img { opacity: .5; }
#bdr-wall .bdr-card.is-watched .bdr-title { color: var(--text3, #9499a0); }
#bdr-wall .bdr-card.is-stack .bdr-cover { box-shadow: 0 -4px 0 -2px var(--graph_weak, #c9ccd0), 0 -8px 0 -4px var(--graph_bg_thick, #e3e5e7); }
#bdr-wall .bdr-stack-n {
  flex: none; margin-left: auto; height: 18px; padding: 0 7px; border-radius: 9px; font-size: 12px; line-height: 18px;
  color: var(--brand_blue, #00aeec); background: var(--brand_blue_thin, #dff6fd); cursor: pointer; transition: color .15s, background .15s;
}
#bdr-wall .bdr-stack-n:hover { color: #fff; background: var(--brand_blue, #00aeec); }
#bdr-wall .bdr-expand {
  display: flex; align-items: center; justify-content: center; gap: 4px; height: 40px; margin: 0 -16px;
  border-top: 1px solid var(--line_light, #f1f2f3); font-size: 13px; color: var(--text2, #61666d); cursor: pointer;
}
#bdr-wall .bdr-expand:hover { color: var(--brand_blue, #00aeec); }
#bdr-wall .bdr-expand svg { width: 16px; height: 16px; }
#bdr-wall .bdr-empty { padding: 26px 0 32px; text-align: center; font-size: 14px; color: var(--text3, #9499a0); }

/* ---------- 右侧直播卡片 ---------- */
#bdr-live { margin: 0 0 8px; background: var(--bg1, #fff); border-radius: 6px; overflow: hidden; }
#bdr-live .bdr-live-head { display: flex; align-items: center; gap: 8px; height: 46px; padding: 0 12px 0 16px; cursor: pointer; user-select: none; }
#bdr-live .bdr-live-head:hover .bdr-chev { color: var(--brand_blue, #00aeec); }
#bdr-live .bdr-live-icon { color: var(--brand_pink, #ff6699); }
#bdr-live .bdr-live-icon svg { width: 18px; height: 18px; }
#bdr-live .bdr-live-title { font-size: 14px; font-weight: 600; color: var(--text1, #18191c); white-space: nowrap; }
#bdr-live .bdr-live-title em { font-style: normal; font-weight: 400; color: var(--text3, #9499a0); margin-left: 4px; }
#bdr-live .bdr-live-faces { flex: 1; display: flex; justify-content: flex-end; padding-left: 6px; }
#bdr-live .bdr-live-faces img { width: 24px; height: 24px; margin-left: -6px; border-radius: 50%; border: 2px solid var(--bg1, #fff); object-fit: cover; }
#bdr-live .bdr-chev { color: var(--text3, #9499a0); transition: transform .2s; }
#bdr-live .bdr-chev svg { width: 16px; height: 16px; }
#bdr-live.is-open .bdr-chev { transform: rotate(180deg); }
#bdr-live.is-open .bdr-live-faces { visibility: hidden; }
#bdr-live .bdr-live-body { display: none; padding: 0 6px 6px; }
#bdr-live.is-open .bdr-live-body { display: block; }
#bdr-live .bdr-live-row { display: flex; align-items: center; gap: 10px; padding: 6px 10px; border-radius: 6px; color: var(--text1, #18191c); }
#bdr-live .bdr-live-row:hover { background: var(--graph_bg_regular, #f1f2f3); }
#bdr-live .bdr-live-row img { width: 36px; height: 36px; flex: none; padding: 1px; border-radius: 50%; border: 2px solid var(--brand_pink, #ff6699); object-fit: cover; }
#bdr-live .bdr-live-text { display: flex; flex-direction: column; min-width: 0; }
#bdr-live .bdr-live-name { font-size: 14px; line-height: 20px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#bdr-live .bdr-live-sub { font-size: 12px; line-height: 17px; color: var(--text3, #9499a0); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#bdr-live .bdr-live-more { display: block; padding: 8px 0 4px; text-align: center; font-size: 12px; color: var(--text3, #9499a0); }
#bdr-live .bdr-live-more:hover { color: var(--brand_blue, #00aeec); }

/* ---------- 设置弹窗、提示条 ---------- */
.bdr-modal-mask { position: fixed; inset: 0; z-index: 100000; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.45); }
.bdr-modal-mask .bdr-modal {
  width: 460px; max-width: calc(100vw - 32px); max-height: calc(100vh - 64px); overflow-y: auto; padding: 18px 24px 20px;
  border-radius: 10px; color: var(--text1, #18191c); background: var(--bg1_float, var(--bg1, #fff)); box-shadow: 0 12px 40px rgba(0,0,0,.25);
}
.bdr-modal-mask .bdr-modal-head { display: flex; align-items: center; margin-bottom: 6px; font-size: 17px; }
.bdr-modal-mask .bdr-set { display: flex; align-items: center; gap: 16px; padding: 11px 0; border-bottom: 1px solid var(--line_light, #f1f2f3); font-size: 14px; cursor: pointer; }
.bdr-modal-mask .bdr-set-text { flex: 1; min-width: 0; line-height: 20px; }
.bdr-modal-mask .bdr-set small { display: block; margin-top: 2px; font-size: 12px; line-height: 17px; color: var(--text3, #9499a0); }
.bdr-modal-mask select {
  height: 30px; padding: 0 6px; border: 1px solid var(--line_regular, #e3e5e7); border-radius: 6px; outline: none;
  font: inherit; font-size: 13px; color: var(--text1, #18191c); background: var(--bg1, #fff); cursor: pointer;
}
.bdr-modal-mask .bdr-switch { position: relative; width: 36px; height: 20px; flex: none; }
.bdr-modal-mask .bdr-switch input { position: absolute; inset: 0; z-index: 1; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
.bdr-modal-mask .bdr-switch i { position: absolute; inset: 0; border-radius: 10px; background: var(--graph_bg_thick, #e3e5e7); transition: background .2s; }
.bdr-modal-mask .bdr-switch i::after {
  content: ''; position: absolute; left: 2px; top: 2px; width: 16px; height: 16px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.25); transition: transform .2s;
}
.bdr-modal-mask .bdr-switch input:checked + i { background: var(--brand_blue, #00aeec); }
.bdr-modal-mask .bdr-switch input:checked + i::after { transform: translateX(16px); }
.bdr-modal-mask .bdr-modal-tip { margin-top: 12px; font-size: 12px; line-height: 18px; color: var(--text3, #9499a0); }
.bdr-modal-mask .bdr-modal-foot { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
.bdr-modal-mask .bdr-ver { font-size: 12px; color: var(--text4, #c9ccd0); }
.bdr-toast {
  position: fixed; left: 50%; bottom: 56px; z-index: 100001; display: flex; align-items: center; gap: 14px;
  padding: 10px 18px; border-radius: 8px; transform: translateX(-50%); font-size: 14px; color: #fff !important;
  background: rgba(24,25,28,.92); box-shadow: 0 6px 24px rgba(0,0,0,.2); transition: opacity .3s;
}
.bdr-toast b { color: #4fc3f7; font-weight: 600; cursor: pointer; }
.bdr-toast.is-out { opacity: 0; }

/* ---------- 播放页：顶栏 ≡ + 左侧抽屉 ---------- */
html.bdr-play:not(.bdr-no-drawer) .bili-header__bar { padding-left: 64px !important; }
#bdr-burger {
  position: fixed; top: 12px; left: 14px; z-index: 1003; display: flex; align-items: center; justify-content: center;
  width: 40px; height: 40px; border-radius: 50%; color: var(--text1, #18191c); cursor: pointer; transition: background .15s;
}
#bdr-burger:hover { background: var(--graph_bg_regular, #f1f2f3); }
#bdr-burger svg { display: block; width: 22px; height: 22px; }
#bdr-burger .bdr-burger-dot {
  display: none; position: absolute; top: 8px; right: 7px; width: 8px; height: 8px; border-radius: 50%;
  background: var(--brand_blue, #00aeec); box-shadow: 0 0 0 2px var(--bg1, #fff);
}
#bdr-burger.has-new .bdr-burger-dot { display: block; }
html.bdr-no-drawer #bdr-burger { display: none; }
#bdr-scrim { position: fixed; inset: 0; z-index: 99989; background: rgba(0,0,0,.4); opacity: 0; pointer-events: none; transition: opacity .2s; }
html.bdr-drawer-open #bdr-scrim { opacity: 1; pointer-events: auto; }
#bdr-drawer {
  position: fixed; top: 0; bottom: 0; left: 0; z-index: 99990; display: flex; flex-direction: column; width: 264px;
  font-family: inherit; text-align: left; color: var(--text1, #18191c); background: var(--bg1, #fff); box-shadow: 4px 0 24px rgba(0,0,0,.16);
  transform: translateX(-110%); visibility: hidden; transition: transform .22s ease, visibility 0s linear .22s;
}
html.bdr-drawer-open #bdr-drawer { transform: none; visibility: visible; transition: transform .22s ease, visibility 0s; }
#bdr-drawer * { box-sizing: border-box; }
#bdr-drawer a { text-decoration: none; }
#bdr-drawer svg { display: block; flex: none; }
#bdr-drawer .bdr-dr-head { display: flex; align-items: center; gap: 8px; flex: none; height: 64px; padding: 0 16px 0 14px; }
#bdr-drawer .bdr-dr-head .bdr-icon-btn { width: 40px; height: 40px; border-radius: 50%; color: var(--text1, #18191c); }
#bdr-drawer .bdr-dr-head .bdr-icon-btn svg { width: 22px; height: 22px; }
#bdr-drawer .bdr-dr-logo { display: flex; align-items: center; color: var(--brand_blue, #00aeec); font-size: 18px; font-weight: 600; }
#bdr-drawer .bdr-dr-logo svg { width: 84px; height: 38px; }
#bdr-drawer .bdr-dr-nav { flex: none; padding: 0 8px 8px; border-bottom: 1px solid var(--line_light, #f1f2f3); }
#bdr-drawer .bdr-dr-link {
  display: flex; align-items: center; gap: 16px; height: 40px; padding: 0 12px; border-radius: 8px;
  font-size: 14px; color: var(--text1, #18191c); transition: background .12s;
}
#bdr-drawer .bdr-dr-link:hover { background: var(--graph_bg_regular, #f1f2f3); }
#bdr-drawer .bdr-dr-link svg { width: 20px; height: 20px; color: var(--text2, #61666d); }
#bdr-drawer .bdr-dr-link span { flex: 1; }
#bdr-drawer #bdr-side { position: static; flex: 1 1 auto; min-height: 0; max-height: none; margin: 0; border-radius: 0; background: transparent; }
#bdr-drawer #bdr-side .bdr-row-all { display: none; }
#bdr-drawer .bdr-dr-foot {
  display: flex; align-items: center; gap: 2px; flex: none; height: 44px; padding: 0 10px 0 16px;
  border-top: 1px solid var(--line_light, #f1f2f3); font-size: 12px; color: var(--text3, #9499a0);
}
#bdr-drawer .bdr-dr-status { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#bdr-drawer.is-up { width: 340px; }
#bdr-drawer.is-up #bdr-side { display: none; }
#bdr-drawer .bdr-dr-up { display: none; flex: 1 1 auto; min-height: 0; flex-direction: column; }
#bdr-drawer.is-up .bdr-dr-up { display: flex; }
#bdr-drawer .bdr-dr-up-head { display: flex; align-items: center; gap: 6px; flex: none; padding: 12px 10px 6px 8px; }
#bdr-drawer .bdr-dr-up-user { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; color: var(--text1, #18191c); }
#bdr-drawer .bdr-dr-up-user .bdr-face { width: 32px; height: 32px; flex: none; border-radius: 50%; object-fit: cover; background: var(--graph_bg_thick, #e3e5e7); }
#bdr-drawer .bdr-dr-up-name { font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#bdr-drawer .bdr-dr-up-user:hover .bdr-dr-up-name { color: var(--brand_blue, #00aeec); }
#bdr-drawer .bdr-dr-star.is-on { color: var(--Ye5, #ffb027); }
#bdr-drawer .bdr-dr-star.is-busy { opacity: .4; pointer-events: none; }
#bdr-drawer .bdr-dr-up-sub { display: flex; align-items: center; gap: 8px; flex: none; padding: 0 16px 8px 48px; font-size: 12px; color: var(--text3, #9499a0); }
#bdr-drawer .bdr-dr-up-list {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 0 8px 10px;
  scrollbar-width: thin; scrollbar-color: transparent transparent;
}
#bdr-drawer .bdr-dr-up-list:hover { scrollbar-color: var(--graph_weak, #c9ccd0) transparent; }
#bdr-drawer .bdr-dr-vid { display: flex; gap: 10px; padding: 6px; border-radius: 8px; color: var(--text1, #18191c); transition: background .12s; }
#bdr-drawer .bdr-dr-vid:hover { background: var(--graph_bg_regular, #f1f2f3); }
#bdr-drawer .bdr-dr-vid.is-current { background: var(--brand_blue_thin, #dff6fd); }
#bdr-drawer .bdr-dr-thumb { position: relative; flex: none; width: 128px; aspect-ratio: 16 / 9; overflow: hidden; border-radius: 6px; background: var(--graph_bg_thick, #e3e5e7); }
#bdr-drawer .bdr-dr-thumb img { display: block; width: 100%; height: 100%; object-fit: cover; }
#bdr-drawer .bdr-dr-dur { position: absolute; right: 4px; bottom: 4px; padding: 0 4px; border-radius: 3px; font-size: 11px; line-height: 16px; color: #fff; background: rgba(0,0,0,.7); }
#bdr-drawer .bdr-dr-prog { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: rgba(255,255,255,.35); }
#bdr-drawer .bdr-dr-prog i { display: block; height: 100%; background: var(--brand_pink, #ff6699); }
#bdr-drawer .bdr-dr-vtext { display: flex; flex: 1; flex-direction: column; gap: 4px; min-width: 0; }
#bdr-drawer .bdr-dr-vtitle { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: 13px; line-height: 18px; word-break: break-all; }
#bdr-drawer .bdr-dr-vtitle .bdr-dot { margin: 0 5px 1px 0; vertical-align: middle; }
#bdr-drawer .bdr-dr-vmeta { font-size: 12px; color: var(--text3, #9499a0); }
#bdr-drawer .bdr-dr-vid.is-current .bdr-dr-vmeta { color: var(--brand_blue, #00aeec); }
#bdr-drawer .bdr-dr-vid.is-watched .bdr-dr-thumb img { opacity: .55; }
#bdr-drawer .bdr-dr-vid.is-watched .bdr-dr-vtitle { color: var(--text3, #9499a0); }
#bdr-drawer .bdr-dr-vid.bdr-skel .bdr-skel-line { margin-top: 6px; }
#bdr-drawer .bdr-dr-up-more { display: block; padding: 10px 6px 4px; text-align: center; font-size: 12px; color: var(--text3, #9499a0); }
#bdr-drawer .bdr-dr-up-more:hover { color: var(--brand_blue, #00aeec); }
#bdr-drawer .bdr-dr-up-list .bdr-none { padding: 24px 10px 6px; text-align: center; font-size: 13px; color: var(--text3, #9499a0); }
`;

  if (PAGE === 'dyn') initDyn(); else if (PAGE === 'play') initPlay(); else initOther();
})();
