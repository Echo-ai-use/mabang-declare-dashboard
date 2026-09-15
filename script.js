'use strict';

/**
 * 前端脚本 · 双模式
 *  - 本地/云端版（默认）：所有数据走 /api/*
 *  - 静态快照版（GitHub Pages）：页面预置 window.__SNAPSHOT__，全部在浏览器内过滤/排序/分页，
 *    不需要任何后端。同一份脚本，靠 STATIC 开关自动切换。
 */

const $ = (id) => document.getElementById(id);

// ===== 静态快照模式判定 =====
const SNAP = (typeof window !== 'undefined' && window.__SNAPSHOT__) || null;
const STATIC = !!(SNAP && Array.isArray(SNAP.items));

// 快照里每条记录用「数组」压缩存储（体积比对象小很多），这里按固定顺序还原
const SNAP_FIELDS = [
  'stockSku', 'nameCN', 'nameEN', 'purchasePrice', 'declareValueNum', 'suggestValue', 'diff',
  'anomaly', 'declareName', 'declareEname', 'declareCode', 'weight', 'provider', 'status', 'timeModify',
];

let SNAP_ITEMS = null;
let SNAP_V2K = null;

// 静态快照里只存了 suggestValue，用快照自带的 rule 反查档位 key（1→lt20、2→20-40 …）
function snapValueToKey(sv) {
  if (!SNAP_V2K) {
    SNAP_V2K = {};
    ((SNAP && SNAP.rule) || []).forEach((r) => { SNAP_V2K[r.value] = r.key; });
  }
  return SNAP_V2K[sv] || '';
}

function snapItems() {
  if (SNAP_ITEMS) return SNAP_ITEMS;
  SNAP_ITEMS = (SNAP.items || []).map((r) => {
    const it = {};
    for (let i = 0; i < SNAP_FIELDS.length; i++) it[SNAP_FIELDS[i]] = r[i];
    it.anomaly = !!it.anomaly;
    it.declareValue = it.declareValueNum == null ? '' : String(it.declareValueNum);
    // 档位分组：口径与后端 decorate().group 一致（无采购价 → unknownPrice 优先）
    it.group = it.suggestValue == null
      ? 'unknownPrice'
      : (it.declareValueNum == null ? 'missingValue' : snapValueToKey(it.suggestValue));
    return it;
  });
  return SNAP_ITEMS;
}

const numOr = (x) => (Number.isFinite(x) ? x : -Infinity);

/** 与后端 lib/sync.js 的 queryItems 保持同一套过滤/排序口径 */
function snapQuery({ anomalyOnly, q, sort, group, page, pageSize }) {
  let list = snapItems();

  const kw = String(q || '').trim().toLowerCase();
  if (kw) {
    list = list.filter((it) =>
      [it.stockSku, it.salesSku, it.nameCN, it.nameEN, it.declareName, it.declareEname, it.declareCode, it.provider]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(kw))
    );
  }
  if (anomalyOnly) list = list.filter((it) => it.anomaly);
  if (group) list = list.filter((it) => it.group === group);

  const sorters = {
    diff_desc: (a, b) => numOr(b.diff) - numOr(a.diff),
    diff_asc: (a, b) => numOr(a.diff) - numOr(b.diff),
    value_desc: (a, b) => numOr(b.declareValueNum) - numOr(a.declareValueNum),
    value_asc: (a, b) => numOr(a.declareValueNum) - numOr(b.declareValueNum),
    price_desc: (a, b) => numOr(b.purchasePrice) - numOr(a.purchasePrice),
    price_asc: (a, b) => numOr(a.purchasePrice) - numOr(b.purchasePrice),
    sku_asc: (a, b) => String(a.stockSku).localeCompare(String(b.stockSku)),
    modify_desc: (a, b) => String(b.timeModify || '').localeCompare(String(a.timeModify || '')),
  };
  list.sort(sorters[sort] || sorters.diff_desc);

  const total = list.length;
  const p = Math.max(1, Number(page) || 1);
  const ps = Math.min(Math.max(1, Number(pageSize) || 50), 500);
  const slice = list.slice((p - 1) * ps, p * ps);
  return { total, page: p, pageSize: ps, returned: slice.length, items: slice };
}

function snapState() {
  return {
    config: { appkey: '', appsecret: '', windowDays: (SNAP.config && SNAP.config.windowDays) || 7 },
    hasCredentials: true,
    rule: SNAP.rule || [],
    stats: SNAP.stats || {},
    meta: SNAP.meta || {},
    storedAt: SNAP.generatedAt || null,
    isStatic: true,
  };
}

