// HTTP transport for Google REST APIs. Knows nothing about Gmail or Drive —
// only how to talk to Google reliably:
//   * per-request timeout
//   * retries with exponential backoff + jitter on 429, 5xx and rate-limit 403s,
//     honouring Retry-After
//   * one forced token refresh on 401
//   * typed errors so callers can tell "reconnect" from "try later" from "missing scope"
//   * bounded pagination

export class GoogleApiError extends Error {
  constructor({ kind, status, reason, message, service }) {
    super(message || kind);
    this.kind = kind;       // auth | scope | rate_limited | not_found | unavailable | timeout | bad_request | failed | not_connected | disabled
    this.status = status;
    this.reason = reason;
    this.service = service;
  }
  get publicMessage() { return describeError(this); }
}

export function describeError(e) {
  const svc = e.service ? e.service + ': ' : '';
  switch (e.kind) {
    case 'not_connected': return svc + 'not connected yet.';
    case 'disabled': return svc + 'switched off in Connections.';
    case 'auth': return svc + 'Google needs you to reconnect.';
    case 'scope': return svc + 'permission was not granted — reconnect and allow it.';
    case 'rate_limited': return svc + 'Google is rate-limiting requests; try again in a minute.';
    case 'timeout': return svc + 'Google took too long to answer.';
    case 'unavailable': return svc + 'Google is having trouble right now.';
    case 'not_found': return svc + 'that item no longer exists or is not shared with you.';
    default: return svc + 'request failed' + (e.status ? ' (' + e.status + ')' : '') + '.';
  }
}

const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'RATE_LIMIT_EXCEEDED', 'quotaExceeded', 'backendError']);
const SCOPE_REASONS = new Set(['insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'SERVICE_DISABLED', 'accessNotConfigured']);

async function readError(r) {
  let body = null;
  try { body = await r.json(); } catch { body = null; }
  const err = body && body.error;
  const reasons = [];
  if (err && Array.isArray(err.errors)) err.errors.forEach(x => x && x.reason && reasons.push(x.reason));
  if (err && Array.isArray(err.details)) err.details.forEach(x => x && x.reason && reasons.push(x.reason));
  if (err && err.status) reasons.push(err.status);
  return { message: (err && err.message) || ('HTTP ' + r.status), reasons };
}

function retryAfterMs(r) {
  const h = r.headers && r.headers.get && r.headers.get('retry-after');
  if (!h) return null;
  const n = Number(h);
  if (Number.isFinite(n)) return Math.min(n * 1000, 20000);
  const d = Date.parse(h);
  return Number.isFinite(d) ? Math.min(Math.max(0, d - Date.now()), 20000) : null;
}

export function createGoogleClient({
  fetchImpl = fetch,
  getAccessToken,                 // async (forceRefresh:boolean) => token
  service = '',
  maxRetries = 3,
  timeoutMs = 12000,
  sleep = ms => new Promise(res => setTimeout(res, ms)),
  random = Math.random,
}) {
  async function request(url, { params, responseType = 'json', method = 'GET' } = {}) {
    const u = new URL(url);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) v.forEach(x => u.searchParams.append(k, String(x)));
        else u.searchParams.set(k, String(v));
      }
    }
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const token = await getAccessToken(false);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let r;
      try {
        r = await fetchImpl(u.toString(), { method, headers: { authorization: 'Bearer ' + token }, signal: ctrl.signal });
      } catch (e) {
        clearTimeout(timer);
        const kind = e.name === 'AbortError' ? 'timeout' : 'unavailable';
        if (attempt < Math.min(maxRetries, 1)) { await sleep(backoff(attempt)); continue; }
        throw new GoogleApiError({ kind, service, message: e.message });
      }
      clearTimeout(timer);
      if (r.ok) {
        if (responseType === 'text') return r.text();
        if (responseType === 'buffer') return Buffer.from(await r.arrayBuffer());
        return r.json();
      }
      const { message, reasons } = await readError(r);
      if (r.status === 401 && !refreshed) {
        refreshed = true;
        await getAccessToken(true);        // throws a typed auth error if the grant is dead
        continue;
      }
      if (r.status === 401) throw new GoogleApiError({ kind: 'auth', status: 401, service, message });
      const rateLimited = r.status === 429 || (r.status === 403 && reasons.some(x => RATE_REASONS.has(x)));
      if (r.status === 403 && !rateLimited && reasons.some(x => SCOPE_REASONS.has(x)))
        throw new GoogleApiError({ kind: 'scope', status: 403, reason: reasons[0], service, message });
      const retryable = rateLimited || r.status >= 500;
      if (retryable && attempt < maxRetries) {
        await sleep(retryAfterMs(r) ?? backoff(attempt));
        continue;
      }
      const kind = rateLimited ? 'rate_limited'
        : r.status === 404 ? 'not_found'
        : r.status >= 500 ? 'unavailable'
        : r.status === 400 ? 'bad_request'
        : r.status === 403 ? 'scope' : 'failed';
      throw new GoogleApiError({ kind, status: r.status, reason: reasons[0], service, message });
    }
  }

  function backoff(attempt) {
    return Math.min(8000, 400 * 2 ** attempt) + Math.floor(random() * 250);
  }

  // Walk pages until maxItems, then stop — a search never drags a whole mailbox.
  async function paginate(url, { params = {}, itemsKey, maxItems = 50, maxPages = 5, pageSizeParam, pageSize } = {}) {
    const out = [];
    let pageToken;
    let estimate = null;
    for (let page = 0; page < maxPages; page++) {
      const p = Object.assign({}, params, pageToken ? { pageToken } : {});
      if (pageSizeParam) p[pageSizeParam] = Math.min(pageSize || maxItems, maxItems - out.length);
      const data = await request(url, { params: p });
      if (estimate == null && data.resultSizeEstimate != null) estimate = data.resultSizeEstimate;
      (data[itemsKey] || []).forEach(x => { if (out.length < maxItems) out.push(x); });
      pageToken = data.nextPageToken;
      if (!pageToken || out.length >= maxItems) break;
    }
    return { items: out, truncated: !!pageToken, estimate };
  }

  return { request, get: (url, params, opts = {}) => request(url, Object.assign({ params }, opts)), paginate };
}
