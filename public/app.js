const REFRESH_MS = 5 * 60 * 1000;
const BLOCKS_KEY = 'rb.blocks.v1';
const TOAST_KEY = 'rb.alertToastShown';
const { t } = I18n;

const state = { data: null, blocks: [], query: '', timeframe: 'all', source: 'all', dragId: null, openId: null };
const $ = id => document.getElementById(id);

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n, cur) => new Intl.NumberFormat(I18n.locale, { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(n);
const fmtDate = d => new Date(d).toLocaleDateString(I18n.locale, { month: 'short', day: 'numeric', year: 'numeric' });
// Cards are narrow: day and month only.
const fmtShortDate = d => new Date(d).toLocaleDateString(I18n.locale, { month: 'short', day: 'numeric' });
const zoneLabel = id => t(`zone.${id}`);
const isPayable = i => i.kind === 'payable';

// Sum amounts per currency so mixed USD/BRL amounts are never added together.
function totals(list, field) {
  const byCur = {};
  for (const i of list) byCur[i.currency] = (byCur[i.currency] || 0) + i[field];
  const parts = Object.entries(byCur).map(([c, v]) => money(v, c));
  return parts.length ? parts.join(' · ') : '—';
}

function highlight(text) {
  if (!state.query) return esc(text);
  const q = state.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Split the raw text so matches never land inside an escaped entity.
  return String(text ?? '').split(new RegExp(`(${q})`, 'ig'))
    .map((part, i) => i % 2 ? `<mark>${esc(part)}</mark>` : esc(part)).join('');
}

/* ---------- Blocks: kept in this browser only, never sent to the server ---------- */

function seedBlocks() {
  const day = n => Logic.toLocalDate(Date.now() + n * Logic.DAY);
  const now = new Date().toISOString();
  const make = (title, kind, amount, due, zone, note = '') =>
    ({ id: crypto.randomUUID(), title, kind, amount, currency: 'BRL', dueDate: day(due), zone, note, createdAt: now, paidAt: zone === 'paid' ? now : null });
  return [
    make(t('seed.rent'), 'payable', 1800, 2, 'pending', t('seed.rentNote')),
    make(t('seed.internet'), 'payable', 120, -3, 'pending'),
    make(t('seed.software'), 'payable', 250, -10, 'paid'),
    make(t('seed.logo'), 'receivable', 2500, 0, 'pending', t('seed.logoNote')),
  ];
}

function loadBlocks() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(BLOCKS_KEY)); } catch { /* storage blocked or corrupt */ }
  state.blocks = Array.isArray(saved) ? saved : seedBlocks();
  if (!Array.isArray(saved)) saveBlocks();
}

function saveBlocks() {
  try { localStorage.setItem(BLOCKS_KEY, JSON.stringify(state.blocks)); } catch { /* still works for this visit */ }
}

const enrichedBlocks = () => state.blocks.map(b => Logic.enrichBlock(b));
const allItems = () => (state.data ? state.data.invoices : []).concat(enrichedBlocks());
const findItem = id => allItems().find(i => i.id === id);

function moveBlock(blockId, zone) {
  const b = state.blocks.find(x => x.id === blockId);
  if (!b || b.zone === zone) return;
  b.zone = zone;
  // Moving into "Paid" records when it was paid; moving out clears it.
  b.paidAt = zone === 'paid' ? new Date().toISOString() : null;
  saveBlocks();
  render();
  if (state.openId === `block:${blockId}`) openDrawer(state.openId);
}

/* ---------- Filters ---------- */

const matchesQuery = inv => !state.query ||
  [inv.client, inv.number, inv.clientEmail].some(v => v && v.toLowerCase().includes(state.query.toLowerCase()));
const matchesSource = inv => state.source === 'all' || inv.sourceLabel === state.source;
const matchesTimeframe = inv => state.timeframe === 'all' || inv.timeframe === state.timeframe;

/* ---------- Rendering ---------- */

