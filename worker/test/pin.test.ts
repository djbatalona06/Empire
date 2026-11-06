import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { api, user } from './helpers';

// Device ids come from the app. Any random string of 16-64 letters, digits or dashes works here.
const newDevice = () => crypto.randomUUID();

async function signedInWithPin(pin = '0528') {
  const u = await user('coworker');
  const device = newDevice();
  const set = await api('/v1/me/pin', { method: 'PUT', token: u.token, body: { device_id: device, pin } });
  expect(set.status).toBe(200);
  return { u, device, pin };
}

const pinLogin = (device: string, pin: string) => api('/v1/auth/pin', { body: { device_id: device, pin } });

describe('device PIN', () => {
  it('needs a signed-in session to set a PIN', async () => {
    const res = await api('/v1/me/pin', { method: 'PUT', body: { device_id: newDevice(), pin: '0528' } });
    expect(res.status).toBe(401);
  });

  it('refuses PINs anyone would guess first', async () => {
    const u = await user('coworker');
    for (const pin of ['1111', '0000', '1234', '9876', 'abcd', '123']) {
      const res = await api('/v1/me/pin', { method: 'PUT', token: u.token, body: { device_id: newDevice(), pin } });
      expect(res.status, pin).toBe(400);
    }
  });

  it('signs in with the PIN on the device it was set on', async () => {
    const { u, device, pin } = await signedInWithPin();
    const res = await pinLogin(device, pin);
    expect(res.status).toBe(200);
    expect(res.body.access_token).toBeTruthy();
    const me = await api('/v1/me', { token: res.body.access_token });
    expect(me.body.id).toBe(u.id);
  });

  it('returns the same error for a wrong PIN, an unknown device and an inactive account', async () => {
    const { u, device } = await signedInWithPin();
    const wrong = await pinLogin(device, '1357');
    const unknown = await pinLogin(newDevice(), '0528');
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe('invalid_pin');
    expect(unknown.status).toBe(401);
    expect(unknown.body.error).toBe('invalid_pin');

    await env.empire_accounts.prepare('UPDATE users SET active = 0 WHERE id = ?').bind(u.id).run();
    const inactive = await pinLogin(device, '0528');
    expect(inactive.status).toBe(401);
    expect(inactive.body.error).toBe('invalid_pin');
  });

  it('locks the device after five wrong tries, even for the right PIN', async () => {
    const { device } = await signedInWithPin();
    for (let i = 0; i < 5; i++) expect((await pinLogin(device, '1357')).status).toBe(401);
    const locked = await pinLogin(device, '0528');
    expect(locked.status).toBe(403);
    expect(locked.body.error).toBe('pin_locked');
  });

  it('accepts the right PIN on the fifth try, after four wrong ones', async () => {
    const { device } = await signedInWithPin();
    for (let i = 0; i < 4; i++) await pinLogin(device, '1357');
    expect((await pinLogin(device, '0528')).status).toBe(200);
  });

  it('reports set and locked state to the app without revealing anything else', async () => {
    const { device } = await signedInWithPin();
    const status = (id: string) => api(`/v1/auth/pin/status?device_id=${id}`);
    expect((await status(device)).body).toEqual({ set: true, locked: false });
    for (let i = 0; i < 5; i++) await pinLogin(device, '1357');
    expect((await status(device)).body).toEqual({ set: true, locked: true });
    expect((await status(newDevice())).body).toEqual({ set: false, locked: false });
  });

  it('clears a lock when the person signs in and sets a new PIN', async () => {
    const { u, device } = await signedInWithPin();
    for (let i = 0; i < 5; i++) await pinLogin(device, '1357');
    expect((await pinLogin(device, '0528')).status).toBe(403);

    // The person signs in again (the normal way), then sets the PIN again on this device.
    const reset = await api('/v1/me/pin', { method: 'PUT', token: u.token, body: { device_id: device, pin: '0528' } });
    expect(reset.status).toBe(200);
    expect((await pinLogin(device, '0528')).status).toBe(200);
  });

  it('will not move another person’s device to a different account', async () => {
    const owner = await user('coworker');
    const other = await user('coworker');
    const device = newDevice();
    expect((await api('/v1/me/pin', { method: 'PUT', token: owner.token, body: { device_id: device, pin: '0528' } })).status).toBe(200);
    const res = await api('/v1/me/pin', { method: 'PUT', token: other.token, body: { device_id: device, pin: '3141' } });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('device_in_use');
  });

  it('stops working after the PIN is removed', async () => {
    const { u, device, pin } = await signedInWithPin();
    const removed = await api(`/v1/me/pin/${device}`, { method: 'DELETE', token: u.token });
    expect(removed.status).toBe(200);
    expect((await pinLogin(device, pin)).status).toBe(401);
  });
});
