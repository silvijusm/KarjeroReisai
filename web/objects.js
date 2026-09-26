// Contractor sites (objects): settings, carriers, live vehicles, loads, waybills.
// Carrier companies see the sites they joined and the same load numbers.
import { doc, collection, onSnapshot, query, where, getDocs, setDoc, updateDoc } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { invoiceForm } from './invoices.js';

let ctx; // helpers from app.js
let unsub = [];
let omap = null;
const stop = () => { unsub.forEach(u => u()); unsub = []; if (omap) { omap.remove(); omap = null; } };

export function pageObjects(main, c) {
  ctx = c; stop();
  const { h, t, state } = ctx;
  const page = h('div', { class: 'page' });
  main.append(page);
  const mine = h('div', { class: 'card' }, h('h2', {}, t('myObjects')), h('div', { class: 'muted' }, t('loading')));
  const carrierCard = h('div', { class: 'card' });
  page.append(mine, carrierCard);
  unsub.push(onSnapshot(collection(ctx.db, 'companies', state.companyId, 'objects'), snap => {
    const list = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.status > b.status) - (a.status < b.status) || a.name.localeCompare(b.name));
    mine.replaceChildren(h('div', { class: 'row', style: 'justify-content:space-between' }, h('h2', {}, t('myObjects')),
      ctx.isAdmin() ? h('button', { class: 'primary', onclick: () => openObject(main, null) }, t('newObject')) : null),
      h('p', { class: 'muted' }, t('objectsIntro')),
      list.length ? h('table', {}, h('tbody', {}, list.map(o => h('tr', { style: 'cursor:pointer', onclick: () => openObject(main, o.id) },
        h('td', {}, h('b', {}, o.name), o.objectCode ? ` (${o.objectCode})` : ''), h('td', {}, `${o.quarryName || '—'} → ${o.unloadName || '—'}`),
        h('td', { class: 'num' }, `${ctx.fmt1(o.distanceKm)} km`), h('td', {}, h('span', { class: 'pill' }, t('status_' + o.status)))))))
        : h('p', { class: 'muted' }, t('noObjectsYet')));
  }));
  renderCarrierSide(carrierCard);
}

// ---------- carrier side: sites my company works on ----------
function renderCarrierSide(card) {
  const { h, t, state, call } = ctx;
  const code = h('input', { placeholder: 'OB-7F3K9Q', style: 'text-transform:uppercase' });
  const msg = h('span', { class: 'muted' });
  const list = h('div');
  card.replaceChildren(h('h2', {}, t('sitesIWork')), h('p', { class: 'muted' }, t('sitesIWorkIntro')),
    ctx.isAdmin() ? h('div', { class: 'row' }, code, h('button', { class: 'blue', onclick: async () => {
      msg.textContent = '';
      try { const r = await call('joinObject', { code: code.value.trim() }); code.value = ''; msg.textContent = t('joinSent', r.objectName); }
      catch (e) { msg.textContent = e.code === 'functions/not-found' ? t('wrongObjectCode') : e.code === 'functions/already-exists' ? t('alreadyJoined') : t('actionFailed'); }
    } }, t('joinObject')), msg) : null, list);
  unsub.push(onSnapshot(collection(ctx.db, 'companies', state.companyId, 'objectLinks'), snap => {
    const links = snap.docs.map(d => ({ objectId: d.id, ...d.data() }));
    list.replaceChildren(links.length ? h('table', {}, h('tbody', {}, links.map(l => h('tr', {},
      h('td', {}, h('b', {}, l.objectName), l.objectCode ? ` (${l.objectCode})` : ''), h('td', {}, l.contractorName),
      h('td', {}, h('span', { class: 'pill' }, t('link_' + l.status))),
      h('td', { class: 'num' }, l.status === 'active' ? h('button', { onclick: () => carrierLoads(l) }, t('loads')) : ''))))) : h('p', { class: 'muted' }, t('noSites')));
  }));
}

