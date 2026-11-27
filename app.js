/* 水上ビル 人流ダッシュボード
 * データ（JSON）は Google Apps Script が毎朝 BigQuery で集計したもの。
 * 形式は gas/Code.gs の buildData() を参照（slot30 / catDay / catHr / roamHr / roamNode / covisit / moves）
 */
'use strict';

const COLORS = { 'A棟': '#2563eb', 'B棟': '#059669', 'C棟': '#dc2626', 'D棟': '#d97706', 'ひとなる図書館': '#7c3aed', '大手ビル西': '#0d9488' };
const EXTRA = ['#db2777', '#4b5563', '#65a30d', '#0891b2'];
const CATS = [
  { k: 'pass', name: '素通り', desc: '1分未満', color: '#93c5fd' },
  { k: 'stop', name: '立ち寄り', desc: '1〜15分', color: '#2563eb' },
  { k: 'long', name: '15分以上', desc: '15〜90分（実際より少なめ）', color: '#1e3a8a' },
  { k: 'staff', name: '動かない機器', desc: '90分以上', color: '#fbbf24' },
  { k: 'car', name: '車', desc: 'A・B・D棟で1秒以下', color: '#d1d5db' },
];
const WD = '日月火水木金土';
const TABS = ['日別トレンド', '日報', '時系列', '滞在の内訳', 'ヒートマップ', '回遊', 'ノード間移動', '機器チェック', '拠点マップ', '地図'];

let D, NDAY, HOL, EV, NODES, DAY, BASE, AREAS;
const S = { from: 0, to: 0, sel: new Set(), tab: 0, smooth: true, win: 3, unit: 'max', hmNode: 'all', hmMetric: 'count', dayMode: 'people', dt: 'all', showOther: false, skip1: true, dayChart: 'line', rep: null, bm: 'vis', flow: true, mapView: null, agg: 'avg' };
const $ = id => document.getElementById(id);
const tip = $('tip');

// ---------------------------------------------------------------- 日付
const T0 = () => Date.UTC(+D.start.slice(0, 4), +D.start.slice(5, 7) - 1, +D.start.slice(8, 10));
const dayStr = i => new Date(T0() + i * 864e5).toISOString().slice(0, 10);
const dayIdx = s => Math.round((Date.parse(s + 'T00:00:00Z') - T0()) / 864e5);
const dow = i => new Date(T0() + i * 864e5).getUTCDay();
const md = i => { const d = new Date(T0() + i * 864e5); return (d.getUTCMonth() + 1) + '/' + d.getUTCDate(); };
const mdw = i => md(i) + '(' + WD[dow(i)] + ')';
const isOff = i => dow(i) === 0 || dow(i) === 6 || HOL.has(dayStr(i));
const evName = i => EV[dayStr(i)] || '';
const inDt = i => S.dt === 'all' || (S.dt === 'off') === isOff(i);
const fmt = n => Math.round(n).toLocaleString();
const pct = (a, b) => b ? Math.round(a / b * 1000) / 10 : 0;

// ---------------------------------------------------------------- 起動
async function boot() {
  try {
    const r = await fetch(window.DATA_URL, { cache: 'no-store' });
    if (!r.ok) throw new Error('データを取得できませんでした（' + r.status + '）');
    D = await r.json();
    if (D.error) throw new Error(D.error);
  } catch (e) {
    $('updated').textContent = '';
    $('pane').innerHTML = ''; $('pane').appendChild(el('div', 'err')).textContent = e.message;
    return;
  }
  NDAY = D.days;
  HOL = new Set(D.holidays || []);
  EV = D.events || {};
  // 並びは西から東：大手ビル → A〜D棟 → ひとなる図書館 → そのほか
  const ORDER = ['大手ビル', 'A棟', 'B棟', 'C棟', 'D棟', 'ひとなる図書館'];
  const rank = k => { const i = ORDER.findIndex(o => k.startsWith(o)); return i < 0 ? 99 : i; };
  NODES = D.nodes.slice().sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, 'ja'));
  AREAS = {}; Object.entries(D.areas || {}).forEach(([a, ks]) => { const k2 = ks.filter(k => NODES.includes(k)); if (k2.length) AREAS[a] = k2; });
  NODES.forEach((k, i) => { if (!COLORS[k]) COLORS[k] = EXTRA[i % EXTRA.length]; });
  NODES.forEach(k => S.sel.add(k));
  for (const k of NODES) while (D.slot30[k].length < NDAY * 48) D.slot30[k].push(null);
  prepDay();
  const m = location.hash.match(/^#tab(\d)$/); if (m && +m[1] < TABS.length) S.tab = +m[1];
  S.to = Math.max(0, NDAY - 2);              // 既定は昨日まで
  S.from = Math.max(0, S.to - 6);
  $('updated').textContent = '最終更新: ' + D.generated.replace('T', ' ').slice(0, 16) + '（毎朝6時・12時・18時ごろ更新）／ データ: ' + md(0) + '〜' + md(NDAY - 1);
  $('from').onchange = e => { S.from = clamp(dayIdx(e.target.value), 0, S.to); render(); };
  $('to').onchange = e => { S.to = clamp(dayIdx(e.target.value), S.from, NDAY - 1); render(); };
  let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(render, 150); });
  render();
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, isNaN(v) ? a : v));

// 日ごとの稼働率・日中・夜の値と、普段の値（機器チェック用）
function prepDay() {
  DAY = {}; BASE = {};
  for (const k of NODES) {
    const u = D.slot30[k], a = [];
    for (let d = 0; d < NDAY; d++) {
      let cov = 0, day = 0, all = 0, night = 0, nn = 0;
      for (let s = 0; s < 48; s++) {
        const v = u[d * 48 + s]; if (v == null) continue;
        cov++; all += v; if (s >= 20 && s < 32) day += v; if (s < 10) { night += v; nn++; }
      }
      a.push({ cov, day, all, night: nn ? night / nn : null });
    }
    DAY[k] = a;
    const ok = d => a[d].cov >= 44 && !evName(d) && d < NDAY - 1;
    const idx = [...Array(NDAY).keys()].filter(ok);
    BASE[k] = {
      off: median(idx.filter(isOff).map(d => a[d].day)),
      on: median(idx.filter(d => !isOff(d)).map(d => a[d].day)),
      night: median(idx.map(d => a[d].night)),
    };
  }
}
function median(arr) { const b = arr.filter(x => x != null).sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : null; }
function flags(k, d) {
  const r = DAY[k][d], f = [];
  if (r.cov === 0) return ['none'];
  if (r.cov < 38) f.push('gap');
  const b = isOff(d) ? BASE[k].off : BASE[k].on;
  if (b && r.cov >= 38) { if (r.day < b * 0.5) f.push('low'); if (r.day > b * 1.8) f.push('high'); }
  const n = BASE[k].night;
  if (n != null && r.night != null && r.night > Math.max(n * 2, n + 5)) f.push('night');
  return f;
}

// ---------------------------------------------------------------- 共通UI
function btn(label, on, fn) { const b = document.createElement('button'); b.className = 'b' + (on ? ' on' : ''); b.textContent = label; b.onclick = fn; return b; }
function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
function head(p, title, controls) { const h = el('div', 'head'); h.appendChild(el('b', null, title)); const c = el('span', 'row'); (controls || []).forEach(x => c.appendChild(x)); h.appendChild(c); p.appendChild(h); }
function lbl(t) { return el('span', 'lbl', t); }
function dtButtons() { return [['all', '全部'], ['on', '平日'], ['off', '土日祝']].map(([k, l]) => btn(l, S.dt === k, () => { S.dt = k; render(); })); }
// エリア：拠点の選択がどれかのエリアとぴったり同じならそのエリア、そうでなければ全体
function curArea() {
  for (const [a, ks] of Object.entries(AREAS)) if (ks.length === S.sel.size && ks.every(k => S.sel.has(k))) return a;
  return 'all';
}
function areaLabel() { const a = curArea(); return a === 'all' ? (S.sel.size === NODES.length ? '全拠点' : '全拠点（拠点を個別に選んだときも全体で計算）') : a; }
// 回遊の行（[日, 到着時, 来た人, 2か所以上, 3か所以上, 通り抜け, 寄り道回遊]）。エリアを選んでいればエリア内で数えたもの
function roamRows() {
  const a = curArea();
  if (a === 'all' || !D.roamHrArea || !D.roamHrArea.length) return D.roamHr;
  return D.roamHrArea.filter(r => r[1] === a).map(r => [r[0]].concat(r.slice(2)));
}
function selNodes() { return NODES.filter(k => S.sel.has(k)); }
function rangeDays() { const a = []; for (let d = S.from; d <= S.to; d++) a.push(d); return a; }

