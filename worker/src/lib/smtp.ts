import { connect as workersConnect } from 'cloudflare:sockets';
import type { Env } from '../env';

// A small SMTP client for Cloudflare Workers.
//   port 465: encrypted from the first byte (implicit TLS)
//   port 587: starts plain, then upgrades with STARTTLS. The password is never sent before the upgrade.
// Port 25 is blocked by Cloudflare for Workers, so it is refused here with a clear message.

const DEFAULT_PORT = 587;
const DEFAULT_TIMEOUT_MS = 20_000;
const CRLF = '\r\n';

export interface SmtpConfig {
  host: string;
  port: number;
  user?: string;
  pass?: string;
}

export interface MailMessage {
  /** "Name <address>" or just an address. */
  from: string;
  to: string;
  subject: string;
  text: string;
}

export class SmtpError extends Error {
  constructor(message: string, public code?: number) {
    super(message);
  }
}

/** The pieces of Cloudflare's socket we use, so a test can stand in for the network. */
export interface SocketLike {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  startTls(): SocketLike;
  close(): Promise<void>;
}
type ConnectFn = (address: { hostname: string; port: number }, options: { secureTransport: 'on' | 'starttls' }) => SocketLike;

export interface SendOptions {
  connect?: ConnectFn;
  timeoutMs?: number;
}

/** Reads the SMTP_* settings. Returns null when no host is set, so the caller can fall back to another sender. */
export function smtpConfig(env: Pick<Env, 'SMTP_HOST' | 'SMTP_PORT' | 'SMTP_USER' | 'SMTP_PASS'>): SmtpConfig | null {
  const host = env.SMTP_HOST?.trim();
  if (!host) return null;
  const port = env.SMTP_PORT ? Number(env.SMTP_PORT) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new SmtpError(`SMTP_PORT is not a valid port: ${env.SMTP_PORT}`);
  if (port === 25) throw new SmtpError('SMTP_PORT 25 does not work from Cloudflare Workers. Use 465 or 587.');
  return { host, port, user: env.SMTP_USER || undefined, pass: env.SMTP_PASS || undefined };
}

/** Sends one plain-text email. Throws SmtpError if the server says no or does not answer in time. */
export async function sendSmtp(config: SmtpConfig, message: MailMessage, options: SendOptions = {}): Promise<void> {
  const raw = buildMessage(message, { date: new Date(), messageId: `${crypto.randomUUID()}@${domainOf(addressOf(message.from))}` });
  const from = addressOf(message.from);
  const to = addressOf(message.to);

  const connectFn = options.connect ?? (workersConnect as unknown as ConnectFn);
  const socket = connectFn({ hostname: config.host, port: config.port }, { secureTransport: config.port === 465 ? 'on' : 'starttls' });
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const work = converse(socket, config, from, to, raw);
  const clock = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SmtpError(`SMTP server did not answer within ${timeoutMs} ms (timed out)`)), timeoutMs);
  });
  try {
    await Promise.race([work, clock]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Whatever happened, drop the connection and quiet the loser of the race.
    work.catch(() => {});
    await socket.close().catch(() => {});
  }
}

// ---- The conversation --------------------------------------------------------------------------------------------

async function converse(socket: SocketLike, config: SmtpConfig, from: string, to: string, raw: string) {
  let line = new LineChannel(socket);
  await line.expect(220);

  let ehlo = await line.command('EHLO dealerdoor.local', 250);
  if (config.port !== 465) {
    if (!/\bSTARTTLS\b/i.test(ehlo)) throw new SmtpError('The mail server does not offer STARTTLS, so the password would not be encrypted. Use port 465 or a different server.');
    await line.command('STARTTLS', 220);
    line = line.upgrade(socket.startTls());
    ehlo = await line.command('EHLO dealerdoor.local', 250);
  }

  if (config.user && config.pass) await authenticate(line, ehlo, config.user, config.pass);

  await line.command(`MAIL FROM:<${from}>`, 250);
  await line.command(`RCPT TO:<${to}>`, [250, 251]);
  await line.command('DATA', 354);
  await line.write(`${dotStuff(raw)}${CRLF}.`);
  await line.expect(250);
  await line.command('QUIT', 221).catch(() => {});
}

async function authenticate(line: LineChannel, ehlo: string, user: string, pass: string) {
  if (/\bAUTH\b[^\r\n]*\bPLAIN\b/i.test(ehlo)) {
    await line.command(`AUTH PLAIN ${b64(`\0${user}\0${pass}`)}`, 235);
  } else if (/\bAUTH\b[^\r\n]*\bLOGIN\b/i.test(ehlo)) {
    // The user name and password travel as lines of their own, so give them a safe label for error messages.
    await line.command('AUTH LOGIN', 334);
    await line.command(b64(user), 334, 'AUTH LOGIN (user)');
    await line.command(b64(pass), 235, 'AUTH LOGIN (password)');
  } else {
    throw new SmtpError('The mail server offers neither AUTH PLAIN nor AUTH LOGIN.');
  }
}