function timeAgo(iso) {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return t('ago.now');
  if (mins < 60) return t('ago.min', { n: mins });
  const h = Math.round(mins / 60);
  return h < 24 ? t('ago.h', { n: h }) : t('ago.d', { n: Math.round(h / 24) });
}

function renderSync() {
  const { lastSuccessfulSync, lastSync, syncing, sources } = state.data;
  const dot = $('syncDot');
  if (syncing) { dot.className = 'dot busy'; $('syncText').textContent = t('sync.running'); return; }
  if (!lastSuccessfulSync) { dot.className = 'dot warn'; $('syncText').textContent = t('sync.never'); return; }
  const stale = Date.now() - Date.parse(lastSuccessfulSync) > 26 * 3600 * 1000;
  const failed = lastSync && !lastSync.ok;
  dot.className = 'dot ' + (failed ? 'err' : stale ? 'warn' : 'ok');
  $('syncText').textContent = t('sync.done', { ago: timeAgo(lastSuccessfulSync), sources: sources.map(s => s.label).join(', ') }) + (failed ? t('sync.errors') : '');
}

function renderKpis(list) {
  // Bills you owe get their own card; every other figure is about money owed to you.
  const all = list.filter(i => !isPayable(i));
  const bills = list.filter(i => isPayable(i) && i.zone !== 'paid');
  const billsSoon = bills.filter(i => i.daysOverdue === 0 && i.daysUntilDue <= 7).length;
  const open = all.filter(i => i.zone !== 'paid');
  const late = open.filter(i => i.daysOverdue > 0);
  const escalated = open.filter(i => i.zone === 'escalated');
  const monthAgo = Date.now() - 30 * Logic.DAY;
  const recovered = all.filter(i => i.paidAt && i.daysOverdue > 0 && Date.parse(i.paidAt) >= monthAgo);
  const everLate = all.filter(i => i.daysOverdue > 0);
  const rate = everLate.length ? Math.round(100 * everLate.filter(i => i.paidAt).length / everLate.length) : 0;
  const avg = late.length ? Math.round(late.reduce((s, i) => s + i.daysOverdue, 0) / late.length) : 0;
  const kpi = (label, value, sub) => `<div class="kpi"><div class="label">${label}</div><div class="value num">${value}</div><div class="sub">${sub}</div></div>`;
  $('kpis').innerHTML = [
    kpi(t('kpi.outstanding'), totals(open, 'outstanding'), t('kpi.outstandingSub', { n: open.length })),
    kpi(t('kpi.overdue'), totals(late, 'outstanding'), t('kpi.overdueSub', { n: late.length, avg })),
    kpi(t('kpi.escalated'), totals(escalated, 'outstanding'), t('kpi.escalatedSub', { n: escalated.length })),
    kpi(t('kpi.recovered'), totals(recovered, 'amount'), t('kpi.recoveredSub', { n: recovered.length })),
    kpi(t('kpi.rate'), `${rate}%`, t('kpi.rateSub')),
    kpi(t('kpi.toPay'), totals(bills, 'outstanding'), bills.length ? t('kpi.toPaySub', { n: bills.length, soon: billsSoon }) : t('kpi.toPayEmpty')),
  ].join('');
}

function renderFilters(all) {
  const base = all.filter(i => matchesQuery(i) && matchesSource(i));
  $('timeframes').innerHTML = state.data.timeframes.map(({ id }) => {
    const n = id === 'all' ? base.length : base.filter(i => i.timeframe === id).length;
    return `<button class="chip" data-tf="${id}" aria-pressed="${state.timeframe === id}">${t(`tf.${id}`)}<span class="count">${n}</span></button>`;
  }).join('');

  const labels = [...new Set(all.map(i => i.sourceLabel))].sort();
  if (!labels.includes(state.source)) state.source = 'all';
  $('sourceFilter').innerHTML = `<option value="all">${t('filter.sources')}</option>` +
    labels.map(l => `<option value="${esc(l)}" ${l === state.source ? 'selected' : ''}>${esc(l === 'Manual' ? t('card.manual') : l)}</option>`).join('');
}

