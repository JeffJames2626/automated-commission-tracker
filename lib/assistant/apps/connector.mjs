import { HttpError } from '../http.mjs';
import { findUserById, isAllowedEmail } from '../repo/users.mjs';
import { redeemPairing, findByToken, touchApp, startResync, markBackfilled, setAppError, disconnectApp, CODE_RE } from '../repo/apps.mjs';
import { takeQueued, createdIdIndex } from '../repo/ops.mjs';
import { ingestRecord, markMissing } from '../repo/mirror.mjs';
import { getAttachmentData } from '../repo/attachments.mjs';
import { checkRate } from '../ratelimit.mjs';
import { APPS } from '../integrations/registry.mjs';
import { normalizeRecord, ID_RE, str } from './records.mjs';
import { handleResult, sweep } from './routing.mjs';
import { verifyPending } from './actions.mjs';
import { startLink, pollLink } from './link.mjs';

// The endpoints a connected app's SERVER calls (never a browser): Dream Board
// runs on a private PC the assistant cannot reach, so the app polls us.
//
//   POST apps/v1/link/start  "Connect Personal Assistant": a secret to wait
//                            with + the address to open in the owner's browser
//   POST apps/v1/link/poll   secret → pending | approved (+ bearer token, once)
//   POST apps/v1/pair    one-time code → bearer token (typed-code fallback)
//   POST apps/v1/sync    results + changed records in, queued ops out
//   GET  apps/v1/files   one photo referenced by a queued op
//
// These routes take a bearer token and nothing else: no cookie is read, and a
// bearer token is never accepted on the owner's routes. Wire format and the
// app-side rules: docs/assistant/CONNECTED-APPS.md.

const MAX_RECORDS = 100, MAX_RESULTS = 100, MAX_MANIFEST = 5000, OPS_PER_SYNC = 20;
const EPOCH_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const json = (body, status = 200) => ({ status, json: body });
const intOr = (v, d) => (Number.isSafeInteger(Number(v)) && Number(v) >= 0 ? Number(v) : d);

