// Test harness: real Postgres (PGlite, in memory), a scriptable fake Google,
// a scriptable fake Claude, and a tiny client that calls router routes the way
// the browser does (cookie + x-assistant header).

import { PGlite } from '@electric-sql/pglite';
import { pgliteDb } from '../../lib/assistant/db/index.mjs';
import { migrate } from '../../lib/assistant/db/schema.mjs';
import { createRouter } from '../../lib/assistant/router.mjs';
import { parseCookies } from '../../lib/assistant/http.mjs';

export const CONFIG = {
  databaseUrl: 'pglite://memory',
  googleClientId: 'test-client.apps.googleusercontent.com',
  googleClientSecret: 'test-secret',
  tokenKey: 'a'.repeat(64),
  sessionSecret: 's'.repeat(48),
  allowedEmails: ['owner@example.com', 'second@example.com'],
  anthropicKey: '',
  model: 'claude-opus-5',
  publicUrl: '',
};

export async function makeDb() {
  const pg = new PGlite();
  const db = pgliteDb(pg);
  await migrate(db);
  return db;
}

export function idToken(claims) {
  const enc = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  return enc({ alg: 'RS256' }) + '.' + enc(Object.assign({
    iss: 'https://accounts.google.com', aud: CONFIG.googleClientId, exp: Math.floor(Date.now() / 1000) + 3600,
    sub: '1001', email: 'owner@example.com', email_verified: true, name: 'Owner Person',
  }, claims)) + '.sig';
}

export const ALL_SCOPES = [
  'openid', 'email', 'profile',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/contacts.readonly',
];

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: Object.assign({ 'content-type': 'application/json' }, headers) });
}

// Fake Google: `routes` maps "METHOD host/path" prefixes (or regexes) to
// handlers (url, init) => Response | object. Every call is recorded.
export function fakeGoogle(overrides = {}) {
  const calls = [];
  const state = {
    tokenResponse: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, scope: ALL_SCOPES.join(' '), id_token: idToken({}) },
    refreshResponse: { access_token: 'at-2', expires_in: 3600 },
    refreshStatus: 200,
    routes: [],
  };
  Object.assign(state, overrides);
  const on = (pattern, handler) => { state.routes.unshift({ pattern, handler }); };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? String(init.body) : '';
    calls.push({ url: u, method: init.method || 'GET', body, auth: init.headers && (init.headers.authorization || init.headers.Authorization) });
    if (u.href.startsWith('https://oauth2.googleapis.com/token')) {
      const p = new URLSearchParams(body);
      if (p.get('grant_type') === 'authorization_code') return jsonResponse(state.tokenResponse);
      if (state.refreshStatus !== 200) return jsonResponse(state.refreshResponse, state.refreshStatus);
      return jsonResponse(state.refreshResponse);
    }
    if (u.href.startsWith('https://oauth2.googleapis.com/revoke')) return jsonResponse({});
    for (const r of state.routes) {
      const key = (init.method || 'GET') + ' ' + u.host + u.pathname;
      const hit = r.pattern instanceof RegExp ? r.pattern.test(key) : key.startsWith(r.pattern);
      if (hit) {
        const out = await r.handler(u, init);
        return out instanceof Response ? out : jsonResponse(out);
      }
    }
    return jsonResponse({ error: { code: 404, message: 'no fake route for ' + u.href } }, 404);
  };
  return { fetchImpl, calls, state, on, jsonResponse };
}

// Fake Claude: `script` is a function (params, n) => message, or an array of
// messages returned in order.
export function fakeClaude(script) {
  const requests = [];
  let n = 0;
  return {
    model: 'claude-opus-5',
    requests,
    async create(params) {
      requests.push(JSON.parse(JSON.stringify(params)));
      const i = n++;
      const m = typeof script === 'function' ? await script(params, i) : script[Math.min(i, script.length - 1)];
      if (m instanceof Error) throw m;
      return Object.assign({ id: 'msg_' + i, type: 'message', role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', usage: {} }, m);
    },
  };
}

export const text = t => ({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn' });
export const toolUse = (calls) => ({ stop_reason: 'tool_use', content: calls.map((c, i) => ({ type: 'tool_use', id: 'tu_' + i + '_' + c.name, name: c.name, input: c.input })) });

export function makeApp({ db, google, claude = null, config = {}, now, linkFetch, lookup, limits }) {
  const router = createRouter({ db, fetchImpl: google ? google.fetchImpl : undefined, claude, config: Object.assign({}, CONFIG, config), now, sleep: async () => {}, linkFetch, lookup, limits });
  const jar = {};
  async function call(method, route, { body, query = {}, headers = {}, cookies } = {}) {
    const out = await router({
      method, route, query, body: body === undefined ? null : body,
      headers: Object.assign({ 'x-assistant': '1', 'x-timezone': 'America/Chicago' }, headers),
      cookies: cookies || Object.assign({}, jar), origin: 'https://assistant.test',
    });
    for (const c of out.cookies || []) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      const k = kv.slice(0, i), v = decodeURIComponent(kv.slice(i + 1));
      if (/Max-Age=0/.test(c)) delete jar[k]; else jar[k] = v;
    }
    return out;
  }
  // Collect an NDJSON stream route into its events.
  async function stream(route, body) {
    const out = await call('POST', route, { body });
    if (!out.stream) return { out, events: [] };
    const events = [];
    try { await out.stream(e => events.push(JSON.parse(JSON.stringify(e)))); }
    catch (e) { events.push({ type: 'error', error: e.message }); }
    return { out, events };
  }
  async function signIn({ sub = '1001', email = 'owner@example.com' } = {}) {
    if (google) google.state.tokenResponse.id_token = idToken({ sub, email });
    const start = await call('GET', 'auth/start', { query: { intent: 'signin' } });
    const state = new URL(start.redirect).searchParams.get('state');
    const cb = await call('GET', 'auth/callback', { query: { code: 'code-1', state } });
    return { start, cb };
  }
  return { router, call, stream, signIn, jar, parseCookies };
}
