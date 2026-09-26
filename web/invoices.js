// VAT invoices issued by a carrier to a contractor from confirmed loads.
// Numbering: company profile invoiceSeries + nextInvoiceNumber, taken in a transaction.
import { doc, collection, runTransaction, getDocs, query, orderBy, limit } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const money = (n, lang) => round2(n).toLocaleString(lang, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyFmt = (n, lang) => round2(n).toLocaleString(lang, { maximumFractionDigits: 2 });

// ---- Lithuanian amount in words (for "Suma žodžiais") ----
const ONES = ['', 'vienas', 'du', 'trys', 'keturi', 'penki', 'šeši', 'septyni', 'aštuoni', 'devyni', 'dešimt',
  'vienuolika', 'dvylika', 'trylika', 'keturiolika', 'penkiolika', 'šešiolika', 'septyniolika', 'aštuoniolika', 'devyniolika'];
const TENS = ['', '', 'dvidešimt', 'trisdešimt', 'keturiasdešimt', 'penkiasdešimt', 'šešiasdešimt', 'septyniasdešimt', 'aštuoniasdešimt', 'devyniasdešimt'];
const form = (n, one, few, many) => { const t = n % 100, u = n % 10; return (t > 10 && t < 20) || u === 0 ? many : u === 1 ? one : few; };
function below1000(n) {
  const out = [];
  const h = Math.floor(n / 100), r = n % 100;
  if (h) out.push(h === 1 ? 'šimtas' : `${ONES[h]} šimtai`);
  if (r < 20) { if (r) out.push(ONES[r]); } else { out.push(TENS[Math.floor(r / 10)]); if (r % 10) out.push(ONES[r % 10]); }
  return out.join(' ');
}
export function amountInWordsLt(amount) {
  const total = round2(amount);
  let euros = Math.floor(total);
  const cents = Math.round((total - euros) * 100);
  const parts = [];
  const mil = Math.floor(euros / 1e6); euros %= 1e6;
  const th = Math.floor(euros / 1000); const rest = euros % 1000;
  if (mil) parts.push(`${below1000(mil)} ${form(mil, 'milijonas', 'milijonai', 'milijonų')}`);
  if (th) parts.push(`${th === 1 ? '' : below1000(th) + ' '}${form(th, 'tūkstantis', 'tūkstančiai', 'tūkstančių')}`.trim());
  if (rest || (!mil && !th)) parts.push(rest ? below1000(rest) : 'nulis');
  const eurosInt = Math.floor(total);
  const text = `${parts.join(' ')} ${form(eurosInt, 'euras', 'eurai', 'eurų')} ${String(cents).padStart(2, '0')} ct`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Lines from confirmed loads, grouped by material.
export function invoiceLines(loads, mode, price, objectName, period) {
  const by = new Map();
  for (const l of loads) {
    const k = l.material || '—';
    const r = by.get(k) || { trips: 0, tonnes: 0, tkm: 0 };
    r.trips++; r.tonnes += l.tonnes || 0; r.tkm += (l.tonnes || 0) * (l.distanceKm || 0);
    by.set(k, r);
  }
  const unit = { trip: 'reis.', tonne: 't', tkm: 't·km' }[mode];
  return [...by].map(([material, r]) => {
    const qty = round2(mode === 'trip' ? r.trips : mode === 'tonne' ? r.tonnes : r.tkm);
    return { desc: `${material} pervežimas, ${objectName} (${period})`, unit, qty, price: round2(price), amount: round2(qty * price) };
  });
}

export function totals(lines, vatRate) {
  const net = round2(lines.reduce((a, l) => a + l.amount, 0));
  const vat = round2(net * vatRate / 100);
  return { net, vat, total: round2(net + vat) };
}

export function invoiceHtml(inv, t, lang) {
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const party = p => `<b>${esc(p.name)}</b><br>${esc(p.address)}<br>${t('companyCodeShort')}: ${esc(p.code)}<br>${t('vatCode')}: ${esc(p.vat)}${p.iban ? `<br>IBAN: ${esc(p.iban)} ${esc(p.bank || '')}` : ''}`;
  return `<section class="inv">
    <h1>${inv.vatRate > 0 ? t('vatInvoice') : t('invoice')}</h1>
    <p class="c">${t('seriesNo')} <b>${esc(inv.number)}</b><br>${esc(inv.dateStr)}${inv.dueStr ? ` · ${t('dueDate')}: ${esc(inv.dueStr)}` : ''}</p>
    <table class="g"><tr><td><small>${t('seller')}</small><br>${party(inv.seller)}</td><td><small>${t('buyer')}</small><br>${party(inv.buyer)}</td></tr></table>
    <table class="t"><thead><tr><th>#</th><th>${t('lineDesc')}</th><th>${t('unit')}</th><th>${t('qty')}</th><th>${t('priceNoVat')}</th><th>${t('amountNoVat')}</th></tr></thead><tbody>
    ${inv.lines.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.desc)}</td><td>${esc(l.unit)}</td><td>${qtyFmt(l.qty, lang)}</td><td>${money(l.price, lang)}</td><td>${money(l.amount, lang)}</td></tr>`).join('')}
    </tbody></table>
    <table class="s"><tr><td>${t('amountNoVat')}</td><td>${money(inv.net, lang)} €</td></tr>
    <tr><td>${inv.vatRate > 0 ? `PVM ${inv.vatRate} %` : t('noVat')}</td><td>${money(inv.vat, lang)} €</td></tr>
    <tr><td><b>${t('totalToPay')}</b></td><td><b>${money(inv.total, lang)} €</b></td></tr></table>
    <p>${t('amountInWords')}: <b>${esc(amountInWordsLt(inv.total))}</b></p>
    ${inv.note ? `<p>${esc(inv.note)}</p>` : ''}
    <table class="g sig"><tr><td>${t('invoiceIssued')}:<br><br>______________________</td><td>${t('invoiceReceived')}:<br><br>______________________</td></tr></table>
  </section>`;
}

export function printInvoices(invoices, t, lang) {
  const w = window.open('', '_blank');
  if (!w) { alert(t('allowPopups')); return; }
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc0(invoices[0]?.number)}</title><style>
    body{font-family:Arial,sans-serif;font-size:12px;color:#000;margin:0}.inv{page-break-after:always;padding:16mm 14mm}
    h1{text-align:center;font-size:20px;margin:0}.c{text-align:center;margin:4px 0 14px}
    table{width:100%;border-collapse:collapse;margin-bottom:10px}td,th{border:1px solid #000;padding:5px;vertical-align:top;text-align:left}
    .t td:nth-child(n+4),.t th:nth-child(n+4){text-align:right}.s{width:50%;margin-left:50%}.s td:last-child{text-align:right}
    .g td{width:50%}.sig td{height:60px}
  </style></head><body>${invoices.map(i => invoiceHtml(i, t, lang)).join('')}<script>setTimeout(()=>print(),300)<\/script></body></html>`);
  w.document.close();
}
const esc0 = s => String(s ?? '').replace(/[<>&"]/g, '');

// ---- form (opened from the carrier's loads view) ----
export function invoiceForm(ctx, link, loads, periodLabel, periodFrom, periodTo) {
  const { h, t, state, lang } = ctx;
  const confirmed = loads.filter(l => l.status === 'confirmed');
  const skipped = loads.length - confirmed.length;
  const saved = key => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } };
  const buyer0 = saved(`kr_buyer_${link.contractorId}`) || { name: link.contractorName };
  const rate0 = saved(`kr_rate_${link.objectId}`) || { mode: 'trip', price: 0 };
  const inp = (v, a = {}) => h('input', { value: v ?? '', ...a });
  const b = { name: inp(buyer0.name, { placeholder: t('companyName') }), code: inp(buyer0.code, { placeholder: t('companyCodeShort') }), vat: inp(buyer0.vat, { placeholder: t('vatCode') }), address: inp(buyer0.address, { placeholder: t('address') }) };
  const mode = h('select', {}, ['trip', 'tonne', 'tkm'].map(m => h('option', { value: m, selected: m === rate0.mode }, t('rate_' + m))));
  const price = inp(rate0.price, { type: 'number', step: '0.01', min: '0', style: 'width:110px' });
  const vatRate = h('select', {}, h('option', { value: '21' }, 'PVM 21 %'), h('option', { value: '0' }, t('noVat')));
  const today = new Date();
  const date = inp(ctx.ymd(today), { type: 'date' });
  const dueDays = inp(30, { type: 'number', min: '0', style: 'width:70px' });
  const note = inp('', { placeholder: t('invoiceNote'), style: 'min-width:300px' });
  const preview = h('div');
  const msg = h('span', { class: 'err' });
  const lines = () => invoiceLines(confirmed, mode.value, Number(String(price.value).replace(',', '.')) || 0, link.objectName, periodLabel);
  const draw = () => {
    const ls = lines(), tt = totals(ls, Number(vatRate.value));
    preview.replaceChildren(h('table', {}, h('tbody', {}, ls.map(l => h('tr', {}, h('td', {}, l.desc), h('td', { class: 'num' }, `${qtyFmt(l.qty, lang())} ${l.unit}`),
      h('td', { class: 'num' }, `${money(l.price, lang())} €`), h('td', { class: 'num' }, `${money(l.amount, lang())} €`))))),
      h('p', {}, `${t('amountNoVat')}: ${money(tt.net, lang())} € · PVM: ${money(tt.vat, lang())} € · `, h('b', {}, `${t('totalToPay')}: ${money(tt.total, lang())} €`)));
  };
  [mode, price, vatRate].forEach(el => el.addEventListener('input', draw));
  draw();

  const issue = async () => {
    msg.textContent = '';
    const ls = lines();
    if (!ls.length || ls.every(l => !l.amount)) { msg.textContent = t('invoiceEmpty'); return; }
    const buyer = Object.fromEntries(Object.entries(b).map(([k, el]) => [k, el.value.trim()]));
    if (!buyer.name) { msg.textContent = t('nameRequired'); return; }
    try { localStorage.setItem(`kr_buyer_${link.contractorId}`, JSON.stringify(buyer)); localStorage.setItem(`kr_rate_${link.objectId}`, JSON.stringify({ mode: mode.value, price: price.value })); } catch {}
    const companyRef = doc(ctx.db, 'companies', state.companyId);
    const invRef = doc(collection(ctx.db, 'companies', state.companyId, 'invoices'));
    try {
      const inv = await runTransaction(ctx.db, async tx => {
        const c = (await tx.get(companyRef)).data() || {};
        const p = c.profile || {};
        const series = (p.invoiceSeries || 'KR').trim();
        const n = Number(p.nextInvoiceNumber) || 1;
        const vr = Number(vatRate.value);
        const due = new Date(date.value); due.setDate(due.getDate() + (Number(dueDays.value) || 0));
        const data = {
          number: `${series}-${String(n).padStart(5, '0')}`, series, dateStr: date.value, dueStr: ctx.ymd(due),
          seller: { name: p.legalName || c.name || '', code: p.code || '', vat: p.vat || '', address: p.address || '', iban: p.iban || '', bank: p.bank || '' },
          buyer, lines: ls, vatRate: vr, ...totals(ls, vr),
          objectId: link.objectId, contractorId: link.contractorId, objectName: link.objectName,
          periodFrom, periodTo, loadIds: confirmed.map(l => l.id).slice(0, 500), note: note.value.trim(),
          createdAtMillis: Date.now(), createdBy: state.user.uid,
        };
        tx.update(companyRef, { profile: { ...p, invoiceSeries: series, nextInvoiceNumber: n + 1 } });
        tx.set(invRef, data);
        return data;
      });
      if (state.company) state.company.profile = { ...(state.company.profile || {}), invoiceSeries: inv.series, nextInvoiceNumber: (Number(state.company.profile?.nextInvoiceNumber) || 1) + 1 };
      printInvoices([inv], t, lang());
      box.replaceChildren(h('p', {}, t('invoiceIssuedOk', inv.number)));
    } catch (e) { console.error(e); msg.textContent = t('invoiceFailed'); }
  };

  const box = h('div', { class: 'card', style: 'margin-top:12px;border:2px solid var(--accent)' },
    h('h2', {}, t('newInvoice')),
    skipped ? h('p', { class: 'err' }, t('invoiceSkipped', skipped)) : null,
    h('h3', {}, t('buyer')), h('div', { class: 'row' }, Object.values(b)),
    h('h3', {}, t('pricing')), h('div', { class: 'row' }, mode, price, '€', vatRate),
    h('div', { class: 'row', style: 'margin-top:6px' }, t('date'), date, t('dueDays'), dueDays, note),
    preview,
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: issue }, t('issueInvoice')), msg),
    h('p', { class: 'muted' }, t('invoiceProfileHint')));
  return box;
}

// Company page: list of issued invoices with reprint.
export async function invoiceList(ctx) {
  const { h, t, state, lang } = ctx;
  const card = h('div', { class: 'card' }, h('h2', {}, t('invoices')), h('div', { class: 'muted' }, t('loading')));
  try {
    const snap = await getDocs(query(collection(ctx.db, 'companies', state.companyId, 'invoices'), orderBy('createdAtMillis', 'desc'), limit(100)));
    const list = snap.docs.map(d => d.data());
    card.lastChild.replaceWith(list.length ? h('table', {}, h('tbody', {}, list.map(inv => h('tr', {},
      h('td', {}, h('b', {}, inv.number)), h('td', {}, inv.dateStr), h('td', {}, inv.buyer?.name || ''), h('td', {}, inv.objectName || ''),
      h('td', { class: 'num' }, `${money(inv.total, lang())} €`), h('td', { class: 'num' }, h('button', { onclick: () => printInvoices([inv], t, lang()) }, t('print'))))))) : h('p', { class: 'muted' }, t('noInvoices')));
  } catch (e) { console.error(e); card.lastChild.replaceWith(h('p', { class: 'muted' }, t('noInvoices'))); }
  return card;
}