function renderControls() {
  const q = $('quick'); q.innerHTML = '';
  const last = NDAY - 2;
  for (const [l, n] of [['昨日', 1], ['7日', 7], ['30日', 30], ['全期間', NDAY - 1]]) {
    q.appendChild(btn(l, S.to === last && S.to - S.from + 1 === n, () => { S.to = last; S.from = Math.max(0, last - n + 1); render(); }));
  }
  q.appendChild(btn('今日（' + D.generated.slice(11, 16) + 'まで）', S.from === NDAY - 1 && S.to === NDAY - 1, () => { S.from = S.to = NDAY - 1; render(); }));
  const ag = $('agg'); ag.innerHTML = '';
  ag.appendChild(btn('1日平均', S.agg === 'avg', () => { S.agg = 'avg'; render(); }));
  ag.appendChild(btn('延べ（期間の合計）', S.agg === 'sum', () => { S.agg = 'sum'; render(); }));
  for (const id of ['from', 'to']) { $(id).min = dayStr(0); $(id).max = dayStr(NDAY - 1); }
  $('from').value = dayStr(S.from); $('to').value = dayStr(S.to);
  const ar = $('areas'); ar.innerHTML = '';
  const ca = curArea();
  ar.appendChild(btn('すべて', S.sel.size === NODES.length, () => { S.sel = new Set(NODES); render(); }));
  for (const [a, ks] of Object.entries(AREAS)) ar.appendChild(btn(a + '（' + ks.join('・').replace(/棟・/g, '・') + '）', ca === a, () => { S.sel = new Set(ks); render(); }));
  const c = $('chips'); c.innerHTML = '';
  for (const k of NODES) {
    const b = el('button', 'chip' + (S.sel.has(k) ? '' : ' off'), k); b.style.background = COLORS[k];
    b.onclick = () => { S.sel.has(k) ? S.sel.delete(k) : S.sel.add(k); render(); };
    c.appendChild(b);
  }
  const t = $('tabs'); t.innerHTML = '';
  TABS.forEach((l, i) => { const b = el('button', 'tab' + (S.tab === i ? ' on' : ''), l); b.onclick = () => { S.tab = i; history.replaceState(null, '', '#tab' + i); render(); }; t.appendChild(b); });
}

function renderKpis() {
  const days = rangeDays(), nodes = selNodes();
  let v = 0, rs = 0;
  for (const r of roamRows()) if (r[0] >= S.from && r[0] <= S.to) { v += r[2]; rs += r[6]; }
  let pass = 0, stay = 0;
  for (const k of nodes) for (const d of days) { pass += D.catDay[k].pass[d]; stay += D.catDay[k].stop[d] + D.catDay[k].long[d]; }
  let cov = 0; for (const k of nodes) for (const d of days) cov += DAY[k][d].cov;
  const cards = [
    S.agg === 'sum' ? ['来た人（延べ・' + days.length + '日間）', fmt(v), areaLabel() + '・1日ごとの人数の合計（毎日来る人は日数分）'] : ['来た人（1日平均）', fmt(v / days.length), areaLabel() + '・車と動かない機器を除く'],
    ['立ち寄り率', pct(stay, pass + stay) + '%', '選んだ拠点で1分以上いた人の割合'],
    ['寄り道回遊率', pct(rs, v) + '%', areaLabel() + 'の中で2か所以上・どこかで1分以上'],
    ['稼働率', nodes.length ? Math.round(cov / (nodes.length * days.length * 48) * 100) + '%' : '-', '30分枠のうちデータが届いた割合'],
  ];
  $('kpis').innerHTML = cards.map(([t, val, s]) => `<div class="kpi"><div class="t">${t}</div><div class="v">${val}</div><div class="s">${s}</div></div>`).join('');
}

// ---------------------------------------------------------------- グラフ部品（canvas）
function setupCanvas(box, H) {
  const cv = document.createElement('canvas'); box.appendChild(cv);
  const dpr = window.devicePixelRatio || 1, W = Math.max(300, box.clientWidth);
  cv.width = W * dpr; cv.height = H * dpr; cv.style.height = H + 'px';
  const g = cv.getContext('2d'); g.scale(dpr, dpr); g.font = '11px sans-serif';
  return { cv, g, W };
}
function niceStep(x) { const p = Math.pow(10, Math.floor(Math.log10(x || 1))); for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= x) return m * p; return 10 * p; }
function yAxis(g, L, R, T, ph, W, ymax, yfmt) {
  const step = niceStep(ymax / 4); ymax = Math.ceil(ymax / step) * step || 1;
  const Y = v => T + ph - v / ymax * ph;
  g.strokeStyle = '#eef0f3'; g.fillStyle = '#6b7280'; g.textAlign = 'right';
  for (let v = 0; v <= ymax + 1e-9; v += step) { g.beginPath(); g.moveTo(L, Y(v)); g.lineTo(W - R, Y(v)); g.stroke(); g.fillText(yfmt(v), L - 6, Y(v) + 4); }
  return Y;
}
function legend(box, items, bar) { const lg = el('div', 'legend', items.map(s => `<span><i style="background:${s.color};${bar ? 'height:10px' : ''}"></i>${s.name}</span>`).join('')); box.prepend(lg); }
function showTip(e, html) { tip.innerHTML = html; tip.style.display = 'block'; tip.style.left = Math.min(e.clientX + 14, innerWidth - 260) + 'px'; tip.style.top = (e.clientY + 14) + 'px'; }
function hideTip() { tip.style.display = 'none'; }

function lineChart(box, { n, series, label, hoverLabel, yfmt, bands }) {
  const H = 340, { cv, g, W } = setupCanvas(box, H);
  const L = 52, R = 12, T = 10, B = 58, pw = W - L - R, ph = H - T - B;
  let ymax = 0; for (const s of series) for (const v of s.vals) if (v != null && v > ymax) ymax = v;
  const X = i => L + (n <= 1 ? pw / 2 : i / (n - 1) * pw);
  for (const b of bands || []) { g.fillStyle = b.color; const x0 = n <= 1 ? L : X(b.a), x1 = n <= 1 ? L + pw : X(b.b); g.fillRect(x0, T, Math.max(1, x1 - x0), ph); }
  const Y = yAxis(g, L, R, T, ph, W, ymax || 1, yfmt);
  const nt = Math.max(1, Math.min(n, Math.floor(pw / 70)));
  g.fillStyle = '#6b7280';
  for (let t = 0; t < nt; t++) { const i = nt === 1 ? 0 : Math.round(t * (n - 1) / (nt - 1)); g.save(); g.translate(X(i), T + ph + 8); g.rotate(-Math.PI / 5); g.textAlign = 'right'; g.fillText(label(i), 0, 4); g.restore(); }
  for (const s of series) {
    g.strokeStyle = s.color; g.lineWidth = 1.6; g.beginPath(); let pen = false;
    s.vals.forEach((v, i) => { if (v == null) { pen = false; return; } pen ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v)); pen = true; });
    g.stroke();
    if (n <= 40) { g.fillStyle = s.color; s.vals.forEach((v, i) => { if (v != null) { g.beginPath(); g.arc(X(i), Y(v), 2.5, 0, 7); g.fill(); } }); }
  }
  legend(box, series);
  cv.onmousemove = e => {
    const r = cv.getBoundingClientRect(); const i = n <= 1 ? 0 : Math.round((e.clientX - r.left - L) / pw * (n - 1));
    if (i < 0 || i >= n) return hideTip();
    showTip(e, '<b>' + (hoverLabel || label)(i) + '</b><br>' + series.map(s => `<span style="color:${s.color}">●</span> ${s.name}: ${s.vals[i] == null ? 'データなし' : yfmt(s.vals[i])}`).join('<br>'));
  };
  cv.onmouseleave = hideTip;
}

