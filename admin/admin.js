'use strict';
// DealerDoor admin console. Talks to the same Worker API as the iOS app.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const money = (cents) => (cents == null ? '—' : `$${(cents / 100).toFixed(2)}`);
const dollarsToCents = (v) => (v === '' || v == null ? undefined : Math.round(Number(v) * 100));
const day = (iso) => (iso ? new Date(iso.replace(' ', 'T') + (iso.length === 19 ? 'Z' : '')).toLocaleString() : '—');

// ---- Session (tab-scoped; closing the tab signs out) ----------------------

const session = {
  get access() { return sessionStorage.getItem('access'); },
  get refresh() { return sessionStorage.getItem('refresh'); },
  save(t) { sessionStorage.setItem('access', t.access_token); sessionStorage.setItem('refresh', t.refresh_token); },
  clear() { sessionStorage.clear(); },
};
let me = null;

async function api(path, { method, body } = {}, retried = false) {
  const res = await fetch(`/v1${path}`, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(session.access && { authorization: `Bearer ${session.access}` }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && session.refresh && !retried) {
    const r = await fetch('/v1/auth/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: session.refresh }) });
    if (r.ok) { session.save(await r.json()); return api(path, { method, body }, true); }
    session.clear(); location.reload();
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message && data.message !== data.error ? data.message : (data.error ?? `HTTP ${res.status}`).replaceAll('_', ' '));
  return data;
}

function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast${isError ? ' error' : ''}`;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 4000);
}

/** Runs an async action, reporting errors as a toast. */
const guard = (fn) => async (...args) => { try { await fn(...args); } catch (e) { toast(e.message, true); } };

function formValues(form) {
  const out = {};
  for (const [k, v] of new FormData(form)) out[k] = typeof v === 'string' ? v.trim() : v;
  return out;
}

// ---- Rendering helpers (textContent only, never innerHTML with data) ------

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) node.append(c instanceof Node ? c : String(c));
  return node;
}

function badge(text, tone) {
  const tones = { paid: 'ok', approved: 'ok', activated: 'ok', complete: 'ok', reconciled: 'ok', overdue: 'bad', rejected: 'bad', cancelled: 'bad', not_serviceable: 'bad', delayed: 'warn', partial: 'warn', pending: 'warn', open: 'warn' };
  return el('span', { className: `badge ${tone ?? tones[text] ?? ''}` }, String(text ?? '—').replaceAll('_', ' '));
}

function button(label, onClick, cls = 'small') {
  return el('button', { type: 'button', className: cls, onclick: guard(onClick) }, label);
}

/** cols: [label, row => value | Node] */
function table(name, rows, cols, onRowClick) {
  const host = $(`[data-table="${name}"]`);
  host.replaceChildren();
  if (!rows.length) return host.append(el('div', { className: 'empty card' }, 'Nothing here yet.'));
  const head = el('tr', {}, ...cols.map(([label]) => el('th', {}, label)));
  const body = rows.map((row) => {
    const tr = el('tr', {}, ...cols.map(([, get]) => el('td', {}, get(row) ?? '—')));
    if (onRowClick) { tr.className = 'clickable'; tr.onclick = (e) => e.target.closest('button') || guard(onRowClick)(row); }
    return tr;
  });
  host.append(el('div', { className: 'table-wrap' }, el('table', {}, el('thead', {}, head), el('tbody', {}, ...body))));
}

async function fillOptions(name, rows, label) {
  for (const select of $$(`select[data-options="${name}"]`)) {
    const keep = [...select.options].filter((o) => o.value === '');
    select.replaceChildren(...keep, ...rows.map((r) => el('option', { value: r.id }, label(r))));
  }
}

// ---- Views ----------------------------------------------------------------

const views = {
  async overview() {
    const m = await api('/admin/metrics');
    const tile = (label, value, target) => el('div', { className: 'tile' }, el('div', { className: 'label' }, label), el('div', { className: 'value' }, value ?? '—'), target ? el('div', { className: 'target muted' }, target) : null);
    const s = m.sales, p = m.payments, f = m.feedback, pu = m.pulse, c = m.compliance;
    const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '—');
    $('#metrics').replaceChildren(
      tile('Door knocks', s.door_knocks), tile('Leads', s.leads), tile('Appointments', s.appointments, `Rate ${pct(s.appointments, s.leads)}`),
      tile('Orders', s.orders, `Appt → order ${pct(s.orders, s.appointments)}`), tile('Activations', s.activations),
      tile('Paid within terms', p.pct_paid_within_terms != null ? `${p.pct_paid_within_terms}%` : '—', 'Target ≥ 70%'),
      tile('Overdue rate', p.overdue_rate != null ? `${p.overdue_rate}%` : '—', 'Target < 15%'),
      tile('Median days to pay', p.median_days_to_pay != null ? Math.round(p.median_days_to_pay) : '—', 'Target ≤ 35'),
      tile('Feedback submission', f.submission_rate != null ? `${f.submission_rate}%` : '—', 'Target ≥ 40%'),
      tile('Avg rating', f.avg_rating, 'Target ≥ 4.2'),
      tile('Pulse responses (7d)', `${pu.responses_this_week} / ${pu.coworkers}`, 'Target ≥ 60%'),
      tile('Pulse score (90d)', pu.score_90d),
      tile('Leads without consent', c.leads_without_consent, 'Must be 0'),
      tile('Do-not-knock check-ins', c.dnk_checkins, 'Must be 0'),
      tile('Addresses to review', c.properties_needing_review),
      tile('Open sync conflicts', c.open_conflicts),
    );
  },

  async review() {
    const [props, conflicts] = await Promise.all([api('/admin/properties?needs_review=1'), api('/admin/conflicts')]);
    const review = (p, valid) => api(`/admin/properties/${p.id}`, { method: 'PATCH', body: { seatac_valid: valid, review_note: valid ? 'Approved by reviewer' : 'Confirmed out of area' } }).then(() => views.review());
    table('review-properties', props, [
      ['Address', (p) => p.address], ['Coordinates', (p) => (p.lat ? `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}` : 'not geocoded')], ['Note', (p) => p.review_note],
      ['', (p) => el('div', { className: 'actions' }, button('Inside SeaTac', () => review(p, true)), button('Out of area', () => review(p, false), 'small danger'))],
    ]);
    table('review-conflicts', conflicts, [
      ['When', (r) => day(r.created_at)], ['Coworker', (r) => r.user_name], ['Type', (r) => r.entity], ['Reason', (r) => badge(r.reason, 'bad')],
      ['Details', (r) => r.payload.address ?? r.payload.property_id ?? ''],
      ['', (r) => button('Resolve', () => api(`/admin/conflicts/${r.id}`, { method: 'PATCH', body: { note: 'Reviewed' } }).then(() => views.review()))],
    ]);
  },

  async routes() {
    const [routes, coworkers] = await Promise.all([api('/admin/routes'), api('/coworkers')]);
    fillOptions('coworkers', coworkers, (u) => u.display_name);
    const date = $('#route-form [name=route_date]');
    if (!date.value) date.value = new Date().toLocaleDateString('en-CA');
    table('routes', routes, [
      ['Date', (r) => r.route_date], ['Name', (r) => r.name], ['Coworker', (r) => r.coworker_name], ['Permit', (r) => r.permit_ref],
      ['Progress', (r) => `${r.knocked} / ${r.stops}`], ['Status', (r) => badge(r.status)],
    ]);
  },

  async dnk() {
    const rows = await api('/admin/dnk');
    table('dnk', rows, [
      ['Address', (r) => r.address], ['Reason', (r) => r.dnk_reason], ['Added', (r) => day(r.created_at)],
      ['', (r) => (me.role === 'admin' ? button('Remove', async () => { if (confirm(`Allow knocking at ${r.address} again?`)) { await api(`/admin/dnk/${r.id}`, { method: 'DELETE' }); views.dnk(); } }, 'small danger') : null)],
    ]);
  },

  async leads() {
    const f = formValues($('#lead-filter'));
    const rows = await api(`/leads?${new URLSearchParams(Object.entries(f).filter(([, v]) => v))}`);
    table('leads', rows, [
      ['Created', (r) => day(r.created_at)], ['Customer', (r) => r.customer_name], ['Address', (r) => el('span', {}, r.address, r.seatac_valid ? null : el('span', {}, ' ', badge('out of area', 'bad')))],
      ['Rep', (r) => r.coworker_name], ['Interest', (r) => JSON.parse(r.product_interest || '[]').join(', ')], ['Status', (r) => badge(r.status)],
    ]);
  },

  async orders() {
    const status = $('#order-filter [name=status]').value;
    const rows = await api(`/orders${status ? `?status=${status}` : ''}`);
    table('orders', rows, [
      ['Created', (r) => day(r.created_at)], ['Customer', (r) => r.customer_name], ['Address', (r) => r.address], ['Rep', (r) => r.coworker_name],
      ['Bundle', (r) => r.bundle.items.map((i) => i.sku).join(' + ')], ['Install', (r) => day(r.install_scheduled_at)],
      ['Open invoices', (r) => r.open_invoices || ''], ['Status', (r) => badge(r.status)],
    ], (r) => openOrder(r.id));
  },

  async invoices() {
    const { invoices } = await api('/invoices');
    table('invoices', invoices, [
      ['Due', (r) => r.due_date], ['Customer', (r) => r.customer_name], ['Description', (r) => r.description], ['Terms', (r) => (r.payment_term_days ? `Net ${r.payment_term_days}` : 'On receipt')],
      ['Amount', (r) => money(r.amount_cents)], ['Paid', (r) => money(r.amount_paid_cents)], ['Status', (r) => badge(r.status)],
      ['', (r) => (r.status === 'draft' ? button('Send', () => api(`/invoices/${r.id}/send`, { body: {} }).then(() => { toast('Invoice sent'); views.invoices(); })) : null)],
    ]);
  },

  async feedback() {
    const status = $('#feedback-filter [name=status]').value;
    const rows = await api(`/feedback/customer?status=${status}`);
    const moderate = (r, s) => api(`/feedback/customer/${r.id}/status`, { method: 'PATCH', body: { status: s, admin_note: prompt('Internal note (optional, never shown to the customer):') || undefined } }).then(() => views.feedback());
    table('feedback', rows, [
      ['When', (r) => day(r.created_at)], ['Customer', (r) => r.customer_name], ['Rep', (r) => r.coworker_name],
      ['Sales / Install / Clarity / Support', (r) => `${r.sales_rating} / ${r.install_rating} / ${r.clarity_rating} / ${r.support_rating}`],
      ['Comment', (r) => r.comment], ['Photo', (r) => (r.photo_key ? button('View', async () => window.open((await api('/files/sign', { body: { key: r.photo_key } })).url)) : null)],
      ['Internal note', (r) => r.admin_note], ['Status', (r) => badge(r.status)],
      ['', (r) => (r.status === 'pending' ? el('div', { className: 'actions' }, button('Approve', () => moderate(r, 'approved')), button('Reject', () => moderate(r, 'rejected'), 'small danger')) : null)],
    ]);
  },

  async scorecards() {
    const s = await api('/admin/scorecards');
    table('score-crews', s.crews, [
      ['Crew', (r) => r.name], ['Responses', (r) => r.n], ['Workload', (r) => (r.hidden ? 'hidden (< 3)' : r.workload)], ['Safety', (r) => r.safety], ['Support from lead', (r) => r.support],
    ]);
    table('score-people', s.people, [
      ['Coworker', (r) => r.display_name], ['Leads', (r) => r.leads], ['Orders', (r) => r.orders], ['Activations', (r) => r.activations], ['Kudos', (r) => r.kudos],
    ]);
    table('score-named', s.named_responses, [
      ['Week', (r) => r.iso_week], ['Coworker', (r) => r.display_name], ['Workload', (r) => r.workload_score], ['Safety', (r) => r.safety_score], ['Support', (r) => r.support_score],
      ['Follow-up', (r) => (r.followup_requested ? badge('requested', 'warn') : '')],
    ]);
  },

  async commissions() {
    const rows = await api('/admin/commissions');
    table('commissions', rows, [
      ['Order', (r) => r.order_id.slice(0, 8)], ['Coworker', (r) => r.coworker_name], ['Order status', (r) => badge(r.order_status)],
      ['Estimate', (r) => money(r.estimate_cents)], ['Actual', (r) => money(r.actual_cents)], ['Status', (r) => badge(r.status)],
      ['', (r) => button(r.status === 'reconciled' ? 'Adjust' : 'Reconcile', async () => {
        const v = prompt('Actual commission ($):', ((r.actual_cents ?? r.estimate_cents) / 100).toFixed(2));
        if (v == null) return;
        await api(`/admin/commissions/${r.order_id}`, { method: 'PATCH', body: { actual_cents: dollarsToCents(v) } });
        views.commissions();
      })],
    ]);
  },

  async catalog() {
    const [items, coverage] = await Promise.all([api('/admin/catalog'), api('/admin/coverage')]);
    table('catalog', items, [
      ['SKU', (r) => r.sku], ['Kind', (r) => r.kind], ['Name', (r) => r.name], ['Monthly', (r) => money(r.monthly_price_cents)], ['Promo', (r) => (r.promo_price_cents ? `${money(r.promo_price_cents)} × ${r.promo_months} mo` : '')],
      ['Tech', (r) => r.required_tech ?? 'any'], ['Commission', (r) => money(r.commission_cents)], ['Active', (r) => (r.active ? badge('active', 'ok') : badge('inactive'))],
    ], (r) => {
      const f = $('#catalog-form');
      for (const [k, v] of Object.entries({ ...r, monthly_price: r.monthly_price_cents / 100, promo_price: r.promo_price_cents ? r.promo_price_cents / 100 : '', commission: r.commission_cents / 100, active: String(!!r.active) })) {
        if (f.elements[k]) f.elements[k].value = v ?? '';
      }
      f.scrollIntoView({ behavior: 'smooth' });
    });
    table('coverage', coverage, [
      ['ZIP', (r) => r.zip], ['Street', (r) => r.street_norm ?? 'whole ZIP'], ['Tech', (r) => r.tech], ['Max speed', (r) => (r.max_speed_mbps ? `${r.max_speed_mbps} Mbps` : '')],
      ['', (r) => button('Delete', () => api(`/admin/coverage/${r.id}`, { method: 'DELETE' }).then(() => views.catalog()), 'small danger')],
    ]);
  },

  async users() {
    const [users, crews] = await Promise.all([api('/admin/users'), api('/admin/crews')]);
    fillOptions('crews', crews, (c) => c.name);
    fillOptions('leads', users.filter((u) => u.role === 'lead'), (u) => u.display_name);
    const crewName = (id) => crews.find((c) => c.id === id)?.name;
    table('users', users, [
      ['Name', (u) => u.display_name], ['Email', (u) => u.email], ['Role', (u) => u.role], ['Crew', (u) => crewName(u.crew_id)], ['Language', (u) => u.locale],
      ['Status', (u) => (u.active ? badge('active', 'ok') : badge('inactive', 'bad'))],
      ['', (u) => (u.id === me.id ? null : button(u.active ? 'Deactivate' : 'Reactivate', () => api(`/admin/users/${u.id}`, { method: 'PATCH', body: { active: !u.active } }).then(() => views.users()), u.active ? 'small danger' : 'small'))],
    ]);
    table('crews', crews, [['Crew', (c) => c.name], ['Lead', (c) => users.find((u) => u.id === c.lead_id)?.display_name]]);
  },

  async settings() {
    const s = await api('/admin/settings');
    const f = $('#settings-form');
    for (const [k, v] of Object.entries(s)) if (f.elements[k]) f.elements[k].value = v;
  },

  async audit() {
    const rows = await api('/admin/audit');
    table('audit', rows, [
      ['When', (r) => day(r.created_at)], ['Who', (r) => r.actor_name], ['Action', (r) => r.action], ['Entity', (r) => `${r.entity} ${r.entity_id?.slice(0, 8) ?? ''}`],
      ['Detail', (r) => el('code', {}, r.detail_json ?? '')],
    ]);
  },
};

// ---- Order dialog ---------------------------------------------------------

let currentOrder = null;

async function openOrder(id) {
  const o = await api(`/orders/${id}`);
  currentOrder = o;
  $('#order-title').textContent = `Order ${o.id.slice(0, 8)} · ${o.status}`;
  $('#order-summary').textContent = `${o.address ?? ''} · ${o.bundle.items.map((i) => i.name).join(' + ')} · ${money(o.bundle.monthly_total_cents)}/mo (billed by AT&T) · commission est. ${money(o.commission?.estimate_cents)}`;
  $('#order-edit [name=att_order_ref]').value = o.att_order_ref ?? '';
  const host = $('#order-timeline');
  host.replaceChildren(...o.timeline.map((stage) => {
    const row = $('#stage-row').content.firstElementChild.cloneNode(true);
    row.querySelector('.stage-name').textContent = stage.stage.replaceAll('_', ' ');
    row.elements.status.value = stage.status;
    row.elements.note_customer.value = stage.note_customer ?? '';
    row.elements.note_internal.value = stage.note_internal ?? '';
    if (stage.stage === 'install_scheduled') row.elements.at.hidden = false;
    row.onsubmit = guard(async (e) => {
      e.preventDefault();
      const v = formValues(row);
      const body = { status: v.status, note_customer: v.note_customer || undefined, note_internal: v.note_internal || undefined };
      if (v.at) body.at = new Date(v.at).toISOString();
      await api(`/timeline/${stage.id}`, { method: 'PATCH', body });
      toast(`${stage.stage.replaceAll('_', ' ')} updated`);
      openOrder(id);
    });
    return row;
  }));
  if (!$('#order-dialog').open) $('#order-dialog').showModal();
}

// ---- Forms ----------------------------------------------------------------

function onSubmit(selector, handler) {
  $(selector).addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    await handler(formValues(e.target), e.target);
  }));
}

function bindForms() {
  onSubmit('#route-form', async (v, form) => {
    const r = await api('/admin/routes', { body: { ...v, permit_ref: v.permit_ref || undefined, addresses: v.addresses.split('\n').map((a) => a.trim()).filter(Boolean) } });
    toast(`Route created: ${r.stops} stops. ${r.excluded_do_not_knock.length} do-not-knock removed. ${r.flagged_for_review.length} flagged for review.`);
    form.elements.addresses.value = '';
    views.routes();
  });
  onSubmit('#dnk-form', async (v, form) => { await api('/admin/dnk', { body: v }); form.reset(); toast('Added to do-not-knock list'); views.dnk(); });
  onSubmit('#lead-filter', () => views.leads());
  onSubmit('#order-filter', () => views.orders());
  onSubmit('#feedback-filter', () => views.feedback());
  onSubmit('#catalog-form', async (v, form) => {
    const num = (x) => (x === '' ? undefined : Number(x));
    await api('/admin/catalog', {
      body: {
        id: v.id || undefined, sku: v.sku, kind: v.kind, name: v.name, name_es: v.name_es || undefined, speed_mbps: num(v.speed_mbps),
        monthly_price_cents: dollarsToCents(v.monthly_price), promo_price_cents: dollarsToCents(v.promo_price), promo_months: num(v.promo_months),
        contract_months: num(v.contract_months), required_tech: v.required_tech || undefined, commission_cents: dollarsToCents(v.commission),
        eligibility_notes: v.eligibility_notes || undefined, active: v.active === 'true',
      },
    });
    form.reset();
    toast('Catalog saved');
    views.catalog();
  });
  onSubmit('#coverage-form', async (v, form) => {
    await api('/admin/coverage', { body: { ...v, street: v.street || undefined, max_speed_mbps: v.max_speed_mbps ? Number(v.max_speed_mbps) : undefined } });
    form.reset();
    views.catalog();
  });
  onSubmit('#user-form', async (v, form) => { await api('/admin/users', { body: { ...v, crew_id: v.crew_id || undefined } }); form.reset(); toast('User added. They sign in with their email.'); views.users(); });
  onSubmit('#crew-form', async (v, form) => { await api('/admin/crews', { body: { ...v, lead_id: v.lead_id || undefined } }); form.reset(); views.users(); });
  onSubmit('#settings-form', async (v) => { await api('/admin/settings', { method: 'PUT', body: v }); toast('Settings saved'); });
  onSubmit('#area-form', async (v) => {
    let geojson;
    try { geojson = JSON.parse(v.geojson); } catch { throw new Error('That is not valid JSON'); }
    await api('/admin/service-area', { method: 'PUT', body: { geojson: geojson.geometry ?? geojson } });
    toast('Service area updated');
  });
  onSubmit('#order-edit', async (v) => {
    await api(`/orders/${currentOrder.id}`, { method: 'PATCH', body: { att_order_ref: v.att_order_ref || undefined } });
    toast('Order saved');
  });
  $('#order-cancel').onclick = guard(async () => {
    const reason = $('#order-edit [name=cancelled_reason]').value.trim();
    if (!reason) throw new Error('Enter a cancel reason first');
    if (!confirm('Cancel this order?')) return;
    await api(`/orders/${currentOrder.id}`, { method: 'PATCH', body: { status: 'cancelled', cancelled_reason: reason } });
    $('#order-dialog').close();
    views.orders();
  });
  onSubmit('#invoice-form', async (v, form) => {
    const inv = await api('/invoices', { body: { order_id: currentOrder.id, description: v.description, amount_cents: dollarsToCents(v.amount), payment_term_days: Number(v.payment_term_days), send: v.send === 'on' } });
    form.reset();
    toast(`Invoice ${inv.status}: ${money(inv.amount_cents)} due ${inv.due_date}`);
  });
}

// ---- Navigation & auth ------------------------------------------------------

function show(name) {
  const allowed = $$('.sidebar a').filter((a) => !a.hidden).map((a) => a.hash.slice(1));
  if (!allowed.includes(name)) name = allowed[0];
  for (const s of $$('section[data-view]')) s.hidden = s.dataset.view !== name;
  for (const a of $$('.sidebar a')) a.classList.toggle('active', a.hash === `#${name}`);
  guard(views[name])();
}

