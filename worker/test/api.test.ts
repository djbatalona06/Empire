import { env } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';

const worker = (exports as unknown as { default: Fetcher }).default;
import { describe, expect, it } from 'vitest';
import { SEATAC, SEATTLE, api, leadBody, login, orderFlow, property, user } from './helpers';
import { reminderFor, runDaily } from '../src/cron';
import handler from '../src/index';
import { hmac } from '../src/lib/crypto';
import { pointInArea } from '../src/lib/geo';
import { addDays, isoWeek, todayPacific } from '../src/lib/util';


async function completeStage(officeToken: string, orderId: string, stage: string, extra: Record<string, unknown> = {}) {
  const rows = (await api(`/v1/orders/${orderId}/timeline`, { token: officeToken })).body as { id: string; stage: string }[];
  return api(`/v1/timeline/${rows.find((r) => r.stage === stage)!.id}`, { method: 'PATCH', token: officeToken, body: { status: 'complete', ...extra } });
}

describe('pure helpers', () => {
  it('validates SeaTac polygon membership', async () => {
    const { geojson } = (await env.DB.prepare(`SELECT geojson FROM service_area WHERE id = 'seatac'`).first<{ geojson: string }>())!;
    expect(pointInArea(SEATAC.lat, SEATAC.lng, JSON.parse(geojson))).toBe(true);
    expect(pointInArea(SEATTLE.lat, SEATTLE.lng, JSON.parse(geojson))).toBe(false);
  });

  it('schedules reminders at T-3, T0, T+7, T+30', () => {
    expect(reminderFor('2026-11-10', '2026-11-06')).toBeNull();
    expect(reminderFor('2026-11-10', '2026-11-07')).toBe('T-3');
    expect(reminderFor('2026-11-10', '2026-11-10')).toBe('T0');
    expect(reminderFor('2026-11-10', '2026-11-16')).toBe('T0');
    expect(reminderFor('2026-11-10', '2026-11-17')).toBe('T+7');
    expect(reminderFor('2026-11-10', '2026-12-10')).toBe('T+30');
  });

  it('labels ISO weeks', () => expect(isoWeek('2026-10-25')).toBe('2026-W43'));
});

describe('auth', () => {
  it('magic link is single-use and unknown emails look identical', async () => {
    const u = await user('coworker');
    expect((await api('/v1/me', { token: u.token })).body.role).toBe('coworker');
    const unknown = await api('/v1/auth/login', { body: { email: 'nobody@example.com' } });
    expect(unknown.body).toEqual({ sent: true });

    const sent = await api('/v1/auth/login', { body: { email: u.email } });
    expect((await api('/v1/auth/verify', { body: { token: sent.body.dev_token } })).status).toBe(200);
    expect((await api('/v1/auth/verify', { body: { token: sent.body.dev_token } })).status).toBe(401);
  });

  it('rotates refresh tokens and blocks deactivated users', async () => {
    const u = await user('coworker');
    const sent = await api('/v1/auth/login', { body: { email: u.email } });
    const tokens = (await api('/v1/auth/verify', { body: { token: sent.body.dev_token } })).body;
    const next = await api('/v1/auth/refresh', { body: { refresh_token: tokens.refresh_token } });
    expect(next.status).toBe(200);
    expect((await api('/v1/auth/refresh', { body: { refresh_token: tokens.refresh_token } })).status).toBe(401);

    await env.DB.prepare('UPDATE users SET active = 0 WHERE id = ?').bind(u.id).run();
    expect((await api('/v1/me', { token: next.body.access_token })).status).toBe(401);
  });

  it('enforces roles', async () => {
    const customer = await user('customer');
    expect((await api('/v1/leads', { token: customer.token })).status).toBe(403);
    expect((await api('/v1/admin/audit', { token: (await user('coworker')).token })).status).toBe(403);
  });
});

describe('app links', () => {
  it('publishes Android asset links only when a signing fingerprint is configured', async () => {
    expect((await api('/.well-known/assetlinks.json')).body).toEqual([]);
    const withCert = await handler.fetch(new Request('http://dealerdoor.test/.well-known/assetlinks.json'), { ...env, ANDROID_CERT_SHA256: 'AA:BB, CC:DD' } as never, {} as never);
    expect(await withCert.json()).toEqual([
      { relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: 'com.dealerdoor.app', sha256_cert_fingerprints: ['AA:BB', 'CC:DD'] } },
    ]);
  });
});

