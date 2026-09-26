import { newId } from '../ids.mjs';

// ExternalRecord: a pointer to something that lives in Google — id, title,
// link, date — recorded when it is cited or linked. Content is never copied.
// (provider, provider_record_id) is unique per user, so seeing the same email
// twice (or a duplicate webhook later) updates one row instead of adding two.

export async function upsertExternal(db, userId, item, { connectionId = null, personId = null, projectId = null } = {}) {
  if (!item || !item.provider || !item.recordId) return null;
  const date = item.date && !isNaN(Date.parse(item.date)) ? new Date(item.date).toISOString() : null;
  const r = await db.query(`INSERT INTO asst_external_records (id, user_id, connection_id, provider, provider_record_id, kind, title, url, occurred_at, meta, person_id, project_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (user_id, provider, provider_record_id) DO UPDATE SET
        title = EXCLUDED.title, url = COALESCE(EXCLUDED.url, asst_external_records.url), kind = EXCLUDED.kind,
        occurred_at = COALESCE(EXCLUDED.occurred_at, asst_external_records.occurred_at),
        connection_id = COALESCE(EXCLUDED.connection_id, asst_external_records.connection_id),
        person_id = COALESCE(asst_external_records.person_id, EXCLUDED.person_id),
        project_id = COALESCE(asst_external_records.project_id, EXCLUDED.project_id),
        last_seen_at = now()
      RETURNING *`,
    [newId('external'), userId, connectionId, item.provider, String(item.recordId), item.kind || null, String(item.title || '').slice(0, 300),
      item.url || null, date, JSON.stringify(slimMeta(item.meta)), personId, projectId]);
  return r[0];
}

// Only small, non-content metadata is kept (who/when), never bodies.
function slimMeta(meta) {
  if (!meta) return {};
  const keep = ['from', 'fromEmail', 'messageCount', 'mimeType', 'owner', 'start', 'end', 'allDay', 'calendar', 'emails', 'company'];
  const out = {};
  keep.forEach(k => { if (meta[k] !== undefined) out[k] = meta[k]; });
  return out;
}

export async function getExternal(db, userId, id) {
  const r = await db.query('SELECT * FROM asst_external_records WHERE id = $1 AND user_id = $2', [id, userId]);
  return r[0] || null;
}

export async function externalForProject(db, userId, projectId, limit = 30) {
  return db.query(`SELECT e.* FROM asst_external_records e WHERE e.user_id = $1 AND (e.project_id = $2 OR EXISTS (
      SELECT 1 FROM asst_links l WHERE l.user_id = $1 AND l.from_type = 'external' AND l.from_id = e.id AND l.to_type = 'project' AND l.to_id = $2))
    ORDER BY e.occurred_at DESC NULLS LAST LIMIT $3`, [userId, projectId, limit]);
}

// ---- external actions: proposed by the assistant, decided by the owner ----

export async function proposeAction(db, userId, { messageId = null, kind, summary, payload }) {
  const r = await db.query(`INSERT INTO asst_actions (id, user_id, message_id, kind, summary, payload) VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING id, kind, summary, payload, status, created_at`,
    [newId('action'), userId, messageId, kind, String(summary || '').slice(0, 500), JSON.stringify(payload || {})]);
  return r[0];
}

export async function attachActionsToMessage(db, userId, actionIds, messageId) {
  if (!actionIds.length) return;
  await db.query('UPDATE asst_actions SET message_id = $3 WHERE user_id = $1 AND id = ANY($2)', [userId, actionIds, messageId]);
}

export async function decideAction(db, userId, id, decision, result) {
  const status = decision === 'confirm' ? 'confirmed' : 'cancelled';
  // Only a still-proposed action can be decided: a double tap cannot run twice.
  const r = await db.query(`UPDATE asst_actions SET status = $3, decided_at = now(), result = $4
      WHERE id = $1 AND user_id = $2 AND status = 'proposed' RETURNING *`, [id, userId, status, result ? JSON.stringify(result) : null]);
  return r[0] || null;
}

export async function getAction(db, userId, id) {
  const r = await db.query('SELECT * FROM asst_actions WHERE id = $1 AND user_id = $2', [id, userId]);
  return r[0] || null;
}
