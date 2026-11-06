import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { csvCell, toCsv } from '../src/lib/util';
import { api, orderFlow, user } from './helpers';

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
