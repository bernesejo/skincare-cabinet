'use strict';

// ============ 常量 ============
// order 决定早晚流程里的使用顺序
const CATEGORIES = [
  { id: 'cleanser',    name: '洁面',     emoji: '🫧', order: 1 },
  { id: 'toner',       name: '化妆水',   emoji: '💧', order: 2 },
  { id: 'essence',     name: '精华水',   emoji: '🌊', order: 3 },
  { id: 'serum',       name: '精华',     emoji: '✨', order: 4 },
  { id: 'treatment',   name: '功效护理', emoji: '🧪', order: 5, hint: '酸类、A醇等' },
  { id: 'eye',         name: '眼霜',     emoji: '👁️', order: 6 },
  { id: 'moisturizer', name: '乳液/面霜', emoji: '🧴', order: 7 },
  { id: 'oil',         name: '面油',     emoji: '🫒', order: 8 },
  { id: 'sunscreen',   name: '防晒',     emoji: '☀️', order: 9 },
  { id: 'mask',        name: '面膜',     emoji: '🎭', order: 10 },
  { id: 'lip',         name: '唇部',     emoji: '💋', order: 11 },
  { id: 'body',        name: '身体',     emoji: '🛁', order: 12 },
  { id: 'other',       name: '其他',     emoji: '🫙', order: 13 },
];
const CAT = Object.fromEntries(CATEGORIES.map(c => [c.id, c]));

const STATUS = {
  using:    '使用中',
  stock:    '囤货',
  finished: '已用完',
  dropped:  '弃用',
  wish:     '心愿单',
};
const STATUS_ORDER = ['using', 'stock', 'finished', 'dropped']; // 已拥有的；心愿单单独放
const owned = () => state.products.filter(p => p.status !== 'wish');
const PAO_OPTIONS = [3, 6, 9, 12, 18, 24, 36];

// ============ 存储（IndexedDB，只存在本机） ============
const DB = {
  _db: null,
  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('skincare-cabinet', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('products', { keyPath: 'id' });
      req.onsuccess = () => resolve(this._db = req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async run(mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('products', mode);
      const req = fn(tx.objectStore('products'));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    });
  },
  all()        { return this.run('readonly', s => s.getAll()); },
  put(p)       { return this.run('readwrite', s => s.put(p)); },
  putMany(ps)  { return this.run('readwrite', s => { ps.forEach(p => s.put(p)); }); },
  del(id)      { return this.run('readwrite', s => s.delete(id)); },
  clear()      { return this.run('readwrite', s => s.clear()); },
};

