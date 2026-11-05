import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { SEATAC, api, leadBody, orderFlow, property, user } from './helpers';

describe('map points: who sees what', () => {
  it('shows a rep only their own leads, and office staff everything', async () => {
    const [repA, repB, office] = [await user('coworker'), await user('coworker'), await user('office')];
    const mine = await captureLead(repA.token);
    const theirs = await captureLead(repB.token);

    const asRep = (await points(repA.token, 'layers=leads')).leads.map((p: Point) => p.id);
    expect(asRep).toContain(mine);
    expect(asRep).not.toContain(theirs);

    const asOffice = (await points(office.token, 'layers=leads')).leads.map((p: Point) => p.id);
    expect(asOffice).toEqual(expect.arrayContaining([mine, theirs]));
  });

  it('shows a team lead their crew, not other crews', async () => {
    const crewA = await crew('A');
    const crewB = await crew('B');
    const lead = await user('lead', { crew_id: crewA });
    const inCrew = await user('coworker', { crew_id: crewA });
    const outside = await user('coworker', { crew_id: crewB });
    const a = await captureLead(inCrew.token);
    const b = await captureLead(outside.token);

    const ids = (await points(lead.token, 'layers=leads')).leads.map((p: Point) => p.id);
    expect(ids).toContain(a);
    expect(ids).not.toContain(b);
  });

  it('turns a lead into a sale pin once it becomes an order', async () => {
    const flow = await orderFlow();
    const data = await points(flow.rep.token, 'layers=leads,sales');

    expect(data.sales.map((p: Point) => p.id)).toContain(flow.orderId);
    expect(data.leads.map((p: Point) => p.id)).not.toContain(flow.lead.id);
    const sale = data.sales.find((p: Point) => p.id === flow.orderId);
    expect(sale).toMatchObject({ lat: SEATAC.lat, lng: SEATAC.lng, status: 'submitted' });
    expect(sale.address).toMatch(/SeaTac/);
  });

  it('hides sales that belong to other reps', async () => {
    const flow = await orderFlow();
    const stranger = await user('coworker');
    expect((await points(stranger.token, 'layers=sales')).sales.map((p: Point) => p.id)).not.toContain(flow.orderId);
  });

  it('shows do-not-knock pins to everyone on staff, with the address only for managers', async () => {
    const dnkId = await property({ dnk: true, address: '77 Quiet Ln, SeaTac, WA 98188' });
    const rep = await user('coworker');
    const office = await user('office');

    const forRep = (await points(rep.token, 'layers=dnk')).dnk.find((p: Point) => p.id === dnkId);
    expect(forRep).toMatchObject({ id: dnkId });
    expect(forRep.address).toBeUndefined();

    const forOffice = (await points(office.token, 'layers=dnk')).dnk.find((p: Point) => p.id === dnkId);
    expect(forOffice.address).toBe('77 Quiet Ln, SeaTac, WA 98188');
  });
});

