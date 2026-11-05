import { describe, expect, it } from 'vitest';
import { buildMessage, dotStuff, sendSmtp, smtpConfig, SmtpError } from '../src/lib/smtp';

const FROM = 'DealerDoor <no-reply@dealer.example>';
const MAIL = { from: FROM, to: 'sam@customer.example', subject: 'Your sign-in link', text: 'Open this: https://x.example/auth/verify?token=abc' };
const DATE = new Date('2026-11-05T16:00:00Z');

describe('building the message', () => {
  it('writes CRLF headers and a base64 body that decodes back to the text', () => {
    const raw = buildMessage({ ...MAIL, text: 'Hola Ana ñ — enlace: https://x.example\n.dot line' }, { date: DATE, messageId: 'id1@dealer.example' });
    const [head, body] = raw.split('\r\n\r\n');

    expect(head).toContain('From: DealerDoor <no-reply@dealer.example>');
    expect(head).toContain('To: sam@customer.example');
    expect(head).toContain('Subject: Your sign-in link');
    expect(head).toContain('Date: Thu, 05 Nov 2026 16:00:00 +0000');
    expect(head).toContain('Message-ID: <id1@dealer.example>');
    expect(head).toContain('Content-Type: text/plain; charset=utf-8');
    expect(head).toContain('Content-Transfer-Encoding: base64');
    expect(raw.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);

    const decoded = new TextDecoder().decode(Uint8Array.from(atob(body.replace(/\r\n/g, '')), (c) => c.charCodeAt(0)));
    expect(decoded).toBe('Hola Ana ñ — enlace: https://x.example\n.dot line');
    for (const line of body.split('\r\n')) expect(line.length).toBeLessThanOrEqual(76);
  });

  it('encodes a non-ASCII subject so it survives the trip', () => {
    const raw = buildMessage({ ...MAIL, subject: 'Recibimos su pedido ñ' }, { date: DATE, messageId: 'id@dealer.example' });
    const subject = raw.split('\r\n').find((l) => l.startsWith('Subject:'))!;
    expect(subject).toMatch(/^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    const b64 = subject.match(/\?B\?(.+)\?=/)![1];
    expect(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))).toBe('Recibimos su pedido ñ');
  });

  it('refuses line breaks in any header, so nobody can inject extra headers or recipients', () => {
    const date = DATE;
    const messageId = 'id@dealer.example';
    expect(() => buildMessage({ ...MAIL, subject: 'hi\r\nBcc: attacker@evil.example' }, { date, messageId })).toThrow(SmtpError);
    expect(() => buildMessage({ ...MAIL, to: 'a@b.example\r\nBcc: attacker@evil.example' }, { date, messageId })).toThrow(SmtpError);
    expect(() => buildMessage({ ...MAIL, from: 'X <a@b.example>\nBcc: z@z.example' }, { date, messageId })).toThrow(SmtpError);
    expect(() => buildMessage({ ...MAIL, to: 'not an address' }, { date, messageId })).toThrow(SmtpError);
  });

  it('doubles a leading dot so a lone "." line cannot end the message early', () => {
    expect(dotStuff('a\r\n.\r\n..b\r\nc')).toBe('a\r\n..\r\n...b\r\nc');
    expect(dotStuff('.start')).toBe('..start');
  });
});

describe('settings', () => {
  it('is off until a host is set, defaults to 587, and refuses port 25', () => {
    expect(smtpConfig({} as never)).toBeNull();
    expect(smtpConfig({ SMTP_HOST: 'smtp.dealer.example' } as never)).toEqual({ host: 'smtp.dealer.example', port: 587, user: undefined, pass: undefined });
    expect(smtpConfig({ SMTP_HOST: 'h', SMTP_PORT: '465', SMTP_USER: 'u', SMTP_PASS: 'p' } as never)).toEqual({ host: 'h', port: 465, user: 'u', pass: 'p' });
    expect(() => smtpConfig({ SMTP_HOST: 'h', SMTP_PORT: '25' } as never)).toThrow(/25/);
    expect(() => smtpConfig({ SMTP_HOST: 'h', SMTP_PORT: 'abc' } as never)).toThrow(/port/i);
  });
});