// Carrier sees the same loads as the contractor (for invoicing).
async function carrierLoads(link) {
  const { h, t, state } = ctx;
  const dlg = modal(h('h2', {}, `${link.objectName} – ${link.contractorName}`));
  const range = rangeInputs();
  const out = h('div');
  const run = async () => {
    out.replaceChildren(h('div', { class: 'muted' }, t('loading')));
    try {
      const snap = await getDocs(query(collection(ctx.db, 'companies', link.contractorId, 'objects', link.objectId, 'loads'),
        where('carrierId', '==', state.companyId), where('loadedAtMillis', '>=', range.from()), where('loadedAtMillis', '<', range.to())));
      const loads = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(l => l.status !== 'cancelled').sort((a, b) => a.loadedAtMillis - b.loadedAtMillis);
      const canInvoice = state.company?.ownerUid === state.user.uid;
      const invoiceBox = h('div');
      out.replaceChildren(summaryTable(loads, 'plate'), loadsTable(loads, null),
        h('div', { class: 'row', style: 'margin-top:8px' }, csvButton(loads, `${link.objectName}`),
          canInvoice ? h('button', { class: 'primary', onclick: () => invoiceBox.replaceChildren(invoiceForm(ctx, link, loads, range.label(), range.from(), range.to())) }, ctx.t('issueInvoiceBtn')) : null),
        invoiceBox);
    } catch (e) { console.error(e); out.replaceChildren(h('div', { class: 'err' }, t('loadFailed'))); }
  };
  dlg.append(h('div', { class: 'row' }, range.el, h('button', { class: 'primary', onclick: run }, t('show'))), out);
  run();
}

// ---------- contractor side: one site ----------
function openObject(main, id) {
  const { h, t, state } = ctx;
  stop();
  main.replaceChildren();
  const page = h('div', { class: 'page' });
  main.append(page);
  const back = h('button', { onclick: () => { stop(); main.replaceChildren(); pageObjects(main, ctx); } }, '← ' + t('back'));
  if (!id) { page.append(back, objectForm(null)); return; }
  const header = h('div', { class: 'card' });
  const tabs = h('div', { class: 'row noprint' });
  const body = h('div');
  page.append(back, header, tabs, body);
  let object = null, tab = 'loads';
  const ref = doc(ctx.db, 'companies', state.companyId, 'objects', id);
  const show = () => {
    tabs.replaceChildren(...['loads', 'live', 'carriers', 'settings'].map(k => h('button', { class: tab === k ? 'blue' : '', onclick: () => { tab = k; show(); } }, t('tab_' + k))));
    if (omap) { omap.remove(); omap = null; }
    body.replaceChildren();
    ({ loads: tabLoads, live: tabLive, carriers: tabCarriers, settings: () => body.append(objectForm(object)) })[tab](body, object);
  };
  unsub.push(onSnapshot(ref, snap => {
    const first = !object;
    object = { id: snap.id, ...snap.data() };
    header.replaceChildren(h('h2', {}, object.name, object.objectCode ? ` (${object.objectCode})` : ''),
      h('div', { class: 'muted' }, `${object.quarryName || '—'} → ${object.unloadName || '—'} · ${ctx.fmt1(object.distanceKm)} km · ${t('status_' + object.status)}`),
      joinCodeRow(object));
    if (first) show();
  }));
}

function joinCodeRow(object) {
  const { h, t, call } = ctx;
  if (!ctx.isAdmin()) return null;
  const code = h('b', { class: 'code', style: 'font-size:22px' }, object.joinCode || '—');
  return h('div', { class: 'row', style: 'margin-top:8px' }, t('objectJoinCode'), code,
    h('button', { onclick: async () => {
      if (object.joinCode) { navigator.clipboard?.writeText(code.textContent); return; }
      try { code.textContent = (await call('objectJoinCode', { objectId: object.id })).code; } catch { code.textContent = '!'; }
    } }, object.joinCode ? t('copy') : t('createCode')),
    object.joinCode ? h('button', { onclick: async () => { if (confirm(t('newCodeConfirm'))) code.textContent = (await call('objectJoinCode', { objectId: object.id, regenerate: true })).code; } }, t('newCode')) : null,
    h('span', { class: 'muted' }, t('objectCodeHint')));
}

function tabCarriers(body, object) {
  const { h, t, state, call } = ctx;
  const card = h('div', { class: 'card' }, h('div', { class: 'muted' }, t('loading')));
  body.append(card);
  unsub.push(onSnapshot(collection(ctx.db, 'companies', state.companyId, 'objects', object.id, 'carriers'), snap => {
    const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    card.replaceChildren(h('h2', {}, t('carriers')), list.length ? h('table', {}, h('tbody', {}, list.map(c => h('tr', {},
      h('td', {}, h('b', {}, c.carrierName)), h('td', {}, h('span', { class: 'pill' }, t('link_' + c.status))),
      h('td', { class: 'num' }, ctx.isAdmin() ? h('div', { class: 'row', style: 'justify-content:flex-end' },
        c.status !== 'active' ? h('button', { class: 'primary', onclick: () => call('approveCarrier', { objectId: object.id, carrierId: c.id }) }, t('approve')) : null,
        c.status !== 'removed' ? h('button', { class: 'danger', onclick: () => confirm(t('removeCarrierConfirm', c.carrierName)) && call('removeCarrier', { objectId: object.id, carrierId: c.id }) }, t('remove')) : null) : ''))))) : h('p', { class: 'muted' }, t('noCarriers')));
  }));
}