export function createConnector({ db, config, now, limits }) {
  async function authed(req, d) {
    const m = String(req.headers.authorization || '').match(/^Bearer\s+(\S+)$/);
    const row = m ? await findByToken(d, m[1]) : null;
    if (!row) throw new HttpError(401, 'reconnect');
    // The token dies with the owner's access: "sign out everywhere" and an
    // allow-list removal both end it — for good, so every screen says so.
    const user = await findUserById(d, row.user_id);
    if (!user || (user.session_epoch || 0) !== row.session_epoch || !(await isAllowedEmail(d, user.email, config().allowedEmails, { fallback: config().allowFallback !== false }))) {
      await disconnectApp(d, row.user_id, row.app, 'Reconnect needed: you signed out everywhere or access changed.');
      throw new HttpError(401, 'reconnect');
    }
    return { row, user };
  }

  const callerIp = req => String(req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0] || 'unknown').trim().slice(0, 64);
  const linkTemplateOf = v => (typeof v === 'string' && /^\/(?![/\\])[^\s\\]{0,200}$/.test(v) && v.includes('{id}') ? v : null);

  async function pair(req, d) {
    const b = req.body || {};
    if (!APPS[b.app] || !CODE_RE.test(String(b.code || '').toUpperCase()) || !ID_RE.test(String(b.instance_id || ''))) throw new HttpError(400, 'invalid');
    // Per caller, so a stranger can't use up the owner's attempts. A 40-bit,
    // single-use, 10-minute code needs no more than that.
    await checkRate(d, 'pair:' + callerIp(req), 'pair', now(), limits);
    const r = await redeemPairing(d, {
      app: b.app, code: b.code, instanceId: b.instance_id, instanceLabel: str(String(b.instance_label || ''), 80) || null,
      linkTemplate: linkTemplateOf(b.link_template),
    });
    if (!r) throw new HttpError(410, 'That code has expired or was already used. Make a new one in the assistant.');
    return json({ token: r.token, app: r.app, next_poll_seconds: 1 });
  }

  // The app asks to be connected; the owner approves in the browser.
  async function linkStart(req, d) {
    const b = req.body || {};
    if (!APPS[b.app] || !ID_RE.test(String(b.instance_id || ''))) throw new HttpError(400, 'invalid');
    await checkRate(d, 'link:' + callerIp(req), 'link', now(), limits);
    const base = config().publicUrl || req.origin;
    const r = await startLink(d, { app: b.app, instanceId: b.instance_id, instanceLabel: str(String(b.instance_label || ''), 80) || null, linkTemplate: linkTemplateOf(b.link_template) });
    return json({
      device_code: r.device, user_code: r.code,
      approve_url: base + '/assistant/#/link?code=' + r.code,
      expires_in: r.expiresInSeconds, interval: 3,
    });
  }

  async function linkPoll(req, d) {
    const b = req.body || {};
    const device = String(b.device_code || '');
    await checkRate(d, 'linkpoll:' + callerIp(req), 'linkpoll', now(), limits);
    const r = await pollLink(d, device, config().tokenKey);
    if (r.status === 'invalid') throw new HttpError(400, 'invalid');
    if (r.status === 'approved') return json({ status: 'approved', token: r.token, app: r.app, next_poll_seconds: 1 });
    return json({ status: r.status, interval: 3 });
  }

  async function sync(req, d) {
    const { row: app, user } = await authed(req, d);
    const userId = user.id;
    await checkRate(d, userId, 'appsync', now(), limits);
    const b = req.body || {};
    if (String(b.instance_id || '') !== app.instance_id) {
      await setAppError(d, app.id, 'A different board (' + (str(String(b.instance_label || b.instance_id || 'unknown'), 40)) + ') tried to sync. Pair again from that board to switch.');
      return json({ error: 'wrong_board', message: 'This assistant is paired with a different board. Pair again from this board to switch.' }, 409);
    }
    const epoch = String(b.epoch || '');
    if (!EPOCH_RE.test(epoch)) throw new HttpError(400, 'epoch required');
    const seq = intOr(b.seq, null);
    if (seq == null) throw new HttpError(400, 'seq required');
    // One sync at a time per board: a retry that overlaps a slow request waits
    // its turn instead of racing it (the lease ends by itself after 30s).
    const lease = await d.query(`UPDATE asst_apps SET sync_until = now() + interval '30 seconds' WHERE id = $1 AND (sync_until IS NULL OR sync_until < now()) RETURNING id`, [app.id]);
    if (!lease.length) return json({ resync: app.resync, since: Number(app.max_seq) || 0, ops: [], acks: [], next_poll_seconds: 2 });
    try { return json(await exchange(d, app, userId, b, epoch, seq)); }
    finally { await d.query('UPDATE asst_apps SET sync_until = NULL WHERE id = $1', [app.id]); }
  }

  async function exchange(d, app, userId, b, epoch, seq) {
    // A different epoch, or a sequence that went backwards, means the app's
    // history was rewound (restored from a backup): resend everything.
    let resync = app.resync;
    if (!resync && ((app.epoch && app.epoch !== epoch) || (app.epoch === epoch && seq < Number(app.max_seq)))) {
      await startResync(d, app.id, epoch);
      resync = true;
    }
    // One bad record or result never blocks the rest: it is skipped, noted in
    // last_error, and everything else goes through.
    const problems = [];
    const attempt = async (what, fn) => { try { return await fn(); } catch (e) { problems.push(what + ': ' + String(e && e.message || e).slice(0, 60)); return null; } };

    // 1. Results first, so a record created by one of our ops is recognised
    //    as ours when its snapshot is read below.
    const acks = [];
    for (const res of (Array.isArray(b.results) ? b.results : []).slice(0, MAX_RESULTS)) {
      if (!res || typeof res.op_id !== 'string') continue;
      const r = await attempt('result', () => handleResult(d, { userId, app: app.app, result: res, epoch }));
      if (r && r.ok) acks.push(res.op_id); else if (r) problems.push('result ' + r.reason);
    }

    // 2. Snapshots.
    const createdBy = await createdIdIndex(d, userId, app.app);
    const records = Array.isArray(b.records) ? b.records : [];
    let maxSeq = Number(app.max_seq) || 0, received = 0;
    for (const raw of records.slice(0, MAX_RECORDS)) {
      const rec = normalizeRecord(raw);
      if (!rec) { problems.push('invalid record'); continue; }
      await attempt('record ' + rec.id, () => ingestRecord(d, { userId, app: app.app, rec, epoch, backfill: resync, createdBy }));
      received++;
      if (!resync) maxSeq = Math.max(maxSeq, rec.seq);
    }

    // 3. End of a full resend: whatever the app no longer lists is hidden.
    //    Only a complete page counts — records past the cap weren't read.
    const bf = b.backfill && typeof b.backfill === 'object' ? b.backfill : null;
    if (resync && bf && bf.done === true) {
      const ids = Array.isArray(bf.ids) ? bf.ids.filter(x => typeof x === 'string' && ID_RE.test(x)) : null;
      if (records.length > MAX_RECORDS) problems.push('backfill page over ' + MAX_RECORDS + ' records — send pages of ' + MAX_RECORDS);
      else if (!ids || bf.ids.length > MAX_MANIFEST) problems.push('backfill ids missing');
      else {
        const from = Math.min(intOr(bf.start_seq, 0), seq);
        await markMissing(d, userId, app.app, ids);
        await markBackfilled(d, app.id, { epoch, fromSeq: from });
        resync = false;
        maxSeq = from;
      }
    }
    if (resync) await touchApp(d, app.id, { epoch, maxSeq: 0 });
    else await touchApp(d, app.id, { epoch, maxSeq });

    // 4. Finish anything half-done, then hand over the queue (never while
    //    the mirror is being rebuilt: routing needs an accurate list).
    await attempt('sweep', () => sweep(d, userId, app.app));
    await attempt('verify', () => verifyPending(d, userId, app.app));
    const ops = resync ? [] : (await takeQueued(d, userId, app.app, OPS_PER_SYNC)).map(toWire);
    await setAppError(d, app.id, problems.length ? problems.slice(0, 3).join('; ') : null);
    return {
      resync, since: resync ? 0 : maxSeq, ops, acks,
      next_poll_seconds: resync || ops.length === OPS_PER_SYNC || records.length >= MAX_RECORDS ? 1 : ops.length || received || acks.length ? 15 : 60,
    };
  }

  async function file(req, d) {
    const { row: app, user } = await authed(req, d);
    await checkRate(d, user.id, 'appfile', now(), limits);
    const id = String(req.query.id || ''), opId = String(req.query.op || '');
    // Only a photo that a queued op for this app lists — never any other file.
    const r = await d.query(`SELECT 1 FROM asst_app_ops WHERE id = $1 AND user_id = $2 AND app = $3 AND status = 'queued'
      AND payload->'attachments' @> $4::jsonb`, [opId, user.id, app.app, JSON.stringify([{ id }])]);
    const a = r[0] ? await getAttachmentData(d, user.id, id) : null;
    if (!a) throw new HttpError(404, 'Not found');
    return { status: 200, binary: Buffer.from(a.data_b64, 'base64'), contentType: a.mime, headers: { 'cache-control': 'no-store' } };
  }

  const routes = { 'POST apps/v1/pair': pair, 'POST apps/v1/link/start': linkStart, 'POST apps/v1/link/poll': linkPoll, 'POST apps/v1/sync': sync, 'GET apps/v1/files': file };

  return async function handleApp(req) {
    const fn = routes[req.method + ' ' + req.route];
    if (!fn) throw new HttpError(404, 'Unknown endpoint');
    return fn(req, await db());
  };
}

// What the app receives for one op: only what it needs to apply it.
const WIRE_FIELDS = ['goal_id', 'title', 'title_origin', 'note', 'captured_at', 'source_type', 'capture_id', 'set', 'expect', 'milestone', 'confirmed_at'];
function toWire(op) {
  const p = op.payload || {}, out = { op_id: op.id, kind: op.kind, created_at: new Date(op.created_at).toISOString() };
  for (const k of WIRE_FIELDS) if (p[k] !== undefined) out[k] = p[k];
  if (Array.isArray(p.attachments) && p.attachments.length) {
    out.attachments = p.attachments.map(a => ({ id: a.id, mime: a.mime, size: a.size, sha256: a.sha256, path: `apps/v1/files?id=${encodeURIComponent(a.id)}&op=${encodeURIComponent(op.id)}` }));
  }
  return out;
}