describe('door-to-door compliance', () => {
  it('rejects do-not-knock check-ins and logs a conflict', async () => {
    const rep = await user('coworker');
    const dnk = await property({ dnk: true });
    const res = await api('/v1/check-ins', { token: rep.token, body: { property_id: dnk, outcome: 'interested', ...SEATAC } });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('do_not_knock');
    const conflict = await env.DB.prepare('SELECT reason FROM sync_conflicts WHERE id = ?').bind(res.body.conflict_id).first();
    expect(conflict?.reason).toBe('do_not_knock');
    expect((await api('/v1/leads', { token: rep.token, body: leadBody(dnk) })).status).toBe(403);
  });

  it('geo-verifies check-ins and replays idempotently', async () => {
    const rep = await user('coworker');
    const prop = await property();
    const far = await api('/v1/check-ins', { token: rep.token, body: { property_id: prop, outcome: 'no_answer', lat: SEATAC.lat + 0.01, lng: SEATAC.lng } });
    expect(far.status).toBe(422);
    const id = crypto.randomUUID();
    const ok = await api('/v1/check-ins', { token: rep.token, body: { id, property_id: prop, outcome: 'interested', lat: SEATAC.lat + 0.0002, lng: SEATAC.lng } });
    expect(ok.status).toBe(201);
    expect(ok.body.distance_m).toBeLessThan(100);
    const replay = await api('/v1/check-ins', { token: rep.token, body: { id, property_id: prop, outcome: 'interested', ...SEATAC } });
    expect(replay.status).toBe(200);
  });

  it('requires TCPA consent and stores immutable consent evidence', async () => {
    const rep = await user('coworker');
    const body = leadBody(await property());
    expect((await api('/v1/leads', { token: rep.token, body: { ...body, tcpa_accepted: false } })).body.error).toBe('tcpa_consent_required');
    expect((await api('/v1/leads', { token: rep.token, body: { ...body, consent_text_version: 'v99' } })).body.error).toBe('unknown_consent_version');
    expect((await api('/v1/leads', { token: rep.token, body })).status).toBe(201);
    const { results } = await env.DB.prepare('SELECT kind, rep_id, address_snapshot, text_version FROM consents WHERE lead_id = ?').bind(body.id).all();
    expect(results.map((r) => r.kind).sort()).toEqual(['d2d_disclosure', 'tcpa']);
    expect(results.every((r) => r.rep_id === rep.id && r.text_version === 'v1' && r.address_snapshot)).toBe(true);
  });

  it('flags out-of-area addresses for review instead of blocking', async () => {
    const rep = await user('coworker');
    const { id, property_id, ...rest } = leadBody('');
    const res = await api('/v1/leads', { token: rep.token, body: { ...rest, address: '400 Pine St, Seattle, WA 98101', ...SEATTLE } });
    expect(res.status).toBe(201);
    expect(res.body.out_of_area).toBe(true);
    const p = await env.DB.prepare('SELECT needs_review FROM properties WHERE id = ?').bind(res.body.property_id).first();
    expect(p?.needs_review).toBe(1);
  });

  it('marks leads not serviceable when no coverage exists', async () => {
    const rep = await user('coworker');
    const covered = leadBody(await property());
    await api('/v1/leads', { token: rep.token, body: covered });
    const ok = await api(`/v1/leads/${covered.id}/serviceability`, { token: rep.token, body: {} });
    expect(ok.body.serviceable).toBe(true);
    expect(ok.body.items.some((i: { sku: string }) => i.sku === 'AIR')).toBe(true);
    expect(ok.body.items.some((i: { sku: string }) => i.sku === 'FIBER-1G')).toBe(false);

    const uncovered = leadBody(await property({ address: '1 Nowhere Rd, SeaTac, WA 98000' }));
    await env.DB.prepare(`UPDATE properties SET zip = '98000' WHERE id = ?`).bind(uncovered.property_id).run();
    await api('/v1/leads', { token: rep.token, body: uncovered });
    const no = await api(`/v1/leads/${uncovered.id}/serviceability`, { token: rep.token, body: {} });
    expect(no.body.serviceable).toBe(false);
    expect((await env.DB.prepare('SELECT status FROM leads WHERE id = ?').bind(uncovered.id).first())?.status).toBe('not_serviceable');
  });

  it('excludes do-not-knock addresses when assigning routes', async () => {
    const lead = await user('lead');
    const rep = await user('coworker');
    const [a, b] = [await property(), await property({ dnk: true })];
    const res = await api('/v1/admin/routes', { token: lead.token, body: { name: 'SeaTac North', coworker_id: rep.id, route_date: todayPacific(), property_ids: [a, b] } });
    expect(res.status).toBe(201);
    expect(res.body.stops).toBe(1);
    expect(res.body.excluded_do_not_knock).toHaveLength(1);
    const mine = await api('/v1/routes/mine', { token: rep.token });
    expect(mine.body[0].stops[0].property_id).toBe(a);
    expect(mine.body[0].permit_ref).toBe('SEATAC-PERMIT-PENDING');
  });
});