// Loads vs trips: a truck may be one load ahead (driving to unload); otherwise it is an error.
export function loadCheck(loads, trips) {
  const d = loads - trips;
  return d === 0 ? 'ok' : d === 1 ? 'transit' : d > 1 ? 'moreLoads' : 'moreTrips';
}
const isErr = c => c === 'moreLoads' || c === 'moreTrips';

function tabLive(body, object) {
  const { h, t, state } = ctx;
  const el = h('div', { style: 'height:520px;border-radius:10px' });
  const list = h('div');
  body.append(h('div', { class: 'card' }, el, h('p', { class: 'muted' }, t('mapLegend'))), h('div', { class: 'card' }, h('h2', {}, t('loadsVsTrips')), list));
  omap = L.map(el).setView(object.quarryLat ? [object.quarryLat, object.quarryLng] : [55.3, 23.9], object.quarryLat ? 13 : 7);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(omap);
  const pts = L.layerGroup().addTo(omap);
  if (object.quarryLat) L.circle([object.quarryLat, object.quarryLng], { radius: object.quarryRadiusM || 300, color: '#e8740c' }).bindTooltip(object.quarryName || t('quarry')).addTo(omap);
  if (object.unloadLat) L.circle([object.unloadLat, object.unloadLng], { radius: object.unloadRadiusM || 300, color: '#2e7d32' }).bindTooltip(object.unloadName || t('unload')).addTo(omap);
  let live = [], loads = [];
  const today = ctx.dayStart(ctx.ymd(new Date()));
  const draw = () => {
    const now = Date.now();
    const byPlate = new Map();
    loads.filter(l => l.status !== 'cancelled').forEach(l => { const k = String(l.plate).toUpperCase(); byPlate.set(k, [...(byPlate.get(k) || []), l]); });
    const trips = new Map();
    live.filter(v => (v.startedAtMillis || 0) >= today).forEach(v => { const k = String(v.plate).toUpperCase(); trips.set(k, (trips.get(k) || 0) + (v.tripsCount || 0)); });
    const dist = v => object.quarryLat && v.lat != null ? L.latLng(v.lat, v.lng).distanceTo([object.quarryLat, object.quarryLng]) : Infinity;
    pts.clearLayers();
    live.filter(v => v.state !== 'offline' && now - (v.updatedAtMillis || 0) < 30 * 60000 && v.lat != null).forEach(v => {
      const k = String(v.plate).toUpperCase(), n = (byPlate.get(k) || []).length, tr = trips.get(k) || 0, c = loadCheck(n, tr);
      const recent = (byPlate.get(k) || []).some(l => now - l.loadedAtMillis < 10 * 60000);
      const color = isErr(c) ? '#c62828' : recent ? '#1565c0' : dist(v) <= (object.quarryRadiusM || 300) ? '#2e7d32' : '#757575';
      L.marker([v.lat, v.lng], { icon: L.divIcon({ className: '', html: `<div class="plate" style="--c:${color}">${ctx.esc(v.plate)} ${n}/${tr}${isErr(c) ? ' !' : ''}</div>`, iconSize: null }) })
        .bindTooltip(`${ctx.esc(v.plate)} · ${ctx.esc(v.carrierName || '')} · ${ctx.esc(v.driverName || '')}<br>${t('colLoaded')} ${n} · ${t('colTrips')} ${tr} – ${t('check_' + c)}`).addTo(pts);
    });
    const plates = [...new Set([...byPlate.keys(), ...trips.keys()])].filter(Boolean).sort();
    list.replaceChildren(plates.length ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, t('plate')), h('th', {}, t('group_carrierName')), h('th', { class: 'num' }, t('colLoaded')), h('th', { class: 'num' }, t('colTrips')), h('th', {}))),
      h('tbody', {}, plates.map(p => {
        const n = (byPlate.get(p) || []).length, tr = trips.get(p) || 0, c = loadCheck(n, tr);
        const carrier = (byPlate.get(p) || [])[0]?.carrierName || live.find(v => String(v.plate).toUpperCase() === p)?.carrierName || '';
        return h('tr', {}, h('td', {}, h('b', {}, p)), h('td', {}, carrier), h('td', { class: 'num' }, n), h('td', { class: 'num' }, tr),
          h('td', { style: `color:${isErr(c) ? 'var(--err)' : 'var(--ok)'};font-weight:${isErr(c) ? 700 : 400}` }, t('check_' + c)));
      }))) : h('p', { class: 'muted' }, t('noLive')));
  };
  unsub.push(onSnapshot(collection(ctx.db, 'companies', state.companyId, 'objects', object.id, 'live'), snap => { live = snap.docs.map(d => d.data()); draw(); }));
  unsub.push(onSnapshot(query(collection(ctx.db, 'companies', state.companyId, 'objects', object.id, 'loads'), where('loadedAtMillis', '>=', today)), snap => { loads = snap.docs.map(d => d.data()); draw(); }));
  const tick = setInterval(draw, 30000);
  unsub.push(() => clearInterval(tick));
}

