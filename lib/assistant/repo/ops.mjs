import { newId } from '../ids.mjs';

// Operations the assistant queues for a connected app (asst_app_ops).
//
//   routing ──► needs_choice ──► queued ──► applied
//      │            │  ▲            │   └──► rejected
//      └──► waiting ┘  └── owner    └──────► cancelled
//                          chooses
// Rejected and cancelled rows stay as routing history.
//
// routing       the capture explicitly asked for the app; target not resolved yet
// needs_choice  the owner must pick (several similar dreams, or none)
// waiting       depends on a create that hasn't been applied yet, or the app's
//               records haven't finished their first sync
// queued        handed to the app on every sync until it reports a result
// applied / rejected / cancelled   final
//
// The row id is the op id the app deduplicates on, so re-delivery is always
// safe. Every transition is a conditional UPDATE: two requests racing can't
// both move the same op.

export const LIVE = ['routing', 'needs_choice', 'waiting', 'queued'];

export const stage = (s, detail) => ({ stage: s, at: new Date().toISOString(), ...(detail ? { detail } : {}) });

export async function createOp(db, { id, userId, app, kind, captureId = null, actionId = null, dependsOn = null, targetId = null, payload = {}, status, trace = [] }) {
  const opId = id || newId('op');
  const r = await db.query(`INSERT INTO asst_app_ops (id, user_id, app, kind, capture_id, action_id, depends_on, target_id, payload, status, trace)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING *`,
    [opId, userId, app, kind, captureId, actionId, dependsOn, targetId, JSON.stringify(payload), status, JSON.stringify(trace)]);
  if (r[0]) return { op: r[0], created: true };
  // Conflict: either the same id (a retried confirm) or a live op already
  // exists for this capture — return that one instead of making a second.
  return { op: captureId ? await liveOpForCapture(db, userId, app, captureId) : await getOp(db, userId, opId), created: false };
}

export async function getOp(db, userId, id) {
  const r = await db.query('SELECT * FROM asst_app_ops WHERE id = $1 AND user_id = $2', [id, userId]);
  return r[0] || null;
}

// Move an op only if it is still in one of `from`. Returns the new row or null.
// Everything (kind included) changes in this one conditional statement, so a
// poll can never pick up a half-changed op.
export async function transition(db, userId, id, from, to, { payload, targetId, dependsOn, reason, result, traceEntry, kind } = {}) {
  const r = await db.query(`UPDATE asst_app_ops SET status = $4, kind = COALESCE($11, kind),
        payload = CASE WHEN $5::jsonb IS NULL THEN payload ELSE $5::jsonb END,
        target_id = CASE WHEN $6::text IS NULL THEN target_id ELSE NULLIF($6, '') END,
        depends_on = CASE WHEN $7::text IS NULL THEN depends_on ELSE NULLIF($7, '') END,
        reason = COALESCE($8, reason),
        result = COALESCE($9::jsonb, result),
        done_at = CASE WHEN $4 IN ('applied','rejected','cancelled') THEN now() ELSE done_at END,
        trace = trace || $10::jsonb,
        updated_at = now()
      WHERE id = $1 AND user_id = $2 AND status = ANY($3) RETURNING *`,
    [id, userId, from, to, payload === undefined ? null : JSON.stringify(payload), targetId === undefined ? null : (targetId || ''),
      dependsOn === undefined ? null : (dependsOn || ''), reason || null, result ? JSON.stringify(result) : null,
      JSON.stringify(traceEntry ? [traceEntry] : []), kind || null]);
  return r[0] || null;
}

export async function appendTrace(db, id, entry) {
  await db.query(`UPDATE asst_app_ops SET trace = trace || $2::jsonb, updated_at = now() WHERE id = $1`, [id, JSON.stringify([entry])]);
}

export async function setLinked(db, id) {
  await db.query('UPDATE asst_app_ops SET linked_at = now() WHERE id = $1 AND linked_at IS NULL', [id]);
}

// Hand the app every queued op, oldest first, each time it syncs. Delivery is
// informational (attempts, first delivery time); only a result ends an op.
export async function takeQueued(db, userId, app, limit = 20) {
  const rows = await db.query(`UPDATE asst_app_ops SET attempts = attempts + 1, delivered_at = COALESCE(delivered_at, now()),
        trace = CASE WHEN attempts = 0 OR (attempts + 1) % 10 = 0 THEN trace || jsonb_build_array(jsonb_build_object('stage','sent','at',now(),'detail',jsonb_build_object('attempt',attempts + 1))) ELSE trace END
      WHERE id IN (SELECT id FROM asst_app_ops WHERE user_id = $1 AND app = $2 AND status = 'queued' ORDER BY created_at, id LIMIT $3)
      RETURNING *`, [userId, app, limit]);
  return rows.sort((a, b) => new Date(a.created_at) - new Date(b.created_at) || a.id.localeCompare(b.id));
}

export async function opsForCapture(db, userId, captureId) {
  return db.query('SELECT * FROM asst_app_ops WHERE user_id = $1 AND capture_id = $2 ORDER BY created_at', [userId, captureId]);
}

export async function liveOpForCapture(db, userId, app, captureId) {
  const r = await db.query(`SELECT * FROM asst_app_ops WHERE user_id = $1 AND app = $2 AND capture_id = $3 AND status <> ALL($4)
    ORDER BY created_at DESC LIMIT 1`, [userId, app, captureId, ['rejected', 'cancelled']]);
  return r[0] || null;
}

