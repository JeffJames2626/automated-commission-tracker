// Thin adapter between Node's (req, res) and the router's plain objects.
// The router receives { method, route, query, headers, cookies, body, origin }
// and returns { status, json } | { status, redirect } | { status, stream }.
// Keeping HTTP out of the router lets tests call routes directly.

const MAX_BODY = 4_400_000;   // Vercel's request limit is 4.5 MB

export function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    if (!k) return;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); }
  });
  return out;
}

export function cookie(name, value, { maxAge, path = '/', secure = true, httpOnly = true, sameSite = 'Lax' } = {}) {
  let s = name + '=' + encodeURIComponent(value || '') + '; Path=' + path + '; SameSite=' + sameSite;
  if (httpOnly) s += '; HttpOnly';
  if (secure) s += '; Secure';
  if (maxAge != null) s += '; Max-Age=' + Math.floor(maxAge);
  return s;
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return null; } }
    if (Buffer.isBuffer(req.body)) { try { return JSON.parse(req.body.toString('utf8')); } catch { return null; } }
    return req.body;
  }
  if (req.method === 'GET' || req.method === 'HEAD') return null;
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) { const e = new Error('body too large'); e.status = 413; throw e; }
    chunks.push(c);
  }
  if (!chunks.length) return null;
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}

export async function toRequest(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  const proto = String(req.headers['x-forwarded-proto'] || (/^localhost|^127\./.test(host) ? 'http' : 'https')).split(',')[0];
  const url = new URL(req.url, proto + '://' + host);
  const query = Object.fromEntries(url.searchParams.entries());
  return {
    method: req.method,
    // /api/assistant/auth/callback and /api/assistant?r=auth/callback are the same route.
    route: String(query.r || (url.pathname.match(/^\/api\/assistant\/(.+)$/) || [])[1] || '').replace(/^\/+|\/+$/g, ''),
    query,
    headers: req.headers,
    cookies: parseCookies(req.headers.cookie),
    body: await readBody(req),
    origin: proto + '://' + host,
  };
}

export async function sendResponse(res, out) {
  const headers = Object.assign({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }, out.headers || {});
  const setCookies = out.cookies || [];
  if (setCookies.length) res.setHeader('set-cookie', setCookies);
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  if (out.redirect) {
    res.statusCode = out.status || 302;
    res.setHeader('location', out.redirect);
    return res.end();
  }
  if (out.stream) {
    res.statusCode = out.status || 200;
    res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
    const write = obj => { res.write(JSON.stringify(obj) + '\n'); };
    try { await out.stream(write); }
    catch (e) { write({ type: 'error', error: publicError(e) }); }
    return res.end();
  }
  if (out.binary) {
    res.statusCode = out.status || 200;
    res.setHeader('content-type', out.contentType || 'application/octet-stream');
    return res.end(out.binary);
  }
  res.statusCode = out.status || 200;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(out.json === undefined ? {} : out.json));
}

// Errors that are safe to show. Anything unexpected becomes a generic message
// (details go to the server log, never to the page).
export class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

export function publicError(e) {
  if (e instanceof HttpError) return e.message;
  if (e && e.publicMessage) return e.publicMessage;
  return 'Something went wrong on the server.';
}
