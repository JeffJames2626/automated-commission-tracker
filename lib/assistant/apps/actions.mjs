import { APPS } from '../integrations/registry.mjs';
import { getMirrorRow } from '../repo/mirror.mjs';
import { createOp, stage } from '../repo/ops.mjs';
import { newId } from '../ids.mjs';
import { fmtAmount } from './records.mjs';

// Changes to a record another app owns: READ → PROPOSE → CONFIRM → EXECUTE
// (the app applies the op on its next sync) → VERIFY (the app's next snapshot
// shows the new value). The confirm card is built here from the mirror —
// never from AI text — so what the owner approves is exactly what is sent.
//
// asst_actions.status: proposed → queued → verified | failed; or cancelled.

const APP = 'dreamboard';
export const APP_ACTION_KINDS = { dreamboard_update_goal: 'update_goal', dreamboard_add_milestone: 'add_milestone' };

const valueOf = (row, field) => {
  if (field === 'title') return row.title;
  if (field === 'status') return (row.data && row.data.status) || null;
  const f = (row.data && row.data.fields) || {};
  return f[field] === undefined ? null : f[field];
};
const show = (v, field) => (v == null || v === '' ? '—' : String(fmtAmount(v, field)));

function coerce(field, v) {
  if (v == null || v === '') return null;
  if (/amount/.test(field)) {
    const n = Number(String(v).replace(/[$,\s]/g, '').replace(/k$/i, '000').replace(/m$/i, '000000'));
    return Number.isFinite(n) && n >= 0 && n < 1e12 ? Math.round(n * 100) / 100 : undefined;
  }
  if (/date/.test(field)) return /^\d{4}-\d{2}(-\d{2})?$/.test(String(v)) ? String(v) : undefined;
  const s = String(v).trim().slice(0, field === 'status' ? 40 : 200);
  return s || undefined;
}

// Returns { action } or { error } (a sentence the AI relays).
export async function proposeAppAction(db, userId, { kind, goalId, field, value, milestone }) {
  const opKind = APP_ACTION_KINDS[kind];
  if (!opKind) return { error: 'Unknown change.' };
  const row = await getMirrorRow(db, userId, APP, 'goal', String(goalId || ''));
  if (!row || row.app_seq == null) return { error: 'I can’t find that dream in the Dream Board records I have.' };
  if (row.deleted_at || row.missing_at) return { error: `“${row.title}” is no longer in Dream Board.` };
  const target = { id: String(goalId), title: row.title, seq: Number(row.app_seq) };
  let payload, summary;
  if (opKind === 'update_goal') {
    if (!APPS.dreamboard.updatableFields.includes(field)) return { error: `I can only change ${APPS.dreamboard.updatableFields.join(', ').replace(/_/g, ' ')}.` };
    const to = coerce(field, value);
    if (to === undefined) return { error: `“${value}” isn’t a valid ${field.replace(/_/g, ' ')}.` };
    const from = valueOf(row, field);
    if (from === to) return { error: `${field.replace(/_/g, ' ')} is already ${show(to, field)}.` };
    payload = { app: APP, target, changes: [{ field, from, to }] };
    summary = `Change “${row.title}” ${field.replace(/_/g, ' ')}: ${show(from, field)} → ${show(to, field)}`;
  } else {
    const title = String(milestone || '').trim().slice(0, 200);
    if (!title) return { error: 'A milestone needs a name.' };
    payload = { app: APP, target, milestone: { title } };
    summary = `Add milestone to “${row.title}”: ${title}`;
  }
  const r = await db.query(`INSERT INTO asst_actions (id, user_id, kind, summary, payload) VALUES ($1,$2,$3,$4,$5)
      RETURNING id, kind, summary, payload, status, created_at`,
    [newId('action'), userId, kind, summary, JSON.stringify(payload)]);
  return { action: r[0] };
}

// The owner pressed Confirm. Safe to repeat: the op id is derived from the
// action id, so a retried request finds the same op instead of queuing twice.
export async function confirmAppAction(db, userId, action) {
  const opKind = APP_ACTION_KINDS[action.kind];
  const p = action.payload || {};
  const opId = 'op_' + action.id.slice(4);
  if (action.status === 'proposed') {
    const row = await getMirrorRow(db, userId, APP, 'goal', p.target.id);
    if (!row || row.deleted_at || row.missing_at) return fail(db, userId, action.id, 'target_deleted');
    // Dream Board moved on since the card was made: don't send a stale "from".
    if (opKind === 'update_goal' && p.changes.some(c => valueOf(row, c.field) !== c.from)) return fail(db, userId, action.id, 'changed_since');
    const r = await db.query(`UPDATE asst_actions SET status = 'queued', op_id = $3, decided_at = now()
      WHERE id = $1 AND user_id = $2 AND status = 'proposed' RETURNING *`, [action.id, userId, opId]);
    if (!r[0]) return confirmAppAction(db, userId, await getAction(db, userId, action.id));
    action = r[0];
  }
  if (action.status !== 'queued') return { action, error: action.status === 'cancelled' ? 'This change was cancelled.' : null };
  const opPayload = opKind === 'update_goal'
    ? { goal_id: p.target.id, set: Object.fromEntries(p.changes.map(c => [c.field, c.to])), expect: Object.fromEntries(p.changes.map(c => [c.field, c.from])), confirmed_at: action.decided_at }
    : { goal_id: p.target.id, milestone: p.milestone, confirmed_at: action.decided_at };
  const { op } = await createOp(db, { id: opId, userId, app: APP, kind: opKind, actionId: action.id, targetId: p.target.id, payload: opPayload,
    status: 'queued', trace: [stage('proposed', { at: action.created_at }), stage('confirmed', { at: action.decided_at }), stage('queued')] });
  return { action, op };
}