// ---------- loads, summaries, edits, waybills ----------
function rangeInputs() {
  const { h, t, ymd, dayStart } = ctx;
  const now = new Date();
  const from = h('input', { type: 'date', value: ymd(now) });
  const to = h('input', { type: 'date', value: ymd(now) });
  return {
    el: h('span', { class: 'row' }, t('from'), from, t('to'), to,
      h('button', { onclick: () => { from.value = ymd(new Date(now.getFullYear(), now.getMonth(), 1)); to.value = ymd(now); } }, t('thisMonth'))),
    from: () => dayStart(from.value), to: () => dayStart(to.value) + 86400000, label: () => `${from.value} – ${to.value}`,
  };
}

function tabLoads(body, object) {
  const { h, t, state } = ctx;
  const range = rangeInputs();
  const group = h('select', {}, ['carrierName', 'plate', 'material'].map(g => h('option', { value: g }, t('group_' + g))));
  const out = h('div');
  let loads = [];
  const run = async () => {
    out.replaceChildren(h('div', { class: 'muted' }, t('loading')));
    try {
      const snap = await getDocs(query(collection(ctx.db, 'companies', state.companyId, 'objects', object.id, 'loads'),
        where('loadedAtMillis', '>=', range.from()), where('loadedAtMillis', '<', range.to())));
      loads = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(l => l.status !== 'cancelled').sort((a, b) => a.loadedAtMillis - b.loadedAtMillis);
      out.replaceChildren(
        h('div', { class: 'card' }, h('h2', {}, `${t('summary')}: ${range.label()}`), summaryTable(loads, group.value),
          h('div', { class: 'row noprint', style: 'margin-top:8px' }, csvButton(loads, object.name), h('button', { onclick: () => printWaybills(object, loads) }, t('waybills')), h('button', { onclick: () => window.print() }, t('exportPdf')))),
        h('div', { class: 'card' }, h('h2', {}, t('loads')), loadsTable(loads, object)));
    } catch (e) { console.error(e); out.replaceChildren(h('div', { class: 'err' }, t('loadFailed'))); }
  };
  body.append(h('div', { class: 'card row noprint' }, range.el, group, h('button', { class: 'primary', onclick: run }, t('show'))), out);
  run();
}

function summaryTable(loads, key) {
  const { h, t, fmt1 } = ctx;
  const m = new Map();
  loads.forEach(l => { const k = l[key] || '—'; const r = m.get(k) || { n: 0, t: 0, m3: 0, tkm: 0 }; r.n++; r.t += l.tonnes || 0; r.m3 += l.m3 || 0; r.tkm += (l.tonnes || 0) * (l.distanceKm || 0); m.set(k, r); });
  const rows = [...m].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const tot = rows.reduce((a, [, r]) => ({ n: a.n + r.n, t: a.t + r.t, m3: a.m3 + r.m3, tkm: a.tkm + r.tkm }), { n: 0, t: 0, m3: 0, tkm: 0 });
  if (!rows.length) return h('p', { class: 'muted' }, t('noTrips'));
  return h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, t('group_' + key)), h('th', { class: 'num' }, t('trips')), h('th', { class: 'num' }, t('tonnes')), h('th', { class: 'num' }, 'm³'), h('th', { class: 'num' }, 't·km'))),
    h('tbody', {}, rows.map(([k, r]) => h('tr', {}, h('td', {}, k), h('td', { class: 'num' }, r.n), h('td', { class: 'num' }, fmt1(r.t)), h('td', { class: 'num' }, fmt1(r.m3)), h('td', { class: 'num' }, fmt1(r.tkm))))),
    h('tfoot', {}, h('tr', {}, h('td', {}, t('total')), h('td', { class: 'num' }, tot.n), h('td', { class: 'num' }, fmt1(tot.t)), h('td', { class: 'num' }, fmt1(tot.m3)), h('td', { class: 'num' }, fmt1(tot.tkm)))));
}