function stackBars(box, { cats, stacks, yfmt, tipFn, H, line, bands }) {
  H = H || 320; const { cv, g, W } = setupCanvas(box, H);
  const L = 52, R = 12, T = 10, B = 40, pw = W - L - R, ph = H - T - B, n = cats.length;
  let ymax = 0; for (let i = 0; i < n; i++) { const s = stacks.reduce((a, st) => a + (st.vals[i] || 0), 0); if (s > ymax) ymax = s; }
  if (line) for (const v of line.vals) if (v != null && v > ymax) ymax = v;
  const bw = pw / Math.max(1, n);
  for (const b of bands || []) { g.fillStyle = b.color; g.fillRect(L + (b.a + 0.5) * bw, T, (b.b - b.a) * bw, ph); }
  const Y = yAxis(g, L, R, T, ph, W, ymax || 1, yfmt);
  const every = Math.ceil(n / Math.max(1, Math.floor(pw / 46)));
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (const st of stacks) { const v = st.vals[i] || 0; g.fillStyle = st.color; g.fillRect(L + i * bw + bw * 0.15, Y(acc + v), Math.max(1, bw * 0.7), Y(acc) - Y(acc + v)); acc += v; }
    if (i % every === 0) { g.fillStyle = '#6b7280'; g.textAlign = 'center'; g.fillText(cats[i], L + i * bw + bw / 2, T + ph + 16); }
  }
  if (line) {
    g.strokeStyle = line.color; g.lineWidth = 2; g.beginPath(); let pen = false;
    line.vals.forEach((v, i) => { const x = L + i * bw + bw / 2; if (v == null) { pen = false; return; } pen ? g.lineTo(x, Y(v)) : g.moveTo(x, Y(v)); pen = true; });
    g.stroke(); g.fillStyle = line.color;
    line.vals.forEach((v, i) => { if (v != null) { g.beginPath(); g.arc(L + i * bw + bw / 2, Y(v), 3, 0, 7); g.fill(); } });
  }
  legend(box, line ? stacks.concat([line]) : stacks, true);
  cv.onmousemove = e => { const r = cv.getBoundingClientRect(); const i = Math.floor((e.clientX - r.left - L) / bw); if (i < 0 || i >= n) return hideTip(); showTip(e, tipFn(i)); };
  cv.onmouseleave = hideTip;
}
function dayBands(a, b, per) {
  const out = [];
  for (let d = a; d <= b; d++) {
    const i0 = (d - a) * per - (per === 1 ? 0.5 : 0), i1 = (d - a + 1) * per - (per === 1 ? 0.5 : 1);
    if (evName(d)) out.push({ a: i0, b: i1, color: 'rgba(234,88,12,.12)' });
    else if (isOff(d)) out.push({ a: i0, b: i1, color: 'rgba(37,99,235,.06)' });
  }
  return out;
}
const BAND_NOTE = '薄い青＝土日祝、薄いオレンジ＝朝市・まつり・イベントの日。';

// ---------------------------------------------------------------- 時系列
function tabSeries(p) {
  const c = [btn('なめらか', S.smooth, () => { S.smooth = true; render(); }), btn('実数', !S.smooth, () => { S.smooth = false; render(); }), lbl(' 単位:')];
  for (const [k, l] of [['count', '台数'], ['avg', '平均=100'], ['max', '最大=100']]) c.push(btn(l, S.unit === k, () => { S.unit = k; render(); }));
  if (S.smooth) { c.push(lbl(' ならす幅:')); for (const w of [1, 3, 6]) c.push(btn(w + '時間', S.win === w, () => { S.win = w; render(); })); }
  head(p, '時間帯別ユニーク端末数（30分ごと）', c);
  p.appendChild(el('p', 'note', (S.smooth ? `前後${S.win}時間の平均でならした値（データのない枠は0として計算）。` : '30分ごとの実数。データのない枠は線が途切れる。') +
    { count: '', avg: '各拠点の期間平均を100とした比率（150＝普段の1.5倍）。', max: '各拠点の期間中の最大を100とした比率（混む時間の形を比べる用。どこが多いかは「台数」で見る）。' }[S.unit] +
    ' 車・動かない機器を含む端末の生の数。' + BAND_NOTE));
  const a = S.from * 48, b = (S.to + 1) * 48, n = b - a, series = [];
  for (const k of selNodes()) {
    let v = D.slot30[k].slice(a, b);
    if (S.smooth) {
      const half = S.win * 2, pre = [0]; for (const x of v) pre.push(pre[pre.length - 1] + (x || 0));
      v = v.map((_, i) => { const lo = Math.max(0, i - half), hi = Math.min(n, i + half + 1); return (pre[hi] - pre[lo]) / (hi - lo); });
    }
    if (S.unit !== 'count') {
      const vs = v.filter(x => x != null); const ref = S.unit === 'max' ? Math.max(...vs) : vs.reduce((x, y) => x + y, 0) / (vs.length || 1);
      v = v.map(x => x == null ? null : ref ? x / ref * 100 : 0);
    }
    series.push({ name: k, color: COLORS[k], vals: v });
  }
  const box = el('div'); p.appendChild(box);
  lineChart(box, { n, series, yfmt: v => fmt(v), bands: dayBands(S.from, S.to, 48),
    label: i => { const d = S.from + Math.floor(i / 48), s = i % 48; return mdw(d) + ' ' + String(s >> 1).padStart(2, '0') + ':' + (s % 2 ? '30' : '00'); },
    hoverLabel: i => { const d = S.from + Math.floor(i / 48), s = i % 48; return mdw(d) + ' ' + String(s >> 1).padStart(2, '0') + ':' + (s % 2 ? '30' : '00') + (evName(d) ? ' ' + evName(d) : ''); } });
}

// ---------------------------------------------------------------- 滞在の内訳
function tabStay(p) {
  const cats = CATS.filter(c => S.showOther || ['pass', 'stop', 'long'].includes(c.k));
  head(p, '素通り・立ち寄り・15分以上', [btn('来た人だけ', !S.showOther, () => { S.showOther = false; render(); }), btn('車・動かない機器も', S.showOther, () => { S.showOther = true; render(); })]);
  const days = rangeDays(), nodes = selNodes(), hourly = days.length <= 3;
  p.appendChild(el('p', 'note', 'その日・その拠点で最初に見えてから最後に見えるまでの長さで分類。' + (hourly ? '3日以内なので1時間ごと（その時間にいた端末数）。' : '日ごと（その日に見えた端末数）。') + '選んだ拠点の合計（拠点をまたいだ人は拠点ごとに数える）。'));
  const box = el('div'); p.appendChild(box);
  if (hourly) {
    const n = days.length * 24, labels = [], stacks = cats.map(c => ({ name: c.name, color: c.color, vals: new Array(n).fill(0) }));
    for (let i = 0; i < n; i++) { const d = S.from + Math.floor(i / 24), h = i % 24; labels.push(h === 0 ? md(d) : h + '時'); cats.forEach((c, j) => { for (const k of nodes) stacks[j].vals[i] += D.catHr[k][c.k][d * 24 + h]; }); }
    stackBars(box, { cats: labels, stacks, yfmt: fmt, tipFn: i => { const d = S.from + Math.floor(i / 24); return `<b>${mdw(d)} ${i % 24}時</b><br>` + stacks.map(s => `<span style="color:${s.color}">■</span> ${s.name}: ${fmt(s.vals[i])}`).join('<br>'); } });
  } else {
    const stacks = cats.map(c => ({ name: c.name, color: c.color, vals: days.map(d => nodes.reduce((a, k) => a + D.catDay[k][c.k][d], 0)) }));
    stackBars(box, { cats: days.map(md), stacks, yfmt: fmt, tipFn: i => { const d = days[i]; const tot = stacks.filter(s => ['素通り', '立ち寄り', '15分以上'].includes(s.name)).reduce((a, s) => a + s.vals[i], 0); const st = stacks.filter(s => ['立ち寄り', '15分以上'].includes(s.name)).reduce((a, s) => a + s.vals[i], 0); return `<b>${mdw(d)}${evName(d) ? ' ' + evName(d) : ''}</b><br>` + stacks.map(s => `<span style="color:${s.color}">■</span> ${s.name}: ${fmt(s.vals[i])}`).join('<br>') + `<br>立ち寄り率 ${pct(st, tot)}%`; } });
  }
  // 拠点ごとの内訳
  const sec = el('div', 'sec'); p.appendChild(sec);
  head(sec, '拠点ごとの内訳（期間の合計）');
  sec.appendChild(el('p', 'note', '横棒は、来た人（素通り＋立ち寄り＋15分以上）を100%とした内訳。右は立ち寄り率（1分以上いた人の割合）。'));
  let h = '<table class="list"><tr><th>拠点</th><th class="r">来た人</th><th style="width:40%">内訳</th><th class="r">立ち寄り率</th><th class="r">車</th><th class="r">動かない機器</th></tr>';
  for (const k of nodes) {
    const t = {}; for (const c of CATS) t[c.k] = days.reduce((a, d) => a + D.catDay[k][c.k][d], 0);
    const tot = t.pass + t.stop + t.long;
    const seg = ['pass', 'stop', 'long'].map(c => `<div style="width:${tot ? t[c] / tot * 100 : 0}%;background:${CATS.find(x => x.k === c).color}" title="${CATS.find(x => x.k === c).name} ${pct(t[c], tot)}%"></div>`).join('');
    h += `<tr><td><span style="color:${COLORS[k]}">●</span> ${k}</td><td class="r">${fmt(tot)}</td><td><div class="bar">${seg}</div></td><td class="r"><b>${pct(t.stop + t.long, tot)}%</b></td><td class="r">${fmt(t.car)}</td><td class="r">${fmt(t.staff)}</td></tr>`;
  }
  sec.insertAdjacentHTML('beforeend', h + '</table>');
}

