import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { addBusinessDays, csvCell, pacificDateOf, toCsv } from '../src/lib/util';
import { api, leadBody, login, orderFlow, property, user } from './helpers';

declare global {
  namespace Cloudflare {
    interface Env {
      FILES: R2Bucket;
    }
  }
}

const getCsv = async (path: string, token: string) => {
  const res = await api(path, { token });
  return res;
};

describe('csv cells', () => {
  it('quotes commas, quotes and new lines', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
  });

  it('defuses spreadsheet formulas but leaves numbers alone', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe('"\'=HYPERLINK(""http://evil"")"');
    expect(csvCell('+15551234567')).toBe("'+15551234567");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(null)).toBe('');
  });

  it('writes a header row and one line per row', () => {
    expect(toCsv(['a', 'b'], [{ a: 1, b: 'x' }, { a: 2, b: null }])).toBe('a,b\r\n1,x\r\n2,\r\n');
  });
});

describe('csv export', () => {
  it('needs a sign-in and the right role', async () => {
    expect((await api('/v1/admin/export/leads')).status).toBe(401);
    const rep = await user('coworker');
    expect((await api('/v1/admin/export/leads', { token: rep.token })).status).toBe(403);
    const lead = await user('lead');
    expect((await api('/v1/admin/export/orders', { token: lead.token })).status).toBe(403);
  });

  it('keeps commissions for admins only', async () => {
    const office = await user('office');
    expect((await api('/v1/admin/export/commissions', { token: office.token })).status).toBe(403);
    const admin = await user('admin');
    const { SELF } = await import('cloudflare:test');
    const res = await SELF.fetch('http://dealerdoor.test/v1/admin/export/commissions', { headers: { authorization: `Bearer ${admin.token}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect((await res.text()).startsWith('order_id,coworker,estimate_dollars')).toBe(true);
  });

  it('exports real rows, defuses formulas, and writes an audit row', async () => {
    const { office, lead } = await orderFlow();
    await env.DB.prepare('UPDATE leads SET customer_name = ? WHERE id = ?').bind('=SUM(1+1)', lead.id).run();
    const { SELF } = await import('cloudflare:test');
    const res = await SELF.fetch('http://dealerdoor.test/v1/admin/export/leads', { headers: { authorization: `Bearer ${office.token}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="dealerdoor-leads-\d{4}-\d{2}-\d{2}\.csv"/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(text).toContain(lead.id);
    expect(text).toContain("'=SUM(1+1)");
    expect(text).not.toMatch(/,=SUM/);
    const logged = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'export.csv' AND actor_id = ?`).bind(office.id).first<{ n: number }>();
    expect(logged!.n).toBe(1);
  });

  it('rejects an unknown export name', async () => {
    const admin = await user('admin');
    expect((await getCsv('/v1/admin/export/users', admin.token)).status).toBe(404);
    expect((await getCsv('/v1/admin/export/__proto__', admin.token)).status).toBe(404);
  });
});

describe('business days', () => {
  it('skips weekends', () => {
    expect(addBusinessDays('2026-11-06', 3)).toBe('2026-11-11'); // Friday + 3 = Wednesday
    expect(addBusinessDays('2026-11-02', 3)).toBe('2026-11-05'); // Monday + 3 = Thursday
    expect(addBusinessDays('2026-11-07', 1)).toBe('2026-11-09'); // Saturday + 1 = Monday
    expect(addBusinessDays('2026-11-06', 0)).toBe('2026-11-06');
  });

  it('reads database timestamps as UTC and answers in Pacific time', () => {
    expect(pacificDateOf('2026-11-06 03:41:54')).toBe('2026-11-05'); // 7:41 pm the evening before
    expect(pacificDateOf('2026-11-06T20:00:00Z')).toBe('2026-11-06');
  });
});

describe('customer cancellation request', () => {
  it('lets the customer ask once, shows it to staff, and staff then cancel', async () => {
    const { office, orderId, customerToken } = await orderFlow();
    const before = await api(`/v1/orders/${orderId}`, { token: customerToken });
    expect(before.body.cancel_eligible).toBe(true);
    expect(before.body.cancel_deadline).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const asked = await api(`/v1/orders/${orderId}/cancel-request`, { token: customerToken, body: { reason: 'Moving away' } });
    expect(asked.status).toBe(200);

    const after = await api(`/v1/orders/${orderId}`, { token: customerToken });
    expect(after.body.cancel_eligible).toBe(false);
    expect(after.body.cancel_requested_at).toBeTruthy();

    const staff = await api(`/v1/orders/${orderId}`, { token: office.token });
    expect(staff.body.cancel_requested_at).toBeTruthy();
    expect(staff.body.cancel_request_reason).toBe('Moving away');
    const list = await api('/v1/orders', { token: office.token });
    expect(list.body.find((o: { id: string }) => o.id === orderId).cancel_requested_at).toBeTruthy();

    expect((await api(`/v1/orders/${orderId}/cancel-request`, { token: customerToken, body: {} })).body.error).toBe('already_requested');

    const done = await api(`/v1/orders/${orderId}`, { token: office.token, method: 'PATCH', body: { status: 'cancelled', cancelled_reason: 'Customer request' } });
    expect(done.status).toBe(200);
    const logged = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'order.cancel_request' AND entity_id = ?`).bind(orderId).first<{ n: number }>();
    expect(logged!.n).toBe(1);
  });

  it('only lets the order owner ask, and only customers', async () => {
    const { orderId, rep } = await orderFlow();
    expect((await api(`/v1/orders/${orderId}/cancel-request`, { token: (await user('customer')).token, body: {} })).status).toBe(404);
    expect((await api(`/v1/orders/${orderId}/cancel-request`, { token: rep.token, body: {} })).status).toBe(403);
    expect((await api(`/v1/orders/${orderId}/cancel-request`, { body: {} })).status).toBe(401);
  });

  it('refuses once the order is active', async () => {
    const { orderId, customerToken } = await orderFlow();
    await env.DB.prepare(`UPDATE orders SET status = 'activated' WHERE id = ?`).bind(orderId).run();
    const res = await api(`/v1/orders/${orderId}/cancel-request`, { token: customerToken, body: {} });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('cannot_cancel_active_order');
    expect((await api(`/v1/orders/${orderId}`, { token: customerToken })).body.cancel_eligible).toBe(false);
  });

  it('refuses after the window and follows the setting', async () => {
    const { orderId, customerToken } = await orderFlow();
    await env.DB.prepare(`UPDATE orders SET created_at = datetime('now', '-30 days') WHERE id = ?`).bind(orderId).run();
    const late = await api(`/v1/orders/${orderId}/cancel-request`, { token: customerToken, body: {} });
    expect(late.status).toBe(409);
    expect(late.body.error).toBe('cancel_window_closed');
    expect((await api(`/v1/orders/${orderId}`, { token: customerToken })).body.cancel_eligible).toBe(false);

    // Admins can widen the window (counsel decides the real number).
    const admin = await user('admin');
    expect((await api('/v1/admin/settings', { token: admin.token, method: 'PUT', body: { cancel_window_business_days: 60 } })).status).toBe(200);
    try {
      expect((await api(`/v1/orders/${orderId}/cancel-request`, { token: customerToken, body: {} })).status).toBe(200);
    } finally {
      await env.DB.prepare(`UPDATE settings SET value = '3' WHERE key = 'cancel_window_business_days'`).run();
    }
  });

  it('rejects a reason that is too long', async () => {
    const { orderId, customerToken } = await orderFlow();
    expect((await api(`/v1/orders/${orderId}/cancel-request`, { token: customerToken, body: { reason: 'x'.repeat(301) } })).status).toBe(400);
  });
});

describe('customer account deletion', () => {
  const cancelOrder = (officeToken: string, orderId: string) =>
    api(`/v1/orders/${orderId}`, { token: officeToken, method: 'PATCH', body: { status: 'cancelled', cancelled_reason: 'Test' } });

  it('is only for signed-in customers', async () => {
    expect((await api('/v1/me', { method: 'DELETE' })).status).toBe(401);
    expect((await api('/v1/me', { method: 'DELETE', token: (await user('coworker')).token })).status).toBe(403);
  });

  it('is refused while an order or an unpaid invoice is open', async () => {
    const { office, orderId, customerToken } = await orderFlow();
    const open = await api('/v1/me', { method: 'DELETE', token: customerToken });
    expect(open.status).toBe(409);
    expect(open.body.error).toBe('account_has_open_items');
    expect(open.body.open_orders).toBe(1);

    // An unpaid invoice still blocks deletion after the order itself is cancelled.
    const inv = await api('/v1/invoices', { token: office.token, body: { order_id: orderId, amount_cents: 5000, payment_term_days: 30, description: 'Activation fee', send: true } });
    expect(inv.status).toBe(201);
    expect((await cancelOrder(office.token, orderId)).status).toBe(200);
    const unpaid = await api('/v1/me', { method: 'DELETE', token: customerToken });
    expect(unpaid.status).toBe(409);
    expect(unpaid.body).toMatchObject({ error: 'account_has_open_items', open_orders: 0, open_invoices: 1 });
    expect((await api('/v1/me', { token: customerToken })).status).toBe(200); // nothing was removed
  });

  it('blanks the person, keeps consent evidence, removes photos, and ends every session', async () => {
    const { office, orderId, customerToken, lead, rep } = await orderFlow();
    const me = (await api('/v1/me', { token: customerToken })).body as { id: string; email: string };

    // A door photo on the sign-up, and a feedback photo + comment from the customer.
    const doorKey = `door_photo/${rep.id}/${crypto.randomUUID()}.jpg`;
    const feedbackKey = `feedback_photo/${me.id}/${crypto.randomUUID()}.jpg`;
    await env.FILES.put(doorKey, 'door');
    await env.FILES.put(feedbackKey, 'feedback');
    await env.DB.prepare('UPDATE leads SET photo_key = ? WHERE id = ?').bind(doorKey, lead.id).run();
    await env.DB.prepare(`INSERT INTO customer_feedback (id, order_id, customer_id, sales_rating, comment, photo_key) VALUES (?, ?, ?, 5, 'Call me at 206-555-0100', ?)`)
      .bind(crypto.randomUUID(), orderId, me.id, feedbackKey)
      .run();

    expect((await cancelOrder(office.token, orderId)).status).toBe(200);
    const gone = await api('/v1/me', { method: 'DELETE', token: customerToken });
    expect(gone.status).toBe(200);

    const row = await env.DB.prepare('SELECT email, display_name, phone, password_hash, active, deleted_at FROM users WHERE id = ?').bind(me.id).first<Record<string, unknown>>();
    expect(row!.email).toBe(`deleted-${me.id}@deleted.invalid`);
    expect(row).toMatchObject({ display_name: 'Deleted customer', phone: null, password_hash: null, active: 0 });
    expect(row!.deleted_at).toBeTruthy();

    const l = await env.DB.prepare('SELECT customer_name, phone, email, photo_key, tcpa_consent_at, consent_text_version, disclosure_ack_at FROM leads WHERE id = ?').bind(lead.id).first<Record<string, unknown>>();
    expect(l).toMatchObject({ customer_name: null, phone: null, email: null, photo_key: null });
    expect(l!.tcpa_consent_at).toBeTruthy();
    expect(l!.consent_text_version).toBe('v1');
    expect(l!.disclosure_ack_at).toBeTruthy();
    const consents = await env.DB.prepare('SELECT COUNT(*) AS n FROM consents WHERE lead_id = ?').bind(lead.id).first<{ n: number }>();
    expect(consents!.n).toBeGreaterThan(0);

    const fb = await env.DB.prepare('SELECT comment, photo_key, sales_rating FROM customer_feedback WHERE customer_id = ?').bind(me.id).first<Record<string, unknown>>();
    expect(fb).toMatchObject({ comment: null, photo_key: null, sales_rating: 5 });
    expect(await env.FILES.get(doorKey)).toBeNull();
    expect(await env.FILES.get(feedbackKey)).toBeNull();

    // Signed out everywhere: the old token, a refresh, and a new sign-in link for the old email all fail.
    expect((await api('/v1/me', { token: customerToken })).status).toBe(401);
    const again = await api('/v1/auth/login', { body: { email: me.email } });
    expect(again.body.sent).toBe(true);
    expect(again.body.dev_token).toBeUndefined();
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL').bind(me.id).first<{ n: number }>())!.n).toBe(0);

    const audited = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'account.delete' AND entity_id = ?`).bind(me.id).first<{ n: number }>();
    expect(audited!.n).toBe(1);
    expect(JSON.stringify(await env.DB.prepare(`SELECT detail_json FROM audit_log WHERE action = 'account.delete' AND entity_id = ?`).bind(me.id).first())).not.toContain(me.email);

    // An admin cannot turn a deleted account back on.
    const admin = await user('admin');
    const back = await api(`/v1/admin/users/${me.id}`, { token: admin.token, method: 'PATCH', body: { active: true } });
    expect(back.status).toBe(409);
    expect(back.body.error).toBe('account_deleted');
  });

  it('lets the same email sign up again as a new, separate customer', async () => {
    const { office, orderId, customerToken, lead, rep } = await orderFlow();
    const me = (await api('/v1/me', { token: customerToken })).body as { id: string };
    await cancelOrder(office.token, orderId);
    expect((await api('/v1/me', { method: 'DELETE', token: customerToken })).status).toBe(200);

    const second = leadBody(await property(), lead.email);
    expect((await api('/v1/leads', { token: rep.token, body: second })).status).toBe(201);
    expect((await api('/v1/orders', { token: rep.token, body: { lead_id: second.id, skus: ['AIR'] } })).status).toBe(201);
    const token = await login(lead.email);
    const fresh = (await api('/v1/me', { token })).body as { id: string };
    expect(fresh.id).not.toBe(me.id);
  });
});