// When searching, show each matching client and how many of their items sit in each zone.
function renderInsight(matches) {
  const box = $('insight');
  if (!state.query) { box.hidden = true; return; }
  box.hidden = false;
  if (!matches.length) { box.innerHTML = `<h2>${esc(t('insight.none', { q: state.query }))}</h2>`; return; }
  const byClient = new Map();
  for (const i of matches) {
    if (!byClient.has(i.client)) byClient.set(i.client, []);
    byClient.get(i.client).push(i);
  }
  box.innerHTML = `<h2>${esc(t('insight.title', { q: state.query }))}</h2>` + [...byClient].map(([client, items]) => {
    const pills = state.data.zones.map(z => {
      const n = items.filter(i => i.zone === z.id).length;
      return n ? `<span class="pill" style="--zone:${z.color}">${zoneLabel(z.id)} · ${n}</span>` : '';
    }).join('');
    const owed = items.filter(i => i.zone !== 'paid' && !isPayable(i));
    const toPay = items.filter(i => i.zone !== 'paid' && isPayable(i));
    const amounts = [
      owed.length && t('insight.owed', { amount: totals(owed, 'outstanding') }),
      toPay.length && t('insight.toPay', { amount: totals(toPay, 'outstanding') }),
    ].filter(Boolean);
    return `<div class="insight-row"><strong>${highlight(client)}</strong>${pills}<span class="muted num">${amounts.join(' · ') || t('insight.nothing')}</span></div>`;
  }).join('');
}

// A block's tag describes its situation in the column it sits in, worded for its type.
const blockTag = inv => `<span class="tag">${t(`tag.${inv.kind}.${inv.zone}`)}</span>`;
const stepAction = s => t(`step.${s.id}`);

function workflowSummary(inv) {
  const w = inv.workflow;
  if (inv.paidAt) return inv.daysOverdue > 0 ? t('wf.recovered', { n: inv.daysOverdue }) : t('wf.onTime');
  if (!w.current) return t('wf.waiting');
  return t('wf.step', { i: w.completed, total: w.total, action: stepAction(w.current) });
}

function whenText(inv) {
  if (inv.zone === 'paid' && inv.paidAt) return t('card.paidOn', { date: fmtShortDate(inv.paidAt) });
  if (inv.daysOverdue > 0) return `<span class="late">${t('card.late', { n: inv.daysOverdue })}</span>`;
  return inv.daysUntilDue === 0 ? t('card.dueToday') : t('card.dueIn', { n: inv.daysUntilDue });
}

function cardHtml(inv, zone) {
  let meta, footer;
  if (inv.manual) {
    meta = `${t(`kind.${inv.kind}`)} · ${t('card.manual')}`;
    footer = `${blockTag(inv)}<em>${esc(inv.note || t('card.dragHint'))}</em>`;
  } else {
    const w = inv.workflow;
    const step = !inv.paidAt && w.next ? t('card.next', { action: stepAction(w.next), date: fmtShortDate(w.next.date + 'T12:00:00') }) : workflowSummary(inv);
    meta = `${highlight(inv.number)} · ${esc(inv.sourceLabel)}`;
    footer = `<span class="progress"><span style="width:${(100 * w.completed / w.total).toFixed(0)}%"></span></span><em>${esc(step)}</em>`;
  }
  return `<article class="card ${inv.manual ? 'manual' : ''} ${state.query ? 'match' : ''}" tabindex="0" role="button" ${inv.manual ? 'draggable="true"' : ''} data-id="${esc(inv.id)}" style="--zone:${zone.color}">
    <div class="card-top"><span class="card-client">${highlight(inv.client)}</span><span class="card-amount num">${money(inv.zone === 'paid' ? inv.amount : inv.outstanding, inv.currency)}</span></div>
    <div class="card-meta"><span>${meta}</span><span>${whenText(inv)}</span></div>
    <div class="card-step">${footer}</div>
  </article>`;
}