// ---------------------------------------------------------------- ヒートマップ
function tabHeat(p) {
  const c = [btn('台数', S.hmMetric === 'count', () => { S.hmMetric = 'count'; render(); }), btn('立ち寄り率', S.hmMetric === 'stay', () => { S.hmMetric = 'stay'; render(); }), lbl(' 拠点:'), btn('選択中の合計', S.hmNode === 'all', () => { S.hmNode = 'all'; render(); })];
  for (const k of selNodes()) c.push(btn(k, S.hmNode === k, () => { S.hmNode = k; render(); }));
  head(p, '曜日×時間', c);
  const nodes = S.hmNode === 'all' || !S.sel.has(S.hmNode) ? selNodes() : [S.hmNode];
  const acc = [...Array(8)].map(() => Array(24).fill(0)), acc2 = [...Array(8)].map(() => Array(24).fill(0)), cnt = [...Array(8)].map(() => Array(24).fill(0));
  for (let d = S.from; d <= S.to; d++) {
    const r = HOL.has(dayStr(d)) ? 7 : (dow(d) + 6) % 7;
    for (let h = 0; h < 24; h++) {
      if (S.hmMetric === 'count') {
        let v = 0, any = false; for (const k of nodes) for (const s of [h * 2, h * 2 + 1]) { const x = D.slot30[k][d * 48 + s]; if (x != null) { v += x; any = true; } }
        if (any) { acc[r][h] += v; cnt[r][h]++; }
      } else {
        for (const k of nodes) { const i = d * 24 + h; acc[r][h] += D.catHr[k].stop[i] + D.catHr[k].long[i]; acc2[r][h] += D.catHr[k].pass[i] + D.catHr[k].stop[i] + D.catHr[k].long[i]; }
        cnt[r][h] = 1;
      }
    }
  }
  const val = acc.map((row, r) => row.map((v, h) => S.hmMetric === 'count' ? (cnt[r][h] ? v / cnt[r][h] : null) : (acc2[r][h] >= 20 ? v / acc2[r][h] * 100 : null)));
  const all = val.flat().filter(v => v != null), mx = Math.max(...all, 1), mn = S.hmMetric === 'stay' ? Math.min(...all) : 0;
  p.appendChild(el('p', 'note', S.hmMetric === 'count' ? '1時間あたりの延べ端末数の平均（車・動かない機器を含む）。色が濃いほど多い。祝日は「祝」の行にまとめた。' : 'その時間にいた人のうち、その拠点で1分以上いた人の割合。濃いほど「止まる」時間帯。人が少ない枠は空白。'));
  let h = '<div class="scroll"><table class="grid"><tr><th></th>' + [...Array(24).keys()].map(x => `<th>${x}</th>`).join('') + '</tr>';
  ['月', '火', '水', '木', '金', '土', '日', '祝'].forEach((l, r) => {
    h += `<tr><th>${l}</th>` + val[r].map((v, hh) => v == null ? '<td style="background:#f3f4f6;min-width:34px"></td>' :
      `<td title="${l} ${hh}時: ${S.hmMetric === 'count' ? fmt(v) + '台' : v.toFixed(1) + '%'}" style="min-width:34px;background:rgba(37,99,235,${(0.06 + 0.94 * (v - mn) / ((mx - mn) || 1)).toFixed(2)})"></td>`).join('') + '</tr>';
  });
  p.insertAdjacentHTML('beforeend', h + '</table></div>');
}

// ---------------------------------------------------------------- 日別トレンド
function tabDaily(p) { tabDailyChart(p); monthlyTable(p); }
// 月別（たくわえの全期間。公開データの90日より前も含む）。延べ／1日平均を上の切り替えに合わせる
function monthlyTable(p) {
  const MO = D.monthly; if (!MO || !Object.keys(MO).length) return;
  const a = curArea(), nodes = selNodes(), sum = S.agg === 'sum';
  const yms = Object.keys(MO).sort(), cur = D.generated.slice(0, 7);
  const sec = el('div', 'sec'); p.appendChild(sec);
  head(sec, '月別　' + (sum ? '延べ人数' : '1日平均') + '（' + areaLabel().replace(/（.*）/, '') + '）', [btn('1日平均', !sum, () => { S.agg = 'avg'; render(); }), btn('延べ', sum, () => { S.agg = 'sum'; render(); })]);
  sec.appendChild(el('p', 'note', '9月1日からの全期間（上の期間の選択には連動しません）。延べ＝その日に来た人（重複を除く）を日数分足した数で、毎日来る人は日数分数えます。データが欠けた時間の分は補っていないので、そのぶん少なめです。立ち寄り率とデータの届いた割合は、選んだ拠点で計算。'));
  let h = '<div class="scroll"><table class="list"><tr><th>月</th><th class="r">日数</th><th class="r">来た人' + (sum ? '（延べ）' : '（1日平均）') + '</th><th class="r">立ち寄り率</th><th class="r">データの届いた割合</th></tr>';
  let tv = 0, td = 0, tt = 0, ts = 0, tc = 0;
  for (const ym of yms) {
    const m = MO[ym], v = a === 'all' ? m.vis : (m.area[a] || 0);
    let t = 0, st = 0, cv = 0; for (const k of nodes) { const n = m.node[k]; if (n) { t += n[0]; st += n[1]; cv += n[2]; } }
    tv += v; td += m.days; tt += t; ts += st; tc += cv;
    h += `<tr><td>${+ym.slice(0, 4)}年${+ym.slice(5)}月${ym === cur ? '（途中）' : ''}</td><td class="r">${m.days}</td><td class="r"><b>${fmt(sum ? v : v / m.days)}</b></td><td class="r">${pct(st, t)}%</td><td class="r">${nodes.length ? Math.round(cv / (nodes.length * m.days * 48) * 100) : '-'}%</td></tr>`;
  }
  h += `<tr class="total"><td>9月からの累計</td><td class="r">${td}</td><td class="r"><b>${fmt(sum ? tv : tv / td)}</b></td><td class="r">${pct(ts, tt)}%</td><td class="r">${nodes.length ? Math.round(tc / (nodes.length * td * 48) * 100) : '-'}%</td></tr>`;
  sec.insertAdjacentHTML('beforeend', h + '</table></div>');
}
function tabDailyChart(p) {
  head(p, '日ごとの推移', [btn('折れ線', S.dayChart === 'line', () => { S.dayChart = 'line'; render(); }), btn('積み上げ', S.dayChart === 'stack', () => { S.dayChart = 'stack'; S.dayMode = 'people'; render(); }), lbl(' '), btn('10〜16時', S.dayMode === 'day', () => { S.dayMode = 'day'; render(); }), btn('一日中', S.dayMode === 'all', () => { S.dayMode = 'all'; render(); }), btn('夜0〜5時', S.dayMode === 'night', () => { S.dayMode = 'night'; render(); }), btn('来た人（分類後）', S.dayMode === 'people', () => { S.dayMode = 'people'; render(); })]);
  p.appendChild(el('p', 'note', (S.dayMode === 'people' ? 'その日その拠点で見えた来た人（素通り＋立ち寄り＋15分以上。車・動かない機器を除く）。' : S.dayMode === 'night' ? '夜0〜5時の30分あたりの平均端末数。置きっぱなしの機器や夜の人通りを見る用。' : '30分ごとのユニーク数を足したもの（同じ人が長くいると重ねて数える）。増減や段差を見る用。') + BAND_NOTE));
  const days = rangeDays(), n = days.length;
  const series = selNodes().map(k => ({ name: k, color: COLORS[k], vals: days.map(d => { const r = DAY[k][d]; if (S.dayMode === 'people') { const c = D.catDay[k]; const t = c.pass[d] + c.stop[d] + c.long[d]; return t || null; } return r.cov === 0 ? null : S.dayMode === 'night' ? r.night : r[S.dayMode]; }) }));
  const box = el('div'); p.appendChild(box);
  const yf = v => S.dayMode === 'night' ? (Math.round(v * 10) / 10).toString() : fmt(v);
  if (S.dayChart === 'line') {
    lineChart(box, { n, series, label: i => mdw(days[i]), hoverLabel: i => mdw(days[i]) + (evName(days[i]) ? ' ' + evName(days[i]) : ''), yfmt: yf, bands: dayBands(S.from, S.to, 1) });
    return;
  }
  // 積み上げ：「来た人（分類後）」のときは、重複を除いた本当の人数を線で重ねる
  let line = null;
  if (S.dayMode === 'people') {
    const byDay = {}; for (const r of roamRows()) byDay[r[0]] = (byDay[r[0]] || 0) + r[2];
    line = { name: '来た人（重複を除く・' + areaLabel().replace(/（.*）/, '') + '）', color: '#111827', vals: days.map(d => byDay[d] || null) };
  }
  p.insertBefore(el('p', 'note', line ? '棒＝拠点ごとの来た人を積んだもの（2か所以上を回った人は重ねて数える）。黒い線＝同じ人を1回だけ数えた人数。棒と線の差が、回遊による重なり。' : '棒の高さは拠点ごとの値を足したもので、人数ではない（人数を見るなら「来た人（分類後）」を選ぶ）。積み上げは一番下以外の増減が読みにくいので、拠点ごとの変化は「折れ線」で見る。'), box);
  stackBars(box, { cats: days.map(md), stacks: series.map(s => ({ name: s.name, color: s.color, vals: s.vals })), yfmt: yf, line, bands: dayBands(S.from, S.to, 1).map(b => ({ a: b.a, b: b.b, color: b.color })),
    tipFn: i => { const d = days[i]; const tot = series.reduce((a, s) => a + (s.vals[i] || 0), 0); return `<b>${mdw(d)}${evName(d) ? ' ' + evName(d) : ''}</b><br>` + series.slice().reverse().map(s => `<span style="color:${s.color}">■</span> ${s.name}: ${s.vals[i] == null ? 'データなし' : yf(s.vals[i])}`).join('<br>') + `<br>棒の合計: ${yf(tot)}` + (line && line.vals[i] != null ? `<br><b>来た人（重複を除く）: ${fmt(line.vals[i])}</b>` : ''); } });
}

