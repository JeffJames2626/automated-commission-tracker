import { randomBytes } from 'node:crypto';

// Server diagnostics: one JSON line per request (and per notable failure),
// named by a request id the person can quote from an error message.
// Never the content: no capture text, questions, email, file names, queries
// or tokens — only which endpoint, how it ended, how long, and the error type.

export function requestId() { return 'req_' + randomBytes(6).toString('hex'); }

// What went wrong, without what was in it. Messages from Postgres, Google or
// the AI SDK can quote data, so only a scrubbed, short form is kept.
export function errorFields(e) {
  if (!e) return {};
  const out = { err: String(e.name || 'Error').slice(0, 40) };
  if (e.code != null) out.code = String(e.code).slice(0, 40);
  if (e.status != null) out.status = Number(e.status) || undefined;
  if (e.kind) out.kind = String(e.kind).slice(0, 30);
  const where = String(e.stack || '').split('\n').find(l => /lib\/assistant\//.test(l));
  if (where) out.at = where.trim().replace(/^at\s+/, '').replace(/^.*\/lib\/assistant\//, '').slice(0, 120);
  out.msg = scrub(e.message);
  return out;
}

export function scrub(s) {
  return String(s || '')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>')
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/"[^"]*"|'[^']*'|\([^)]*\)=\([^)]*\)/g, '<value>')
    .replace(/\b(ya29|1\/\/|sk-ant|dbc_|eyJ)[\w.-]*/g, '<secret>')
    .replace(/\d{5,}/g, '<n>')
    .slice(0, 160);
}

export function logEvent(fields, sink = console) {
  try { (fields.level === 'error' ? sink.error : sink.log).call(sink, JSON.stringify(Object.assign({ at: new Date().toISOString(), svc: 'assistant' }, fields))); }
  catch { /* logging never breaks a request */ }
}