function snapApi(path) {
  if (path.indexOf('/state') === 0) return Promise.resolve(snapState());
  if (path.indexOf('/items') === 0) {
    const qi = path.indexOf('?');
    const qs = new URLSearchParams(qi >= 0 ? path.slice(qi + 1) : '');
    return Promise.resolve(
      snapQuery({
        anomalyOnly: qs.get('anomalyOnly') === '1',
        q: qs.get('q') || '',
        sort: qs.get('sort') || 'diff_desc',
        group: qs.get('group') || '',
        page: Number(qs.get('page')) || 1,
        pageSize: Number(qs.get('pageSize')) || 50,
      })
    );
  }
  return Promise.reject(new Error('静态快照版是只读页面：同步 / 改配置请在本地版做完后重新发布'));
}

// ===== 通用工具 =====
const state = {
  page: 1,
  pageSize: 50,
  anomalyOnly: false,
  q: '',
  sort: 'diff_desc',
  group: '', // 当前点选的档位分组（空 = 全部）
};

function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._t);
  t._t = setTimeout(() => (t.hidden = true), ms);
}

async function api(path, opts) {
  if (STATIC) return snapApi(path);
  const r = await fetch('/api' + path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ('请求失败 ' + r.status));
  return data;
}

function fmtTime(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d)) return s;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function money(v, digits = 2) {
  return Number.isFinite(v) ? v.toFixed(digits) : '—';
}

const STATUS_MAP = { 1: '在售', 2: '停售', 3: '草稿', 4: '待上架' };

async function refreshState() {
  try {
    const s = await api('/state');
    renderStats(s);
    if (STATIC) {
      $('syncInfo').textContent = `静态快照版 · 数据生成于 ${SNAP.generatedAt || '—'}`;
    } else {
      $('syncInfo').textContent = s.meta?.lastSyncAt
        ? `最近同步：${fmtTime(s.meta.lastSyncAt)} · 窗口${s.meta.windowDays}天 · 累计${s.meta.total}个SKU`
        : '尚未同步';
      if (!s.hasCredentials) {
        toast('请先在「设置」中填写马帮 AppKey / App密钥', 3500);
      }
    }
    return s;
  } catch (e) {
    toast('读取状态失败：' + e.message);
    return null;
  }
}

// 当前可点击的档位分组（由 /state 的 stats.groups 下发）
let GROUPS = [];

function groupTitle(g) {
  return g.kind === 'tier' ? `采购价 ${g.label} → 建议 ${g.value}` : g.label;
}

function renderStats(s) {
  const st = s.stats || {};
  $('statTotal').textContent = st.total ?? 0;
  $('statAnomaly').textContent = st.anomaly ?? 0;
  $('statRate').textContent = (st.anomalyRate ?? 0) + '%';
  $('statMax').textContent = st.maxValue != null ? money(+st.maxValue) : '—';
  $('statExcess').textContent = st.avgExcess != null ? '+' + money(+st.avgExcess) : '—';

  // 优先用后端下发的 groups；老数据没有时按 tiers 兜底拼一份
  GROUPS = Array.isArray(st.groups) && st.groups.length
    ? st.groups
    : [
        ...(st.tiers || []).map((t) => ({ ...t, kind: 'tier', sub: `异常 ${t.anomaly}` })),
        ...(st.missingValue ? [{ key: 'missingValue', label: '无申报价值', total: st.missingValue, anomaly: 0, kind: 'missing', sub: '无法判定' }] : []),
        ...(st.unknownPrice ? [{ key: 'unknownPrice', label: '无采购价', total: st.unknownPrice, anomaly: 0, kind: 'unknown', sub: '无法判定' }] : []),
      ];

  renderGroups();
}

/** 渲染可点击的档位卡片（点一下 = 只看该档；再点一下 = 取消） */
function renderGroups() {
  $('dist').innerHTML = GROUPS.map((g) => {
    const active = state.group === g.key;
    const extra = g.kind === 'tier' ? '' : ' plain';
    return `<div class="seg clickable${g.anomaly > 0 ? ' alert' : ''}${extra}${active ? ' active' : ''}" data-group="${escapeHtml(g.key)}" title="点击：只看「${escapeHtml(groupTitle(g))}」（再点一次取消）">
      <div class="s-label">${escapeHtml(groupTitle(g))}</div>
      <div class="s-val">${g.total}</div>
      <div class="s-sub">${escapeHtml(g.sub || '')}</div>
    </div>`;
  }).join('');
  renderFilterPill();
}

/** 工具栏里的「当前筛选」小药丸，点 × 取消档位筛选 */
function renderFilterPill() {
  const el = $('filterPill');
  if (!el) return;
  const g = GROUPS.find((x) => x.key === state.group);
  if (!g) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.innerHTML = `筛选：${escapeHtml(groupTitle(g))} <b>×</b>`;
  el.title = '点击取消该筛选';
}