describe('map points: filters and limits', () => {
  it('returns only the layers asked for', async () => {
    const office = await user('office');
    const data = await points(office.token, 'layers=dnk');
    expect(Object.keys(data).sort()).toEqual(['dnk', 'truncated']);
  });

  it('filters by lead status', async () => {
    const rep = await user('coworker');
    const id = await captureLead(rep.token);
    expect((await points(rep.token, 'layers=leads&status=closed')).leads.map((p: Point) => p.id)).not.toContain(id);
    expect((await points(rep.token, 'layers=leads&status=interested')).leads.map((p: Point) => p.id)).toContain(id);
  });

  it('filters by the map window (bbox)', async () => {
    const rep = await user('coworker');
    const id = await captureLead(rep.token);
    const aroundSeatac = '-122.30,47.42,-122.25,47.45'; // minLng,minLat,maxLng,maxLat
    const aroundSeattle = '-122.36,47.59,-122.30,47.62';
    expect((await points(rep.token, `layers=leads&bbox=${aroundSeatac}`)).leads.map((p: Point) => p.id)).toContain(id);
    expect((await points(rep.token, `layers=leads&bbox=${aroundSeattle}`)).leads.map((p: Point) => p.id)).not.toContain(id);
  });

  it('filters by date', async () => {
    const rep = await user('coworker');
    const id = await captureLead(rep.token);
    expect((await points(rep.token, 'layers=leads&to=2000-01-01')).leads.map((p: Point) => p.id)).not.toContain(id);
    expect((await points(rep.token, 'layers=leads&from=2000-01-01')).leads.map((p: Point) => p.id)).toContain(id);
  });

  it('says when it cut the list short', async () => {
    const rep = await user('coworker');
    await captureLead(rep.token);
    await captureLead(rep.token);
    const data = await points(rep.token, 'layers=leads&limit=1');
    expect(data.leads).toHaveLength(1);
    expect(data.truncated.leads).toBe(true);
  });

  it('skips pins that have no coordinates', async () => {
    const rep = await user('coworker');
    const noCoords = await property();
    await env.DB.prepare('UPDATE properties SET lat = NULL, lng = NULL WHERE id = ?').bind(noCoords).run();
    const id = await captureLead(rep.token, noCoords);
    expect((await points(rep.token, 'layers=leads')).leads.map((p: Point) => p.id)).not.toContain(id);
  });

  it('rejects bad input', async () => {
    const rep = await user('coworker');
    for (const q of ['layers=secrets', 'bbox=1,2,3', 'bbox=a,b,c,d', 'bbox=-200,0,0,0', 'status=nonsense', 'from=yesterday', 'limit=0', 'limit=99999']) {
      const res = await api(`/v1/map/points?${q}`, { token: rep.token });
      expect(res.status, q).toBe(400);
    }
  });
});

describe('map points: access', () => {
  it('needs a sign-in, and customers cannot use it', async () => {
    expect((await api('/v1/map/points')).status).toBe(401);
    const flow = await orderFlow();
    expect((await api('/v1/map/points', { token: flow.customerToken })).status).toBe(403);
  });

  it('is locked for an owner who has not entered the password yet', async () => {
    const email = `gated-${crypto.randomUUID().slice(0, 8)}@example.test`;
    await env.DB.prepare(`INSERT INTO users (id, email, role, display_name, require_password) VALUES (?, ?, 'admin', 'Gated', 1)`).bind(crypto.randomUUID(), email).run();
    const sent = await api('/v1/auth/login', { body: { email } });
    const limited = await api('/v1/auth/verify', { body: { token: sent.body.dev_token } });
    const res = await api('/v1/map/points', { token: limited.body.access_token });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('password_required');
  });
});

describe('where an order happened', () => {
  it('gives staff the coordinates of the order, and customers nothing about the property position', async () => {
    const flow = await orderFlow();
    const staff = await api(`/v1/orders/${flow.orderId}`, { token: flow.rep.token });
    expect(staff.body).toMatchObject({ lat: SEATAC.lat, lng: SEATAC.lng });

    const customer = await api(`/v1/orders/${flow.orderId}`, { token: flow.customerToken });
    expect(customer.status).toBe(200);
    expect(customer.body.lat).toBeUndefined();
    expect(customer.body.lng).toBeUndefined();
  });
});

// ---- helpers ---------------------------------------------------------------

type Point = { id: string; lat: number; lng: number; address?: string; status?: string };

async function points(token: string, query = '') {
  const res = await api(`/v1/map/points?${query}`, { token });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

/** A rep records interest at a property (a new one at SeaTac unless given); returns the lead id. */
async function captureLead(token: string, propertyId?: string) {
  const lead = leadBody(propertyId ?? (await property({ ...SEATAC })));
  const res = await api('/v1/leads', { token, body: lead });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return lead.id;
}

async function crew(name: string) {
  const id = `crew_${name}_${crypto.randomUUID().slice(0, 6)}`;
  await env.DB.prepare('INSERT INTO crews (id, name) VALUES (?, ?)').bind(id, `Crew ${name}`).run();
  return id;
}
