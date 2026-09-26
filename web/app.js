// KarjeroReisai – web dispatcher. Plain ES modules, no build step.
// Firebase config is generated at deploy time (config.js). All access control
// is enforced by Firestore rules and Cloud Functions; this page only shows
// what the signed-in user is allowed to read.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, sendPasswordResetEmail, signOut } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { getFirestore, doc, getDoc, collection, onSnapshot, query, where, getDocs, orderBy, updateDoc, writeBatch, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js';
import { firebaseConfig } from './config.js';
import { t, lang, setLang, LANGS } from './i18n.js';
import { pageObjects } from './objects.js';
import { invoiceList } from './invoices.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const fns = getFunctions(app, 'europe-west1');
const call = (name, data = {}) => httpsCallable(fns, name)(data).then(r => r.data);

const root = document.getElementById('app');
const state = { user: null, profile: null, company: null, companyId: null, role: null, page: 'map', members: [], vehicles: [], live: [], unsub: [] };

// ---------- tiny DOM helper ----------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}
const fmt1 = n => (Math.round((n || 0) * 10) / 10).toLocaleString(lang(), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const hhmm = ms => ms ? new Date(ms).toLocaleTimeString(lang(), { hour: '2-digit', minute: '2-digit' }) : '';
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayStart = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
function stopAll() { state.unsub.forEach(u => u()); state.unsub = []; }
const isAdmin = () => ['company_admin', 'super_admin'].includes(state.role);

// ---------- auth ----------
onAuthStateChanged(auth, async user => {
  stopAll();
  state.user = user;
  if (!user) return renderLogin();
  root.replaceChildren(h('div', { class: 'center muted' }, t('loading')));
  try {
    const profile = (await getDoc(doc(db, 'users', user.uid))).data();
    const role = profile?.role;
    if (!profile || !['company_admin', 'dispatcher', 'super_admin'].includes(role) || !profile.companyId) {
      return renderLogin(t('noAccess'));
    }
    state.profile = profile; state.role = role; state.companyId = profile.companyId;
    state.company = (await getDoc(doc(db, 'companies', state.companyId))).data() || {};
    startListeners();
    render();
  } catch (e) {
    console.error(e);
    renderLogin(t('noAccess'));
  }
});

function renderLogin(message) {
  if (auth.currentUser && message) signOut(auth);
  const email = h('input', { type: 'email', placeholder: t('email'), autocomplete: 'username' });
  const pass = h('input', { type: 'password', placeholder: t('password'), autocomplete: 'current-password' });
  const msg = h('div', { class: 'err' }, message || '');
  const submit = async e => {
    e.preventDefault(); msg.textContent = '';
    try { await signInWithEmailAndPassword(auth, email.value.trim(), pass.value); }
    catch { msg.textContent = t('signInFailed'); }
  };
  root.replaceChildren(h('form', { class: 'login', onsubmit: submit },
    h('h1', {}, 'Karjero', h('span', { style: 'color:var(--accent)' }, 'Reisai')),
    h('div', { class: 'muted' }, t('loginIntro')),
    email, pass, msg,
    h('button', { class: 'primary', type: 'submit' }, t('signIn')),
    h('button', { type: 'button', onclick: async () => {
      if (!email.value.trim()) { msg.textContent = t('enterEmail'); return; }
      try { await sendPasswordResetEmail(auth, email.value.trim()); msg.textContent = t('resetSent'); } catch { msg.textContent = t('resetSent'); }
    } }, t('forgot')),
    langSelect()));
}

function langSelect() {
  return h('select', { onchange: e => { setLang(e.target.value); state.user ? render() : renderLogin(); } },
    LANGS.map(([code, name]) => h('option', { value: code, selected: code === lang() }, name)));
}

// ---------- live data ----------
function startListeners() {
  const c = collection(db, 'companies', state.companyId, 'liveLocations');
  state.unsub.push(onSnapshot(c, snap => { state.live = snap.docs.map(d => ({ uid: d.id, ...d.data() })); if (state.page === 'map') updateMap(); }));
  state.unsub.push(onSnapshot(collection(db, 'companies', state.companyId, 'members'), snap => {
    state.members = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
    renderNavBadge();
    if (state.page === 'drivers') render();
  }));
  state.unsub.push(onSnapshot(collection(db, 'companies', state.companyId, 'vehicles'), snap => {
    state.vehicles = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.plateNumber.localeCompare(b.plateNumber));
    if (state.page === 'vehicles') render();
  }));
  const tick = setInterval(() => { if (state.page === 'map') updateMap(); }, 30000);
  state.unsub.push(() => clearInterval(tick));
}