function setGroup(key) {
  state.group = state.group === key ? '' : key; // 再点一次取消
  state.page = 1;
  renderGroups();
  loadItems();
}

async function loadItems() {
  const params = new URLSearchParams({
    anomalyOnly: state.anomalyOnly ? '1' : '0',
    q: state.q,
    sort: state.sort,
    group: state.group,
    page: String(state.page),
    pageSize: String(state.pageSize),
  });
  try {
    const data = await api('/items?' + params.toString());
    renderTable(data);
  } catch (e) {
    toast('加载明细失败：' + e.message);
  }
}

function renderTable(data) {
  const rows = data.items || [];
  const tb = $('tbody');
  if (!rows.length) {
    tb.innerHTML = `<tr><td colspan="14" class="muted" style="text-align:center;padding:28px">无数据，请先点「同步数据」并确认已配置凭据</td></tr>`;
  } else {
    tb.innerHTML = rows
      .map((it, i) => {
        const pp = parseFloat(it.purchasePrice);
        const sv = it.suggestValue;
        const v = it.declareValueNum;
        const isAnom = !!it.anomaly;

        const priceCell = Number.isFinite(pp) ? money(pp) : '<span class="muted">—</span>';
        const suggestCell = sv != null ? `<span class="suggest">${sv}</span>` : '<span class="muted">—</span>';
        const valCell = v != null ? `<span class="${isAnom ? 'val-big' : ''}">${money(v)}</span>` : '<span class="muted">—</span>';
        const diffCell =
          it.diff != null && it.diff > 0
            ? `<span class="diff-up">+${money(it.diff)}</span>`
            : it.diff != null
            ? `<span class="muted">${money(it.diff)}</span>`
            : '<span class="muted">—</span>';

        return `<tr class="${isAnom ? 'anomaly' : ''}">
          <td class="muted">${(data.page - 1) * data.pageSize + i + 1}</td>
          <td>${escapeHtml(it.stockSku)}</td>
          <td>${escapeHtml(it.nameCN || '')}</td>
          <td class="num">${priceCell}</td>
          <td class="num">${suggestCell}</td>
          <td class="num">${valCell}</td>
          <td class="num">${diffCell}</td>
          <td>${escapeHtml(it.declareName || '')}</td>
          <td>${escapeHtml(it.declareEname || '')}</td>
          <td>${escapeHtml(it.declareCode || '')}</td>
          <td class="num">${escapeHtml(it.weight || '')}</td>
          <td>${escapeHtml(it.provider || '')}</td>
          <td>${STATUS_MAP[it.status] || (it.status != null ? it.status : '—')}</td>
          <td><span class="badge ${isAnom ? 'yes' : 'no'}">${isAnom ? '异常' : '正常'}</span></td>
        </tr>`;
      })
      .join('');
  }
  const g = GROUPS.find((x) => x.key === state.group);
  const tags = [];
  if (g) tags.push(`档位：${groupTitle(g)}`);
  if (state.anomalyOnly) tags.push('仅异常');
  $('resultCount').textContent = `共 ${data.total} 条` + (tags.length ? `（${tags.join(' · ')}）` : '');
  $('pageInfo').textContent = `第 ${data.page} 页 / 共 ${Math.max(1, Math.ceil(data.total / data.pageSize))} 页`;
  $('btnPrev').disabled = data.page <= 1;
  $('btnNext').disabled = data.page * data.pageSize >= data.total;
}