// ---------------------------------------------------------------- 回遊
function tabRoam(p) {
  head(p, '何時に来た人が回遊するか（到着時間別）', dtButtons());
  p.appendChild(el('p', 'note', 'その日最初に見えた時間ごとに、2か所以上で見えた人の割合。<b>通り抜け</b>＝どこにも1分以上いなかった人、<b>寄り道回遊</b>＝どこかで1分以上いた人。車・動かない機器は除く。上の「エリア」で商店街（A〜D棟）などを選ぶと、そのエリアの中だけで数え直す（今：<b>' + areaLabel() + '</b>）。'));
  const hr = [...Array(24)].map(() => [0, 0, 0, 0, 0, 0]);
  const RR = roamRows();
  for (const r of RR) if (r[0] >= S.from && r[0] <= S.to && inDt(r[0])) for (let j = 2; j < 7; j++) hr[r[1]][j - 2] += r[j];
  const box = el('div'); p.appendChild(box);
  const rs = hr.map(x => pct(x[4], x[0])), wt = hr.map(x => pct(x[3], x[0]));
  stackBars(box, { cats: [...Array(24).keys()].map(String), stacks: [{ name: '寄り道回遊', color: '#059669', vals: rs }, { name: '通り抜け', color: '#cbd5e1', vals: wt }], yfmt: v => v + '%',
    tipFn: i => `<b>${i}時に来た人</b><br>来た人 ${fmt(hr[i][0])}<br><span style="color:#34d399">■</span> 寄り道回遊 ${rs[i]}%<br><span style="color:#cbd5e1">■</span> 通り抜け ${wt[i]}%<br>3か所以上 ${pct(hr[i][2], hr[i][0])}%` });
  const ok = [...Array(24).keys()].filter(i => hr[i][0] >= 200);
  if (ok.length) {
    const hi = ok.reduce((a, b) => rs[b] > rs[a] ? b : a), wh = ok.reduce((a, b) => wt[b] > wt[a] ? b : a);
    p.appendChild(el('p', 'note', `📌 寄り道回遊が一番多いのは <b>${hi}時着（${rs[hi]}%）</b>、通り抜けが一番多いのは <b>${wh}時着（${wt[wh]}%）</b>。遅い時間に来た人は閉店まで時間が短いので、回遊は自然と下がる。`));
  }

  // 日ごと
  let sec = el('div', 'sec'); p.appendChild(sec);
  head(sec, '日ごとの回遊率');
  sec.appendChild(el('p', 'note', '車・動かない機器を除いた来た人（' + areaLabel() + '）のうちの割合。' + BAND_NOTE));
  const days = rangeDays(), byDay = {};
  for (const r of RR) { if (!byDay[r[0]]) byDay[r[0]] = [0, 0, 0, 0, 0]; for (let j = 2; j < 7; j++) byDay[r[0]][j - 2] += r[j]; }
  const g = f => days.map(d => { const x = byDay[d]; return x && x[0] >= 500 ? f(x) : null; });
  const b2 = el('div'); sec.appendChild(b2);
  lineChart(b2, { n: days.length, series: [{ name: '2か所以上', color: '#2563eb', vals: g(x => x[1] / x[0] * 100) }, { name: '寄り道回遊', color: '#059669', vals: g(x => x[4] / x[0] * 100) }, { name: '3か所以上', color: '#7c3aed', vals: g(x => x[2] / x[0] * 100) }],
    label: i => mdw(days[i]), hoverLabel: i => mdw(days[i]) + (evName(days[i]) ? ' ' + evName(days[i]) : '') + (byDay[days[i]] ? '　来た人 ' + fmt(byDay[days[i]][0]) : ''), yfmt: v => (Math.round(v * 10) / 10) + '%', bands: dayBands(S.from, S.to, 1) });

  // 拠点ごと
  sec = el('div', 'sec'); p.appendChild(sec);
  head(sec, '拠点ごとの回遊', dtButtons());
  sec.appendChild(el('p', 'note', 'その拠点で見えた人を100%として、<b>ここで1分以上いた</b>割合と、<b>ほかの拠点にも行った</b>割合（緑＝寄り道回遊、グレー＝通り抜け）。'));
  const agg = {}; for (const k of NODES) agg[k] = [0, 0, 0, 0, 0, 0];
  for (const r of D.roamNode) if (r[0] >= S.from && r[0] <= S.to && inDt(r[0]) && agg[r[1]]) for (let j = 2; j < 8; j++) agg[r[1]][j - 2] += r[j];
  let h = '<table class="list"><tr><th>拠点</th><th class="r">来た人</th><th style="width:28%">ここで1分以上いた</th><th style="width:36%">ほかの拠点にも行った</th><th class="r">平均の拠点数</th></tr>';
  for (const k of selNodes()) {
    const [v, here, r, w, rsn, locs] = agg[k]; if (!v) continue;
    h += `<tr><td><span style="color:${COLORS[k]}">●</span> ${k}</td><td class="r">${fmt(v)}</td>
      <td><div class="barcell"><div class="bar"><div style="width:${pct(here, v)}%;background:#2563eb"></div></div><span class="r" style="width:44px">${pct(here, v)}%</span></div></td>
      <td><div class="barcell"><div class="bar" title="寄り道回遊 ${pct(rsn, v)}%／通り抜け ${pct(w, v)}%"><div style="width:${pct(rsn, v)}%;background:#059669"></div><div style="width:${pct(w, v)}%;background:#cbd5e1"></div></div><span class="r" style="width:150px">${pct(r, v)}%（寄り道 ${pct(rsn, v)}%）</span></div></td>
      <td class="r">${(locs / v).toFixed(2)}</td></tr>`;
  }
  sec.insertAdjacentHTML('beforeend', h + '</table>');

  // 組み合わせ
  sec = el('div', 'sec'); p.appendChild(sec);
  head(sec, 'どの拠点同士が一緒に回られているか');
  sec.appendChild(el('p', 'note', '同じ日に両方の拠点で見えた人数（期間の合計、車・動かない機器除く）。カッコ内は、どちらかで1分以上いた人。隣同士が多いのは自然なので、離れた拠点同士の数に注目。'));
  const cv = {}, key = (a, b) => a < b ? a + '|' + b : b + '|' + a;
  for (const r of D.covisit) if (r[0] >= S.from && r[0] <= S.to && inDt(r[0])) { const kk = key(r[1], r[2]); if (!cv[kk]) cv[kk] = [0, 0]; cv[kk][0] += r[3]; cv[kk][1] += r[4]; }
  const nodes = selNodes(), mx = Math.max(1, ...Object.values(cv).map(x => x[0]));
  h = '<div class="scroll"><table class="grid" style="font-size:12px"><tr><th></th>' + nodes.map(n => `<th>${n}</th>`).join('') + '</tr>';
  for (const a of nodes) {
    h += `<tr><th style="text-align:right">${a}</th>`;
    for (const b of nodes) {
      if (a === b) { h += '<td style="background:#f3f4f6;min-width:96px">—</td>'; continue; }
      const x = cv[key(a, b)] || [0, 0], al = (0.05 + 0.9 * Math.sqrt(x[0] / mx));
      h += `<td style="min-width:96px;height:32px;background:rgba(5,150,105,${al.toFixed(2)});color:${al > 0.5 ? '#fff' : '#111'}" title="${a}×${b}: ${fmt(x[0])}人（うち寄り道あり ${fmt(x[1])}人）">${fmt(x[0])}<br><span style="font-size:10px;opacity:.8">(${fmt(x[1])})</span></td>`;
    }
    h += '</tr>';
  }
  sec.insertAdjacentHTML('beforeend', h + '</table></div>');
}