function loadsTable(loads, object) {
  const { h, t, fmt1, hhmm, lang } = ctx;
  if (!loads.length) return h('p', { class: 'muted' }, t('noTrips'));
  const canEdit = object && ['company_admin', 'super_admin', 'dispatcher'].includes(ctx.state.role);
  return h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, t('date')), h('th', {}, t('time')), h('th', {}, t('plate')), h('th', {}, t('group_carrierName')),
    h('th', {}, t('group_material')), h('th', { class: 'num' }, 't'), h('th', { class: 'num' }, 'km'), h('th', {}, t('driverStatus')), h('th', {}, t('loaderCol')), canEdit ? h('th', { class: 'noprint' }) : null)),
    h('tbody', {}, loads.map(l => h('tr', {}, h('td', {}, new Date(l.loadedAtMillis).toLocaleDateString(lang())), h('td', {}, hhmm(l.loadedAtMillis)), h('td', {}, h('b', {}, l.plate)),
      h('td', {}, l.carrierName), h('td', {}, l.material), h('td', { class: 'num' }, fmt1(l.tonnes), l.history?.length ? h('span', { title: historyText(l), style: 'color:var(--warn)' }, ' ✎') : ''),
      h('td', { class: 'num' }, fmt1(l.distanceKm)), h('td', {}, t('load_' + (l.status || 'loaded')), l.driverNote ? h('div', { class: 'muted' }, l.driverNote) : ''), h('td', {}, l.loaderName),
      canEdit ? h('td', { class: 'noprint' }, h('button', { onclick: () => editLoad(object, l) }, t('edit'))) : null))));
}

const historyText = l => (l.history || []).map(x => `${new Date(x.at).toLocaleString()} ${x.byName || ''}: ${x.field} ${x.old} → ${x.new} (${x.reason || ''})`).join('\n');

// Contractor correction of tonnes / km: every change kept in history (section 19).
async function editLoad(object, l) {
  const { t, state } = ctx;
  const tonnes = prompt(t('editTonnes', l.plate), String(l.tonnes));
  if (tonnes == null) return;
  const km = prompt(t('editKm'), String(l.distanceKm ?? object.distanceKm ?? 0));
  if (km == null) return;
  const reason = prompt(t('editReason'), '') || '';
  const nt = Number(String(tonnes).replace(',', '.')), nk = Number(String(km).replace(',', '.'));
  if (!(nt >= 0 && nt <= 100) || !(nk >= 0 && nk <= 1000)) { alert(t('actionFailed')); return; }
  const density = (object.materials || []).find(m => m.name === l.material)?.densityTm3 || 1.6;
  const at = Date.now(), by = state.user.uid, byName = state.profile.name || state.user.email;
  const history = [...(l.history || [])];
  if (nt !== l.tonnes) history.push({ at, by, byName, field: 'tonnes', old: l.tonnes, new: nt, reason });
  if (nk !== l.distanceKm) history.push({ at, by, byName, field: 'distanceKm', old: l.distanceKm ?? null, new: nk, reason });
  if (history.length === (l.history || []).length) return;
  try {
    await updateDoc(doc(ctx.db, 'companies', state.companyId, 'objects', object.id, 'loads', l.id),
      { tonnes: nt, m3: nt / density, distanceKm: nk, history, editedBy: by, editedAtMillis: at });
    l.tonnes = nt; l.distanceKm = nk; l.history = history;
    alert(t('saved'));
  } catch (e) { console.error(e); alert(t('actionFailed')); }
}

function csvButton(loads, name) {
  const { h, t } = ctx;
  return h('button', { onclick: () => {
    const sep = ';', num = n => String(Math.round((n || 0) * 100) / 100).replace('.', ',');
    const q = s => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const lines = [[t('date'), t('time'), t('plate'), t('group_carrierName'), t('group_material'), 't', 'm3', 'km', t('driverStatus'), t('loaderCol')].join(sep),
      ...loads.map(l => [new Date(l.loadedAtMillis).toLocaleDateString(ctx.lang()), ctx.hhmm(l.loadedAtMillis), q(l.plate), q(l.carrierName), q(l.material),
        num(l.tonnes), num(l.m3), num(l.distanceKm), q(t('load_' + (l.status || 'loaded'))), q(l.loaderName)].join(sep))];
    const a = h('a', { href: URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })), download: `${name}_krovimai.csv` });
    document.body.append(a); a.click(); a.remove();
  } }, t('exportExcel'));
}