// ---------- shell ----------
const PAGES = [['map', 'navMap'], ['objects', 'navObjects'], ['drivers', 'navDrivers'], ['vehicles', 'navVehicles'], ['history', 'navHistory'], ['reports', 'navReports'], ['company', 'navCompany']];
let navBadge;
function renderNavBadge() {
  if (!navBadge) return;
  const n = state.members.filter(m => m.status === 'pending').length;
  navBadge.textContent = n; navBadge.style.display = n ? '' : 'none';
}
function render() {
  if (map) { map.remove(); map = null; cluster = null; routeLayer = null; }
  if (hmap) { hmap.remove(); hmap = null; }
  navBadge = h('span', { class: 'badge', style: 'display:none' });
  const nav = h('nav', {}, PAGES.map(([id, key]) => h('button', { class: state.page === id ? 'active' : '', onclick: () => { state.page = id; render(); } },
    t(key), id === 'drivers' ? navBadge : null)));
  const main = h('main');
  root.replaceChildren(h('div', { class: 'shell' },
    h('header', {},
      h('div', { class: 'brand' }, 'Karjero', h('span', {}, 'Reisai')),
      h('div', { class: 'muted', style: 'color:#aab4bd' }, state.company?.name || ''),
      nav, h('div', { class: 'spacer' }),
      h('div', { style: 'color:#cfd6dc' }, `${state.profile.name || state.user.email} · ${t('role_' + state.role)}`),
      langSelect(),
      h('button', { class: 'out', onclick: () => signOut(auth) }, t('signOut'))),
    main));
  renderNavBadge();
  const ctx = { h, t, db, call, state, fmt1, hhmm, ymd, dayStart, esc, lang, isAdmin };
  ({ map: pageMap, objects: m => pageObjects(m, ctx), drivers: pageDrivers, vehicles: pageVehicles, history: pageHistory, reports: pageReports, company: pageCompany })[state.page](main);
}

