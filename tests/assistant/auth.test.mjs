import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, makeApp, fakeGoogle, idToken, ALL_SCOPES, CONFIG } from './helpers.mjs';
import { decrypt } from '../../lib/assistant/crypto.mjs';
import { signPayload } from '../../lib/assistant/session.mjs';

let db;
before(async () => { db = await makeDb(); });

test('sign-in URL: code flow, PKCE S256, offline access, sign-in scopes only', async () => {
  const app = makeApp({ db, google: fakeGoogle() });
  const r = await app.call('GET', 'auth/start', { query: { intent: 'signin' } });
  assert.equal(r.status, 302);
  const u = new URL(r.redirect);
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.equal(u.searchParams.get('scope'), 'openid email profile');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://assistant.test/api/assistant/auth/callback');
  assert.ok(u.searchParams.get('state').length > 20);
  assert.ok(!r.redirect.includes(CONFIG.googleClientSecret), 'client secret never leaves the server');
  assert.match(r.cookies[0], /HttpOnly/);
});

test('callback signs in, seeds projects, stores encrypted tokens; tokens never appear in API output', async () => {
  const g = fakeGoogle();
  g.state.tokenResponse.scope = 'openid email profile';
  const app = makeApp({ db, google: g });
  const { cb } = await app.signIn();
  assert.equal(cb.status, 302);
  assert.equal(cb.redirect, '/assistant/#/today');
  assert.ok(app.jar.asst_session, 'session cookie set');
  const sessionCookie = cb.cookies.find(c => c.startsWith('asst_session='));
  assert.match(sessionCookie, /HttpOnly/);
  assert.match(sessionCookie, /Secure/);
  assert.match(sessionCookie, /SameSite=Lax/);

  const rows = await db.query('SELECT * FROM asst_connections');
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].refresh_token_enc, 'rt-1');
  assert.equal(decrypt(rows[0].refresh_token_enc, CONFIG.tokenKey), 'rt-1');

  const boot = await app.call('GET', 'bootstrap');
  assert.equal(boot.status, 200);
  assert.ok(boot.json.projects.find(p => p.name === 'ALP'));
  const conns = await app.call('GET', 'connections');
  const dump = JSON.stringify([boot.json, conns.json]);
  assert.ok(!dump.includes('rt-1') && !dump.includes('at-1') && !dump.includes('refresh_token'), 'no token material in responses');
  assert.equal(conns.json.services.find(s => s.key === 'gmail').state, 'not_granted');
});

test('email not on the allow-list is refused', async () => {
  const g = fakeGoogle();
  const app = makeApp({ db, google: g });
  const { cb } = await app.signIn({ sub: '666', email: 'stranger@example.com' });
  assert.match(cb.redirect, /signin\?error=/);
  // Only the private notice: not the address, not what the app is or holds.
  assert.equal(decodeURIComponent(cb.redirect), '/assistant/#/signin?error=This Personal Assistant is private.');
  assert.equal(app.jar.asst_session, undefined);
  // …and nothing behind the sign-in answers them.
  const me = await app.call('GET', 'bootstrap');
  assert.equal(me.status, 401);
});

test('tampered state, expired oauth cookie and forged sessions are rejected', async () => {
  const app = makeApp({ db, google: fakeGoogle() });
  await app.call('GET', 'auth/start', { query: { intent: 'signin' } });
  const bad = await app.call('GET', 'auth/callback', { query: { code: 'c', state: 'not-the-state' } });
  assert.match(decodeURIComponent(bad.redirect), /expired/);

  const forged = signPayload({ u: 'usr_whatever', ep: 0, x: Date.now() + 1e6 }, 'wrong-secret-wrong-secret-wrong-secret!!');
  const r = await app.call('GET', 'me', { cookies: { asst_session: forged } });
  assert.equal(r.status, 401);
  const none = await app.call('GET', 'me', { cookies: {} });
  assert.equal(none.status, 401);
});