function renderBoard(visible) {
  const filtered = state.query || state.timeframe !== 'all' || state.source !== 'all';
  $('board').setAttribute('aria-label', t('wf.title'));
  $('board').innerHTML = state.data.zones.map(zone => {
    const list = visible.filter(i => i.zone === zone.id);
    if (zone.id === 'paid') list.sort((a, b) => Date.parse(b.paidAt) - Date.parse(a.paidAt));
    if (zone.id === 'pending') list.sort((a, b) => a.daysUntilDue - b.daysUntilDue);
    // Zone totals count money owed to you; bills you owe are shown on their own line.
    const field = zone.id === 'paid' ? 'amount' : 'outstanding';
    const bills = list.filter(isPayable);
    const total = totals(list.filter(i => !isPayable(i)), field);
    return `<section class="zone" data-zone="${zone.id}" style="--zone:${zone.color}" aria-label="${zoneLabel(zone.id)}">
      <div class="zone-head">
        <div class="zone-title"><h2>${zoneLabel(zone.id)}</h2><span class="zone-count">${list.length}</span></div>
        <div class="zone-hint">${t(`zone.${zone.id}.hint`)}</div>
        <div class="zone-total num">${total}</div>
        ${bills.length ? `<div class="zone-bills">${t(`zone.bills.${zone.id}`)} (${bills.length}): <span class="num">${totals(bills, field)}</span></div>` : ''}
      </div>
      <div class="zone-list">${list.length ? list.map(i => cardHtml(i, zone)).join('') : `<div class="empty">${t(filtered ? 'zone.emptyFiltered' : 'zone.empty')}</div>`}</div>
    </section>`;
  }).join('');
}

/* ---------- Billing alerts (rule-based, from each block's due date) ---------- */

function alertText(a) {
  const vars = { title: a.block.client, days: a.days, amount: money(a.block.amount, a.block.currency) };
  if (a.type === 'mismatch') return t('alert.mismatch', { ...vars, zone: zoneLabel(a.block.zone), suggest: zoneLabel(a.suggest) });
  return t(`alert.${a.block.kind}.${a.type}`, vars);
}

function renderAlerts() {
  const alerts = Logic.blockAlerts(enrichedBlocks());
  const urgent = alerts.filter(a => a.level !== 'info');
  const badge = $('alertsCount');
  badge.hidden = !alerts.length;
  badge.textContent = alerts.length;
  badge.classList.toggle('danger', alerts.some(a => a.level === 'danger'));
  const zoneColor = id => state.data.zones.find(z => z.id === id).color;
  $('alertsList').innerHTML = alerts.length ? alerts.map(a => `
    <div class="alert ${a.level}">
      <p>${esc(alertText(a))}</p>
      <div class="alert-actions">
        <button class="mini" data-alert="paid" data-block="${a.block.blockId}" style="--zone:${zoneColor('paid')}">${t(isPayable(a.block) ? 'alert.markPaid' : 'alert.markReceived')}</button>
        ${a.suggest ? `<button class="mini" data-alert="move" data-zone="${a.suggest}" data-block="${a.block.blockId}" style="--zone:${zoneColor(a.suggest)}">${t('alert.moveTo', { zone: zoneLabel(a.suggest) })}</button>` : ''}
        <button class="mini ghost" data-alert="open" data-block="${a.block.blockId}">${t('alert.open')}</button>
      </div>
    </div>`).join('') : `<p class="muted alerts-empty">${t('alerts.empty')}</p>`;
  return urgent;
}

function toggleAlerts(open = $('alertsPanel').hidden) {
  $('alertsPanel').hidden = !open;
  $('alertsBtn').setAttribute('aria-expanded', String(open));
}