// ---------- map ----------
let map, cluster, routeLayer, selectedUid = null, fitted = false, listEl, detailEl, search = '', filter = 'all';
const COLORS = { moving: '#2e7d32', stopped: '#f57c00', loading: '#1565c0', unloading: '#1565c0', inactive: '#757575', offline: '#bdbdbd' };
function displayState(v) {
  if (v.state === 'offline') return 'offline';
  if (Date.now() - (v.updatedAtMillis || 0) > 10 * 60000) return 'inactive';
  return v.state || 'offline';
}
function ago(ms) {
  if (!ms) return '';
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 60 ? t('minAgo', Math.max(0, m)) : hhmm(ms);
}
function pageMap(main) {
  const wrap = h('div', { class: 'mapwrap' });
  const mapEl = h('div', { id: 'map' });
  const input = h('input', { placeholder: t('search'), value: search, oninput: e => { search = e.target.value.toLowerCase(); updateMap(); } });
  const sel = h('select', { onchange: e => { filter = e.target.value; updateMap(); } },
    ['all', 'moving', 'stopped', 'inactive', 'offline'].map(s => h('option', { value: s, selected: s === filter }, t(s === 'all' ? 'all' : 'state_' + s))));
  listEl = h('div', { class: 'list' });
  detailEl = h('div', { class: 'detail', style: 'display:none' });
  wrap.append(mapEl, h('div', { class: 'side' }, h('div', { class: 'tools' }, input, sel), detailEl, listEl));
  main.style.overflow = 'hidden';
  main.append(wrap);
  map = L.map(mapEl, { zoomControl: true }).setView([55.3, 23.9], 7);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  cluster = L.markerClusterGroup({ maxClusterRadius: 40 });
  map.addLayer(cluster);
  routeLayer = L.layerGroup().addTo(map);
  fitted = false;
  updateMap();
  if (selectedUid) showDriver(selectedUid);
}
function updateMap() {
  if (!map || !listEl) return;
  const order = { moving: 0, stopped: 1, loading: 0, unloading: 0, inactive: 2, offline: 3 };
  const rows = state.live.map(v => ({ ...v, ds: displayState(v) }))
    .filter(v => filter === 'all' || v.ds === filter)
    .filter(v => !search || `${v.plate} ${v.driverName}`.toLowerCase().includes(search))
    .sort((a, b) => order[a.ds] - order[b.ds] || String(a.plate).localeCompare(String(b.plate)));
  cluster.clearLayers();
  const pts = [];
  for (const v of rows) {
    if (v.lat == null || v.ds === 'offline') continue;
    const icon = L.divIcon({ className: '', html: `<div class="plate" style="--c:${COLORS[v.ds]}">${esc(v.plate || v.driverName || '?')}</div>`, iconSize: null });
    const m = L.marker([v.lat, v.lng], { icon, title: `${v.plate} – ${v.driverName}` });
    m.on('click', () => showDriver(v.uid));
    m.bindTooltip(`<b>${esc(v.plate)}</b> ${esc(v.driverName)}<br>${t('state_' + v.ds)} · ${Math.round(v.speedKmh || 0)} km/h<br>${t('tripsN', v.tripsCount || 0)} · ${fmt1(v.tonnes)} t`, { direction: 'top', offset: [0, -24] });
    cluster.addLayer(m);
    pts.push([v.lat, v.lng]);
  }
  if (!fitted && pts.length) { fitted = true; pts.length === 1 ? map.setView(pts[0], 13) : map.fitBounds(pts, { padding: [40, 40] }); }
  listEl.replaceChildren(...(rows.length ? rows.map(v => h('div', { class: 'veh' + (v.uid === selectedUid ? ' sel' : ''), onclick: () => showDriver(v.uid, true) },
    h('div', { class: 'dot', style: `background:${COLORS[v.ds]}` }),
    h('div', { style: 'flex:1;min-width:0' }, h('b', {}, `${v.plate || '—'} · ${v.driverName || ''}`),
      h('small', {}, `${t('state_' + v.ds)} · ${t('tripsN', v.tripsCount || 0)} · ${fmt1(v.tonnes)} t`)),
    h('small', {}, ago(v.updatedAtMillis)))) : [h('div', { class: 'muted', style: 'padding:14px' }, t('noLive'))]));
}
async function showDriver(uid, pan) {
  selectedUid = uid;
  const v = state.live.find(x => x.uid === uid);
  if (pan && v?.lat != null) map.setView([v.lat, v.lng], 14);
  detailEl.style.display = '';
  detailEl.replaceChildren(h('div', { class: 'row', style: 'justify-content:space-between' }, h('b', {}, `${v?.plate || ''} – ${v?.driverName || ''}`),
    h('button', { onclick: () => { selectedUid = null; detailEl.style.display = 'none'; routeLayer.clearLayers(); updateMap(); } }, '✕')), h('div', { class: 'muted' }, t('loading')));
  updateMap();
  try {
    const day = await loadDay(uid, ymd(new Date()));
    if (selectedUid !== uid) return;
    drawRoute(routeLayer, day);
    detailEl.lastChild.replaceWith(h('div', {}, t('todaySummary', day.trips.length, fmt1(day.tonnes), fmt1(day.km))));
  } catch (e) { console.error(e); detailEl.lastChild.replaceWith(h('div', { class: 'err' }, t('loadFailed'))); }
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Sessions of one driver on one day, with route and trips.
async function loadDay(uid, dateStr) {
  const from = dayStart(dateStr), to = from + 86400000;
  const snap = await getDocs(query(collection(db, 'companies', state.companyId, 'sessions'),
    where('startedAtMillis', '>=', from), where('startedAtMillis', '<', to)));
  const sessions = snap.docs.map(d => ({ id: d.id, ref: d.ref, ...d.data() })).filter(s => !uid || s.driverUid === uid);
  const lines = [], trips = [];
  let tonnes = 0, km = 0;
  for (const s of sessions) {
    tonnes += s.tonnes || 0; km += s.km || 0;
    (s.trips || []).forEach(tr => trips.push({ ...tr, plate: s.plate, driverName: s.driverName }));
    const chunks = await getDocs(query(collection(s.ref, 'route'), orderBy('firstMillis')));
    const line = [];
    chunks.docs.forEach(c => { const d = c.data(); d.lat.forEach((la, i) => line.push([la, d.lng[i]])); });
    if (line.length) lines.push(line);
  }
  trips.sort((a, b) => a.atMillis - b.atMillis);
  return { sessions, lines, trips, tonnes, km };
}
function drawRoute(layer, day) {
  layer.clearLayers();
  const all = [];
  day.lines.forEach(line => { L.polyline(line, { color: '#1565c0', weight: 5, opacity: .8 }).addTo(layer); all.push(...line); });
  day.trips.forEach((tr, i) => {
    if (tr.lat == null) return;
    L.marker([tr.lat, tr.lng], { icon: L.divIcon({ className: '', html: `<div class="tripdot">${i + 1}</div>`, iconSize: null }) })
      .bindTooltip(`${t('trip')} ${i + 1} · ${hhmm(tr.atMillis)} · ${fmt1(tr.weightT)} t`).addTo(layer);
    all.push([tr.lat, tr.lng]);
  });
  if (all.length) layer._map?.fitBounds(all, { padding: [40, 40] });
}

// ---------- drivers ----------
async function pageDrivers(main) {
  const page = h('div', { class: 'page' });
  main.append(page);
  const msg = h('div', { class: 'err' });
  const act = async (name, data) => {
    msg.textContent = '';
    try { await call(name, data); call('syncSeats').catch(() => {}); } // company plan: bill the new driver count
    catch (e) { console.error(e); msg.textContent = t('actionFailed'); }
  };
  if (isAdmin()) {
    const codeEl = h('div', { class: 'code' }, '…');
    const card = h('div', { class: 'card' }, h('h2', {}, t('companyCode')), codeEl, h('p', { class: 'muted' }, t('codeHint')),
      h('div', { class: 'row' },
        h('button', { onclick: () => navigator.clipboard.writeText(codeEl.textContent) }, t('copy')),
        h('button', { onclick: async () => { if (confirm(t('newCodeConfirm'))) { codeEl.textContent = (await call('companyCode', { regenerate: true })).code; } } }, t('newCode'))));
    page.append(card);
    call('companyCode').then(r => { codeEl.textContent = r.code; }).catch(() => { codeEl.textContent = '—'; msg.textContent = t('actionFailed'); });
  } else page.append(h('div', { class: 'card muted' }, t('viewOnly')));
  page.append(msg);
  const pending = state.members.filter(m => m.status === 'pending');
  if (pending.length) page.append(h('div', { class: 'card' }, h('h2', {}, t('pending')), h('table', {}, h('tbody', {}, pending.map(m => h('tr', {},
    h('td', {}, h('b', {}, m.displayName)), h('td', {}, m.email), h('td', {}, new Date(m.joinedAtMillis).toLocaleString(lang())),
    h('td', { class: 'num' }, isAdmin() ? h('div', { class: 'row', style: 'justify-content:flex-end' },
      h('button', { class: 'primary', onclick: () => act('approveMember', { uid: m.uid }) }, t('approve')),
      h('button', { onclick: () => act('rejectMember', { uid: m.uid }) }, t('reject'))) : '')))))));
  const active = state.members.filter(m => m.status === 'active').sort((a, b) => a.displayName.localeCompare(b.displayName));
  page.append(h('div', { class: 'card' }, h('h2', {}, t('members')), active.length ? h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, t('name')), h('th', {}, t('email')), h('th', {}, t('role')), h('th', {}))),
    h('tbody', {}, active.map(m => h('tr', {}, h('td', {}, h('b', {}, m.displayName)), h('td', {}, m.email), h('td', {}, t('role_' + m.role)),
      h('td', { class: 'num' }, isAdmin() && m.uid !== state.user.uid ? h('div', { class: 'row', style: 'justify-content:flex-end' },
        h('button', { onclick: () => act('setMemberRole', { uid: m.uid, role: m.role === 'dispatcher' ? 'driver' : 'dispatcher' }) }, t(m.role === 'dispatcher' ? 'makeDriver' : 'makeDispatcher')),
        h('button', { class: 'danger', onclick: () => confirm(t('removeConfirm', m.displayName)) && act('removeMember', { uid: m.uid }) }, t('remove'))) : ''))))) : h('p', { class: 'muted' }, t('noMembers'))));
}

