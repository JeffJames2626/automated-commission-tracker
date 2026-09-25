import { HttpError } from '../http.mjs';
import { findUserById, isAllowedEmail } from '../repo/users.mjs';
import { redeemPairing, findByToken, touchApp, setResync, markBackfilled, setAppError, CODE_RE } from '../repo/apps.mjs';
import { takeQueued, createdIdIndex } from '../repo/ops.mjs';
import { ingestRecord, markMissing } from '../repo/mirror.mjs';
import { getAttachmentData } from '../repo/attachments.mjs';
import { checkRate } from '../ratelimit.mjs';
import { APPS } from '../integrations/registry.mjs';
import { normalizeRecord } from './records.mjs';
import { handleResult, sweep } from './routing.mjs';
import { verifyPending } from './actions.mjs';

// The endpoints a connected app's SERVER calls (never a browser): Dream Board
// runs on a private PC the assistant cannot reach, so the app polls us.
//
//   POST apps/v1/pair    one-time code → bearer token
//   POST apps/v1/sync    results + changed records in, queued ops out
//   GET  apps/v1/files   one photo referenced by a queued op
//
// These routes take a bearer token and nothing else: no cookie is read, and a
// bearer token is never accepted on the owner's routes. Wire format and the
// app-side rules: docs/assistant/CONNECTED-APPS.md.

const MAX_RECORDS = 100, MAX_RESULTS = 100, MAX_MANIFEST = 5000, OPS_PER_SYNC = 20;
const EPOCH_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const ID_RE = /^[A-Za-z0-9_:.\-]{1,120}$/;
const json = (body, status = 200) => ({ status, json: body });
const intOr = (v, d) => (Number.isSafeInteger(Number(v)) && Number(v) >= 0 ? Number(v) : d);

export function createConnector({ db, config, now, limits }) {
  async function authed(req, d) {
    const m = String(req.headers.authorization || '').match(/^Bearer\s+(\S+)$/);
    const row = m ? await findByToken(d, m[1]) : null;
    if (!row) throw new HttpError(401, 'reconnect');
    // The token dies with the owner's access: "sign out everywhere" and an
    // allow-list removal both end it.
    const user = await findUserById(d, row.user_id);
    if (!user || (user.session_epoch || 0) !== row.session_epoch || !(await isAllowedEmail(d, user.email, config().allowedEmails))) throw new HttpError(401, 'reconnect');
    return { row, user };
  }

  async function pair(req, d) {
    await checkRate(d, '*pair', 'pair', now(), limits);
    const b = req.body || {};
    if (!APPS[b.app] || !CODE_RE.test(String(b.code || '').toUpperCase()) || !ID_RE.test(String(b.instance_id || ''))) throw new HttpError(400, 'invalid');
    const r = await redeemPairing(d, {
      app: b.app, code: b.code, instanceId: b.instance_id, instanceLabel: String(b.instance_label || '').slice(0, 80) || null,
      linkTemplate: typeof b.link_template === 'string' && /^\/[^\s]{0,200}$/.test(b.link_template) && b.link_template.includes('{id}') ? b.link_template : null,
      sessionEpochOf: async uid => ((await findUserById(d, uid)) || {}).session_epoch || 0,
    });
    if (!r) throw new HttpError(410, 'That code has expired or was already used. Make a new one in the assistant.');
    return json({ token: r.token, app: r.app, next_poll_seconds: 1 });
  }

  async function sync(req, d) {
    const { row: app, user } = await authed(req, d);
    const userId = user.id;
    await checkRate(d, userId, 'appsync', now(), limits);
    const b = req.body || {};
    if (String(b.instance_id || '') !== app.instance_id) {
      await setAppError(d, app.id, 'A different board (' + String(b.instance_label || b.instance_id || 'unknown').slice(0, 40) + ') tried to sync. Pair again from that board to switch.');
      return json({ error: 'wrong_board', message: 'This assistant is paired with a different board. Pair again from this board to switch.' }, 409);
    }
    const epoch = String(b.epoch || '');
    if (!EPOCH_RE.test(epoch)) throw new HttpError(400, 'epoch required');
    const seq = intOr(b.seq, null);
    if (seq == null) throw new HttpError(400, 'seq required');

    // A different epoch, or a sequence that went backwards, means the app's
    // history was rewound (restored from a backup): resend everything.
    let resync = app.resync;
    if (!resync && ((app.epoch && app.epoch !== epoch) || (app.epoch === epoch && seq < Number(app.max_seq)))) {
      await setResync(d, app.id, true, { epoch, resetSeq: true });
      resync = true;
    }
    const problems = [];

    // 1. Results first, so a record created by one of our ops is recognised
    //    as ours when its snapshot is read below.
    const acks = [];
    for (const res of (Array.isArray(b.results) ? b.results : []).slice(0, MAX_RESULTS)) {
      if (!res || typeof res.op_id !== 'string') continue;
      const r = await handleResult(d, { userId, app: app.app, result: res });
      if (r.ok) acks.push(res.op_id); else problems.push('result ' + r.reason);
    }

    // 2. Snapshots.
    const createdBy = await createdIdIndex(d, userId, app.app);
    let maxSeq = Number(app.max_seq) || 0, received = 0;
    for (const raw of (Array.isArray(b.records) ? b.records : []).slice(0, MAX_RECORDS)) {
      const rec = normalizeRecord(raw);
      if (!rec) { problems.push('invalid record'); continue; }
      await ingestRecord(d, { userId, app: app.app, appRow: app, rec, epoch, backfill: resync, createdBy });
      received++;
      if (!resync) maxSeq = Math.max(maxSeq, rec.seq);
    }

    // 3. End of a full resend: whatever the app no longer lists is hidden.
    const bf = b.backfill && typeof b.backfill === 'object' ? b.backfill : null;
    if (resync && bf && bf.done === true) {
      const ids = Array.isArray(bf.ids) ? bf.ids.filter(x => typeof x === 'string' && ID_RE.test(x)) : null;
      if (!ids || bf.ids.length > MAX_MANIFEST) problems.push('backfill ids missing');
      else {
        await markMissing(d, userId, app.app, ids);
        await markBackfilled(d, app.id, { epoch, fromSeq: Math.min(intOr(bf.start_seq, 0), seq) });
        resync = false;
        maxSeq = Math.min(intOr(bf.start_seq, 0), seq);
      }
    } else {
      await touchApp(d, app.id, { epoch, maxSeq: resync ? 0 : maxSeq, caughtUp: !resync && maxSeq >= seq });
    }

    // 4. Finish anything half-done, then hand over the queue (never while
    //    the mirror is being rebuilt: routing needs an accurate list).
    await sweep(d, userId, app.app);
    await verifyPending(d, userId, app.app);
    const ops = resync ? [] : (await takeQueued(d, userId, app.app, OPS_PER_SYNC)).filter(o => APPS[app.app].ops[o.kind]).map(toWire);
    await setAppError(d, app.id, problems.length ? problems.slice(0, 3).join('; ') : null);
    return json({
      resync, since: resync ? 0 : maxSeq, ops, acks,
      next_poll_seconds: resync || ops.length === OPS_PER_SYNC || received === MAX_RECORDS ? 1 : ops.length || received || acks.length ? 15 : 60,
    });
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

  const routes = { 'POST apps/v1/pair': pair, 'POST apps/v1/sync': sync, 'GET apps/v1/files': file };

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