async function doSync() {
  if (STATIC) {
    toast('静态快照版为只读页面：数据更新请在本地同步后重新发布', 3600);
    return;
  }
  const btn = $('btnSync');
  btn.disabled = true;
  btn.textContent = '⟳ 同步中…';
  try {
    const data = await api('/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    const m = data.meta || {};
    toast(`同步完成：累计 ${m.total} 个SKU，本批拉取 ${m.pulled} 条，异常 ${m.anomaly ?? '—'}`);
    await refreshState();
    await loadItems();
  } catch (e) {
    toast('同步失败：' + e.message, 4000);
  } finally {
    btn.disabled = false;
    btn.textContent = '⟳ 同步数据';
  }
}

// ===== 设置弹窗 =====
function renderRuleTable(rule) {
  const rows = (rule || []).map((t) => `<tr><td>采购价 ${escapeHtml(t.label)}</td><td class="num">申报 = ${t.value}</td></tr>`).join('');
  $('ruleTable').innerHTML = rows + `<tr><td>实际申报 &gt; 建议值</td><td class="num danger-text">判为异常</td></tr>`;
}

async function openSettings() {
  if (STATIC) {
    renderRuleTable(SNAP.rule);
    $('cfgMsg').textContent = '';
    $('settingsModal').hidden = false;
    return;
  }
  try {
    const s = await api('/state');
    $('cfgAppkey').value = s.config.appkey || '';
    $('cfgAppsecret').value = '';
    $('cfgWindow').value = s.config.windowDays ?? 7;
    renderRuleTable(s.rule);
  } catch (e) {
    toast('读取配置失败：' + e.message);
  }
  $('cfgMsg').textContent = '';
  $('settingsModal').hidden = false;
}

async function saveSettings() {
  const body = {
    appkey: $('cfgAppkey').value.trim(),
    appsecret: $('cfgAppsecret').value,
    windowDays: $('cfgWindow').value,
  };
  try {
    await api('/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    $('cfgMsg').className = 'cfg-msg ok';
    $('cfgMsg').textContent = '已保存。';
    setTimeout(() => ($('settingsModal').hidden = true), 900);
    await refreshState();
  } catch (e) {
    $('cfgMsg').className = 'cfg-msg err';
    $('cfgMsg').textContent = '保存失败：' + e.message;
  }
}

// ===== 静态模式下调整界面（隐藏只对后端有意义的控件） =====
function applyStaticUi() {
  document.title = '马帮库存SKU申报价值看板';
  const h1 = document.querySelector('.topbar h1');
  if (h1 && !h1.querySelector('.badge')) {
    const b = document.createElement('span');
    b.className = 'badge no';
    b.style.cssText = 'font-size:11px;vertical-align:4px;margin-left:8px';
    b.textContent = '快照版';
    h1.appendChild(b);
  }
  const sub = document.querySelector('.subtitle');
  if (sub) sub.innerHTML = '按「采购价 → 建议申报价」阶梯判定 · 实际申报超过建议值自动标红异常 · <b>点下面任意卡片可单独查看该档</b> · 静态快照，只读';
  if ($('btnSync')) $('btnSync').hidden = true;
  if ($('btnSettings')) $('btnSettings').textContent = '⚙ 判定规则';
  if ($('cfgCreds')) $('cfgCreds').hidden = true;
  if ($('btnCfgSave')) $('btnCfgSave').hidden = true;
}

// ===== 事件绑定 =====
$('btnSync').onclick = doSync;
$('btnSettings').onclick = openSettings;
$('btnCfgCancel').onclick = () => ($('settingsModal').hidden = true);
$('btnCfgSave').onclick = saveSettings;

// 关闭弹窗的兜底方式：点遮罩空白处 / 按 ESC
const settingsModal = $('settingsModal');
settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) settingsModal.hidden = true;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !settingsModal.hidden) settingsModal.hidden = true;
});

$('chkAnomaly').onchange = (e) => { state.anomalyOnly = e.target.checked; state.page = 1; loadItems(); };
$('selSort').onchange = (e) => { state.sort = e.target.value; state.page = 1; loadItems(); };

// 点档位卡片 → 只看该档（再点一次取消）
$('dist').addEventListener('click', (e) => {
  const seg = e.target.closest('.seg[data-group]');
  if (seg) setGroup(seg.dataset.group);
});

// 点顶部统计卡 → 快捷筛选 / 排序
$('stats').addEventListener('click', (e) => {
  const card = e.target.closest('.card[data-action]');
  if (!card) return;
  const act = card.dataset.action;
  if (act === 'all') {
    state.group = '';
    state.anomalyOnly = false;
    state.q = '';
    $('chkAnomaly').checked = false;
    $('inpSearch').value = '';
    state.page = 1;
    renderGroups();
    loadItems();
    toast('已清空筛选，显示全部 SKU');
  } else if (act === 'anomaly') {
    state.anomalyOnly = true;
    $('chkAnomaly').checked = true;
    state.page = 1;
    loadItems();
  } else if (act.startsWith('sort:')) {
    state.sort = act.slice(5);
    $('selSort').value = state.sort;
    state.page = 1;
    loadItems();
  }
});

// 工具栏「筛选：xxx ×」药丸 → 取消档位筛选
$('filterPill').addEventListener('click', () => {
  state.group = '';
  state.page = 1;
  renderGroups();
  loadItems();
});
let searchTimer;
$('inpSearch').oninput = (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.q = e.target.value; state.page = 1; loadItems(); }, 300);
};
$('btnPrev').onclick = () => { if (state.page > 1) { state.page--; loadItems(); } };
$('btnNext').onclick = () => { state.page++; loadItems(); };

(async () => {
  if (STATIC) applyStaticUi();
  await refreshState();
  await loadItems();
})();
