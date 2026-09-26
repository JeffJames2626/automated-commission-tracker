// Talking to /api/assistant. Every request carries the CSRF header and the
// device's time zone; the session itself is an HttpOnly cookie the page never
// sees.

const BASE = '/api/assistant';
export const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })();

export class ApiError extends Error {
  constructor(status, message, body) { super(message); this.status = status; this.body = body; }
  get offline() { return this.status === 0; }
}

// What a person reads when a request fails: the server's plain-words message,
// plus a reference to quote in a bug report when the server itself broke.
export function errorText(status, data) {
  const msg = (data && data.error) || (status >= 500 ? 'Something went wrong on the server.' : 'That did not work (' + status + ').');
  return data && data.ref ? msg + ' Reference: ' + data.ref : msg;
}

const listeners = new Set();
export function onSignedOut(fn) { listeners.add(fn); }

export async function api(route, { method = 'GET', body, query, signal } = {}) {
  const q = new URLSearchParams(Object.assign({ r: route }, query || {}));
  let r;
  try {
    r = await fetch(BASE + '?' + q.toString(), {
      method, signal, credentials: 'same-origin',
      headers: Object.assign({ 'x-assistant': '1', 'x-timezone': TZ }, body !== undefined ? { 'content-type': 'application/json' } : {}),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError(0, navigator.onLine ? 'Could not reach the server.' : 'You are offline.');
  }
  let data = null;
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('application/json')) { try { data = await r.json(); } catch { data = null; } }
  if (r.status === 401) { listeners.forEach(fn => fn()); throw new ApiError(401, 'Signed out', data); }
  if (!r.ok) throw new ApiError(r.status, errorText(r.status, data), data);
  return data;
}

// NDJSON stream (assistant answers): calls onEvent for each line as it arrives.
export async function stream(route, body, onEvent, { signal } = {}) {
  let r;
  try {
    r = await fetch(BASE + '?r=' + encodeURIComponent(route), {
      method: 'POST', signal, credentials: 'same-origin',
      headers: { 'x-assistant': '1', 'x-timezone': TZ, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError(0, navigator.onLine ? 'Could not reach the server.' : 'You are offline.');
  }
  if (r.status === 401) { listeners.forEach(fn => fn()); throw new ApiError(401, 'Signed out'); }
  if (!r.ok) { let d = null; try { d = await r.json(); } catch { /* not json */ } throw new ApiError(r.status, errorText(r.status, d), d); }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let ev = null;
      try { ev = JSON.parse(line); } catch { /* not a full event */ }
      if (ev) onEvent(ev);
    }
  }
  let tail = null;
  if (buf.trim()) { try { tail = JSON.parse(buf); } catch { /* ignore */ } }
  if (tail) onEvent(tail);
}

// The standalone demo (scripts/assistant-demo) serves attachments from memory.
export const attachmentUrl = id => (window.__asstAttachmentUrl && window.__asstAttachmentUrl(id)) || BASE + '?r=attachment&id=' + encodeURIComponent(id);
export const authUrl = (intent, services = [], next = '') => BASE + '/auth/start?intent=' + intent + (services.length ? '&services=' + services.join(',') : '') + (next ? '&next=' + encodeURIComponent(next) : '');