async function getAction(db, userId, id) {
  const r = await db.query('SELECT * FROM asst_actions WHERE id = $1 AND user_id = $2', [id, userId]);
  return r[0] || null;
}

const REASONS = {
  target_deleted: 'That dream is no longer in Dream Board, so nothing was changed.',
  target_missing: 'That dream is no longer in Dream Board, so nothing was changed.',
  changed_since: 'Dream Board changed since this was suggested, so nothing was sent. Ask again to see the current value.',
  conflict: 'Dream Board had a newer value when the change arrived, so it kept that one. Nothing was overwritten.',
  not_applied: 'Dream Board applied the change but now shows a different value.',
};

async function fail(db, userId, actionId, reason) {
  const a = await failAction(db, userId, actionId, reason);
  return { action: a, error: a && a.result ? a.result.message : REASONS[reason] };
}

export async function failAction(db, userId, actionId, reason) {
  const message = REASONS[reason] || 'Dream Board refused the change (' + reason + '). Nothing was changed.';
  const r = await db.query(`UPDATE asst_actions SET status = 'failed', decided_at = COALESCE(decided_at, now()), result = $3
    WHERE id = $1 AND user_id = $2 AND status IN ('proposed','queued') RETURNING *`, [actionId, userId, JSON.stringify({ reason, message })]);
  return r[0] || null;
}

// VERIFY: once the app reports "applied", look at its own snapshot. Waits
// (returns false) until a snapshot at least as new as the result has arrived.
export async function verifyAction(db, userId, op) {
  const action = op.action_id ? await getAction(db, userId, op.action_id) : null;
  if (!action || action.status !== 'queued') return true;
  const p = action.payload || {};
  const row = await getMirrorRow(db, userId, APP, 'goal', p.target.id);
  const resSeq = op.result && op.result.seq;
  if (!row || row.app_seq == null || (resSeq != null && Number(row.app_seq) < resSeq)) return false;
  let ok, shows = null;
  if (APP_ACTION_KINDS[action.kind] === 'update_goal') {
    ok = p.changes.every(c => valueOf(row, c.field) === c.to);
    if (!ok) shows = p.changes.map(c => c.field.replace(/_/g, ' ') + ' ' + show(valueOf(row, c.field), c.field)).join(', ');
  } else {
    const made = new Set((op.result && op.result.created && op.result.created.milestones) || []);
    ok = ((row.data && row.data.milestones) || []).some(m => made.has(m.id) || m.title === p.milestone.title);
  }
  if (!ok) {
    const a = await failAction(db, userId, action.id, 'not_applied');
    if (a && shows) await db.query(`UPDATE asst_actions SET result = result || $3 WHERE id = $1 AND user_id = $2`, [a.id, userId, JSON.stringify({ message: REASONS.not_applied + ' It shows ' + shows + '.' })]);
    return true;
  }
  await db.query(`UPDATE asst_actions SET status = 'verified', result = $3 WHERE id = $1 AND user_id = $2 AND status = 'queued'`,
    [action.id, userId, JSON.stringify({ message: 'Done — Dream Board shows the change.', seq: Number(row.app_seq) })]);
  return true;
}

// Called on every sync: verify applied changes whose snapshot arrived later.
export async function verifyPending(db, userId, app) {
  const rows = await db.query(`SELECT o.* FROM asst_app_ops o JOIN asst_actions a ON a.id = o.action_id AND a.user_id = o.user_id
    WHERE o.user_id = $1 AND o.app = $2 AND o.status = 'applied' AND a.status = 'queued' LIMIT 20`, [userId, app]);
  for (const op of rows) await verifyAction(db, userId, op);
}

export async function actionStatuses(db, userId, ids) {
  if (!ids.length) return new Map();
  const r = await db.query('SELECT id, status, result FROM asst_actions WHERE user_id = $1 AND id = ANY($2)', [userId, ids]);
  return new Map(r.map(x => [x.id, x]));
}