// ---------- vehicles ----------
function pageVehicles(main) {
  const page = h('div', { class: 'page' });
  main.append(page);
  const msg = h('div', { class: 'err' });
  if (isAdmin()) {
    const ta = h('textarea', { rows: 4, placeholder: t('platesHint'), style: 'width:100%' });
    page.append(h('div', { class: 'card' }, h('h2', {}, t('addVehicles')), ta, h('div', { class: 'row', style: 'margin-top:8px' },
      h('button', { class: 'primary', onclick: async () => {
        const existing = new Set(state.vehicles.map(v => v.plateNumber.toUpperCase()));
        const plates = [...new Set(ta.value.split('\n').map(s => s.trim().toUpperCase().replace(/\s+/g, ' ')).filter(s => s && s.length <= 20 && !existing.has(s)))];
        if (!plates.length) { ta.value = ''; return; }
        const batch = writeBatch(db);
        plates.forEach(p => batch.set(doc(collection(db, 'companies', state.companyId, 'vehicles')), { plateNumber: p, name: '', active: true, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
        try { await batch.commit(); ta.value = ''; msg.textContent = ''; } catch (e) { console.error(e); msg.textContent = t('actionFailed'); }
      } }, t('add'))), msg));
  } else page.append(h('div', { class: 'card muted' }, t('viewOnly')));
  if (isAdmin() && state.vehicles.some(v => v.active)) page.append(h('div', { class: 'card noprint' }, h('h2', {}, t('qrStickers')), h('p', { class: 'muted' }, t('qrStickersHint')),
    h('button', { class: 'blue', onclick: printQr }, t('printQr'))));
  page.append(h('div', { class: 'card' }, h('h2', {}, t('navVehicles')), state.vehicles.length ? h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, t('plate')), h('th', {}, t('inUse')))),
    h('tbody', {}, state.vehicles.map(v => h('tr', {}, h('td', {}, h('b', {}, v.plateNumber), v.name ? ` – ${v.name}` : ''),
      h('td', {}, h('input', { type: 'checkbox', checked: v.active, disabled: !isAdmin(), onchange: async e => {
        try { await updateDoc(doc(db, 'companies', state.companyId, 'vehicles', v.id), { active: e.target.checked, updatedAt: serverTimestamp() }); }
        catch { msg.textContent = t('actionFailed'); }
      } })))))) : h('p', { class: 'muted' }, t('noVehicles'))));
}