async function start() {
  me = await api('/me');
  if (me.role === 'customer' || me.role === 'coworker') {
    session.clear();
    throw new Error('The admin console is for team leads, office staff and admins. Use the DealerDoor app.');
  }
  $('#me-name').textContent = `${me.display_name ?? me.email} · ${me.role}`;
  for (const a of $$('.sidebar a')) a.hidden = !a.dataset.roles.split(' ').includes(me.role);
  $('#login').hidden = true;
  $('#app').hidden = false;
  bindForms();
  window.addEventListener('hashchange', () => show(location.hash.slice(1)));
  show(location.hash.slice(1) || 'overview');
}

async function boot() {
  // Arriving from an emailed magic link: /auth/verify redirects to /#magic=<token>.
  const magic = new URLSearchParams(location.hash.slice(1)).get('magic');
  if (magic) {
    history.replaceState(null, '', '/');
    try { session.save(await api('/auth/verify', { body: { token: magic } })); } catch (e) { $('#login-msg').textContent = e.message; }
  }
  if (session.access) {
    try { return await start(); } catch (e) { $('#login-msg').textContent = e.message; }
  }
  $('#login').hidden = false;
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = formValues(e.target);
  const msg = $('#login-msg');
  try {
    const res = await api('/auth/login', { body: { email: v.email, password: v.password || undefined } });
    if (res.access_token) { session.save(res); return start().catch((err) => (msg.textContent = err.message)); }
    if (res.dev_token) { session.save(await api('/auth/verify', { body: { token: res.dev_token } })); return start(); } // local dev only
    msg.textContent = 'Check your email for a sign-in link.';
  } catch (err) {
    msg.textContent = err.message;
  }
});

$('#logout').onclick = async () => {
  await api('/auth/logout', { body: { refresh_token: session.refresh } }).catch(() => {});
  session.clear();
  location.href = '/';
};

boot();