describe('talking to a mail server', () => {
  it('sends over implicit TLS (port 465) with AUTH PLAIN', async () => {
    const server = fakeServer();
    await sendSmtp({ host: 'smtp.dealer.example', port: 465, user: 'mailer', pass: 's3cret-pass' }, MAIL, { connect: server.connect });

    expect(server.connectCalls).toEqual([{ hostname: 'smtp.dealer.example', port: 465, secureTransport: 'on' }]);
    expect(server.startTlsCalls).toBe(0);
    expect(server.commands.map((c) => c.split(' ')[0])).toEqual(['EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA', 'QUIT']);
    expect(server.commands.find((c) => c.startsWith('AUTH PLAIN'))).toBe(`AUTH PLAIN ${btoa('\0mailer\0s3cret-pass')}`);
    expect(server.commands).toContain('MAIL FROM:<no-reply@dealer.example>');
    expect(server.commands).toContain('RCPT TO:<sam@customer.example>');
    expect(server.data).toContain('Subject: Your sign-in link');
    expect(server.data).not.toMatch(/\r\n\.\r\n.+/s);
  });

  it('upgrades to TLS on port 587 before it sends the password', async () => {
    const server = fakeServer({ advertiseStartTls: true });
    await sendSmtp({ host: 'smtp.dealer.example', port: 587, user: 'mailer', pass: 'pw' }, MAIL, { connect: server.connect });

    expect(server.connectCalls[0].secureTransport).toBe('starttls');
    expect(server.startTlsCalls).toBe(1);
    const kinds = server.commands.map((c) => c.split(' ')[0]);
    expect(kinds).toEqual(['EHLO', 'STARTTLS', 'EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA', 'QUIT']);
  });

  it('refuses to send the password if the server will not offer encryption on 587', async () => {
    const server = fakeServer({ advertiseStartTls: false });
    await expect(sendSmtp({ host: 'h', port: 587, user: 'u', pass: 'pw' }, MAIL, { connect: server.connect })).rejects.toThrow(/STARTTLS/);
    expect(server.commands.some((c) => c.startsWith('AUTH'))).toBe(false);
  });

  it('reports a rejected login without leaking the password', async () => {
    const server = fakeServer({ rejectAuth: true });
    const err = await sendSmtp({ host: 'h', port: 465, user: 'mailer', pass: 'topsecret' }, MAIL, { connect: server.connect }).catch((e) => e);
    expect(err).toBeInstanceOf(SmtpError);
    expect(err.code).toBe(535);
    expect(String(err.message)).not.toContain('topsecret');
    expect(String(err.stack)).not.toContain('topsecret');
  });

  it('falls back to AUTH LOGIN and still never leaks the password', async () => {
    const ok = fakeServer({ loginOnly: true });
    await sendSmtp({ host: 'h', port: 465, user: 'mailer', pass: 'topsecret' }, MAIL, { connect: ok.connect });
    expect(ok.commands.slice(0, 2)).toEqual(['EHLO dealerdoor.local', 'AUTH LOGIN']);

    const bad = fakeServer({ loginOnly: true, rejectAuth: true });
    const err = await sendSmtp({ host: 'h', port: 465, user: 'mailer', pass: 'topsecret' }, MAIL, { connect: bad.connect }).catch((e) => e);
    expect(err).toBeInstanceOf(SmtpError);
    expect(err.code).toBe(535);
    expect(String(err.message)).not.toContain('topsecret');
    expect(String(err.message)).not.toContain(btoa('topsecret'));
    expect(String(err.message)).not.toContain(btoa('mailer'));
  });

  it('reports a rejected recipient', async () => {
    const server = fakeServer({ rejectRcpt: true });
    const err = await sendSmtp({ host: 'h', port: 465 }, MAIL, { connect: server.connect }).catch((e) => e);
    expect(err).toBeInstanceOf(SmtpError);
    expect(err.code).toBe(550);
  });

  it('gives up if the server never answers', async () => {
    const server = fakeServer({ silent: true });
    await expect(sendSmtp({ host: 'h', port: 465 }, MAIL, { connect: server.connect, timeoutMs: 50 })).rejects.toThrow(/timed out/i);
  });
});