// QR stickers (KR1|companyId|plate) – 6 per A4 page, for the windscreen.
function printQr() {
  const w = window.open('', '_blank');
  if (!w) { alert(t('allowPopups')); return; }
  const plates = state.vehicles.filter(v => v.active).map(v => v.plateNumber);
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>QR</title>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"><\/script>
    <style>body{font-family:Arial,sans-serif;margin:0}.g{display:grid;grid-template-columns:1fr 1fr;gap:6mm;padding:10mm}
    .s{border:1px dashed #999;height:85mm;display:flex;flex-direction:column;align-items:center;justify-content:center;page-break-inside:avoid}
    .p{font-size:30px;font-weight:800;margin-top:8px}.c{font-size:11px;color:#444}</style></head><body><div class="g">
    ${plates.map((p, i) => `<div class="s"><div id="q${i}"></div><div class="p">${esc(p)}</div><div class="c">${esc(state.company?.name || '')} · KarjeroReisai</div></div>`).join('')}
    </div><script>const d=${JSON.stringify(plates.map(p => `KR1|${state.companyId}|${p}`))};
    window.onload=()=>{d.forEach((x,i)=>new QRCode(document.getElementById('q'+i),{text:x,width:220,height:220,correctLevel:QRCode.CorrectLevel.M}));setTimeout(()=>print(),500)}<\/script></body></html>`);
  w.document.close();
}

// ---------- history ----------
let hmap;
function driverOptions(extraAll) {
  const people = new Map();
  state.members.filter(m => ['active', 'removed'].includes(m.status)).forEach(m => people.set(m.uid, m.displayName));
  if (state.company?.ownerUid) people.set(state.company.ownerUid, people.get(state.company.ownerUid) || state.profile.name || t('owner'));
  state.live.forEach(v => { if (!people.has(v.uid)) people.set(v.uid, v.driverName); });
  return [extraAll ? h('option', { value: '' }, t('allDrivers')) : null,
    ...[...people].sort((a, b) => String(a[1]).localeCompare(String(b[1]))).map(([uid, name]) => h('option', { value: uid }, name))];
}
function pageHistory(main) {
  const page = h('div', { class: 'page' });
  main.append(page);
  const date = h('input', { type: 'date', value: ymd(new Date()) });
  const who = h('select', {}, driverOptions(true));
  const out = h('div');
  const mapEl = h('div', { id: 'hmap' });
  const show = async () => {
    out.replaceChildren(h('div', { class: 'muted' }, t('loading')));
    try {
      const day = await loadDay(who.value, date.value);
      if (!hmap) {
        hmap = L.map(mapEl).setView([55.3, 23.9], 7);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(hmap);
        hmap._routes = L.layerGroup().addTo(hmap);
      }
      drawRoute(hmap._routes, day);
      out.replaceChildren(day.trips.length ? h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, t('time')), h('th', {}, t('driver')), h('th', {}, t('plate')), h('th', { class: 'num' }, 't'), h('th', { class: 'num' }, 'km'))),
        h('tbody', {}, day.trips.map((tr, i) => h('tr', {}, h('td', {}, i + 1), h('td', {}, hhmm(tr.atMillis)), h('td', {}, tr.driverName), h('td', {}, tr.plate),
          h('td', { class: 'num' }, fmt1(tr.weightT)), h('td', { class: 'num' }, fmt1(tr.km))))),
        h('tfoot', {}, h('tr', {}, h('td', { colspan: 4 }, t('total')), h('td', { class: 'num' }, fmt1(day.tonnes)), h('td', { class: 'num' }, fmt1(day.km)))))
        : h('p', { class: 'muted' }, t('noTrips')));
      setTimeout(() => hmap.invalidateSize(), 50);
    } catch (e) { console.error(e); out.replaceChildren(h('div', { class: 'err' }, t('loadFailed'))); }
  };
  page.append(h('div', { class: 'card row noprint' }, t('date'), date, t('driver'), who, h('button', { class: 'primary', onclick: show }, t('show'))),
    h('div', { class: 'hgrid' }, h('div', { class: 'card' }, mapEl), h('div', { class: 'card' }, out)));
  show();
}

// ---------- reports ----------
function pageReports(main) {
  const page = h('div', { class: 'page' });
  main.append(page);
  const today = new Date();
  const from = h('input', { type: 'date', value: ymd(new Date(today.getFullYear(), today.getMonth(), 1)) });
  const to = h('input', { type: 'date', value: ymd(today) });
  const group = h('select', {}, h('option', { value: 'driver' }, t('byDriver')), h('option', { value: 'plate' }, t('byVehicle')));
  const out = h('div');
  let rows = [];
  const quick = (a, b) => { from.value = ymd(a); to.value = ymd(b); run(); };
  const run = async () => {
    out.replaceChildren(h('div', { class: 'muted' }, t('loading')));
    try {
      const snap = await getDocs(query(collection(db, 'companies', state.companyId, 'sessions'),
        where('startedAtMillis', '>=', dayStart(from.value)), where('startedAtMillis', '<', dayStart(to.value) + 86400000)));
      const sessions = snap.docs.map(d => d.data());
      const map = new Map();
      for (const s of sessions) {
        const key = group.value === 'driver' ? s.driverUid : (s.plate || '—');
        const r = map.get(key) || { name: group.value === 'driver' ? s.driverName : (s.plate || '—'), days: new Set(), trips: 0, tonnes: 0, km: 0, hours: 0 };
        r.days.add(s.date); r.trips += s.tripsCount || 0; r.tonnes += s.tonnes || 0; r.km += s.km || 0;
        r.hours += Math.max(0, ((s.endedAtMillis || s.updatedAtMillis || s.startedAtMillis) - s.startedAtMillis) / 3600000);
        map.set(key, r);
      }
      rows = [...map.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
      const tot = rows.reduce((a, r) => ({ days: a.days + r.days.size, trips: a.trips + r.trips, tonnes: a.tonnes + r.tonnes, km: a.km + r.km, hours: a.hours + r.hours }), { days: 0, trips: 0, tonnes: 0, km: 0, hours: 0 });
      out.replaceChildren(h('h2', {}, `${t('navReports')}: ${from.value} – ${to.value}`), rows.length ? h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, t(group.value === 'driver' ? 'driver' : 'plate')), h('th', { class: 'num' }, t('days')), h('th', { class: 'num' }, t('trips')),
          h('th', { class: 'num' }, t('tonnes')), h('th', { class: 'num' }, 'km'), h('th', { class: 'num' }, t('hours')))),
        h('tbody', {}, rows.map(r => h('tr', {}, h('td', {}, r.name), h('td', { class: 'num' }, r.days.size), h('td', { class: 'num' }, r.trips),
          h('td', { class: 'num' }, fmt1(r.tonnes)), h('td', { class: 'num' }, fmt1(r.km)), h('td', { class: 'num' }, fmt1(r.hours))))),
        h('tfoot', {}, h('tr', {}, h('td', {}, t('total')), h('td', { class: 'num' }, tot.days), h('td', { class: 'num' }, tot.trips),
          h('td', { class: 'num' }, fmt1(tot.tonnes)), h('td', { class: 'num' }, fmt1(tot.km)), h('td', { class: 'num' }, fmt1(tot.hours)))))
        : h('p', { class: 'muted' }, t('noTrips')));
    } catch (e) { console.error(e); out.replaceChildren(h('div', { class: 'err' }, t('loadFailed'))); }
  };
  const csv = () => {
    const sep = ';', num = n => String(Math.round(n * 10) / 10).replace('.', ',');
    const lines = [[t(group.value === 'driver' ? 'driver' : 'plate'), t('days'), t('trips'), t('tonnes'), 'km', t('hours')].join(sep),
      ...rows.map(r => [`"${String(r.name).replace(/"/g, '""')}"`, r.days.size, r.trips, num(r.tonnes), num(r.km), num(r.hours)].join(sep))];
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `karjeroreisai_${from.value}_${to.value}.csv` });
    document.body.append(a); a.click(); a.remove();
  };
  const now = new Date();
  page.append(h('div', { class: 'card noprint' }, h('div', { class: 'row' }, t('from'), from, t('to'), to, group, h('button', { class: 'primary', onclick: run }, t('show'))),
    h('div', { class: 'row', style: 'margin-top:8px' },
      h('button', { onclick: () => quick(now, now) }, t('today')),
      h('button', { onclick: () => { const d = new Date(now); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); quick(d, now); } }, t('thisWeek')),
      h('button', { onclick: () => quick(new Date(now.getFullYear(), now.getMonth(), 1), now) }, t('thisMonth')),
      h('button', { onclick: () => quick(new Date(now.getFullYear(), now.getMonth() - 1, 1), new Date(now.getFullYear(), now.getMonth(), 0)) }, t('lastMonth')),
      h('span', { class: 'spacer', style: 'flex:1' }),
      h('button', { onclick: csv }, t('exportExcel')), h('button', { onclick: () => window.print() }, t('exportPdf')))),
    h('div', { class: 'card' }, out));
  run();
}

