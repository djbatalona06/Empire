'use strict';
// Sign-in shared by the admin console (index.html) and the phone map (map.html).
// Both pages have the same #login and #locked blocks. Load this file before the page's own script.
//
// Step 1  email -> one-time link (or a password straight away)
// Step 2  accounts that need a password see the #locked block and load no data until it is entered

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function formValues(form) {
  const out = {};
  for (const [k, v] of new FormData(form)) out[k] = typeof v === 'string' ? v.trim() : v;
  return out;
}

// ---- Session (tab-scoped; closing the tab signs out) ----------------------

const session = {
  get access() { return sessionStorage.getItem('access'); },
  get refresh() { return sessionStorage.getItem('refresh'); },
  save(t) { sessionStorage.setItem('access', t.access_token); sessionStorage.setItem('refresh', t.refresh_token); },
  clear() { sessionStorage.clear(); },
};

/** The signed-in person, as returned by GET /v1/me. */
let me = null;

async function api(path, { method, body } = {}, retried = false) {
  const res = await fetch(`/v1${path}`, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(session.access && { authorization: `Bearer ${session.access}` }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  // A wrong password is also a 401, and retrying it would count as a second wrong try.
  if (res.status === 401 && session.refresh && !retried && !path.startsWith('/auth/')) {
    const r = await fetch('/v1/auth/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: session.refresh }) });
    if (r.ok) { session.save(await r.json()); return api(path, { method, body }, true); }
    session.clear(); location.reload();
  }
  const data = await res.json().catch(() => ({}));
  // The server says this sign-in has not entered its password yet: go back to the locked screen.
  if (res.status === 403 && data.error === 'password_required') { location.reload(); return new Promise(() => {}); }
  if (!res.ok) throw new Error(data.message && data.message !== data.error ? data.message : (data.error ?? `HTTP ${res.status}`).replaceAll('_', ' '));
  return data;
}

// ---- The flow ---------------------------------------------------------------

/**
 * Runs sign-in and calls ready(me) once the person is fully in.
 * accepts(me) decides who may use the page: return null to allow, a sentence to refuse,
 * or { redirect: '/somewhere' } to send them to a page that suits their role.
 */
function bootAuth({ accepts, ready }) {
  async function start() {
    me = await api('/me');
    const verdict = accepts(me);
    if (verdict && typeof verdict === 'object') return location.replace(verdict.redirect);
    if (verdict) {
      session.clear();
      throw new Error(verdict);
    }
    // Emailed link only: show the password step and load nothing else until it is entered.
    if (me.require_password && me.aal < 2) return showLocked();
    $('#locked').hidden = true;
    $('#login').hidden = true;
    await ready(me);
  }

  function showLocked() {
    const first = !me.has_password;
    $('#login').hidden = true;
    $('#app')?.setAttribute('hidden', '');
    $('#locked').hidden = false;
    $('#unlock-intro').textContent = `You are signed in as ${me.email}. ${first ? 'Create a password' : 'Enter your password'} to unlock invoices, sales and leads.`;
    $('#confirm-row').hidden = !first;
    $('#unlock-hint').hidden = !first;
    $('#unlock-btn').textContent = first ? 'Create password' : 'Unlock';
    $('#unlock-form [name=password]').autocomplete = first ? 'new-password' : 'current-password';
  }

  async function boot() {
    // Arriving from an emailed magic link: /auth/verify redirects to /#magic=<token>.
    const magic = new URLSearchParams(location.hash.slice(1)).get('magic');
    if (magic) {
      history.replaceState(null, '', location.pathname);
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

  $('#unlock-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = formValues(e.target);
    const msg = $('#unlock-msg');
    msg.textContent = '';
    try {
      if (!me.has_password && v.password !== v.confirm) throw new Error('The two passwords do not match');
      // First time: set the password. After that: prove it. Either way the answer is a full sign-in.
      session.save(await api(me.has_password ? '/auth/step-up' : '/auth/password', { body: { password: v.password } }));
      e.target.reset();
      await start();
    } catch (err) {
      msg.textContent = err.message;
    }
  });

  window.signOut = async () => {
    await api('/auth/logout', { body: { refresh_token: session.refresh } }).catch(() => {});
    session.clear();
    location.href = '/';
  };
  $('#unlock-signout').onclick = window.signOut;

  return boot();
}