describe('orders and timeline', () => {
  it('creates customer, timeline and commission; customer sees simplified stages', async () => {
    const { office, orderId, customerToken, rep } = await orderFlow();
    const staff = await api(`/v1/orders/${orderId}`, { token: office.token });
    expect(staff.body.timeline).toHaveLength(11);
    expect(staff.body.commission.estimate_cents).toBe(4500);

    const cust = await api(`/v1/orders/${orderId}`, { token: customerToken });
    expect(cust.body.timeline.map((s: { key: string }) => s.key)).toEqual(['order_received', 'install_scheduled', 'installed', 'activated', 'feedback_available']);
    expect(cust.body.coworker_id).toBeUndefined();
    expect(cust.body.billing_notice).toMatch(/billed separately by AT&T/);
    expect(JSON.stringify(cust.body)).not.toContain('note_internal');
    expect(cust.body.feedback_unlocked).toBe(false);

    // Other customers can't read it (no client-supplied customer ids).
    expect((await api(`/v1/orders/${orderId}`, { token: (await user('customer')).token })).status).toBe(404);
    expect((await api(`/v1/orders/${orderId}`, { token: rep.token })).status).toBe(200);
  });

  it('advances stages in order and unlocks feedback after activation', async () => {
    const { office, orderId, customerToken } = await orderFlow();
    expect((await completeStage(office.token, orderId, 'activated')).status).toBe(409);
    expect((await completeStage(office.token, orderId, 'install_scheduled')).body.error).toBe('at_required');
    const at = new Date(Date.now() + 86_400_000).toISOString();
    expect((await completeStage(office.token, orderId, 'install_scheduled', { at })).status).toBe(200);

    const feedback = { order_id: orderId, sales_rating: 5, install_rating: 4, clarity_rating: 5, support_rating: 4, comment: 'Great rep' };
    expect((await api('/v1/feedback/customer', { token: customerToken, body: feedback })).body.error).toBe('feedback_locked');

    await completeStage(office.token, orderId, 'install_complete');
    await completeStage(office.token, orderId, 'activated');
    const order = await api(`/v1/orders/${orderId}`, { token: customerToken });
    expect(order.body.status).toBe('activated');
    expect(order.body.install_scheduled_at).toBe(at);
    expect(order.body.feedback_unlocked).toBe(true);

    expect((await api('/v1/feedback/customer', { token: customerToken, body: feedback })).status).toBe(201);
    expect((await api('/v1/feedback/customer', { token: customerToken, body: feedback })).status).toBe(409);
    expect((await api('/v1/feedback/customer', { token: customerToken, body: { ...feedback, comment: 'x'.repeat(1001) } })).status).toBe(400);

    // Moderation: summary counts approved only, admin_note never reaches the customer.
    const admin = await user('admin');
    const [pending] = (await api('/v1/feedback/customer', { token: admin.token })).body;
    await api(`/v1/feedback/customer/${pending.id}/status`, { method: 'PATCH', token: admin.token, body: { status: 'approved', admin_note: 'internal only' } });
    expect((await api('/v1/feedback/summary', { token: customerToken })).body.count).toBe(1);
    expect(JSON.stringify((await api('/v1/feedback/customer/mine', { token: customerToken })).body)).not.toContain('internal only');
    const auditRow = await env.DB.prepare(`SELECT action FROM audit_log WHERE entity_id = ?`).bind(pending.id).first();
    expect(auditRow?.action).toBe('feedback.approved');
  });

  it('closing requires admin and a reconciled commission', async () => {
    const { office, orderId } = await orderFlow();
    const admin = await user('admin');
    await completeStage(office.token, orderId, 'install_scheduled', { at: new Date().toISOString() });
    await completeStage(office.token, orderId, 'install_complete');
    await completeStage(office.token, orderId, 'activated');
    await completeStage(office.token, orderId, 'invoice_paid');
    expect((await completeStage(office.token, orderId, 'closed')).status).toBe(403);
    expect((await completeStage(admin.token, orderId, 'closed')).body.error).toBe('commission_not_reconciled');
    await api(`/v1/admin/commissions/${orderId}`, { method: 'PATCH', token: admin.token, body: { actual_cents: 4300 } });
    expect((await completeStage(admin.token, orderId, 'closed')).status).toBe(200);
  });
});