// Creates that haven't been applied yet: target resolution must see them, or
// "add this to my lake house dream" while the PC is off makes a second goal.
export async function pendingCreates(db, userId, app) {
  return db.query(`SELECT * FROM asst_app_ops WHERE user_id = $1 AND app = $2 AND kind = 'create_goal' AND status = ANY($3) ORDER BY created_at`,
    [userId, app, LIVE]);
}

export async function dependents(db, userId, opId) {
  return db.query(`SELECT * FROM asst_app_ops WHERE user_id = $1 AND depends_on = $2 AND status = 'waiting' ORDER BY created_at`, [userId, opId]);
}

export async function staleRouting(db, userId, app, olderThanSeconds = 120) {
  return db.query(`SELECT * FROM asst_app_ops WHERE user_id = $1 AND app = $2 AND status = 'routing'
    AND created_at < now() - ($3 || ' seconds')::interval ORDER BY created_at LIMIT 20`, [userId, app, String(olderThanSeconds)]);
}

// Ops waiting on a create that has finished (applied, rejected, cancelled) —
// or, by mistake, on themselves. The sweep releases or re-asks them.
export async function waitingOnFinished(db, userId, app) {
  return db.query(`SELECT w.*, d.status AS dep_status, d.result AS dep_result, d.target_id AS dep_target FROM asst_app_ops w
    JOIN asst_app_ops d ON d.id = w.depends_on AND d.user_id = w.user_id
    WHERE w.user_id = $1 AND w.app = $2 AND w.status = 'waiting' AND (d.status NOT IN ('routing','needs_choice','waiting','queued') OR d.id = w.id)
    ORDER BY w.created_at LIMIT 50`, [userId, app]);
}

export async function waitingOnSync(db, userId, app) {
  return db.query(`SELECT * FROM asst_app_ops WHERE user_id = $1 AND app = $2 AND status = 'waiting' AND depends_on IS NULL ORDER BY created_at LIMIT 50`, [userId, app]);
}

export async function appliedUnlinked(db, userId, app) {
  return db.query(`SELECT * FROM asst_app_ops WHERE user_id = $1 AND app = $2 AND status = 'applied' AND linked_at IS NULL ORDER BY done_at LIMIT 50`, [userId, app]);
}

export async function opsForTarget(db, userId, app, targetId) {
  return db.query(`SELECT * FROM asst_app_ops WHERE user_id = $1 AND app = $2 AND (target_id = $3 OR result->'created'->>'goal' = $3)
    ORDER BY created_at`, [userId, app, targetId]);
}

// Ops the app applied, keyed by every entity id they created — lets a later
// snapshot tell "Jeff did this in Dream Board" from "this came from a capture".
// A confirmed change creates nothing; it is recognised by the value it set
// ("f:<record id>:<field>:<value>"), whatever version the snapshot carries.
export async function createdIdIndex(db, userId, app) {
  const rows = await db.query(`SELECT id, kind, payload, result FROM asst_app_ops WHERE user_id = $1 AND app = $2 AND status = 'applied'
    AND done_at > now() - interval '400 days'`, [userId, app]);
  const byId = new Map();
  for (const r of rows) {
    const res = r.result || {}, c = res.created || {};
    [c.goal, c.item].concat(c.notes || [], c.images || [], c.milestones || []).filter(Boolean).forEach(x => byId.set(String(x), r.id));
    if (r.kind === 'update_goal' && res.record) Object.entries((r.payload && r.payload.set) || {}).forEach(([f, v]) => byId.set(changeKey(res.record.id, f, v), r.id));
  }
  return byId;
}
export const changeKey = (recordId, field, value) => 'f:' + recordId + ':' + field + ':' + JSON.stringify(value ?? null);

export async function recentOps(db, userId, sinceIso) {
  return db.query(`SELECT o.*, c.kind AS capture_kind, c.title AS capture_title, c.captured_at, a.summary AS action_summary FROM asst_app_ops o
    LEFT JOIN asst_captures c ON c.id = o.capture_id LEFT JOIN asst_actions a ON a.id = o.action_id AND a.user_id = o.user_id
    WHERE o.user_id = $1 AND (o.done_at >= $2 OR o.created_at >= $2) ORDER BY o.created_at`, [userId, sinceIso]);
}

export async function cancelLiveOpsForCapture(db, userId, captureId, reason = 'capture_deleted') {
  return db.query(`UPDATE asst_app_ops SET status = 'cancelled', reason = $3, done_at = now(), payload = payload - 'note',
      trace = trace || jsonb_build_array(jsonb_build_object('stage','cancelled','at',now(),'detail',jsonb_build_object('reason',$3::text))),
      updated_at = now()
    WHERE user_id = $1 AND capture_id = $2 AND status = ANY($4) RETURNING *`, [userId, captureId, reason, LIVE]);
}

export async function queueSummary(db, userId, app) {
  const r = await db.query(`SELECT status, count(*)::int AS n FROM asst_app_ops WHERE user_id = $1 AND app = $2 AND status = ANY($3) GROUP BY status`, [userId, app, LIVE]);
  return Object.fromEntries(r.map(x => [x.status, x.n]));
}
