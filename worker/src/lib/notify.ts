import type { Env } from '../env';
import { SmtpError, sendSmtp, smtpConfig } from './smtp';

const b64url = (data: ArrayBuffer | string) =>
  btoa(typeof data === 'string' ? data : String.fromCharCode(...new Uint8Array(data))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let apnsJwt: { token: string; at: number } | null = null;

/** APNs provider token (ES256), reused for 50 minutes as Apple recommends. */
async function apnsToken(env: Env) {
  if (apnsJwt && Date.now() - apnsJwt.at < 50 * 60_000) return apnsJwt.token;
  const pem = env.APNS_KEY_P8!.replace(/\\n/g, '\n').replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  const der = Uint8Array.from(atob(pem), (ch) => ch.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64url(JSON.stringify({ alg: 'ES256', kid: env.APNS_KEY_ID }));
  const claims = b64url(JSON.stringify({ iss: env.APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) }));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(`${head}.${claims}`));
  apnsJwt = { token: `${head}.${claims}.${b64url(sig)}`, at: Date.now() };
  return apnsJwt.token;
}

export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, string>;
}

export async function pushToUser(env: Env, userId: string, build: (locale: string) => PushMessage) {
  const user = await env.DB.prepare('SELECT locale FROM users WHERE id = ?').bind(userId).first<{ locale: string }>();
  if (!user) return;
  const msg = build(user.locale);
  if (!env.APNS_KEY_P8 || !env.APNS_KEY_ID || !env.APNS_TEAM_ID) {
    console.log('[push:disabled]', userId, msg.title);
    return;
  }
  const { results } = await env.DB.prepare('SELECT apns_token, env FROM devices WHERE user_id = ?').bind(userId).all<{ apns_token: string; env: string }>();
  const jwt = await apnsToken(env);
  await Promise.all(
    results.map(async (d) => {
      const host = d.env === 'sandbox' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
      const res = await fetch(`https://${host}/3/device/${d.apns_token}`, {
        method: 'POST',
        headers: { authorization: `bearer ${jwt}`, 'apns-topic': env.APNS_TOPIC, 'apns-push-type': 'alert', 'content-type': 'application/json' },
        body: JSON.stringify({ aps: { alert: { title: msg.title, body: msg.body }, sound: 'default' }, ...msg.data }),
      }).catch(() => null);
      // 410 Gone / 400 BadDeviceToken: the app was deleted or token rotated.
      if (res && (res.status === 410 || res.status === 400)) {
        await env.DB.prepare('DELETE FROM devices WHERE apns_token = ?').bind(d.apns_token).run();
      }
    }),
  );
}

/**
 * The one place email leaves the app. Order: SMTP (if SMTP_HOST is set), then Resend (if RESEND_API_KEY is set),
 * otherwise the message is only written to the log. Never throws: a mail problem must not break a sign-in.
 */
export async function sendEmail(env: Env, to: string, subject: string, text: string) {
  try {
    const smtp = smtpConfig(env);
    if (smtp) return await sendSmtp(smtp, { from: env.EMAIL_FROM, to, subject, text });
    if (env.RESEND_API_KEY) return await sendWithResend(env, to, subject, text);
    console.log('[email:disabled]', to, subject);
  } catch (err) {
    // Only the reason is logged: never the message body (it holds a sign-in link) or any credential.
    console.error(JSON.stringify({ level: 'error', msg: 'email_failed', via: env.SMTP_HOST ? 'smtp' : 'resend', reason: err instanceof Error ? err.message : String(err), code: err instanceof SmtpError ? err.code : undefined }));
  }
}

async function sendWithResend(env: Env, to: string, subject: string, text: string) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_FROM, to, subject, text }),
  });
  if (!res.ok) throw new Error(`Resend answered ${res.status}: ${await res.text()}`);
}