let toastTimer;
function showToast(html, ms = 6000) {
  const el = $('toast');
  el.innerHTML = html;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// Once per browser session, tell the visitor about urgent alerts.
function maybeToast(urgent) {
  if (!urgent.length) return;
  try { if (sessionStorage.getItem(TOAST_KEY)) return; sessionStorage.setItem(TOAST_KEY, '1'); } catch { /* show anyway */ }
  showToast(`🔔 ${esc(t('alerts.toast', { n: urgent.length }))} <button class="link-btn" data-toast="alerts">${t('alerts.see')}</button>`);
}

function render() {
  if (!state.data) return;
  const all = allItems();
  renderSync();
  renderFilters(all);
  const matches = all.filter(i => matchesQuery(i) && matchesSource(i));
  const visible = matches.filter(matchesTimeframe);
  // Summary cards follow the search and every filter, like the board.
  renderKpis(visible);
  renderInsight(matches);
  renderBoard(visible);
  return renderAlerts();
}

/* ---------- Drawer ---------- */

function collectionMessage(inv) {
  const w = inv.workflow;
  const step = w.current || w.steps[0];
  const tone = Logic.STEP_TONE[step.id];
  const vars = { client: inv.client, number: inv.number, amount: money(inv.outstanding, inv.currency), days: inv.daysOverdue, date: fmtDate(inv.dueDate) };
  const when = inv.daysOverdue > 0 ? t('msg.when.past', { ...vars, days: inv.daysOverdue })
    : inv.daysUntilDue === 0 ? t('msg.when.today', vars) : t('msg.when.future', { ...vars, days: inv.daysUntilDue });
  return { subject: t(`msg.subject.${tone}`, vars), body: t(`msg.body.${tone}`, { ...vars, whenSentence: when }) };
}

function invoiceDrawerHtml(inv, zone) {
  const w = inv.workflow;
  const msg = inv.paidAt ? null : collectionMessage(inv);
  return `
    <span class="pill" style="--zone:${zone.color}">${zoneLabel(zone.id)}</span>
    <h2>${esc(inv.client)}</h2>
    <div class="muted">${esc(inv.number)} · ${esc(inv.sourceLabel)}${inv.clientEmail ? ' · ' + esc(inv.clientEmail) : ''}</div>
    <div class="facts">
      <div class="fact"><span>${t('fact.amount')}</span><b class="num">${money(inv.amount, inv.currency)}</b></div>
      <div class="fact"><span>${t(inv.paidAt ? 'fact.paidOn' : 'fact.outstanding')}</span><b class="num">${inv.paidAt ? fmtDate(inv.paidAt) : money(inv.outstanding, inv.currency)}</b></div>
      <div class="fact"><span>${t('fact.issued')}</span><b>${fmtDate(inv.issuedAt)}</b></div>
      <div class="fact"><span>${t('fact.due')}</span><b>${fmtDate(inv.dueDate)}</b></div>
      <div class="fact"><span>${t('fact.daysLate')}</span><b class="num">${inv.daysOverdue}</b></div>
      <div class="fact"><span>${t('fact.gateway')}</span><b>${esc(inv.gatewayStatus)}</b></div>
    </div>
    ${msg ? `
    <h3>${t('msg.title')}</h3>
    <div class="message">
      <div class="message-subject">${esc(msg.subject)}</div>
      <div class="message-body">${esc(msg.body)}</div>
      <div class="message-foot"><span class="muted">${t('msg.note')}</span><button class="mini ghost" data-copy>${t('msg.copy')}</button></div>
    </div>` : ''}
    <h3>${t('wf.title')}</h3>
    <div class="muted">${esc(workflowSummary(inv))}</div>
    <ol class="timeline">${w.steps.map(s => `
      <li class="${s.done ? 'done' : w.next && w.next.id === s.id ? 'next' : ''}">
        <div>${esc(stepAction(s))}</div>
        <div class="when">${t(s.done ? 'wf.sent' : inv.paidAt ? 'wf.notNeeded' : 'wf.scheduled')} · ${fmtDate(s.date + 'T12:00:00')} · ${t(`channel.${s.channel}`)} · ${t('wf.day', { d: (s.day > 0 ? '+' : '') + s.day })}</div>
      </li>`).join('')}
    </ol>`;
}

function blockDrawerHtml(inv, zone) {
  return `
    <span class="pill" style="--zone:${zone.color}">${zoneLabel(zone.id)}</span> ${blockTag(inv)}
    <h2>${esc(inv.client)}</h2>
    <div class="muted">${t('block.created', { kind: t(`kind.${inv.kind}`), date: fmtDate(inv.issuedAt) })}</div>
    <div class="facts">
      <div class="fact"><span>${t('fact.amount')}</span><b class="num">${money(inv.amount, inv.currency)}</b></div>
      <div class="fact"><span>${t('fact.due')}</span><b>${fmtDate(inv.dueDate)}</b></div>
      <div class="fact"><span>${t(inv.paidAt ? 'fact.paidOn' : 'fact.daysLate')}</span><b class="num">${inv.paidAt ? fmtDate(inv.paidAt) : inv.daysOverdue}</b></div>
      <div class="fact"><span>${t(inv.paidAt ? 'fact.status' : 'fact.dueIn')}</span><b>${inv.paidAt ? t(`tag.${inv.kind}.paid`) : t('fact.days', { n: inv.daysUntilDue })}</b></div>
    </div>
    ${inv.note ? `<h3>${t('block.note')}</h3><p class="note">${esc(inv.note)}</p>` : ''}
    <h3>${t('block.moveTo')}</h3>
    <div class="move">${state.data.zones.map(z => `
      <button class="move-btn" data-move="${z.id}" style="--zone:${z.color}" ${z.id === inv.zone ? 'disabled aria-current="true"' : ''}>${zoneLabel(z.id)}</button>`).join('')}
    </div>
    <div class="actions">
      <button class="btn ghost danger" data-block-action="delete">${t('block.delete')}</button>
      <button class="btn" data-block-action="edit">${t('block.edit')}</button>
    </div>`;
}

function openDrawer(id) {
  const inv = findItem(id);
  if (!inv) return;
  const zone = state.data.zones.find(z => z.id === inv.zone);
  $('drawer').style.setProperty('--zone', zone.color);
  $('drawerBody').innerHTML = inv.manual ? blockDrawerHtml(inv, zone) : invoiceDrawerHtml(inv, zone);
  state.openId = id;
  $('drawer').classList.add('open');
  $('drawer').setAttribute('aria-hidden', 'false');
  $('drawerClose').focus();
}

function closeDrawer() {
  state.openId = null;
  $('drawer').classList.remove('open');
  $('drawer').setAttribute('aria-hidden', 'true');
}

async function onDrawerAction(e) {
  const inv = findItem(state.openId);
  if (!inv) return;
  if (e.target.closest('[data-copy]')) {
    const msg = collectionMessage(inv);
    try { await navigator.clipboard.writeText(`${msg.subject}\n\n${msg.body}`); e.target.textContent = t('msg.copied'); } catch { /* clipboard blocked */ }
    return;
  }
  if (!inv.manual) return;
  const move = e.target.closest('[data-move]');
  const action = e.target.closest('[data-block-action]')?.dataset.blockAction;
  if (move) moveBlock(inv.blockId, move.dataset.move);
  else if (action === 'edit') { closeDrawer(); openBlockForm(inv); }
  else if (action === 'delete' && confirm(t('block.deleteConfirm', { title: inv.client }))) {
    state.blocks = state.blocks.filter(b => b.id !== inv.blockId);
    saveBlocks();
    closeDrawer();
    render();
  }
}

/* ---------- Block form ---------- */

function openBlockForm(inv = null) {
  const form = $('blockForm');
  form.reset();
  form.dataset.editing = inv ? inv.blockId : '';
  $('blockZone').innerHTML = state.data.zones.map(z => `<option value="${z.id}">${zoneLabel(z.id)}</option>`).join('');
  $('blockFormTitle').textContent = t(inv ? 'form.editTitle' : 'form.newTitle');
  $('blockSubmit').textContent = t(inv ? 'form.save' : 'form.create');
  $('blockError').hidden = true;
  const values = inv
    ? { title: inv.client, kind: inv.kind, amount: inv.amount, currency: inv.currency, dueDate: Logic.toLocalDate(inv.dueDate), zone: inv.zone, note: inv.note || '' }
    : { kind: 'payable', currency: 'BRL', dueDate: Logic.toLocalDate(Date.now() + 7 * Logic.DAY), zone: 'pending' };
  // Works for radio groups too: RadioNodeList.value checks the matching radio.
  for (const [name, value] of Object.entries(values)) form.elements[name].value = value;
  $('blockDialog').showModal();
  form.elements.title.focus();
}

function submitBlock(e) {
  e.preventDefault();
  const f = Object.fromEntries(new FormData($('blockForm')));
  const title = f.title.trim();
  const amount = Number(f.amount);
  const error = !title || title.length > 120 ? 'form.errName'
    : f.amount === '' || !Number.isFinite(amount) || amount < 0 ? 'form.errAmount'
    : !/^\d{4}-\d{2}-\d{2}$/.test(f.dueDate) ? 'form.errDue' : null;
  if (error) { $('blockError').textContent = t(error); $('blockError').hidden = false; return; }

  const fields = { title, kind: f.kind, amount: Math.round(amount * 100) / 100, currency: f.currency, dueDate: f.dueDate, zone: f.zone, note: f.note.trim().slice(0, 500) };
  const id = $('blockForm').dataset.editing;
  const existing = id && state.blocks.find(b => b.id === id);
  if (existing) {
    const paidAt = fields.zone === 'paid' ? existing.paidAt || new Date().toISOString() : null;
    Object.assign(existing, fields, { paidAt });
  } else {
    const now = new Date().toISOString();
    state.blocks.push({ ...fields, id: crypto.randomUUID(), createdAt: now, paidAt: fields.zone === 'paid' ? now : null });
  }
  saveBlocks();
  $('blockDialog').close();
  render();
}

/* ---------- Data loading ---------- */

async function load() {
  try {
    const res = await fetch('/api/dashboard');
    state.data = await res.json();
    if (state.data.repoUrl) { $('repoLink').href = state.data.repoUrl; $('repoLink').hidden = false; }
    // Re-rendering mid-drag would drop the card the user is holding.
    if (!state.dragId) return render();
  } catch {
    $('syncDot').className = 'dot err';
    $('syncText').textContent = t('sync.unreachable');
  } finally {
    // Keep polling quickly while the initial/background sync is running.
    if (state.data?.syncing) setTimeout(load, 2000);
  }
}

async function syncNow() {
  const btn = $('syncBtn');
  btn.disabled = true;
  btn.textContent = t('sync.running');
  try { await fetch('/api/sync', { method: 'POST' }); } catch { /* shown by load() */ } finally {
    btn.disabled = false;
    btn.textContent = t('sync.now');
    await load();
  }
}

function switchLanguage() {
  I18n.setLang(I18n.lang === 'pt' ? 'en' : 'pt');
  I18n.apply();
  render();
  if (state.openId) openDrawer(state.openId);
}

function resetDemo() {
  if (!confirm(t('demo.resetConfirm'))) return;
  state.blocks = seedBlocks();
  saveBlocks();
  Object.assign(state, { query: '', timeframe: 'all', source: 'all' });
  $('search').value = '';
  closeDrawer();
  render();
}

/* ---------- Events ---------- */

$('search').addEventListener('input', e => { state.query = e.target.value.trim(); render(); });
$('timeframes').addEventListener('click', e => {
  const chip = e.target.closest('[data-tf]');
  if (chip) { state.timeframe = chip.dataset.tf; render(); }
});
$('sourceFilter').addEventListener('change', e => { state.source = e.target.value; render(); });
$('board').addEventListener('click', e => { const c = e.target.closest('.card'); if (c) openDrawer(c.dataset.id); });
$('board').addEventListener('keydown', e => {
  const c = e.target.closest('.card');
  if (c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openDrawer(c.dataset.id); }
});

// Drag and drop: only manual blocks are draggable; any zone accepts them.
const clearDropTargets = () => document.querySelectorAll('.drop-target').forEach(z => z.classList.remove('drop-target'));
$('board').addEventListener('dragstart', e => {
  const card = e.target.closest('.card.manual');
  if (!card) return;
  state.dragId = card.dataset.id;
  e.dataTransfer.setData('text/plain', state.dragId);
  e.dataTransfer.effectAllowed = 'move';
  card.classList.add('dragging');
  $('board').classList.add('is-dragging');
});
$('board').addEventListener('dragend', () => {
  state.dragId = null;
  clearDropTargets();
  $('board').classList.remove('is-dragging');
  document.querySelector('.card.dragging')?.classList.remove('dragging');
});
$('board').addEventListener('dragover', e => {
  const zone = e.target.closest('.zone');
  if (!zone || !state.dragId) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (!zone.classList.contains('drop-target')) { clearDropTargets(); zone.classList.add('drop-target'); }
});
$('board').addEventListener('dragleave', e => {
  const zone = e.target.closest('.zone');
  if (zone && !zone.contains(e.relatedTarget)) zone.classList.remove('drop-target');
});
$('board').addEventListener('drop', e => {
  const zone = e.target.closest('.zone');
  if (!zone || !state.dragId) return;
  e.preventDefault();
  const item = findItem(state.dragId);
  state.dragId = null;
  if (item) moveBlock(item.blockId, zone.dataset.zone);
});

$('alertsBtn').addEventListener('click', e => { e.stopPropagation(); toggleAlerts(); });
$('alertsPanel').addEventListener('click', e => {
  e.stopPropagation();
  const btn = e.target.closest('[data-alert]');
  if (!btn) return;
  const { alert: action, block, zone } = btn.dataset;
  if (action === 'paid') moveBlock(block, 'paid');
  else if (action === 'move') moveBlock(block, zone);
  else if (action === 'open') { toggleAlerts(false); openDrawer(`block:${block}`); }
});
document.addEventListener('click', e => {
  if (!$('alertsPanel').hidden && !e.target.closest('.alerts-wrap')) toggleAlerts(false);
});
$('toast').addEventListener('click', e => {
  if (e.target.closest('[data-toast="alerts"]')) { $('toast').hidden = true; e.stopPropagation(); toggleAlerts(true); }
});

$('newBlockBtn').addEventListener('click', () => openBlockForm());
$('blockForm').addEventListener('submit', submitBlock);
$('blockCancel').addEventListener('click', () => $('blockDialog').close());
$('drawerBody').addEventListener('click', onDrawerAction);
$('syncBtn').addEventListener('click', syncNow);
$('langBtn').addEventListener('click', switchLanguage);
$('resetDemo').addEventListener('click', resetDemo);
$('drawerClose').addEventListener('click', closeDrawer);
$('drawer').addEventListener('click', e => { if (e.target.id === 'drawer') closeDrawer(); });
document.addEventListener('keydown', e => {
  if ($('blockDialog').open) return;
  if (e.key === 'Escape') { closeDrawer(); toggleAlerts(false); }
  if (e.key === '/' && document.activeElement !== $('search')) { e.preventDefault(); $('search').focus(); }
});

I18n.apply();
loadBlocks();
load().then(urgent => maybeToast(urgent || []));
setInterval(load, REFRESH_MS);