// ---- A tiny in-process mail server ------------------------------------------------------------------------------

interface Script {
  advertiseStartTls?: boolean;
  rejectAuth?: boolean;
  rejectRcpt?: boolean;
  silent?: boolean;
  /** Only offers AUTH LOGIN (the older, three-step login). */
  loginOnly?: boolean;
}

function fakeServer(script: Script = {}) {
  const commands: string[] = [];
  let data = '';
  let startTlsCalls = 0;
  const connectCalls: { hostname: string; port: number; secureTransport: string }[] = [];

  const toClient = new TransformStream<Uint8Array, Uint8Array>();
  const toServer = new TransformStream<Uint8Array, Uint8Array>();
  const out = toClient.writable.getWriter();
  const input = toServer.readable.getReader();
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const say = (s: string) => out.write(enc.encode(s));

  const socket = {
    readable: toClient.readable,
    writable: toServer.writable,
    startTls() {
      startTlsCalls++;
      return socket;
    },
    close: async () => {},
  };

  void (async () => {
    if (script.silent) return;
    await say('220 fake.example ESMTP ready\r\n');
    let buf = '';
    let inData = false;
    let tls = false;
    let loginStep = 0; // AUTH LOGIN: 1 = asked for user, 2 = asked for password
    for (;;) {
      const { value, done } = await input.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            await say('250 2.0.0 queued\r\n');
          } else {
            data += `${line.startsWith('..') ? line.slice(1) : line}\r\n`;
          }
          continue;
        }
        if (loginStep > 0) {
          // The user name and password lines of AUTH LOGIN are not commands; do not record them.
          if (loginStep === 1) { loginStep = 2; await say('334 UGFzc3dvcmQ6\r\n'); }
          else { loginStep = 0; await say(script.rejectAuth ? '535 5.7.8 authentication failed\r\n' : '235 2.7.0 ok\r\n'); }
          continue;
        }
        commands.push(line);
        const verb = line.split(' ')[0].toUpperCase();
        if (verb === 'EHLO') await say(`250-fake.example\r\n${script.advertiseStartTls && !tls ? '250-STARTTLS\r\n' : ''}250 AUTH ${script.loginOnly ? 'LOGIN' : 'PLAIN LOGIN'}\r\n`);
        else if (verb === 'STARTTLS') { tls = true; await say('220 ready to start TLS\r\n'); }
        else if (verb === 'AUTH' && script.loginOnly) { loginStep = 1; await say('334 VXNlcm5hbWU6\r\n'); }
        else if (verb === 'AUTH') await say(script.rejectAuth ? '535 5.7.8 authentication failed\r\n' : '235 2.7.0 ok\r\n');
        else if (verb === 'MAIL') await say('250 ok\r\n');
        else if (verb === 'RCPT') await say(script.rejectRcpt ? '550 5.1.1 no such user\r\n' : '250 ok\r\n');
        else if (verb === 'DATA') { inData = true; await say('354 go ahead\r\n'); }
        else if (verb === 'QUIT') { await say('221 bye\r\n'); return; }
        else await say('500 what?\r\n');
      }
    }
  })();

  return {
    commands,
    get data() { return data; },
    get startTlsCalls() { return startTlsCalls; },
    connectCalls,
    connect: (addr: { hostname: string; port: number }, opts: { secureTransport: string }) => {
      connectCalls.push({ hostname: addr.hostname, port: addr.port, secureTransport: opts.secureTransport });
      return socket;
    },
  };
}