describe('invoices and payments', () => {
  it('runs draft → sent → viewed → partial → paid with 0–60 day terms', async () => {
    const { office, orderId, customerToken } = await orderFlow();
    expect((await api('/v1/invoices', { token: office.token, body: { order_id: orderId, amount_cents: 9900, payment_term_days: 20, description: 'MDU wiring' } })).body.error).toBe('invalid_term');
    const inv = await api('/v1/invoices', { token: office.token, body: { order_id: orderId, amount_cents: 9900, payment_term_days: 45, description: 'MDU wiring' } });
    expect(inv.body.status).toBe('draft');
    expect((await api(`/v1/invoices/${inv.body.id}`, { token: customerToken })).status).toBe(404); // drafts hidden

    const sent = await api(`/v1/invoices/${inv.body.id}/send`, { token: office.token, body: {} });
    expect(sent.body.due_date).toBe(addDays(todayPacific(), 45));
    const viewed = await api(`/v1/invoices/${inv.body.id}`, { token: customerToken });
    expect(viewed.body.status).toBe('viewed');
    expect(viewed.body.billing_notice).toMatch(/AT&T/);

    const partial = await api(`/v1/invoices/${inv.body.id}/pay`, { token: customerToken, body: { method: 'ach', amount_cents: 4000 } });
    expect(partial.body.invoice.status).toBe('partial');
    expect((await api(`/v1/invoices/${inv.body.id}/pay`, { token: customerToken, body: { method: 'card', amount_cents: 99999 } })).status).toBe(400);
    const paid = await api(`/v1/invoices/${inv.body.id}/pay`, { token: customerToken, body: { method: 'card' } });
    expect(paid.body.invoice.status).toBe('paid');
    expect(paid.body.invoice.amount_paid_cents).toBe(9900);
    const stage = await env.DB.prepare(`SELECT status FROM order_timeline WHERE order_id = ? AND stage = 'invoice_paid'`).bind(orderId).first();
    expect(stage?.status).toBe('complete');
  });

  it('accepts only correctly signed processor webhooks, idempotently', async () => {
    const { office, orderId } = await orderFlow();
    const inv = await api('/v1/invoices', { token: office.token, body: { order_id: orderId, amount_cents: 5000, payment_term_days: 0, description: 'Activation fee', send: true } });
    const payload = JSON.stringify({ type: 'payment_intent.succeeded', data: { object: { id: 'pi_123', amount: 5000, metadata: { invoice_id: inv.body.id, method: 'card' } } } });
    const t = Math.floor(Date.now() / 1000);
    const good = { 'stripe-signature': `t=${t},v1=${await hmac('whsec_test', `${t}.${payload}`)}` };
    expect((await api('/v1/webhooks/stripe', { raw: payload, headers: { 'stripe-signature': `t=${t},v1=deadbeef` } })).status).toBe(400);
    expect((await api('/v1/webhooks/stripe', { raw: payload, headers: good })).status).toBe(200);
    expect((await api('/v1/webhooks/stripe', { raw: payload, headers: good })).status).toBe(200);
    const row = await env.DB.prepare('SELECT status, amount_paid_cents FROM invoices WHERE id = ?').bind(inv.body.id).first();
    expect(row).toEqual({ status: 'paid', amount_paid_cents: 5000 });
  });

  it('cron marks overdue and sends each reminder once', async () => {
    const { office, orderId } = await orderFlow();
    const inv = await api('/v1/invoices', { token: office.token, body: { order_id: orderId, amount_cents: 5000, payment_term_days: 15, description: 'Setup', send: true } });
    await env.DB.prepare('UPDATE invoices SET due_date = ? WHERE id = ?').bind(addDays(todayPacific(), -8), inv.body.id).run();
    const first = await runDaily(env as never);
    expect(first.reminders_sent).toBeGreaterThanOrEqual(1);
    expect((await env.DB.prepare('SELECT status FROM invoices WHERE id = ?').bind(inv.body.id).first())?.status).toBe('overdue');
    expect((await env.DB.prepare('SELECT kind FROM invoice_reminders WHERE invoice_id = ?').bind(inv.body.id).first())?.kind).toBe('T+7');
    const second = await runDaily(env as never);
    expect(second.reminders_sent).toBe(0);
  });
});

