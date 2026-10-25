const enc = new TextEncoder();

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export const sha256 = async (s: string) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));

export async function hmac(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}

/** Constant-time string compare for signatures. */
export function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function randomToken(bytes = 32) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// PBKDF2-SHA256; 100k is the Workers runtime maximum.
const ITER = 100_000;

async function pbkdf2(password: string, salt: Uint8Array) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITER }, key, 256));
}

export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITER}$${hex(salt.buffer)}$${await pbkdf2(password, salt)}`;
}

export async function verifyPassword(password: string, stored: string | null) {
  if (!stored) return false;
  const [, , saltHex, hash] = stored.split('$');
  const salt = new Uint8Array(saltHex.match(/../g)!.map((h) => parseInt(h, 16)));
  return safeEqual(await pbkdf2(password, salt), hash);
}

// ---- Signed R2 URLs (bucket stays private; Worker proxies with short-lived signatures) ----

export async function signFileUrl(baseUrl: string, secret: string, method: 'GET' | 'PUT', key: string, ttlSec = 900) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = await hmac(secret, `${method}:${key}:${exp}`);
  return `${baseUrl}/v1/files/${key}?exp=${exp}&sig=${sig}`;
}

export async function verifyFileSig(secret: string, method: string, key: string, exp: string | undefined, sig: string | undefined) {
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  return safeEqual(await hmac(secret, `${method}:${key}:${exp}`), sig);
}
