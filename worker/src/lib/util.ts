import type { Context } from 'hono';
import type { AppEnv } from '../env';

export class ApiError extends Error {
  constructor(public status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 502, public code: string, message?: string, public extra?: Record<string, unknown>) {
    super(message ?? code);
  }
}

export const fail = (status: ApiError['status'], code: string, message?: string, extra?: Record<string, unknown>): never => {
  throw new ApiError(status, code, message, extra);
};

export const newId = () => crypto.randomUUID();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Offline-created records carry a client UUID so replays are idempotent. */
export const clientId = (v: unknown) => {
  if (v === undefined || v === null) return newId();
  if (typeof v !== 'string' || !UUID.test(v)) fail(400, 'invalid_id', 'id must be a UUID');
  return (v as string).toLowerCase();
};

export const nowIso = () => new Date().toISOString();

// ---- Input validation at the trust boundary ------------------------------

type Obj = Record<string, unknown>;

export async function readJson(c: Context<AppEnv>): Promise<Obj> {
  const data = await c.req.json().catch(() => fail(400, 'invalid_json'));
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail(400, 'invalid_json');
  return data as Obj;
}

export function str(o: Obj, k: string, opt: { max?: number; optional?: boolean; pattern?: RegExp } = {}): string | undefined {
  const v = o[k];
  if (v === undefined || v === null || v === '') {
    if (opt.optional) return undefined;
    fail(400, 'missing_field', `${k} is required`);
  }
  if (typeof v !== 'string') fail(400, 'invalid_field', `${k} must be a string`);
  const s = (v as string).trim();
  if (s.length > (opt.max ?? 500)) fail(400, 'invalid_field', `${k} is too long`);
  if (opt.pattern && !opt.pattern.test(s)) fail(400, 'invalid_field', `${k} has an invalid format`);
  return s;
}
export const reqStr = (o: Obj, k: string, opt: { max?: number; pattern?: RegExp } = {}) => str(o, k, opt) as string;

export function num(o: Obj, k: string, opt: { min?: number; max?: number; int?: boolean; optional?: boolean } = {}): number | undefined {
  const v = o[k];
  if (v === undefined || v === null) {
    if (opt.optional) return undefined;
    fail(400, 'missing_field', `${k} is required`);
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(400, 'invalid_field', `${k} must be a number`);
  const n = v as number;
  if (opt.int && !Number.isInteger(n)) fail(400, 'invalid_field', `${k} must be an integer`);
  if ((opt.min !== undefined && n < opt.min) || (opt.max !== undefined && n > opt.max)) fail(400, 'invalid_field', `${k} is out of range`);
  return n;
}
export const reqNum = (o: Obj, k: string, opt: { min?: number; max?: number; int?: boolean } = {}) => num(o, k, opt) as number;

export function oneOf<T extends string>(o: Obj, k: string, values: readonly T[], optional = false): T | undefined {
  const v = o[k];
  if ((v === undefined || v === null) && optional) return undefined;
  if (!values.includes(v as T)) fail(400, 'invalid_field', `${k} must be one of ${values.join(', ')}`);
  return v as T;
}

export const isoDate = /^\d{4}-\d{2}-\d{2}$/;
export const isoDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
export const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---- Dates (business runs on Pacific time) --------------------------------

export function todayPacific(d = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(d);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Adds business days (Monday to Friday) to a YYYY-MM-DD date. Public holidays are not skipped. */
export function addBusinessDays(date: string, days: number): string {
  let d = date;
  for (let left = Math.max(0, Math.floor(days)); left > 0; ) {
    d = addDays(d, 1);
    const weekday = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) left--;
  }
  return d;
}

/** Pacific calendar date (YYYY-MM-DD) of a database timestamp such as "2026-11-06 03:41:54" (stored in UTC). */
export function pacificDateOf(stamp: string): string {
  const iso = stamp.includes('T') ? stamp : `${stamp.replace(' ', 'T')}Z`;
  return todayPacific(new Date(iso));
}

export const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** ISO-8601 week label like 2026-W43 (Pacific date). */
export function isoWeek(date = todayPacific()): string {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// ---- Audit ---------------------------------------------------------------

export function audit(db: D1Database, actorId: string, action: string, entity: string, entityId: string | null, detail?: unknown) {
  return db
    .prepare('INSERT INTO audit_log (id, actor_id, action, entity, entity_id, detail_json) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(newId(), actorId, action, entity, entityId, detail === undefined ? null : JSON.stringify(detail));
}

// ---- CSV -----------------------------------------------------------------

/**
 * One CSV cell. Text that starts with = + - @ (or a tab / carriage return) would be run as a formula when
 * the file is opened in Excel or Sheets, so it gets a leading apostrophe. Real numbers are left alone.
 */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  return [columns.join(','), ...rows.map((r) => columns.map((k) => csvCell(r[k])).join(','))].join('\r\n') + '\r\n';
}

export const normalizeAddress = (a: string) =>
  a.toUpperCase().replace(/[.,#]/g, ' ').replace(/\bSOUTH\b/g, 'S').replace(/\bSTREET\b/g, 'ST').replace(/\bAVENUE\b/g, 'AVE').replace(/\s+/g, ' ').trim();

export const zipOf = (a: string) => a.match(/\b(98\d{3})(?:-\d{4})?\b/)?.[1] ?? null;