// ---------- company details for invoices ----------
function profileCard(c) {
  const p = c.profile || {};
  const f = {};
  const field = (k, label, attrs = {}) => { f[k] = h('input', { value: p[k] ?? '', ...attrs }); return h('label', { style: 'display:flex;flex-direction:column;gap:2px' }, h('small', { class: 'muted' }, label), f[k]); };
  const msg = h('span', { class: 'muted' });
  return h('div', { class: 'card' }, h('h2', {}, t('invoiceDetails')), h('p', { class: 'muted' }, t('invoiceDetailsHint')),
    h('div', { class: 'row', style: 'align-items:flex-end' },
      field('legalName', t('legalName'), { placeholder: c.name || '' }), field('code', t('companyCodeShort')), field('vat', t('vatCode')),
      field('address', t('address'), { style: 'min-width:260px' }), field('iban', 'IBAN', { style: 'min-width:220px' }), field('bank', t('bank')),
      field('invoiceSeries', t('invoiceSeries'), { style: 'width:90px', placeholder: 'KR' }),
      field('nextInvoiceNumber', t('nextNumber'), { type: 'number', min: '1', style: 'width:100px', placeholder: '1' })),
    h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'primary', onclick: async () => {
      const profile = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, k === 'nextInvoiceNumber' ? (parseInt(el.value, 10) || 1) : el.value.trim()]));
      try { await updateDoc(doc(db, 'companies', state.companyId), { profile }); state.company.profile = profile; msg.textContent = t('saved'); }
      catch (e) { console.error(e); msg.textContent = t('actionFailed'); }
    } }, t('save')), msg));
}