test('unverified Google email or token for another app is refused', async () => {
  const g = fakeGoogle();
  const app = makeApp({ db, google: g });
  const start = await app.call('GET', 'auth/start', { query: { intent: 'signin' } });
  g.state.tokenResponse.id_token = idToken({ email_verified: false });
  const cb = await app.call('GET', 'auth/callback', { query: { code: 'x', state: new URL(start.redirect).searchParams.get('state') } });
  assert.match(decodeURIComponent(cb.redirect), /not verified/);
  const start2 = await app.call('GET', 'auth/start', { query: { intent: 'signin' } });
  g.state.tokenResponse.id_token = idToken({ aud: 'someone-else' });
  const cb2 = await app.call('GET', 'auth/callback', { query: { code: 'x', state: new URL(start2.redirect).searchParams.get('state') } });
  assert.match(decodeURIComponent(cb2.redirect), /different app/);
});

test('state-changing requests need the x-assistant header (CSRF)', async () => {
  const app = makeApp({ db, google: fakeGoogle() });
  await app.signIn();
  const r = await app.call('POST', 'capture', { body: { text: 'hi', client_ref: 'csrf-test-1' }, headers: { 'x-assistant': undefined } });
  assert.equal(r.status, 403);
});

test('connecting services: incremental scopes, consent, and scopes the person unticked', async () => {
  const g = fakeGoogle();
  const app = makeApp({ db, google: g });
  await app.signIn();
  const start = await app.call('GET', 'auth/start', { query: { intent: 'connect', services: 'gmail,drive,sheets' } });
  const u = new URL(start.redirect);
  const scopes = u.searchParams.get('scope').split(' ');
  assert.ok(scopes.includes('https://www.googleapis.com/auth/gmail.readonly'));
  assert.ok(scopes.includes('https://www.googleapis.com/auth/drive.readonly'));
  assert.ok(!scopes.some(s => /gmail\.(send|modify|compose)|auth\/drive$|spreadsheets$/.test(s)), 'read-only scopes only');
  assert.equal(u.searchParams.get('include_granted_scopes'), 'true');
  assert.equal(u.searchParams.get('prompt'), 'consent');
  // The person unticks Drive on Google's consent screen.
  g.state.tokenResponse.scope = ALL_SCOPES.filter(s => !s.includes('drive')).join(' ');
  const cb = await app.call('GET', 'auth/callback', { query: { code: 'c2', state: u.searchParams.get('state') } });
  assert.equal(cb.redirect, '/assistant/#/connections?missing=drive');
  const conns = await app.call('GET', 'connections');
  const st = Object.fromEntries(conns.json.services.map(s => [s.key, s.state]));
  assert.equal(st.gmail, 'connected');
  assert.equal(st.drive, 'not_granted');
  assert.equal(st.sheets, 'connected');
});

test('switching a service off and disconnecting Google (revokes at Google)', async () => {
  const g = fakeGoogle();
  const app = makeApp({ db, google: g });
  await app.signIn();
  await app.call('POST', 'connections/service', { body: { service: 'gmail', enabled: false } });
  let conns = await app.call('GET', 'connections');
  assert.equal(conns.json.services.find(s => s.key === 'gmail').state, 'disabled');
  await app.call('POST', 'connections/service', { body: { service: 'gmail', enabled: true } });
  conns = await app.call('GET', 'connections');
  assert.equal(conns.json.services.find(s => s.key === 'gmail').state, 'connected');
  const d = await app.call('POST', 'connections/disconnect');
  assert.equal(d.json.revokedAtGoogle, true);
  assert.ok(g.calls.some(c => c.url.href.startsWith('https://oauth2.googleapis.com/revoke')));
  conns = await app.call('GET', 'connections');
  assert.equal(conns.json.google, null);
  assert.equal(conns.json.services.find(s => s.key === 'gmail').state, 'not_connected');
});

test('sign out everywhere invalidates existing cookies', async () => {
  const app = makeApp({ db, google: fakeGoogle() });
  await app.signIn();
  const old = app.jar.asst_session;
  assert.equal((await app.call('GET', 'me')).status, 200);
  await app.call('POST', 'auth/signout-all');
  const r = await app.call('GET', 'me', { cookies: { asst_session: old } });
  assert.equal(r.status, 401);
});

test('removing someone from the allow-list ends their session on the next request', async () => {
  const app = makeApp({ db, google: fakeGoogle() });
  await app.signIn({ sub: '2002', email: 'second@example.com' });
  assert.equal((await app.call('GET', 'me')).status, 200);
  const app2 = makeApp({ db, google: fakeGoogle(), config: { allowedEmails: ['owner@example.com'] } });
  const r = await app2.call('GET', 'me', { cookies: Object.assign({}, app.jar) });
  assert.equal(r.status, 401);
});
