#!/usr/bin/env node
// Creates an admin account, or promotes an existing account to admin and sets its password.
//
// The password is read from the ADMIN_PASSWORD environment variable. It is never printed and never
// written into the repo. The SQL goes to the --out file, which you delete after running it.
//
//   cd worker
//   ADMIN_PASSWORD='...' node scripts/create-admin.mjs \
//     --email you@example.com --name "Your Name" --out "$HOME/admin-bootstrap.sql"
//   npx wrangler d1 execute DB --remote --env production --file "$HOME/admin-bootstrap.sql"
//   rm "$HOME/admin-bootstrap.sql"
//
// For local testing, drop --remote/--env and add --local instead.

import { randomBytes, webcrypto } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { subtle } = webcrypto;
const ITER = 100_000; // Must match worker/src/lib/crypto.ts, or login will reject the hash.
const enc = new TextEncoder();
const hex = (buf) => Buffer.from(buf).toString('hex');

async function pbkdf2(password, salt) {
  const key = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITER }, key, 256));
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  return `pbkdf2$${ITER}$${hex(salt)}$${await pbkdf2(password, salt)}`;
}

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string', default: 'Owner' },
    out: { type: 'string' },
  },
});

const email = values.email?.trim().toLowerCase();
const name = values.name.trim();
const password = process.env.ADMIN_PASSWORD;

if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Pass a valid --email');
if (!name || name.length > 100) throw new Error('--name must be 1-100 characters');
if (!values.out) throw new Error('Pass --out <file.sql> (outside the repo)');
if (!password) throw new Error('Set ADMIN_PASSWORD in the environment for this command');
if (password.length > 200) throw new Error('Password is over the 200-character limit the API enforces');
if (password.length < 12) {
  console.warn(`Warning: the password is ${password.length} characters. The app's own password-change rule needs 12+.`);
}

const q = (s) => `'${s.replace(/'/g, "''")}'`;
const id = hex(randomBytes(16));
const hash = await hashPassword(password);

// If the email already exists, keep its id and history: promote it, reactivate it, and replace the password.
const sql = `INSERT INTO users (id, email, role, display_name, locale, password_hash, active)
VALUES (${q(id)}, ${q(email)}, 'admin', ${q(name)}, 'en', ${q(hash)}, 1)
ON CONFLICT(email) DO UPDATE SET role = 'admin', active = 1, password_hash = excluded.password_hash;
`;

writeFileSync(values.out, sql, { mode: 0o600 });
console.log(`Wrote ${values.out} for ${email} (role: admin). The password and hash were not printed.`);