const prefs = {
  get(k) { try { return localStorage.getItem('skincare:' + k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('skincare:' + k, v); } catch {} },
};

// ============ 状态 ============
const state = {
  products: [],
  tab: 'home',
  filter: 'all',
  query: '',
  routine: new Date().getHours() < 15 ? 'am' : 'pm',
  statsYear: new Date().getFullYear(),
};

// ============ 工具 ============
const $ = (sel, el = document) => el.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const pad = n => String(n).padStart(2, '0');
const toDateStr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => toDateStr(new Date());
const money = n => '¥' + (Math.round(n * 100) / 100).toLocaleString('zh-CN');
const parseDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const fmtDate = s => { if (!s) return ''; const d = typeof s === 'string' ? parseDate(s) : s; return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`; };
const find = id => state.products.find(p => p.id === id);

// 囤货数量：同一款产品的多瓶囤货记在一条记录里，用 qty 表示
const qtyOf = p => Math.max(1, parseInt(p.qty, 10) || 1);
const norm = s => (s || '').trim().toLowerCase();
const isSameProduct = (a, b) => a.id !== b.id && norm(a.name) === norm(b.name) && norm(a.brand) === norm(b.brand);
const stockOf = p => state.products.filter(x => x.status === 'stock' && isSameProduct(x, p));
const stockCount = p => stockOf(p).reduce((n, x) => n + qtyOf(x), 0);

function addMonths(dateStr, months) {
  const d = parseDate(dateStr);
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  if (d.getDate() < day) d.setDate(0); // 1月31日 + 1个月 → 2月最后一天
  return d;
}

// 实际到期日 = min(未开封保质期, 开封日 + 开封后保质期)
function expiryInfo(p) {
  if (p.status !== 'using' && p.status !== 'stock') return null;
  const candidates = [];
  if (p.expiryDate) candidates.push({ date: parseDate(p.expiryDate), source: 'shelf' });
  if (p.openedDate && p.pao) candidates.push({ date: addMonths(p.openedDate, Number(p.pao)), source: 'pao' });
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.date - b.date);
  const { date, source } = candidates[0];
  const days = Math.round((date - parseDate(todayStr())) / 86400000);
  const level = days < 0 ? 'expired' : days <= 30 ? 'soon' : days <= 90 ? 'warn' : 'ok';
  return { date, source, days, level };
}

function expiryText(e) {
  if (e.days < 0) return `已过期 ${-e.days} 天`;
  if (e.days === 0) return '今天到期';
  return `还剩 ${e.days} 天`;
}

const expiryDays = p => expiryInfo(p)?.days ?? Infinity;
const byExpiry = (a, b) => expiryDays(a) - expiryDays(b);

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 1800);
}

async function save(p) {
  p.updatedAt = Date.now();
  await DB.put(p);
  const i = state.products.findIndex(x => x.id === p.id);
  if (i >= 0) state.products[i] = p; else state.products.push(p);
}

async function remove(id) {
  await DB.del(id);
  state.products = state.products.filter(p => p.id !== id);
}

function compressImage(file, max = 720) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
    img.src = url;
  });
}

// ============ 组件 ============
function thumb(p, cls = 'thumb') {
  return p.photo
    ? `<div class="${cls}"><img src="${p.photo}" alt=""></div>`
    : `<div class="${cls} ph">${CAT[p.category]?.emoji || '🧴'}</div>`;
}

function tags(p) {
  const e = expiryInfo(p);
  const qty = p.status === 'stock' && qtyOf(p) > 1 ? ` ×${qtyOf(p)}` : '';
  const backups = p.status === 'using' ? stockCount(p) : 0;
  return `<span class="badge st-${p.status}">${STATUS[p.status]}${qty}</span>` +
    (e ? `<span class="pill ${e.level}">${expiryText(e)}</span>` : '') +
    (backups ? `<span class="pill ok">还囤着 ${backups} 瓶</span>` : '');
}

function card(p) {
  const sub = [p.brand, CAT[p.category]?.name].filter(Boolean).join(' · ');
  const faded = p.status === 'finished' || p.status === 'dropped';
  return `<button class="card ${faded ? 'faded' : ''}" data-id="${p.id}">
    ${thumb(p)}
    <div class="card-body">
      <div class="card-title">${esc(p.name)}</div>
      <div class="card-sub">${esc(sub)}</div>
      <div class="card-tags">${tags(p)}</div>
    </div>
  </button>`;
}

// 数据只存在本机，所以用了一周以上、且超过 30 天没备份时在首页提醒
function backupReminder() {
  const oldest = Math.min(...state.products.map(p => p.createdAt || Date.now()));
  if (Date.now() - oldest < 7 * 86400000) return '';
  const last = Number(prefs.get('lastBackup')) || 0;
  const days = Math.floor((Date.now() - last) / 86400000);
  if (last && days < 30) return '';
  return `<button class="banner" data-goto-tab="settings">
    <span>💾</span>
    <span>${last ? `已经 ${days} 天没备份了` : '还没有备份过数据'}，导出一份更安心</span>
    <span class="banner-go">去备份 ›</span>
  </button>`;
}

// ============ 页面 ============
function viewHome() {
  const ps = state.products;
  if (!ps.length) {
    return `<div class="empty">
      <div class="big">🧴</div>
      <h3>护肤柜还是空的</h3>
      <p class="muted">把你的护肤品一件件放进来吧</p>
      <button class="btn" data-add>添加第一件</button>
    </div>`;
  }
  const alerts = ps.filter(p => expiryDays(p) <= 30).sort(byExpiry);
  const alertIds = new Set(alerts.map(p => p.id));
  const using = ps.filter(p => p.status === 'using');
  const stockBottles = ps.filter(p => p.status === 'stock').reduce((n, p) => n + qtyOf(p), 0);
  const usingRest = using.filter(p => !alertIds.has(p.id)).sort(byExpiry);

  return `
    ${backupReminder()}
    <div class="stats">
      <button class="stat" data-goto="using"><b>${using.length}</b><span>使用中</span></button>
      <button class="stat" data-goto="stock"><b>${stockBottles}</b><span>囤货（瓶）</span></button>
      <div class="stat ${alerts.length ? 'alert' : ''}"><b>${alerts.length}</b><span>30天内到期</span></div>
    </div>
    ${alerts.length ? `<h2 class="sec">⚠️ 快过期了</h2><div class="list">${alerts.map(card).join('')}</div>` : ''}
    <h2 class="sec">正在使用</h2>
    ${usingRest.length
      ? `<div class="list">${usingRest.map(card).join('')}</div>`
      : `<p class="muted">${using.length ? '使用中的都在上面啦' : '还没有正在使用的产品'}</p>`}
  `;
}

function libraryList() {
  const q = state.query.trim().toLowerCase();
  let list = state.filter === 'all' ? owned() : state.products.filter(p => p.status === state.filter);
  if (q) {
    list = list.filter(p =>
      [p.name, p.brand, CAT[p.category]?.name, p.notes].join(' ').toLowerCase().includes(q));
  }
  list.sort((a, b) =>
    STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || (b.updatedAt || 0) - (a.updatedAt || 0));
  if (list.length) return list.map(card).join('');
  if (state.filter === 'wish' && !q) return `<p class="muted center">想买的产品先记在这里，点右上角 + 添加</p>`;
  return `<p class="muted center">${state.products.length ? '没有符合的产品' : '还没有产品，点右上角 + 添加'}</p>`;
}

function viewLibrary() {
  const count = s => s === 'all' ? owned().length : state.products.filter(p => p.status === s).length;
  return `
    <div class="search"><input id="search" type="search" placeholder="搜索名称、品牌、品类、备注" value="${esc(state.query)}"></div>
    <div class="chips">
      ${['all', ...STATUS_ORDER, 'wish'].map(s =>
        `<button class="chip ${state.filter === s ? 'on' : ''}" data-filter="${s}">${s === 'all' ? '全部' : STATUS[s]} <small>${count(s)}</small></button>`
      ).join('')}
    </div>
    <div class="list" id="libList">${libraryList()}</div>
  `;
}

function viewRoutine() {
  const key = state.routine;
  const label = key === 'am' ? '早上' : '晚上';
  const list = state.products
    .filter(p => p.status === 'using' && p[key])
    .sort((a, b) => (CAT[a.category]?.order ?? 99) - (CAT[b.category]?.order ?? 99));
  return `
    <div class="seg">
      <button data-routine="am" class="${key === 'am' ? 'on' : ''}">☀️ 早上</button>
      <button data-routine="pm" class="${key === 'pm' ? 'on' : ''}">🌙 晚上</button>
    </div>
    ${list.length
      ? `<ol class="steps">${list.map((p, i) => `<li>
          <button class="step" data-id="${p.id}">
            <span class="num">${i + 1}</span>
            ${thumb(p, 'thumb sm')}
            <div><div class="card-title">${esc(p.name)}</div><div class="card-sub">${esc(CAT[p.category]?.name || '')}</div></div>
          </button></li>`).join('')}</ol>
         <p class="muted small center" style="margin-top:16px">按品类自动排序 · 在产品里修改「使用时段」</p>`
      : `<div class="empty">
          <div class="big">${key === 'am' ? '☀️' : '🌙'}</div>
          <h3>还没有${label}的护肤步骤</h3>
          <p class="muted">给「使用中」的产品勾选「${label}」，<br>就会按顺序出现在这里</p>
        </div>`}
  `;
}

function viewSettings() {
  const last = prefs.get('lastBackup');
  const theme = prefs.get('theme') || 'auto';
  return `
    <div class="panel">
      <h3>🌗 外观</h3>
      <div class="seg seg3">
        ${[['auto', '跟随系统'], ['light', '浅色'], ['dark', '深色']].map(([v, l]) =>
          `<button data-theme-pick="${v}" class="${theme === v ? 'on' : ''}">${l}</button>`).join('')}
      </div>
    </div>
    <div class="panel">
      <h3>💾 数据备份</h3>
      <p class="muted">所有数据只保存在这台手机的浏览器里，不会上传到任何地方。换手机或清理浏览器之前，记得先导出备份。</p>
      <div class="btn-row">
        <button class="btn" id="exportBtn">导出备份</button>
        <label class="btn ghost">导入备份<input type="file" id="importInput" accept="application/json,.json" hidden></label>
      </div>
      <p class="muted small" style="margin:10px 0 0">${last ? `上次备份：${fmtDate(new Date(Number(last)))}` : '还没有备份过'}</p>
    </div>
    <div class="panel">
      <h3>📱 添加到主屏幕</h3>
      <p class="muted">iPhone：用 Safari 打开 → 底部「分享」→「添加到主屏幕」。<br>安卓：Chrome 右上角菜单 →「添加到主屏幕」。<br><br>添加后可以像 App 一样全屏打开。在 iPhone 上，长期不打开的网页数据可能被系统清理，加到主屏幕就能避免。</p>
    </div>
    <div class="panel">
      <h3>危险操作</h3>
      <p class="muted">清空后无法恢复，建议先导出备份。</p>
      <button class="btn danger" id="clearBtn">清空所有数据</button>
    </div>
    <p class="muted small center" style="margin-top:20px">共 ${owned().length} 件产品${state.products.length > owned().length ? ` · 心愿单 ${state.products.length - owned().length} 件` : ''}</p>
  `;
}

const yearOf = d => (d ? Number(d.slice(0, 4)) : null);
// 没填购买日期的，按添加日期算
const boughtDate = p => p.purchaseDate || (p.createdAt ? toDateStr(new Date(p.createdAt)) : '');
const spendOf = p => (parseFloat(p.price) || 0) * qtyOf(p);

function emptyRow(p) {
  const used = p.openedDate && p.finishedDate
    ? Math.max(1, Math.round((parseDate(p.finishedDate) - parseDate(p.openedDate)) / 86400000)) : null;
  const sub = [fmtDate(p.finishedDate) + ' 用完', used && `用了 ${used} 天`].filter(Boolean).join(' · ');
  const rep = p.repurchase === 'yes' ? '<span class="badge st-using">会回购</span>'
    : p.repurchase === 'no' ? '<span class="badge st-finished">不回购</span>' : '';
  return `<button class="card empty-row" data-id="${p.id}">
    ${thumb(p, 'thumb sm')}
    <div class="card-body">
      <div class="card-title">${esc(p.name)}</div>
      <div class="card-sub">${esc(sub)}</div>
      ${rep ? `<div class="card-tags">${rep}</div>` : ''}
    </div>
  </button>`;
}

function viewStats() {
  const mine = owned();
  const years = new Set([new Date().getFullYear()]);
  mine.forEach(p => {
    const b = yearOf(boughtDate(p)); if (b) years.add(b);
    const f = yearOf(p.finishedDate); if (f) years.add(f);
  });
  const Y = state.statsYear;
  const bought = mine.filter(p => yearOf(boughtDate(p)) === Y);
  const spend = bought.reduce((n, p) => n + spendOf(p), 0);
  const boughtCount = bought.reduce((n, p) => n + qtyOf(p), 0);
  const empties = mine.filter(p => p.status === 'finished' && yearOf(p.finishedDate) === Y)
    .sort((a, b) => b.finishedDate.localeCompare(a.finishedDate));
  const droppedCount = mine.filter(p => p.status === 'dropped' && yearOf(p.finishedDate) === Y).length;
  const decided = empties.filter(p => p.repurchase);
  const rate = decided.length
    ? Math.round(decided.filter(p => p.repurchase === 'yes').length / decided.length * 100) + '%' : '—';

  const months = Array(12).fill(0);
  bought.forEach(p => { months[Number(boughtDate(p).slice(5, 7)) - 1] += spendOf(p); });
  const maxMonth = Math.max(...months);

  const byCat = {};
  bought.forEach(p => { byCat[p.category] = (byCat[p.category] || 0) + spendOf(p); });
  const cats = Object.entries(byCat).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const maxCat = cats.length ? cats[0][1] : 0;

  return `
    ${years.size > 1 ? `<div class="chips year-chips">${[...years].sort((a, b) => b - a).map(y =>
      `<button class="chip ${y === Y ? 'on' : ''}" data-year="${y}">${y}</button>`).join('')}</div>` : ''}
    <div class="panel">
      <span class="muted small">${Y} 年护肤花费</span>
      <div class="hero-num">${money(spend)}</div>
      <span class="muted small">买了 ${boughtCount} 件${bought.some(p => !p.price) ? ' · 有些产品没填价格' : ''}</span>
    </div>
    <div class="mini-stats">
      <div class="stat"><b>${empties.length}</b><span>用空（瓶）</span></div>
      <div class="stat"><b>${rate}</b><span>回购率</span></div>
      <div class="stat"><b>${droppedCount}</b><span>弃用</span></div>
      <div class="stat"><b>${state.products.filter(p => p.status === 'wish').length}</b><span>心愿单</span></div>
    </div>

    <div class="panel">
      <h3>每月花费</h3>
      ${maxMonth ? `
        <p class="chart-readout" id="readout">点一下柱子看当月金额</p>
        <div class="bars" id="bars" role="img" aria-label="${Y} 年每月花费">
          ${months.map((v, i) => `<button class="bar-col" data-month="${i}" data-amount="${v}" aria-label="${i + 1}月 ${money(v)}">
            <span class="bar" style="height:${v / maxMonth * 100}%"></span></button>`).join('')}
        </div>
        <div class="bar-labels">${months.map((_, i) => `<span>${i + 1}</span>`).join('')}</div>`
      : `<p class="muted">${Y} 年还没有带价格的购买记录</p>`}
    </div>

    ${cats.length ? `<div class="panel">
      <h3>按品类</h3>
      <div class="cat-rows">${cats.map(([c, v]) => `<div class="cat-row">
        <span>${CAT[c]?.emoji || ''} ${CAT[c]?.name || '其他'}</span>
        <div class="cat-track"><div class="cat-fill" style="width:${v / maxCat * 100}%"></div></div>
        <span class="amt">${money(v)}</span>
      </div>`).join('')}</div>
    </div>` : ''}

    <h2 class="sec">🫙 空瓶记录 · ${empties.length} 瓶</h2>
    ${empties.length ? `<div class="list">${empties.map(emptyRow).join('')}</div>`
      : `<p class="muted">${Y} 年还没有用空的产品，加油～</p>`}
  `;
}

const VIEWS = {
  home:     { title: '护肤柜', render: viewHome },
  library:  { title: '产品库', render: viewLibrary },
  routine:  { title: '护肤流程', render: viewRoutine },
  stats:    { title: '统计', render: viewStats },
  settings: { title: '设置', render: viewSettings },
};

// ============ 深色模式 ============
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme() {
  const pref = prefs.get('theme');
  const root = document.documentElement;
  if (pref === 'light' || pref === 'dark') root.dataset.theme = pref;
  else delete root.dataset.theme;
  const dark = pref === 'dark' || (pref !== 'light' && darkQuery.matches);
  $('#themeColor').setAttribute('content', dark ? '#141a17' : '#f5f8f4');
}

function render() {
  const v = VIEWS[state.tab];
  $('#title').textContent = v.title;
  $('#view').innerHTML = v.render();
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === state.tab));
}

// ============ 底部弹层 ============
let sheetToken = 0;

function openSheet(html) {
  const s = $('#sheet');
  const token = ++sheetToken;
  s.innerHTML = `<div class="backdrop" data-close></div><div class="sheet-panel" role="dialog">${html}</div>`;
  s.classList.remove('hidden');
  document.body.classList.add('locked');
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (token === sheetToken) s.classList.add('open');
  }));
  return s;
}

function closeSheet() {
  const s = $('#sheet');
  const token = ++sheetToken;
  s.classList.remove('open');
  document.body.classList.remove('locked');
  setTimeout(() => {
    if (token !== sheetToken) return; // 期间又打开了新的弹层
    s.classList.add('hidden');
    s.innerHTML = '';
  }, 250);
}

function openDetail(id) {
  const p = find(id);
  if (!p) return;
  const e = expiryInfo(p);
  const rows = [
    ['品类', CAT[p.category]?.name],
    ['价格', p.price ? `¥${p.price}` : ''],
    ['购买日期', fmtDate(p.purchaseDate)],
    ['保质期至', fmtDate(p.expiryDate)],
    ['开封日期', fmtDate(p.openedDate)],
    ['开封后保质', p.pao ? `${p.pao} 个月` : ''],
    ['用完日期', fmtDate(p.finishedDate)],
    ['回购', p.repurchase === 'yes' ? '会回购 👍' : p.repurchase === 'no' ? '不回购' : ''],
    ['使用时段', [p.am && '早上', p.pm && '晚上'].filter(Boolean).join('、')],
  ].filter(r => r[1]);

  let actions = '';
  let stockLine = '';
  if (p.status === 'stock') {
    const q = qtyOf(p);
    actions = `<button class="btn" data-act="open">${q > 1 ? '开封一瓶' : '开封，开始用'}</button>`;
    stockLine = `<div class="stock-line">
      <span>囤了 <b>${q}</b> 瓶</span>
      <div class="stepper">
        <button data-qty="-1" ${q <= 1 ? 'disabled' : ''} aria-label="减少一瓶">−</button>
        <b>${q}</b>
        <button data-qty="1" aria-label="增加一瓶">+</button>
      </div>
    </div>`;
  } else if (p.status === 'wish') {
    actions = `<button class="btn" data-act="bought-stock">买到了，先囤着</button><button class="btn ghost" data-act="bought-use">买到了，直接用</button>`;
  } else {
    const inWish = state.products.some(x => x.status === 'wish' && isSameProduct(x, p));
    actions = p.status === 'using'
      ? `<button class="btn" data-act="finish">用完了</button><button class="btn ghost" data-act="drop">不用了</button>`
      : `<button class="btn" data-act="rebuy">再买一瓶</button>` +
        (inWish || p.repurchase === 'no' ? '' : `<button class="btn ghost" data-act="wish">加入心愿单</button>`);
    const n = stockCount(p);
    stockLine = `<div class="stock-line">
      <span>${n ? `还囤着 <b>${n}</b> 瓶` : '没有囤货'}</span>
      ${p.status === 'using' ? `<button class="link" data-act="rebuy">＋ 再囤一瓶</button>` : ''}
    </div>`;
  }

  let expiryBox = '';
  if (e) {
    const how = e.source === 'pao' ? `开封后 ${p.pao} 个月` : '未开封保质期';
    expiryBox = `<div class="expiry-box ${e.level}"><b>${expiryText(e)}</b>${fmtDate(e.date)} 到期 · 按${how}计算</div>`;
  } else if (p.status === 'using' && !p.pao) {
    expiryBox = `<div class="expiry-box ok">还没填开封后保质期，<a href="#" data-edit>补充一下</a>就能提醒你啦</div>`;
  }

  openSheet(`
    <div class="sheet-head">
      <button class="link" data-close>关闭</button>
      <button class="link strong" data-edit>编辑</button>
    </div>
    ${thumb(p, 'thumb hero')}
    <h2 class="detail-name">${esc(p.name)}</h2>
    ${p.brand ? `<p class="muted detail-brand">${esc(p.brand)}</p>` : ''}
    <div class="card-tags">${tags(p)}</div>
    ${expiryBox}
    <div class="actions">${actions}</div>
    ${stockLine}
    ${rows.length ? `<dl class="info">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}
    ${p.notes ? `<div class="notes">${esc(p.notes)}</div>` : ''}
    <div class="delete-row"><button data-delete>删除这件产品</button></div>
  `).dataset.id = p.id;
}

function askPao(p) {
  openSheet(`
    <div class="sheet-head"><span></span><button class="link" data-close>跳过</button></div>
    <div class="ask">
      <div style="font-size:44px">🫙</div>
      <h3>开封后能用多久？</h3>
      <p class="muted">看瓶身上开盖罐子的图标，比如「12M」就是 12 个月</p>
      <div class="chips">${PAO_OPTIONS.map(m => `<button class="chip" data-pao="${m}">${m} 个月</button>`).join('')}</div>
    </div>
  `).dataset.id = p.id;
}

function askRepurchase(p) {
  openSheet(`
    <div class="sheet-head"><span></span><button class="link" data-close>取消</button></div>
    <div class="ask">
      <div style="font-size:44px">🎉</div>
      <h3>又用空一瓶！</h3>
      <p class="muted">${esc(p.name)} 会回购吗？</p>
      <div class="options">
        <button class="btn" data-repurchase="yes">会回购</button>
        <button class="btn ghost" data-repurchase="no">不回购</button>
        <button class="btn ghost" data-repurchase="">还没想好</button>
      </div>
    </div>
  `).dataset.id = p.id;
}

// 用完一瓶后，如果还有囤货，顺手问要不要开新的
function askOpenNext(stockItem) {
  openSheet(`
    <div class="sheet-head"><span></span><button class="link" data-close>先不用</button></div>
    <div class="ask">
      <div style="font-size:44px">📦</div>
      <h3>还囤着 ${qtyOf(stockItem)} 瓶</h3>
      <p class="muted">现在开一瓶新的「${esc(stockItem.name)}」吗？</p>
      <div class="options">
        <button class="btn" data-act="open">开一瓶新的</button>
      </div>
    </div>
  `).dataset.id = stockItem.id;
}

function defaultTimes(category) {
  if (category === 'sunscreen') return { am: true, pm: false };
  if (category === 'treatment' || category === 'oil') return { am: false, pm: true };
  if (['mask', 'lip', 'body', 'other'].includes(category)) return { am: false, pm: false };
  return { am: true, pm: true };
}

function openForm(p, isNew) {
  // 在产品库里筛选着「囤货 / 心愿单」时点 +，默认就是那个状态
  const preset = state.tab === 'library' && ['using', 'stock', 'wish'].includes(state.filter) ? state.filter : 'using';
  const d = p || { status: preset, category: 'serum', ...defaultTimes('serum') };
  let photo = d.photo || '';
  let timesTouched = !isNew;

  const opt = (name, value, label, checked, type = 'radio') =>
    `<label><input type="${type}" name="${name}" value="${value}" ${checked ? 'checked' : ''}><span>${label}</span></label>`;

  const s = openSheet(`
    <form id="form" class="form" novalidate>
      <div class="sheet-head">
        <button type="button" class="link" data-close>取消</button>
        <b>${isNew ? '添加产品' : '编辑产品'}</b>
        <button type="submit" class="link strong">保存</button>
      </div>

      <label class="photo-pick" id="photoPick"></label>
      <input type="file" accept="image/*" id="photoInput" hidden>

      <div class="field">
        <label class="lbl" for="f-name">名称 *</label>
        <input type="text" id="f-name" name="name" value="${esc(d.name)}" placeholder="比如：小棕瓶精华" autocomplete="off">
      </div>
      <div class="row2">
        <div class="field">
          <label class="lbl" for="f-brand">品牌</label>
          <input type="text" id="f-brand" name="brand" value="${esc(d.brand)}" autocomplete="off">
        </div>
        <div class="field">
          <label class="lbl" for="f-cat">品类</label>
          <select id="f-cat" name="category">
            ${CATEGORIES.map(c => `<option value="${c.id}" ${d.category === c.id ? 'selected' : ''}>${c.emoji} ${c.name}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="field">
        <span class="lbl">状态</span>
        <div class="opts">${[...STATUS_ORDER, 'wish'].map(st => opt('status', st, STATUS[st], d.status === st)).join('')}</div>
      </div>
      <div class="field" id="qtyField">
        <span class="lbl">囤了几瓶</span>
        <div class="stepper">
          <button type="button" data-step="-1" aria-label="减少一瓶">−</button>
          <input type="number" name="qty" inputmode="numeric" min="1" value="${qtyOf(d)}" aria-label="数量">
          <button type="button" data-step="1" aria-label="增加一瓶">+</button>
        </div>
        <p class="hint">同一款买了好几瓶，记在一起就好，开封时会自动拆出一瓶</p>
      </div>
      <div class="row2">
        <div class="field">
          <label class="lbl" for="f-price">价格（元）</label>
          <input type="number" id="f-price" name="price" inputmode="decimal" min="0" step="0.01" value="${esc(d.price)}">
        </div>
        <div class="field" id="buyField">
          <label class="lbl" for="f-buy">购买日期</label>
          <input type="date" id="f-buy" name="purchaseDate" value="${esc(d.purchaseDate)}">
        </div>
      </div>

      <div id="expiryFields">
      <h4 class="form-sec">保质期</h4>
      <div class="row2">
        <div class="field">
          <label class="lbl" for="f-exp">保质期至</label>
          <input type="date" id="f-exp" name="expiryDate" value="${esc(d.expiryDate)}">
        </div>
        <div class="field">
          <label class="lbl" for="f-open">开封日期</label>
          <input type="date" id="f-open" name="openedDate" value="${esc(d.openedDate)}">
        </div>
      </div>
      <div class="field">
        <span class="lbl">开封后保质期</span>
        <div class="opts">
          ${PAO_OPTIONS.map(m => opt('pao', m, `${m}个月`, Number(d.pao) === m)).join('')}
          ${opt('pao', '', '不确定', !d.pao)}
        </div>
        <p class="hint">瓶身上开盖罐子图标里的数字，比如 12M = 12 个月</p>
      </div>
      </div>

      <div id="finishedFields">
        <h4 class="form-sec">用完 / 弃用</h4>
        <div class="row2">
          <div class="field">
            <label class="lbl" for="f-fin">日期</label>
            <input type="date" id="f-fin" name="finishedDate" value="${esc(d.finishedDate)}">
          </div>
          <div class="field">
            <label class="lbl" for="f-rep">回购吗</label>
            <select id="f-rep" name="repurchase">
              <option value="" ${!d.repurchase ? 'selected' : ''}>还没想好</option>
              <option value="yes" ${d.repurchase === 'yes' ? 'selected' : ''}>会回购</option>
              <option value="no" ${d.repurchase === 'no' ? 'selected' : ''}>不回购</option>
            </select>
          </div>
        </div>
      </div>

      <div id="timeFields">
        <h4 class="form-sec">使用时段</h4>
        <div class="opts">
          ${opt('am', '1', '☀️ 早上', d.am, 'checkbox')}
          ${opt('pm', '1', '🌙 晚上', d.pm, 'checkbox')}
        </div>
      </div>

      <h4 class="form-sec">备注</h4>
      <div class="field">
        <textarea name="notes" rows="3" placeholder="肤感、成分、适不适合自己…">${esc(d.notes)}</textarea>
      </div>
    </form>
  `);

  const form = $('#form', s);
  const pick = $('#photoPick', s);
  const input = $('#photoInput', s);

  const drawPhoto = () => {
    pick.innerHTML = photo
      ? `<img src="${photo}" alt=""><button type="button" class="remove" id="photoRemove">移除</button>`
      : `<span>📷 添加照片</span>`;
  };
  const syncStatus = () => {
    const st = form.status.value;
    $('#finishedFields', s).style.display = (st === 'finished' || st === 'dropped') ? '' : 'none';
    $('#qtyField', s).style.display = st === 'stock' ? '' : 'none';
    ['#buyField', '#expiryFields', '#timeFields'].forEach(id => { $(id, s).style.display = st === 'wish' ? 'none' : ''; });
  };
  drawPhoto();
  syncStatus();

  s.querySelectorAll('[data-step]').forEach(b => b.addEventListener('click', () => {
    form.qty.value = Math.max(1, (parseInt(form.qty.value, 10) || 1) + Number(b.dataset.step));
  }));

  pick.addEventListener('click', e => {
    if (e.target.id === 'photoRemove') { e.preventDefault(); photo = ''; drawPhoto(); return; }
    input.click();
  });
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    try { photo = await compressImage(file); drawPhoto(); }
    catch (err) { toast(err.message); }
    input.value = '';
  });
  form.addEventListener('change', e => {
    if (e.target.name === 'status') syncStatus();
    if (e.target.name === 'am' || e.target.name === 'pm') timesTouched = true;
    if (e.target.name === 'category' && !timesTouched) {
      const t = defaultTimes(e.target.value);
      form.am.checked = t.am;
      form.pm.checked = t.pm;
    }
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(form);
    const name = (f.get('name') || '').trim();
    if (!name) { toast('请填写名称'); form.name.focus(); return; }

    const p = {
      ...d,
      id: d.id || uid(),
      createdAt: d.createdAt || Date.now(),
      name,
      brand: f.get('brand').trim(),
      category: f.get('category'),
      status: f.get('status'),
      price: f.get('price'),
      purchaseDate: f.get('purchaseDate'),
      expiryDate: f.get('expiryDate'),
      openedDate: f.get('openedDate'),
      pao: f.get('pao') ? Number(f.get('pao')) : null,
      finishedDate: f.get('finishedDate'),
      repurchase: f.get('repurchase'),
      am: !!f.get('am'),
      pm: !!f.get('pm'),
      notes: f.get('notes').trim(),
      photo,
      qty: f.get('status') === 'stock' ? Math.max(1, parseInt(f.get('qty'), 10) || 1) : 1,
    };
    // 自动补日期：改成使用中就记开封日，改成用完就记用完日
    if (p.status === 'using' && !p.openedDate) p.openedDate = todayStr();
    if ((p.status === 'finished' || p.status === 'dropped') && !p.finishedDate) p.finishedDate = todayStr();
    if (!['finished', 'dropped'].includes(p.status)) { p.finishedDate = ''; p.repurchase = ''; }

    // 新增囤货时，如果已经囤着同一款，问要不要合并成一条
    if (isNew && p.status === 'stock') {
      const existing = stockOf(p)[0];
      if (existing && confirm(`已经囤着 ${qtyOf(existing)} 瓶「${existing.name}」，合并成 ${qtyOf(existing) + p.qty} 瓶吗？`)) {
        await save({ ...existing, qty: qtyOf(existing) + p.qty });
        render();
        toast(`囤货 +${p.qty}`);
        openDetail(existing.id);
        return;
      }
    }

    try {
      await save(p);
    } catch (err) {
      toast('保存失败：' + (err?.message || '存储空间不足？'));
      return;
    }
    render();
    toast(isNew ? '已添加' : '已保存');
    if (isNew) closeSheet(); else openDetail(p.id);
  });
}

async function handleSheetClick(e) {
  const s = $('#sheet');
  const t = e.target.closest('[data-close],[data-edit],[data-delete],[data-act],[data-pao],[data-repurchase],[data-qty]');
  if (!t) return;
  e.preventDefault();
  if (t.matches('[data-close]')) return closeSheet();

  const p = find(s.dataset.id);
  if (!p) return;

  if (t.matches('[data-edit]')) return openForm(p, false);

  if (t.matches('[data-delete]')) {
    if (!confirm(`确定删除「${p.name}」吗？`)) return;
    await remove(p.id);
    closeSheet(); render(); toast('已删除');
    return;
  }

  if (t.dataset.act === 'open') {
    // 囤了多瓶：拆出一瓶变成「使用中」，其余继续囤着
    let opened;
    if (qtyOf(p) > 1) {
      await save({ ...p, qty: qtyOf(p) - 1 });
      opened = { ...p, id: uid(), createdAt: Date.now(), qty: 1, status: 'using', openedDate: todayStr() };
    } else {
      opened = { ...p, qty: 1, status: 'using', openedDate: p.openedDate || todayStr() };
    }
    await save(opened);
    render();
    if (opened.pao) { openDetail(opened.id); toast('开封啦'); } else askPao(opened);
    return;
  }
  if (t.hasAttribute('data-qty')) {
    await save({ ...p, qty: Math.max(1, qtyOf(p) + Number(t.dataset.qty)) });
    render(); openDetail(p.id);
    return;
  }
  if (t.dataset.act === 'finish') return askRepurchase(p);
  if (t.dataset.act === 'drop') {
    await save({ ...p, status: 'dropped', finishedDate: todayStr() });
    render(); openDetail(p.id); toast('已标记为弃用');
    return;
  }
  if (t.dataset.act === 'rebuy') {
    const existing = stockOf(p)[0];
    if (existing) {
      await save({ ...existing, qty: qtyOf(existing) + 1 });
      render(); openDetail(p.id);
      toast(`囤货 +1，现在共 ${qtyOf(existing) + 1} 瓶`);
      return;
    }
    const copy = {
      name: p.name, brand: p.brand, category: p.category, price: p.price, pao: p.pao,
      am: p.am, pm: p.pm, photo: p.photo, notes: p.notes,
      status: 'stock', purchaseDate: todayStr(),
    };
    return openForm(copy, true);
  }
  if (t.dataset.act === 'wish') {
    await save({
      id: uid(), createdAt: Date.now(), status: 'wish',
      name: p.name, brand: p.brand, category: p.category, price: p.price, photo: p.photo, am: p.am, pm: p.pm, pao: p.pao,
    });
    render(); openDetail(p.id); toast('已加入心愿单');
    return;
  }
  if (t.dataset.act === 'bought-stock') {
    const existing = stockOf(p)[0];
    if (existing) {
      await save({ ...existing, qty: qtyOf(existing) + 1 });
      await remove(p.id);
      render(); openDetail(existing.id);
    } else {
      await save({ ...p, status: 'stock', qty: 1, purchaseDate: p.purchaseDate || todayStr() });
      render(); openDetail(p.id);
    }
    toast('已放进囤货，可以点「编辑」补充保质期');
    return;
  }
  if (t.dataset.act === 'bought-use') {
    const opened = { ...p, status: 'using', qty: 1, purchaseDate: p.purchaseDate || todayStr(), openedDate: todayStr() };
    await save(opened);
    render();
    if (opened.pao) { openDetail(opened.id); toast('开始用啦'); } else askPao(opened);
    return;
  }
  if (t.hasAttribute('data-pao')) {
    await save({ ...p, pao: Number(t.dataset.pao) });
    render(); openDetail(p.id);
    return;
  }
  if (t.hasAttribute('data-repurchase')) {
    await save({ ...p, status: 'finished', finishedDate: todayStr(), repurchase: t.dataset.repurchase });
    render();
    const next = stockOf(p)[0];
    if (next) askOpenNext(next); else openDetail(p.id);
    toast('已放进空瓶记录');
  }
}

// ============ 备份 ============
function exportBackup() {
  const data = { app: 'skincare-cabinet', version: 1, exportedAt: new Date().toISOString(), products: state.products };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `护肤柜备份-${todayStr()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  prefs.set('lastBackup', String(Date.now()));
  render();
  toast('已导出');
}

async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    const list = Array.isArray(data) ? data : data.products;
    if (!Array.isArray(list)) throw new Error();
    const valid = list.filter(p => p && p.id && p.name && STATUS[p.status]);
    if (!valid.length) { toast('文件里没有找到产品'); return; }
    if (!confirm(`导入 ${valid.length} 件产品？已有的同一件产品会被备份里的版本覆盖。`)) return;
    await DB.putMany(valid);
    state.products = await DB.all();
    render();
    toast(`已导入 ${valid.length} 件`);
  } catch {
    toast('这个文件不是有效的备份');
  }
}

// ============ 事件 ============
function bindEvents() {
  document.querySelector('.tabbar').addEventListener('click', e => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    state.tab = b.dataset.tab;
    render();
    window.scrollTo(0, 0);
  });

  $('#addBtn').addEventListener('click', () => openForm(null, true));

  $('#view').addEventListener('click', async e => {
    const t = e.target.closest('[data-id],[data-filter],[data-year],[data-month],[data-routine],[data-goto],[data-goto-tab],[data-theme-pick],[data-add],#exportBtn,#clearBtn');
    if (!t) return;
    if (t.dataset.year) { state.statsYear = Number(t.dataset.year); return render(); }
    if (t.dataset.month) return showMonth(t);
    if (t.dataset.gotoTab) { state.tab = t.dataset.gotoTab; render(); window.scrollTo(0, 0); return; }
    if (t.dataset.themePick) {
      if (t.dataset.themePick === 'auto') prefs.set('theme', ''); else prefs.set('theme', t.dataset.themePick);
      applyTheme(); render();
      return;
    }
    if (t.dataset.id) return openDetail(t.dataset.id);
    if (t.dataset.filter) { state.filter = t.dataset.filter; return render(); }
    if (t.dataset.routine) { state.routine = t.dataset.routine; return render(); }
    if (t.dataset.goto) { state.tab = 'library'; state.filter = t.dataset.goto; state.query = ''; return render(); }
    if (t.hasAttribute('data-add')) return openForm(null, true);
    if (t.id === 'exportBtn') return exportBackup();
    if (t.id === 'clearBtn') {
      if (!state.products.length) return toast('已经是空的了');
      if (!confirm('确定清空所有数据吗？此操作无法恢复。')) return;
      await DB.clear();
      state.products = [];
      render();
      toast('已清空');
    }
  });

  $('#view').addEventListener('mouseover', e => {
    const b = e.target.closest('[data-month]');
    if (b) showMonth(b);
  });

  $('#view').addEventListener('input', e => {
    if (e.target.id !== 'search') return;
    state.query = e.target.value;
    $('#libList').innerHTML = libraryList();
  });

  $('#view').addEventListener('change', e => {
    if (e.target.id === 'importInput' && e.target.files[0]) {
      importBackup(e.target.files[0]);
      e.target.value = '';
    }
  });

  $('#sheet').addEventListener('click', handleSheetClick);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });
}

function showMonth(col) {
  const bars = $('#bars');
  bars.classList.add('has-on');
  bars.querySelectorAll('.bar-col').forEach(c => c.classList.toggle('on', c === col));
  $('#readout').innerHTML = `${Number(col.dataset.month) + 1} 月花了 <b>${money(Number(col.dataset.amount))}</b>`;
}

// ============ 启动 ============
async function init() {
  applyTheme();
  darkQuery.addEventListener?.('change', applyTheme);
  bindEvents();
  try {
    state.products = await DB.all();
  } catch {
    $('#view').innerHTML = `<div class="empty"><div class="big">😢</div><h3>无法读取本地数据</h3><p class="muted">可能是浏览器开启了无痕模式，请换成普通模式打开</p></div>`;
    return;
  }
  render();
  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