// ---------- data retention (GDPR) ----------
function retentionCard(c) {
  const days = h('input', { type: 'number', min: '30', max: '3650', value: c.settings?.dataRetentionDays || 365, style: 'width:100px' });
  const msg = h('span', { class: 'muted' });
  return h('div', { class: 'card' }, h('h2', {}, t('retention')), h('p', { class: 'muted' }, t('retentionHint')),
    h('div', { class: 'row' }, days, t('daysWord'), h('button', { class: 'primary', onclick: async () => {
      const v = Math.min(3650, Math.max(30, parseInt(days.value, 10) || 365));
      try { await updateDoc(doc(db, 'companies', state.companyId), { settings: { ...(state.company.settings || {}), dataRetentionDays: v } }); days.value = v; msg.textContent = t('saved'); }
      catch (e) { console.error(e); msg.textContent = t('actionFailed'); }
    } }, t('save')), msg));
}

// ---------- subscription ----------
const BPLANS = ['monthly', 'yearly', 'company', 'contractor_small', 'contractor_medium', 'contractor_large'];
function billingCard(c, trial) {
  const card = h('div', { class: 'card' }, h('h2', {}, t('subscription')), h('p', {}, t('plan_' + (c.plan || 'inactive')), trial ? ` · ${trial}` : ''),
    c.billingPlan ? h('p', {}, t('bplan_' + c.billingPlan), c.seats ? ` · ${t('seatsBilled', c.seats)}` : '') : null,
    c.graceUntilMillis ? h('p', { class: 'err' }, t('paymentGrace', new Date(c.graceUntilMillis).toLocaleDateString(lang()))) : null);
  if (!(isAdmin() && c.ownerUid === state.user.uid)) { card.append(h('p', { class: 'muted' }, t('viewOnly'))); return card; }
  const body = h('div', { class: 'muted' }, t('loading'));
  card.append(body);
  call('billingStatus').then(st => {
    if (!st.enabled) { body.replaceChildren(t('billingInApp')); return; }
    body.className = '';
    const msg = h('span', { class: 'err' });
    const open = async (name, data) => {
      msg.textContent = '';
      try { const r = await call(name, data); if (/^https:\/\/(checkout|billing)\.stripe\.com\//.test(r.url)) location.href = r.url; else msg.textContent = t('actionFailed'); }
      catch (e) { console.error(e); msg.textContent = t('actionFailed'); }
    };
    if (st.hasSubscription) {
      body.replaceChildren(h('div', { class: 'row' }, h('button', { class: 'blue', onclick: () => open('createBillingPortal') }, t('manageSubscription')), msg));
    } else {
      let plan = 'company';
      body.replaceChildren(h('div', {}, BPLANS.map(p => h('label', { style: 'display:block;margin:4px 0' },
        h('input', { type: 'radio', name: 'bplan', value: p, checked: p === plan, onchange: () => { plan = p; } }), ' ', t('bplan_' + p)))),
        h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'primary', onclick: () => open('createCheckout', { plan }) }, t('payCard')), msg));
    }
  }).catch(() => body.replaceChildren(t('billingInApp')));
  return card;
}