// Electronic cargo waybill laid out like the paper one. One per day + vehicle,
// or one per trip when the distance is over 15 km (rule printed on the paper form).
function printWaybills(object, loads) {
  const { t, fmt1, hhmm, esc } = ctx;
  const groups = new Map();
  for (const l of loads) {
    const day = ctx.ymd(new Date(l.loadedAtMillis));
    const perTrip = (l.distanceKm ?? object.distanceKm ?? 0) > 15;
    const key = perTrip ? `${day}|${l.plate}|${l.id}` : `${day}|${l.carrierId}|${l.plate}`;
    groups.set(key, [...(groups.get(key) || []), l]);
  }
  const party = p => p ? `${esc(p.name || '')}<br>${esc(p.address || '')}<br>${t('companyCodeShort')}: ${esc(p.code || '')} · ${t('vatCode')}: ${esc(p.vat || '')}` : '';
  const pages = [...groups.values()].map((ls, i) => {
    const first = ls[0], last = ls[ls.length - 1];
    const day = new Date(first.loadedAtMillis).toLocaleDateString(ctx.lang());
    const nr = `${esc(object.waybillSeries || 'KR')}-${ctx.ymd(new Date(first.loadedAtMillis)).replace(/-/g, '')}-${i + 1}`;
    const tonnes = ls.reduce((a, l) => a + (l.tonnes || 0), 0), m3 = ls.reduce((a, l) => a + (l.m3 || 0), 0);
    const density = (object.materials || []).find(m => m.name === first.material)?.densityTm3;
    const km = first.distanceKm ?? object.distanceKm ?? 0;
    const confirmed = ls.every(l => l.status === 'confirmed');
    return `<section class="wb">
      <h1>${t('waybillTitle')} Nr. ${nr}</h1>
      <table class="g"><tr><td><b>${t('sender')}</b><br>${party(object.sender)}</td><td><b>${t('receiver')}</b><br>${party(object.receiver)}</td></tr>
      <tr><td>${t('date')}: <b>${day}</b></td><td>${t('objectCodeLabel')}: <b>${esc(object.objectCode || '')}</b></td></tr>
      <tr><td colspan="2">${t('route')}: <b>${esc(object.quarryName || '')} → ${esc(object.unloadName || '')}</b> · ${t('distance')}: <b>${fmt1(km)} km</b></td></tr>
      <tr><td>${t('group_material')}: <b>${esc(first.material)}</b></td><td>${t('density')}: <b>${density ? fmt1(density) + ' t/m³' : ''}</b></td></tr>
      <tr><td>${t('carrierCompany')}: <b>${esc(first.carrierName)}</b></td><td>${t('plate')}: <b>${esc(first.plate)}</b></td></tr>
      <tr><td>${t('firstLoad')}: <b>${hhmm(first.loadedAtMillis)}</b></td><td>${t('lastLoad')}: <b>${hhmm(last.loadedAtMillis)}</b></td></tr></table>
      <table class="t"><thead><tr><th>#</th><th>${t('time')}</th><th>t</th><th>m³</th><th>km</th><th>${t('loaderCol')}</th><th>${t('driverStatus')}</th></tr></thead><tbody>
      ${ls.map((l, j) => `<tr><td>${j + 1}</td><td>${hhmm(l.loadedAtMillis)}</td><td>${fmt1(l.tonnes)}</td><td>${fmt1(l.m3)}</td><td>${fmt1(l.distanceKm ?? km)}</td><td>${esc(l.loaderName)}</td><td>${t('load_' + (l.status || 'loaded'))}</td></tr>`).join('')}
      </tbody><tfoot><tr><td colspan="2">${t('total')}: ${ls.length} ${t('trips').toLowerCase()}</td><td>${fmt1(tonnes)}</td><td>${fmt1(m3)}</td><td colspan="3"></td></tr></tfoot></table>
      <table class="g sig"><tr><td>${t('loadResponsible')}:<br><b>${esc([...new Set(ls.map(l => l.loaderName))].join(', '))}</b><br><small>${t('confirmedElectronically')}</small></td>
      <td>${t('acceptedForTransport')}:<br><b>${confirmed ? t('confirmedByDriver') : '______________________'}</b></td>
      <td>${t('receivedBy')}:<br>______________________<br>______________________</td></tr></table>
      <p class="note">${km > 15 ? t('rule15one') : t('rule15day')}</p>
    </section>`;
  });
  const w = window.open('', '_blank');
  if (!w) { alert(t('allowPopups')); return; }
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${t('waybills')}</title><style>
    body{font-family:Arial,sans-serif;font-size:12px;color:#000;margin:0}
    .wb{page-break-after:always;padding:18mm 14mm}
    h1{font-size:18px;text-align:center;margin:0 0 10px}
    table{width:100%;border-collapse:collapse;margin-bottom:8px}
    td,th{border:1px solid #000;padding:5px;vertical-align:top;text-align:left}
    .t td:nth-child(n+3),.t th:nth-child(n+3){text-align:right}
    .sig td{height:60px;width:33%}
    .note{font-size:11px;font-style:italic}
  </style></head><body>${pages.join('') || `<p style="padding:20px">${t('noTrips')}</p>`}<script>setTimeout(()=>print(),300)<\/script></body></html>`);
  w.document.close();
}

// ---------- site settings form ----------
function objectForm(object) {
  const { h, t, state } = ctx;
  const o = object || { name: '', objectCode: '', status: 'active', materials: [{ name: 'Smėlis', densityTm3: 1.6, tonnesPerTrip: 26 }], quarryRadiusM: 300, unloadRadiusM: 300, distanceKm: 0, gpsWarnPct: 20, allowLoaderOverride: false, vehicleTonnes: {} };
  const inp = (v, attrs = {}) => h('input', { value: v ?? '', ...attrs });
  const f = {
    name: inp(o.name, { required: true, style: 'min-width:260px' }), objectCode: inp(o.objectCode, { placeholder: 'P-256' }),
    status: h('select', {}, ['active', 'finished'].map(s => h('option', { value: s, selected: o.status === s }, t('status_' + s)))),
    quarryName: inp(o.quarryName), unloadName: inp(o.unloadName),
    distanceKm: inp(o.distanceKm, { type: 'number', step: '0.1', min: '0', style: 'width:100px' }),
    quarryRadiusM: inp(o.quarryRadiusM || 300, { type: 'number', min: '50', style: 'width:90px' }),
    unloadRadiusM: inp(o.unloadRadiusM || 300, { type: 'number', min: '50', style: 'width:90px' }),
    allow: h('input', { type: 'checkbox', checked: !!o.allowLoaderOverride }),
    gpsWarnPct: inp(o.gpsWarnPct ?? 20, { type: 'number', min: '0', style: 'width:80px' }),
    waybillSeries: inp(o.waybillSeries || '', { placeholder: 'KR', style: 'width:90px' }),
    vehicleTonnes: h('textarea', { rows: 3, style: 'width:100%', placeholder: 'ABC123 = 20' }),
  };
  f.vehicleTonnes.value = Object.entries(o.vehicleTonnes || {}).map(([p, v]) => `${p} = ${v}`).join('\n');
  const party = (p = {}) => ({ name: inp(p.name, { placeholder: t('companyName') }), address: inp(p.address, { placeholder: t('address') }), code: inp(p.code, { placeholder: t('companyCodeShort') }), vat: inp(p.vat, { placeholder: t('vatCode') }) });
  const sender = party(o.sender), receiver = party(o.receiver);
  let coords = { quarryLat: o.quarryLat ?? null, quarryLng: o.quarryLng ?? null, unloadLat: o.unloadLat ?? null, unloadLng: o.unloadLng ?? null };
  const mats = h('tbody');
  const addMat = (m = { name: '', densityTm3: 1.6, tonnesPerTrip: 26 }) => mats.append(h('tr', {}, h('td', {}, inp(m.name)), h('td', {}, inp(m.densityTm3, { type: 'number', step: '0.01', style: 'width:90px' })),
    h('td', {}, inp(m.tonnesPerTrip, { type: 'number', step: '0.1', style: 'width:90px' })), h('td', {}, h('button', { type: 'button', onclick: e => e.target.closest('tr').remove() }, '✕'))));
  (o.materials || []).forEach(addMat);
  const mapEl = h('div', { style: 'height:340px;border-radius:10px' });
  let mode = 'quarry';
  const modeBtns = h('div', { class: 'row' });
  const msg = h('span', { class: 'muted' });
  const drawModes = () => modeBtns.replaceChildren(t('clickMapToSet'),
    h('button', { type: 'button', class: mode === 'quarry' ? 'primary' : '', onclick: () => { mode = 'quarry'; drawModes(); } }, t('quarry')),
    h('button', { type: 'button', class: mode === 'unload' ? 'primary' : '', onclick: () => { mode = 'unload'; drawModes(); } }, t('unload')));
  drawModes();
  const save = async e => {
    e.preventDefault(); msg.textContent = '';
    const materials = [...mats.children].map(tr => { const [n, d, tp] = tr.querySelectorAll('input'); return { name: n.value.trim(), densityTm3: Number(d.value) || 0, tonnesPerTrip: Number(tp.value) || 0 }; }).filter(m => m.name);
    const vehicleTonnes = {};
    f.vehicleTonnes.value.split('\n').forEach(line => { const m = line.match(/^\s*([^=]+?)\s*=\s*([\d.,]+)\s*$/); if (m) vehicleTonnes[m[1].toUpperCase().replace(/\s+/g, ' ')] = Number(m[2].replace(',', '.')); });
    const partyVal = p => Object.fromEntries(Object.entries(p).map(([k, el]) => [k, el.value.trim()]));
    const data = {
      name: f.name.value.trim(), objectCode: f.objectCode.value.trim(), status: f.status.value,
      sender: partyVal(sender), receiver: partyVal(receiver),
      quarryName: f.quarryName.value.trim(), unloadName: f.unloadName.value.trim(), ...coords,
      quarryRadiusM: Number(f.quarryRadiusM.value) || 300, unloadRadiusM: Number(f.unloadRadiusM.value) || 300,
      distanceKm: Number(String(f.distanceKm.value).replace(',', '.')) || 0, materials, vehicleTonnes,
      allowLoaderOverride: f.allow.checked, gpsWarnPct: Number(f.gpsWarnPct.value) || 20, waybillSeries: f.waybillSeries.value.trim(),
      updatedAtMillis: Date.now(),
    };
    if (!data.name) { msg.textContent = t('nameRequired'); return; }
    try {
      const ref = object ? doc(ctx.db, 'companies', state.companyId, 'objects', object.id) : doc(collection(ctx.db, 'companies', state.companyId, 'objects'));
      if (object) await updateDoc(ref, data); else await setDoc(ref, { ...data, createdAtMillis: Date.now() });
      msg.textContent = t('saved');
    } catch (err) { console.error(err); msg.textContent = t('actionFailed'); }
  };
  const readonly = !ctx.isAdmin();
  const form = h('form', { class: 'card', onsubmit: save },
    h('h2', {}, object ? t('tab_settings') : t('newObject')),
    h('div', { class: 'row' }, t('objectName'), f.name, t('objectCodeLabel'), f.objectCode, f.status),
    h('h3', {}, t('sender')), h('div', { class: 'row' }, Object.values(sender)),
    h('h3', {}, t('receiver')), h('div', { class: 'row' }, Object.values(receiver)),
    h('h3', {}, t('route')), h('div', { class: 'row' }, t('quarry'), f.quarryName, t('radius'), f.quarryRadiusM, t('unload'), f.unloadName, t('radius'), f.unloadRadiusM),
    modeBtns, mapEl,
    h('div', { class: 'row', style: 'margin-top:8px' }, h('b', {}, t('agreedKm')), f.distanceKm, h('span', { class: 'muted' }, t('agreedKmHint'))),
    h('h3', {}, t('materials')), h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, t('group_material')), h('th', {}, t('density')), h('th', {}, t('tonnesPerTrip')), h('th', {}))), mats),
    h('button', { type: 'button', onclick: () => addMat() }, '+ ' + t('addMaterial')),
    h('h3', {}, t('vehicleTonnes')), h('p', { class: 'muted' }, t('vehicleTonnesHint')), f.vehicleTonnes,
    h('div', { class: 'row', style: 'margin-top:8px' }, h('label', { class: 'row' }, f.allow, t('allowOverride'))),
    h('div', { class: 'row' }, t('gpsWarn'), f.gpsWarnPct, '%', t('waybillSeries'), f.waybillSeries),
    readonly ? h('p', { class: 'muted' }, t('viewOnly')) : h('div', { class: 'row', style: 'margin-top:12px' }, h('button', { class: 'primary', type: 'submit' }, t('save')), msg));
  setTimeout(() => {
    const m = L.map(mapEl).setView(coords.quarryLat ? [coords.quarryLat, coords.quarryLng] : [55.3, 23.9], coords.quarryLat ? 11 : 7);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(m);
    const layer = L.layerGroup().addTo(m);
    const draw = () => {
      layer.clearLayers();
      if (coords.quarryLat != null) L.circle([coords.quarryLat, coords.quarryLng], { radius: Number(f.quarryRadiusM.value) || 300, color: '#e8740c' }).bindTooltip(t('quarry'), { permanent: true }).addTo(layer);
      if (coords.unloadLat != null) L.circle([coords.unloadLat, coords.unloadLng], { radius: Number(f.unloadRadiusM.value) || 300, color: '#2e7d32' }).bindTooltip(t('unload'), { permanent: true }).addTo(layer);
    };
    draw();
    if (!readonly) m.on('click', e => { coords = { ...coords, [mode + 'Lat']: e.latlng.lat, [mode + 'Lng']: e.latlng.lng }; draw(); });
    omap = m;
  }, 0);
  return form;
}

// ---------- tiny modal ----------
function modal(...content) {
  const { h, t } = ctx;
  const box = h('div', { class: 'card', style: 'max-width:1000px;width:95%;max-height:88vh;overflow:auto' }, ...content);
  const bg = h('div', { style: 'position:fixed;inset:0;background:#0006;display:flex;align-items:center;justify-content:center;z-index:2000', onclick: e => { if (e.target === bg) bg.remove(); } }, box);
  box.prepend(h('div', { style: 'text-align:right' }, h('button', { onclick: () => bg.remove() }, '✕ ' + t('close'))));
  document.body.append(bg);
  return box;
}