// ---------------------------------------------------------------- ノード間移動
function tabMoves(p) {
  head(p, 'ノード間移動', [...dtButtons(), lbl(' '), btn('1分未満を除く', S.skip1, () => { S.skip1 = !S.skip1; render(); })]);
  p.appendChild(el('p', 'note', '同じ端末が60分以内に別の拠点で見えたら「移動」（車・動かない機器除く）。<b>1分未満の移動</b>は、隣り合う拠点が同じ人を同時に拾っただけのことが多いので、初期状態では除いている。行＝出発、列＝到着。'));
  const nodes = selNodes(), M = {};
  for (const r of D.moves) {
    if (r[0] < S.from || r[0] > S.to || !inDt(r[0])) continue;
    const k = r[1] + '→' + r[2]; if (!M[k]) M[k] = { from: r[1], to: r[2], n: 0, n1: 0, medw: 0 };
    M[k].n += r[3]; M[k].n1 += r[4]; M[k].medw += r[5] * r[3];
  }
  const val = x => x ? (S.skip1 ? x.n - x.n1 : x.n) : 0;
  const mx = Math.max(1, ...Object.values(M).filter(x => S.sel.has(x.from) && S.sel.has(x.to)).map(val));
  let h = '<div class="scroll"><table class="grid" style="font-size:12px"><tr><th>出発＼到着</th>' + nodes.map(n => `<th>${n}</th>`).join('') + '</tr>';
  for (const a of nodes) {
    h += `<tr><th style="text-align:right">${a}</th>`;
    for (const b of nodes) {
      if (a === b) { h += '<td style="background:#f3f4f6;min-width:90px">—</td>'; continue; }
      const x = M[a + '→' + b], v = val(x), al = 0.05 + 0.9 * Math.sqrt(v / mx);
      h += `<td style="min-width:90px;height:30px;background:rgba(37,99,235,${al.toFixed(2)});color:${al > 0.5 ? '#fff' : '#111'}" title="${a}→${b}: ${fmt(v)}件">${fmt(v)}</td>`;
    }
    h += '</tr>';
  }
  p.insertAdjacentHTML('beforeend', h + '</table></div>');

  const sec = el('div', 'sec'); p.appendChild(sec);
  head(sec, '多い流れ');
  sec.appendChild(el('p', 'note', '「逆向き」との比が大きく片寄る組み合わせは、時計のずれや拾い方の違いを疑う（人の流れなら、ふつうは行きと帰りがある程度そろう）。かかった時間は日ごとの中央値の平均（目安）。'));
  const list = Object.values(M).filter(x => S.sel.has(x.from) && S.sel.has(x.to)).sort((a, b) => val(b) - val(a)).slice(0, 12);
  let t = '<table class="list"><tr><th>流れ</th><th class="r">件数</th><th class="r">逆向き</th><th class="r">1分未満</th><th class="r">かかった時間</th></tr>';
  for (const x of list) {
    const rev = val(M[x.to + '→' + x.from]);
    t += `<tr><td><span style="color:${COLORS[x.from]}">●</span> ${x.from} → <span style="color:${COLORS[x.to]}">●</span> ${x.to}</td><td class="r"><b>${fmt(val(x))}</b></td><td class="r">${fmt(rev)}</td><td class="r">${pct(x.n1, x.n)}%</td><td class="r">${x.n ? Math.round(x.medw / x.n / 60 * 10) / 10 + '分' : '-'}</td></tr>`;
  }
  sec.insertAdjacentHTML('beforeend', t + '</table>');
}

// ---------------------------------------------------------------- 機器チェック
function tabCheck(p) {
  head(p, '拠点ごとのデータの届き方');
  p.appendChild(el('p', 'note', '色＝その日の稼働率（30分枠のうちデータが届いた割合）。記号：▼ 10〜16時が普段の半分未満／▲ 普段の1.8倍超／☾ 夜0〜5時が普段の2倍超。普段＝同じ拠点の平日・休日別の中央値（イベント日を除く）。マウスを乗せると数字が出る。今日の分は途中なので低く出る。' +
    '<span class="lg"><span style="background:#16a34a"></span>95%以上<span style="background:#86efac"></span>80%〜<span style="background:#fde047"></span>60%〜<span style="background:#f87171"></span>60%未満<span style="background:#e5e7eb"></span>データなし</span>'));
  let h = '<div class="scroll"><table class="grid"><tr><th></th>';
  for (let d = S.from; d <= S.to; d++) { const dd = new Date(T0() + d * 864e5).getUTCDate(); h += `<th style="${isOff(d) ? 'color:#2563eb;' : ''}${evName(d) ? 'background:#ffedd5' : ''}">${dd === 1 || d === S.from ? md(d) : dd}</th>`; }
  h += '</tr>';
  for (const k of selNodes()) {
    h += `<tr><th style="text-align:right">${k}</th>`;
    for (let d = S.from; d <= S.to; d++) {
      const r = DAY[k][d], cv = r.cov / 48, f = flags(k, d);
      const bg = r.cov === 0 ? '#e5e7eb' : cv >= 0.95 ? '#16a34a' : cv >= 0.8 ? '#86efac' : cv >= 0.6 ? '#fde047' : '#f87171';
      const sym = (f.includes('low') ? '▼' : '') + (f.includes('high') ? '▲' : '') + (f.includes('night') ? '☾' : '');
      const b = isOff(d) ? BASE[k].off : BASE[k].on;
      h += `<td style="background:${bg};color:${cv >= 0.95 ? '#fff' : '#111'}" title="${k} ${mdw(d)}${evName(d) ? ' ' + evName(d) : ''}&#10;稼働率 ${Math.round(cv * 100)}%&#10;10〜16時 ${fmt(r.day)}（普段 ${b == null ? '-' : fmt(b)}）&#10;夜0〜5時 ${r.night == null ? '-' : r.night.toFixed(1)}/30分（普段 ${BASE[k].night == null ? '-' : BASE[k].night.toFixed(1)}）">${sym}</td>`;
    }
    h += '</tr>';
  }
  p.insertAdjacentHTML('beforeend', h + '</table></div>');
}