// ---------- company ----------
async function pageCompany(main) {
  const page = h('div', { class: 'page' });
  main.append(page);
  try { state.company = (await getDoc(doc(db, 'companies', state.companyId))).data() || state.company; } catch {}
  const c = state.company || {};
  const isOwner = c.ownerUid === state.user.uid;
  const name = h('input', { value: c.name || '', style: 'min-width:280px' });
  const msg = h('span', { class: 'muted' });
  const trial = c.plan === 'trial' && c.trialEndsAtMillis ? t('trialUntil', new Date(c.trialEndsAtMillis).toLocaleDateString(lang())) : '';
  page.append(h('div', { class: 'card' }, h('h2', {}, t('navCompany')),
    h('div', { class: 'row' }, t('companyName'), name, isAdmin() && c.ownerUid === state.user.uid ? h('button', { class: 'primary', onclick: async () => {
      try { await updateDoc(doc(db, 'companies', state.companyId), { name: name.value.trim() }); state.company.name = name.value.trim(); msg.textContent = t('saved'); }
      catch { msg.textContent = t('actionFailed'); }
    } }, t('save')) : null, msg)),
    billingCard(c, trial),
    isOwner ? profileCard(c) : null,
    isOwner ? retentionCard(c) : null,
    h('div', { class: 'card' }, h('h2', {}, t('mobileApp')), h('p', {}, t('mobileHint')),
      h('a', { href: 'https://github.com/silvijusm/KarjeroReisai/releases/download/testas/KarjeroReisai-testas.apk' }, t('downloadApk'))));
  if (isAdmin()) invoiceList({ h, t, db, state, lang }).then(card => page.append(card));
}
