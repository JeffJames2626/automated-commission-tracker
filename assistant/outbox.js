import { api } from './api.js';

// The "it won't disappear" guarantee. Every capture is written to IndexedDB on
// the phone *before* any network request. It leaves the outbox only when the
// server confirms it stored it (the server de-duplicates by client_ref, so a
// retry after a lost response can never create a second copy). Items the
// server rejects stay here, visible, until the owner retries or discards them.

const DB = 'personal-assistant', STORE = 'outbox';
let dbp = null;
const memory = new Map();          // fallback when IndexedDB is unavailable (private mode)
const subs = new Set();

function open() {
  if (dbp) return dbp;
  dbp = new Promise(resolve => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'client_ref' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbp;
}

async function tx(mode, fn) {
  const db = await open();
  if (!db) return fn(null);
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error);
  });
}

export async function all() {
  const db = await open();
  if (!db) return [...memory.values()];
  return new Promise(resolve => {
    const r = db.transaction(STORE).objectStore(STORE).getAll();
    r.onsuccess = () => resolve((r.result || []).sort((a, b) => a.created_at.localeCompare(b.created_at)));
    r.onerror = () => resolve([]);
  });
}
async function put(item) { memory.set(item.client_ref, item); await tx('readwrite', s => s && s.put(item)); notify(); }
async function del(ref) { memory.delete(ref); await tx('readwrite', s => s && s.delete(ref)); notify(); }

export function newRef() {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return 'c-' + Date.now().toString(36) + '-' + [...a].map(b => b.toString(36).padStart(2, '0')).join('').slice(0, 16);
}

export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
async function notify() { const items = await all(); subs.forEach(fn => fn(items)); }

// Queue, then try to send immediately. Resolves with the server's answer when
// online, or { queued: true } when the capture is safe on the device.
export async function capture(body) {
  const item = { client_ref: body.client_ref || newRef(), body: Object.assign({}, body), created_at: new Date().toISOString(), attempts: 0, error: null };
  item.body.client_ref = item.client_ref;
  if (!item.body.captured_at) item.body.captured_at = item.created_at;
  await put(item);
  try { return Object.assign({ queued: false }, await send(item)); }
  catch (e) { return { queued: true, error: e }; }
}

async function send(item) {
  item.attempts++;
  try {
    const r = await api('capture', { method: 'POST', body: item.body });
    await del(item.client_ref);
    return r;
  } catch (e) {
    // Retryable: offline, server error, rate limit. Permanent: validation.
    if (e.status >= 400 && e.status < 500 && ![401, 408, 409, 425, 429].includes(e.status)) item.error = e.message;
    else item.error = null;
    item.last_try = new Date().toISOString();
    await put(item);
    throw e;
  }
}

let flushing = false;
export async function flush() {
  if (flushing || !navigator.onLine) return;
  flushing = true;
  try {
    for (const item of await all()) {
      if (item.error) continue;             // needs the owner's attention
      try { await send(item); } catch (e) { if (!e.status || e.status >= 500 || e.status === 401) break; }
    }
  } finally { flushing = false; }
}

export async function retry(ref) { const it = (await all()).find(i => i.client_ref === ref); if (it) { it.error = null; await put(it); await flush(); } }
export async function discard(ref) { await del(ref); }

export function startAutoFlush() {
  window.addEventListener('online', () => flush());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') flush(); });
  setInterval(() => flush(), 30000);
  flush();
}
