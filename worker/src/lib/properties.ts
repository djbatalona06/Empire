import { geocode, inServiceArea } from './geo';
import { fail, newId, normalizeAddress, zipOf } from './util';

export interface Property {
  id: string;
  address: string;
  zip: string | null;
  lat: number | null;
  lng: number | null;
  seatac_valid: number;
  needs_review: number;
  do_not_knock: number;
}

const COLS = 'id, address, zip, lat, lng, seatac_valid, needs_review, do_not_knock';

/** Finds a property by normalized address or creates it, validating it against the SeaTac polygon. */
export async function upsertProperty(db: D1Database, input: { address: string; lat?: number; lng?: number }, opts: { geocode?: boolean } = {}) {
  const norm = normalizeAddress(input.address);
  const existing = await db.prepare(`SELECT ${COLS} FROM properties WHERE address_norm = ?`).bind(norm).first<Property>();
  if (existing) return existing;

  let { lat, lng } = input;
  if ((lat == null || lng == null) && opts.geocode) ({ lat, lng } = (await geocode(input.address)) ?? {});
  const valid = await inServiceArea(db, lat, lng);
  const row: Property = {
    id: newId(),
    address: input.address,
    zip: zipOf(input.address),
    lat: lat ?? null,
    lng: lng ?? null,
    seatac_valid: valid ? 1 : 0,
    needs_review: valid ? 0 : 1,
    do_not_knock: 0,
  };
  // Address could be on the do-not-knock list before we ever saw it as a property.
  await db
    .prepare(
      `INSERT INTO properties (id, address, address_norm, zip, lat, lng, seatac_valid, needs_review, review_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(address_norm) DO NOTHING`,
    )
    .bind(row.id, row.address, norm, row.zip, row.lat, row.lng, row.seatac_valid, row.needs_review, valid ? null : 'Outside SeaTac polygon or not geocoded')
    .run();
  return (await db.prepare(`SELECT ${COLS} FROM properties WHERE address_norm = ?`).bind(norm).first<Property>())!;
}

export async function getProperty(db: D1Database, id: string) {
  return (await db.prepare(`SELECT ${COLS} FROM properties WHERE id = ?`).bind(id).first<Property>()) ?? fail(404, 'property_not_found');
}

export async function recordConflict(db: D1Database, userId: string, entity: string, payload: unknown, reason: string) {
  const id = newId();
  await db.prepare('INSERT INTO sync_conflicts (id, user_id, entity, payload_json, reason) VALUES (?, ?, ?, ?, ?)').bind(id, userId, entity, JSON.stringify(payload), reason).run();
  return id;
}