describe('coworker satisfaction', () => {
  it('keeps pulse anonymous, one per week, with own trend and hidden small crews', async () => {
    const crew = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO crews (id, name) VALUES (?, ?)').bind(crew, 'Crew A').run();
    const rep = await user('coworker', { crew_id: crew });
    expect((await api('/v1/pulse/status', { token: rep.token })).body.due).toBe(true);
    const scores = { workload_score: 4, safety_score: 5, support_score: 3 };
    expect((await api('/v1/pulse', { token: rep.token, body: scores })).status).toBe(201);
    expect((await api('/v1/pulse', { token: rep.token, body: scores })).status).toBe(409);
    expect((await api('/v1/pulse/status', { token: rep.token })).body.due).toBe(false);

    const row = await env.DB.prepare('SELECT user_id, anonymous FROM pulse_responses WHERE crew_id = ?').bind(crew).first();
    expect(row).toEqual({ user_id: null, anonymous: 1 });
    expect((await api('/v1/scorecards/me', { token: rep.token })).body.trend[0].workload).toBe(4);
    expect((await api('/v1/scorecards/crew', { token: rep.token })).body.trend).toEqual([]); // n=1 < 3

    const admin = await user('admin');
    const card = (await api('/v1/admin/scorecards', { token: admin.token })).body;
    expect(card.crews.find((c: { id: string }) => c.id === crew).hidden).toBe(true);
    expect(card.named_responses).toEqual([]);
  });

  it('ties kudos to an order or route', async () => {
    const { rep, orderId } = await orderFlow();
    const peer = await user('coworker');
    expect((await api('/v1/kudos', { token: peer.token, body: { to_user_id: rep.id, message: 'Nice close!' } })).status).toBe(400);
    expect((await api('/v1/kudos', { token: peer.token, body: { to_user_id: rep.id, order_id: orderId, message: 'Nice close!' } })).status).toBe(201);
    expect((await api('/v1/scorecards/me', { token: rep.token })).body.kudos[0].message).toBe('Nice close!');
  });
});

describe('files', () => {
  it('uploads and reads through signed URLs only', async () => {
    const rep = await user('coworker');
    const up = await api('/v1/uploads', { token: rep.token, body: { kind: 'door_photo', content_type: 'image/jpeg' } });
    const path = new URL(up.body.upload_url).pathname + new URL(up.body.upload_url).search;
    const put = await worker.fetch(new Request(`http://dealerdoor.test${path}`, { method: 'PUT', headers: { 'content-type': 'image/jpeg', 'content-length': '3' }, body: 'abc' }));
    expect(put.status).toBe(201);
    const tampered = path.replace(/sig=[0-9a-f]{4}/, 'sig=0000');
    expect((await worker.fetch(new Request(`http://dealerdoor.test${tampered}`, { method: 'PUT', headers: { 'content-type': 'image/jpeg', 'content-length': '3' }, body: 'abc' }))).status).toBe(403);

    expect((await api('/v1/files/sign', { token: (await user('coworker')).token, body: { key: up.body.key } })).status).toBe(403);
    const signed = await api('/v1/files/sign', { token: rep.token, body: { key: up.body.key } });
    const get = await worker.fetch(new Request(signed.body.url.replace(/^https?:\/\/[^/]+/, 'http://dealerdoor.test')));
    expect(await get.text()).toBe('abc');
  });
});