// ---------------------------------------------------------------- 日報
const WMO = c => c == null ? '' : c === 0 ? '快晴' : c <= 2 ? '晴れ' : c === 3 ? 'くもり' : c <= 48 ? '霧' : c <= 57 ? '霧雨' : c <= 67 ? '雨' : c <= 77 ? '雪' : c <= 82 ? 'にわか雨' : c <= 86 ? 'にわか雪' : '雷雨';
const WICON = c => c == null ? '' : c <= 1 ? '☀️' : c <= 3 ? '⛅' : c <= 48 ? '🌫' : c <= 67 ? '☔' : c <= 77 ? '❄️' : c <= 82 ? '🌦' : c <= 86 ? '❄️' : '⛈';
const esc = t => String(t == null ? '' : t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sgn = x => (x >= 0 ? '+' : '−') + Math.abs(Math.round(x)) + '%';

// 比べる相手：平日は同じ曜日、土日祝は土日祝。イベント日・データが欠けた日・今日は除いて直近4日
function repBase(d, ok) {
  const off = isOff(d), out = [];
  for (let j = d - 1; j >= 0 && out.length < 4; j--) {
    if (evName(j) || !ok(j)) continue;
    if (off ? isOff(j) : (!isOff(j) && dow(j) === dow(d))) out.push(j);
  }
  return out;
}
// 朝の予報文から周辺施設の行を抜く。「まちなか図書館：…」「em-campus（FOOD）：…」のように施設名で始まる行だけ。
// 見つからない日は、施設名を含む行をそのまま（予報の書き方は日によって違うため）
function venueLines(msg) {
  const KW = /まちなか図書館|em-?campus|エムキャンパス/i;
  const ls = msg.split('\n').map(x => x.replace(/\*\*/g, '').replace(/^[\s・\-•]+/, '').trim()).filter(Boolean);
  const head = ls.filter(x => { const m = x.match(KW); return m && m.index <= 3 && x.length < 200; });
  const out = head.length ? head : ls.filter(x => KW.test(x) && x.length < 120);
  return [...new Set(out)].slice(0, 6);
}
function tabReport(p) {
  const last = NDAY - 1;
  if (S.rep == null || S.repTo !== S.to || S.rep > last) { S.rep = Math.min(S.to, last); S.repTo = S.to; }  // 期間を変えたら最後の日に合わせる
  const d = S.rep, nodes = selNodes(), C = D.ctx || {};
  const c = [btn('◀ 前の日', false, () => { S.rep = Math.max(0, d - 1); render(); }), btn('次の日 ▶', false, () => { S.rep = Math.min(last, d + 1); render(); })];
  const cp = btn('文章をコピー', false, () => { navigator.clipboard.writeText(text.join('\n')).then(() => { cp.textContent = 'コピーしました'; }); });
  c.push(cp);
  head(p, '日報　' + mdw(d) + (d === last ? '（今日・' + D.generated.slice(11, 16) + 'まで）' : ''), c);

  const R = roamRows(), sum = (j, col) => R.reduce((a, r) => a + (r[0] === j ? r[col] : 0), 0);
  // 全体の比較：どの拠点も0枠ではなく、全体で85%以上届いた日。拠点ごとの比較：その拠点が38枠以上届いた日
  const full = j => nodes.every(k => DAY[k][j].cov > 0) && nodes.reduce((a, k) => a + DAY[k][j].cov, 0) >= nodes.length * 48 * 0.85;
  const base = repBase(d, j => full(j) && j < last);
  const avgOf = (b, f) => b.length ? b.reduce((a, j) => a + f(j), 0) / b.length : null;
  const avg = f => avgOf(base, f);
  const vis = sum(d, 2), roam = sum(d, 3), walk = sum(d, 5), stopR = sum(d, 6), bv = avg(j => sum(j, 2));
  const tot = (k, j) => D.catDay[k].pass[j] + D.catDay[k].stop[j] + D.catDay[k].long[j];
  const stay = (k, j) => D.catDay[k].stop[j] + D.catDay[k].long[j];
  const allT = nodes.reduce((a, k) => a + tot(k, d), 0), allS = nodes.reduce((a, k) => a + stay(k, d), 0);
  let pk = -1, pv = -1; for (let h = 0; h < 24; h++) { const v = R.reduce((a, r) => a + (r[0] === d && r[1] === h ? r[2] : 0), 0); if (v > pv) { pv = v; pk = h; } }
  const tag = [isOff(d) ? (HOL.has(dayStr(d)) ? '祝日' : '休日') : '平日', !isOff(d) && d > 0 && HOL.has(dayStr(d - 1)) ? '祝日明け' : '', evName(d)].filter(Boolean).join('・');
  const cmpWord = isOff(d) ? '最近の土日祝' : '同じ曜日';
  const text = [], html = [];
  const line = (h, t) => { html.push(h); text.push(t == null ? h.replace(/<[^>]+>/g, '') : t); };

  text.push('【水上ビル 人流日報】' + mdw(d) + '（' + tag + '）' + (curArea() !== 'all' ? '　' + areaLabel() : ''));
  // 天気
  const w = (C.weather || {})[d];
  const wTxt = w ? `${WICON(w[5])} ${WMO(w[5])}　最高 ${w[0]}℃／最低 ${w[1]}℃` + (w[2] > 0 ? `　雨 ${w[2]}mm（${w[3]}時間）` : '　雨なし') + (w[4] != null ? `　風 最大${w[4]}m/s` : '') : '天気データなし';
  // 人流
  const diff = bv ? (vis / bv - 1) * 100 : null;
  html.push('<div class="rep-lead"><div class="rep-num">' + fmt(vis) + '<span>人</span></div><div>' +
    (diff == null ? '比べる日がありません' : `${cmpWord}の平均（${fmt(bv)}人）より <b class="${diff >= 0 ? 'up' : 'down'}">${sgn(diff)}</b>`) +
    `<div class="note" style="margin:2px 0 0">${tag}　${wTxt}</div></div></div>`);
  text.push('天気：' + wTxt.replace(/^\S+ /, ''));
  text.push('来た人：' + fmt(vis) + '人' + (diff == null ? '' : `（${cmpWord}の平均${fmt(bv)}人より${sgn(diff)}）`));

  const ul = [];
  const li = (h, t) => { ul.push('<li>' + h + '</li>'); text.push('・' + (t || h.replace(/<[^>]+>/g, ''))); };
  li(`来た人がいちばん多かった時間：<b>${pk}時</b>（${fmt(pv)}人）`);
  li(`立ち寄り率：<b>${pct(allS, allT)}%</b>（1分以上いた人の割合）`);
  li(`回遊：<b>${fmt(roam)}人（${pct(roam, vis)}%）</b>　うち通り抜け ${fmt(walk)}人・寄り道回遊 ${fmt(stopR)}人`);
  // 拠点ごとの増減（平均との差が大きい順に）
  const rows = nodes.map(k => { const b = avgOf(repBase(d, j => DAY[k][j].cov >= 38 && j < last), j => tot(k, j)); return { k, v: tot(k, d), b, r: b ? (tot(k, d) / b - 1) * 100 : null, cov: DAY[k][d].cov }; });
  const big = rows.filter(x => x.r != null && Math.abs(x.r) >= 25 && x.cov >= 38).sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
  if (big.length) li('目立った拠点：' + big.slice(0, 3).map(x => `${x.k} <b class="${x.r >= 0 ? 'up' : 'down'}">${sgn(x.r)}</b>`).join('、'));
  const gaps = rows.filter(x => x.cov < 38);
  if (gaps.length) li('⚠️ データの欠け：' + gaps.map(x => `${x.k}（48枠中${x.cov}枠）`).join('、') + ' → この拠点の数字は少なめに出ています');
  html.push('<ul class="rep-ul">' + ul.join('') + '</ul>');

  // イベント・店・メンテ
  const sec = (title, items) => { if (!items.length) return; html.push(`<div class="rep-sec"><b>${title}</b><ul class="rep-ul">${items.map(x => '<li>' + x + '</li>').join('')}</ul></div>`); text.push(title); items.forEach(x => text.push('・' + x.replace(/<[^>]+>/g, ''))); };
  const evs = ((C.events || {})[d] || []).map(e => esc(e.t) + (e.loc ? '（' + esc(e.loc) + '）' : '') + (e.h ? ' ' + esc(e.h) : '') + (e.note ? '　<span class="note">' + esc(e.note) + '</span>' : ''));
  if (evName(d) && !evs.some(x => x.includes(evName(d)))) evs.unshift(esc(evName(d)));
  sec('📅 イベント', evs);
  const sh = (C.shop || {})[d] || [];
  const shTxt = e => `<b>${esc(e.shop)}</b>${e.scope === '水上ビル外' && e.venue ? '＠' + esc(e.venue) : ''}：${esc(e.title)}${e.time ? ' ' + esc(e.time) : ''}` +
    (e.sum ? `<br><span class="note">${esc(e.sum)}</span>` : '') + (/^https:\/\//i.test(e.url || '') ? ` <a href="${esc(e.url)}" target="_blank" rel="noopener" class="note">Instagram</a>` : '');
  sec('🏢 水上ビルのお店のイベント', sh.filter(e => e.scope === '水上ビル内' && e.kind !== '臨時休業').map(shTxt));
  sec('🚚 お出かけ先のお店', sh.filter(e => e.scope === '水上ビル外').map(e => shTxt(e) + (e.open ? '（お店は' + esc(e.open) + '）' : '')));
  // 周辺施設（まちなか図書館・em-campus）：朝のひと気予報の文中から、その段落を抜き出す
  const pr0 = ((C.pred || {})[d] || [])[0] || '';
  sec('🏛 周辺施設（まちなか図書館・em-campus）', venueLines(pr0).map(esc));
  sec('🔒 お休み・短縮', sh.filter(e => e.open === '休業' || e.open === '短縮').map(e => `<b>${esc(e.shop)}</b>：${esc(e.open)}${e.title ? '（' + esc(e.title) + '）' : ''}`));
  sec('🔧 機器のメンテ', ((C.maint || {})[d] || []).map(esc));

  // 拠点の表
  let t = '<div class="rep-sec"><b>拠点ごと</b><table class="list"><tr><th>拠点</th><th class="r">来た人</th><th class="r">' + cmpWord + 'の平均</th><th class="r">差</th><th class="r">立ち寄り率</th><th class="r">データ</th></tr>';
  for (const x of rows) t += `<tr><td><span class="dot" style="background:${COLORS[x.k]}"></span>${x.k}</td><td class="r">${fmt(x.v)}</td><td class="r">${x.b == null ? '-' : fmt(x.b)}</td><td class="r ${x.r == null ? '' : x.r >= 0 ? 'up' : 'down'}">${x.r == null ? '-' : sgn(x.r)}</td><td class="r">${pct(stay(x.k, d), x.v)}%</td><td class="r">${x.cov < 38 ? '⚠️ ' : ''}${Math.round(x.cov / 48 * 100)}%</td></tr>`;
  html.push(t + '</table><p class="note">拠点ごとの「来た人」は素通り＋立ち寄り＋15分以上（車・動かない機器を除く）。拠点をまたぐ重複は除いていないので、合計は上の来た人より多くなります。全体で比べた日：' + (base.length ? base.map(mdw).join('、') : 'なし') + '（拠点ごとの平均は、その拠点のデータがそろった日で計算）</p></div>');

  // 朝の予報
  const pr = (C.pred || {})[d];
  if (pr && (pr[0] || pr[1])) html.push('<details class="rep-sec"><summary><b>☀️ この日の朝のひと気予報</b>（ひと気予報Botの投稿）</summary>' +
    (pr[0] ? '<pre class="rep-pre">' + esc(pr[0]) + '</pre>' : '') + (pr[1] ? '<b class="note">開店案内・お店イベント</b><pre class="rep-pre">' + esc(pr[1]) + '</pre>' : '') + '</details>');
  if (!D.ctx) html.push('<p class="note">天気・イベント・お店の情報は、次の集計（6時・12時・18時）から載ります。</p>');

  p.insertAdjacentHTML('beforeend', '<div class="rep">' + html.join('') + '</div>');
}



// ---------------------------------------------------------------- 拠点マップ（緯度経度のバブル。期間・拠点・平日/土日の選択に連動）
let LEAF = null;
function loadLeaflet() {
  if (LEAF) return LEAF;
  LEAF = new Promise((ok, ng) => {
    const c = document.createElement('link'); c.rel = 'stylesheet'; c.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css'; c.integrity = 'sha512-h9FcoyWjHcOcmEVkxOfTLnmZFWIH0iZhZT1H2TbOq55xssQGEJHEaIm+PgoUaZbRvQTNTluNOEfb1ZRy6D3BOw=='; c.crossOrigin = 'anonymous'; c.referrerPolicy = 'no-referrer'; document.head.appendChild(c);
    const j = document.createElement('script'); j.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js'; j.integrity = 'sha512-puJW3E/qXDqYp9IfhAI54BJEaWIfloJ7JWs7OeD5i6ruC9JZL1gERT1wjtwXFlh7CjE7ZJ+/vcRZRkIYIb6p4g=='; j.crossOrigin = 'anonymous'; j.referrerPolicy = 'no-referrer'; j.onload = ok; j.onerror = ng; document.head.appendChild(j);
  });
  return LEAF;
}
function tabBubble(p) {
  const M = [['vis', '来た人'], ['stay', '立ち寄り'], ['rate', '立ち寄り率']];
  head(p, '拠点マップ', [...dtButtons(), lbl(' 大きさ:'), ...M.map(([k, l]) => btn(l, S.bm === k, () => { S.bm = k; render(); })), lbl(' '), btn('移動の線', S.flow, () => { S.flow = !S.flow; render(); })]);
  const L0 = D.locs || {}, nodes = selNodes().filter(k => L0[k]);
  const miss = selNodes().filter(k => !L0[k]);
  p.appendChild(el('p', 'note', (S.agg === 'sum' ? '円の大きさ＝選んだ期間の延べ人数' : '円の大きさ＝選んだ期間の1日平均') + '（立ち寄り率のときは率）。線＝ノード間移動（1分未満を除く・両方向の合計）で、太いほど多い。円や線にマウスを乗せると数字が出ます。' +
    (miss.length ? '<br>位置が登録されていない拠点：' + miss.join('、') + '（BigQuery の device_locations に緯度経度を足すと出ます）' : '')));
  if (!Object.keys(L0).length) { p.appendChild(el('div', 'empty', '拠点の位置データがまだありません（次の集計から入ります）')); return; }
  const box = el('div', 'bubblemap'); p.appendChild(box);
  const days = rangeDays().filter(inDt), nd = Math.max(1, days.length);
  const val = {};
  for (const k of nodes) {
    let t = 0, st = 0; for (const d of days) { const c = D.catDay[k]; t += c.pass[d] + c.stop[d] + c.long[d]; st += c.stop[d] + c.long[d]; }
    const dv = S.agg === 'sum' ? 1 : nd;
    val[k] = { vis: t / dv, stay: st / dv, rate: t ? st / t * 100 : 0 };
  }
  const mx = Math.max(1e-9, ...nodes.map(k => val[k][S.bm]));
  loadLeaflet().then(() => {
    if (!box.isConnected) return;
    const L = window.L;
    const map = L.map(box, { scrollWheelZoom: false });
    // CARTOの無料タイルは鍵が要るようになった（2026-09）ので OpenStreetMap を薄くして使う
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, className: 'bm-tiles', attribution: '© OpenStreetMap contributors' }).addTo(map);
    if (S.mapView) map.setView(S.mapView[0], S.mapView[1]); else map.fitBounds(nodes.map(k => L0[k]), { padding: [60, 60], maxZoom: 18 });
    map.on('moveend', () => { S.mapView = [map.getCenter(), map.getZoom()]; });
    if (S.flow) {
      const F = {};
      for (const r of D.moves) {
        if (r[0] < S.from || r[0] > S.to || !inDt(r[0]) || !L0[r[1]] || !L0[r[2]] || !S.sel.has(r[1]) || !S.sel.has(r[2])) continue;
        const key = [r[1], r[2]].sort().join('|'); F[key] = F[key] || { a: 0, b: 0 };
        F[key][r[1] < r[2] ? 'a' : 'b'] += r[3] - r[4];
      }
      const fm = Math.max(1, ...Object.values(F).map(x => x.a + x.b));
      Object.entries(F).sort((x, y) => (x[1].a + x[1].b) - (y[1].a + y[1].b)).forEach(([key, x]) => {
        const [a, b] = key.split('|'), n = x.a + x.b; if (!n) return;
        L.polyline([L0[a], L0[b]], { color: '#475569', weight: 1 + 11 * n / fm, opacity: 0.25 + 0.45 * n / fm })
          .bindTooltip(`${a}→${b}：${fmt(x.a / nd)}人/日<br>${b}→${a}：${fmt(x.b / nd)}人/日`, { sticky: true }).addTo(map);
      });
    }
    for (const k of nodes) {
      const v = val[k], r = 8 + 42 * Math.sqrt(v[S.bm] / mx);
      L.circleMarker(L0[k], { radius: r, color: '#fff', weight: 2, fillColor: COLORS[k], fillOpacity: 0.72 })
        .bindTooltip(`<b>${k}</b><br>来た人 ${fmt(v.vis)}人${S.agg === 'sum' ? '（延べ）' : '/日'}<br>立ち寄り ${fmt(v.stay)}人${S.agg === 'sum' ? '' : '/日'}（${v.rate.toFixed(1)}%）`, { direction: 'top' })
        .addTo(map);
      L.marker(L0[k], { icon: L.divIcon({ className: 'bm-label', html: `<span>${k}<br><b>${S.bm === 'rate' ? v.rate.toFixed(1) + '%' : fmt(v[S.bm])}</b></span>`, iconSize: [0, 0] }), interactive: false }).addTo(map);
    }
  }).catch(() => { box.innerHTML = '<div class="err">地図の部品を読み込めませんでした</div>'; });
}

