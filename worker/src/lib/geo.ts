type Ring = [number, number][];
type Geometry = { type: 'Polygon'; coordinates: Ring[] } | { type: 'MultiPolygon'; coordinates: Ring[][] };

/** Ray-casting point-in-ring; GeoJSON order is [lng, lat]. */
function inRing(lng: number, lat: number, ring: Ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const inPolygon = (lng: number, lat: number, rings: Ring[]) =>
  inRing(lng, lat, rings[0]) && !rings.slice(1).some((hole) => inRing(lng, lat, hole));

export function pointInArea(lat: number, lng: number, geo: Geometry) {
  return geo.type === 'Polygon'
    ? inPolygon(lng, lat, geo.coordinates)
    : geo.coordinates.some((poly) => inPolygon(lng, lat, poly));
}

export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ponytail: per-isolate cache, admins see polygon edits within 5 minutes; add a version bump if that's too slow.
let cached: { at: number; areas: Geometry[] } | null = null;

export async function activeAreas(db: D1Database): Promise<Geometry[]> {
  if (cached && Date.now() - cached.at < 300_000) return cached.areas;
  const { results } = await db.prepare('SELECT geojson FROM service_area WHERE active = 1').all<{ geojson: string }>();
  cached = { at: Date.now(), areas: results.map((r) => JSON.parse(r.geojson)) };
  return cached.areas;
}

export const clearAreaCache = () => (cached = null);

export async function inServiceArea(db: D1Database, lat: number | null | undefined, lng: number | null | undefined) {
  if (lat == null || lng == null) return false;
  return (await activeAreas(db)).some((g) => pointInArea(lat, lng, g));
}

/** Free US Census geocoder (no key). Returns null when the address can't be matched. */
export async function geocode(address: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const url = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=${encodeURIComponent(address)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { result?: { addressMatches?: { coordinates: { x: number; y: number } }[] } };
    const m = data.result?.addressMatches?.[0];
    return m ? { lat: m.coordinates.y, lng: m.coordinates.x } : null;
  } catch {
    return null;
  }
}