/** Reads and writes CRLF lines; a reply can span several lines ("250-..." until "250 ..."). */
class LineChannel {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private decoder = new TextDecoder();
  private encoder = new TextEncoder();
  private buffer = '';

  constructor(private socket: SocketLike) {
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }

  /** After STARTTLS the same connection continues, now encrypted, on fresh streams. */
  upgrade(secured: SocketLike): LineChannel {
    this.reader.releaseLock();
    this.writer.releaseLock();
    return new LineChannel(secured);
  }

  /** `label` is what an error message calls this step. It defaults to the command word and is never the full text (which may hold a password). */
  async command(text: string, ok: number | number[], label = text.split(' ')[0]) {
    await this.write(text);
    return this.expect(ok, label);
  }

  async write(text: string) {
    await this.writer.write(this.encoder.encode(text + CRLF));
  }

  /** Waits for a full reply and checks its code. Returns the reply text. */
  async expect(ok: number | number[], sent = '(connect)') {
    const wanted = Array.isArray(ok) ? ok : [ok];
    const lines: string[] = [];
    for (;;) {
      const next = await this.readLine();
      lines.push(next);
      if (/^\d{3}( |$)/.test(next)) break;
    }
    const code = Number(lines[lines.length - 1].slice(0, 3));
    if (!wanted.includes(code)) throw new SmtpError(`SMTP ${sent} failed: ${lines[lines.length - 1]}`, code);
    return lines.join(CRLF);
  }

  private async readLine() {
    while (!this.buffer.includes(CRLF)) {
      const { value, done } = await this.reader.read();
      if (done) throw new SmtpError('The mail server closed the connection.');
      this.buffer += this.decoder.decode(value, { stream: true });
    }
    const i = this.buffer.indexOf(CRLF);
    const line = this.buffer.slice(0, i);
    this.buffer = this.buffer.slice(i + 2);
    return line;
  }
}

// ---- Building the message ----------------------------------------------------------------------------------------

/** Turns a message into the text that goes after DATA. Headers are checked so nothing can sneak in a new one. */
export function buildMessage(message: MailMessage, meta: { date: Date; messageId: string }): string {
  const from = safeHeader(message.from, 'From');
  const to = safeHeader(message.to, 'To');
  const subject = safeHeader(message.subject, 'Subject');
  addressOf(from);
  addressOf(to);
  safeHeader(meta.messageId, 'Message-ID');

  const headers = [
    `From: ${formatFrom(from)}`,
    `To: ${to}`,
    `Subject: ${encodeWords(subject)}`,
    `Date: ${rfc5322Date(meta.date)}`,
    `Message-ID: <${meta.messageId}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  ];
  return `${headers.join(CRLF)}${CRLF}${CRLF}${wrap76(b64(message.text))}`;
}

/** SMTP ends the message at a line with just ".", so any line that starts with "." gets one more. */
export function dotStuff(data: string): string {
  return data.replace(/(^|\r\n)\./g, '$1..');
}

function safeHeader(value: string, name: string): string {
  if (/[\r\n\0]/.test(value)) throw new SmtpError(`${name} must not contain line breaks`);
  return value.trim();
}

const ADDRESS = /^[^\s<>@"]+@[^\s<>@"]+$/;

/** "Name <a@b.example>" or "a@b.example" -> "a@b.example". Throws if it is not a plain address. */
function addressOf(value: string): string {
  const inBrackets = value.match(/<([^<>]*)>\s*$/);
  const address = (inBrackets ? inBrackets[1] : value).trim();
  if (!ADDRESS.test(address)) throw new SmtpError(`Not a valid email address: ${address.slice(0, 80)}`);
  return address;
}

const domainOf = (address: string) => address.split('@')[1];

function formatFrom(from: string): string {
  const m = from.match(/^(.*?)\s*<([^<>]*)>\s*$/);
  if (!m || !m[1]) return from;
  return `${encodeWords(m[1].replace(/^"|"$/g, ''))} <${m[2]}>`;
}

/** Plain ASCII passes through; anything else becomes RFC 2047 "=?UTF-8?B?...?=" pieces under 75 characters. */
function encodeWords(text: string): string {
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  const words: string[] = [];
  let chunk = '';
  for (const char of text) {
    if (new TextEncoder().encode(chunk + char).length > 42) {
      words.push(chunk);
      chunk = '';
    }
    chunk += char;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${b64(w)}?=`).join(`${CRLF} `);
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function rfc5322Date(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${DAYS[d.getUTCDay()]}, ${p(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

/** Base64 of the UTF-8 bytes of a string (btoa alone only handles Latin-1). */
function b64(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const wrap76 = (s: string) => s.match(/.{1,76}/g)?.join(CRLF) ?? '';