// ---------------------------------------------------------------- 地図（Visitor Flow Intelligence を埋め込む）
// 開いたときだけ読み込み、画面の再描画では作り直さない（地図が毎回読み直しにならないように）
const MAP_URL = 'https://takashi440.github.io/mizunoue-data-center/';
let MAP_FRAME = null;
function tabMap(p) {
  head(p, '地図で見る人の流れ（Visitor Flow Intelligence）', [el('a', 'b', '全画面で開く ↗')]);
  const a = p.querySelector('.head a'); a.href = MAP_URL; a.target = '_blank'; a.rel = 'noopener'; a.style.textDecoration = 'none';
  p.appendChild(el('p', 'note', '拠点の円の大きさ＝人数、線＝拠点の間の流れ。時間ごとの再生や音の機能もあります（音はページ内のボタンで鳴らしたときだけ）。このタブの上の期間・エリアの選択は地図には反映されません。'));
  // 地図は #pane の外に1つだけ置き、表示・非表示を切り替える（DOMから外すと読み込み直しになるため）
  if (!MAP_FRAME) {
    MAP_FRAME = document.createElement('iframe');
    MAP_FRAME.src = MAP_URL; MAP_FRAME.className = 'mapframe'; MAP_FRAME.title = 'Visitor Flow Intelligence';
    MAP_FRAME.allow = 'autoplay; fullscreen';
    $('pane').after(MAP_FRAME);
  }
}

// ---------------------------------------------------------------- 描画
function render() {
  renderControls(); renderKpis();
  const p = $('pane'); p.innerHTML = ''; hideTip();
  if (MAP_FRAME) MAP_FRAME.style.display = TABS[S.tab] === '地図' ? '' : 'none';
  if (!selNodes().length) { p.innerHTML = '<div class="empty">拠点を1つ以上選んでください</div>'; return; }
  [tabDaily, tabReport, tabSeries, tabStay, tabHeat, tabRoam, tabMoves, tabCheck, tabBubble, tabMap][S.tab](p);
}
boot();
