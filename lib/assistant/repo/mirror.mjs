import { newId } from '../ids.mjs';
import { searchTextOf, diffRecords } from '../apps/records.mjs';
import { findProjectByName } from './projects.mjs';
import { anyWordQuery } from './captures.mjs';

// The read-only mirror of records an app owns (rows in asst_external_records
// with provider = app). The assistant never edits these: they change only
// when the app publishes a newer snapshot. Keys always start with user_id.

const PID = rec => rec.type + ':' + rec.id;

// The app's own record id, from our row ("goal:<id>"; the id may contain ':').
export const goalIdOf = row => row.provider_record_id.slice(row.provider_record_id.indexOf(':') + 1);

// How a dream is cited: it opens the assistant's dream page.
export const dreamSource = (id, title, date) => ({ provider: 'dreamboard', kind: 'goal', recordId: id, title, url: '#/dream/' + encodeURIComponent(id), date });

export async function getMirrorRow(db, userId, app, type, id) {
  const r = await db.query('SELECT * FROM asst_external_records WHERE user_id = $1 AND provider = $2 AND provider_record_id = $3', [userId, app, type + ':' + id]);
  return r[0] || null;
}

async function projectFor(db, userId, app, category) {
  if (!category) return null;
  if (category.id) {
    const r = await db.query(`SELECT project_id FROM asst_identities WHERE user_id = $1 AND provider = $2 AND provider_id = $3 AND project_id IS NOT NULL`,
      [userId, app + ':category', category.id]);
    if (r[0]) return r[0].project_id;
  }
  const p = await findProjectByName(db, userId, category.name);
  if (!p) return null;
  // Remember the app's own category id, so a rename in the app keeps the link.
  if (category.id) {
    await db.query(`INSERT INTO asst_identities (id, user_id, person_id, project_id, provider, provider_id, label)
      VALUES ($1,$2,NULL,$3,$4,$5,$6) ON CONFLICT (user_id, provider, provider_id) DO NOTHING`,
      [newId('identity'), userId, p.id, app + ':category', category.id, category.name]);
  }
  return p.id;
}

// Store one snapshot. Returns false when it is a duplicate or older than what
// we hold (out-of-order delivery) — checked again inside the write itself.
//   backfill: part of a full resend (initial connect or after a restore):
//             accepted regardless of version, never produces an event.
export async function ingestRecord(db, { userId, app, rec, epoch, backfill = false, createdBy }) {
  const prev = await getMirrorRow(db, userId, app, rec.type, rec.id);
  const sameEpoch = prev && (prev.app_epoch || '') === (epoch || '');
  if (!backfill && prev && prev.app_seq != null && sameEpoch && Number(prev.app_seq) >= rec.seq) return false;
  const prevData = prev && prev.data ? Object.assign({ deleted: !!prev.deleted_at, placeholder: prev.app_seq == null }, prev.data) : null;
  const aliases = new Set(prev ? prev.aliases || [] : []);
  if (prevData && !prevData.placeholder && !rec.deleted && prevData.title && prevData.title !== rec.title) aliases.add(prevData.title);
  const title = rec.deleted ? (prev ? prev.title : '(deleted)') : rec.title;
  aliases.delete(title);
  const data = rec.deleted ? Object.assign({}, prev && prev.data, { deleted: true }) : rec;
  const projectId = rec.deleted ? (prev ? prev.project_id : null) : await projectFor(db, userId, app, rec.category);
  const aliasList = [...aliases].slice(-20);
  const row = (await db.query(`INSERT INTO asst_external_records (id, user_id, provider, provider_record_id, kind, title, occurred_at, status,
        data, aliases, search_text, app_epoch, app_seq, deleted_at, missing_at, project_id, last_seen_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, CASE WHEN $14 THEN now() END, NULL, $15, now())
      ON CONFLICT (user_id, provider, provider_record_id) DO UPDATE SET
        title = EXCLUDED.title, occurred_at = COALESCE(EXCLUDED.occurred_at, asst_external_records.occurred_at),
        status = EXCLUDED.status, data = EXCLUDED.data, aliases = EXCLUDED.aliases, search_text = EXCLUDED.search_text,
        app_epoch = EXCLUDED.app_epoch, app_seq = EXCLUDED.app_seq,
        deleted_at = CASE WHEN $14 THEN COALESCE(asst_external_records.deleted_at, now()) ELSE NULL END,
        missing_at = NULL, project_id = EXCLUDED.project_id, last_seen_at = now()
      WHERE $16 OR asst_external_records.app_seq IS NULL OR asst_external_records.app_epoch IS DISTINCT FROM EXCLUDED.app_epoch
        OR asst_external_records.app_seq < EXCLUDED.app_seq
      RETURNING *`,
    [newId('external'), userId, app, PID(rec), rec.type, title, rec.deleted ? null : rec.updated_at,
      rec.deleted ? (prev ? prev.status : null) : rec.status, JSON.stringify(data), JSON.stringify(aliasList),
      searchTextOf(rec.deleted ? null : rec, aliasList), epoch || '', rec.seq, !!rec.deleted, projectId, backfill]))[0];
  if (!row) return false;
  if (backfill) return true;
  const d = diffRecords(prevData, rec, { createdBy });
  if (!d.changes.length) return true;
  const occurred = d.changes.map(c => c.at).filter(Boolean).sort().pop() || new Date().toISOString();
  await db.query(`INSERT INTO asst_events (id, user_id, app, external_id, record_id, epoch, seq, changes, progress, occurred_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (user_id, app, record_id, epoch, seq) DO NOTHING`,
    [newId('event'), userId, app, row.id, rec.id, epoch || '', rec.seq, JSON.stringify(d.changes), d.progress, occurred]);
  return true;
}

// An op's result arrived after the snapshot that already showed its effect
// (a lost response, a late result): mark those changes as ours after all, so
// they are told once, as the owner's.
export async function claimChanges(db, { userId, app, recordId, opId, created = {}, set = {} }) {
  const ids = new Set([].concat(created.notes || [], created.images || [], created.milestones || []).map(String));
  const mine = c => !c.op_id && ((c.kind === 'created' && recordId === created.goal) || (c.id && ids.has(String(c.id)))
    || (['renamed', 'status_changed', 'updated'].includes(c.kind) && (c.field || (c.kind === 'renamed' ? 'title' : 'status')) in set
      && JSON.stringify(set[c.field || (c.kind === 'renamed' ? 'title' : 'status')]) === JSON.stringify(c.to)));
  const evs = await db.query(`SELECT id, changes FROM asst_events WHERE user_id = $1 AND app = $2 AND record_id = $3 AND received_at > now() - interval '30 days'`, [userId, app, recordId]);
  for (const e of evs) {
    if (!(e.changes || []).some(mine)) continue;
    await db.query('UPDATE asst_events SET changes = $2 WHERE id = $1', [e.id, JSON.stringify(e.changes.map(c => (mine(c) ? Object.assign({}, c, { op_id: opId }) : c)))]);
  }
}

// A goal the app created for us, before its first snapshot arrives: keeps the
// capture → record link valid. Replaced by the real snapshot (seq NULL loses
// to any version).
export async function ensurePlaceholder(db, { userId, app, type, id, title }) {
  await db.query(`INSERT INTO asst_external_records (id, user_id, provider, provider_record_id, kind, title, data, app_seq)
      VALUES ($1,$2,$3,$4,$5,$6,'{}'::jsonb, NULL) ON CONFLICT (user_id, provider, provider_record_id) DO NOTHING`,
    [newId('external'), userId, app, type + ':' + id, type, title || '(syncing…)']);
  return getMirrorRow(db, userId, app, type, id);
}

// After a complete backfill: anything we hold that the app didn't list —
// placeholders included — is no longer in the app (restored from an older
// backup, or deleted while we weren't told). Hidden, never hard-deleted, so
// links still explain it; a later snapshot brings it back.
export async function markMissing(db, userId, app, presentIds) {
  const keys = presentIds.map(id => 'goal:' + id);
  await db.query(`UPDATE asst_external_records SET missing_at = now() WHERE user_id = $1 AND provider = $2 AND missing_at IS NULL
      AND NOT (provider_record_id = ANY($3))`, [userId, app, keys]);
}

export function liveGoalsSql(alias = 'e') {
  return `${alias}.deleted_at IS NULL AND ${alias}.missing_at IS NULL`;
}

export async function listGoals(db, userId, app, { includeGone = false } = {}) {
  return db.query(`SELECT e.*,
      (SELECT max(v.occurred_at) FROM asst_events v WHERE v.external_id = e.id) AS last_update_at,
      (SELECT max(v.occurred_at) FROM asst_events v WHERE v.external_id = e.id AND v.progress) AS last_progress_at
    FROM asst_external_records e WHERE e.user_id = $1 AND e.provider = $2 AND e.kind = 'goal'
      ${includeGone ? '' : 'AND ' + liveGoalsSql('e')}
    ORDER BY e.title`, [userId, app]);
}

export async function searchMirror(db, userId, app, q, limit = 10) {
  const text = String(q || '').trim().slice(0, 200);
  if (!text) return [];
  const orq = anyWordQuery(text) || 'zzzznomatch';
  const like = '%' + text.replace(/[\\%_]/g, m => '\\' + m) + '%';
  return db.query(`SELECT e.*, ts_rank(e.search, to_tsquery('english', $4)) AS rank
    FROM asst_external_records e WHERE e.user_id = $1 AND e.provider = $2 AND ${liveGoalsSql('e')}
      AND (e.search @@ to_tsquery('english', $4) OR e.title ILIKE $3 OR e.aliases::text ILIKE $3)
    ORDER BY (e.title ILIKE $3) DESC, rank DESC LIMIT $5`, [userId, app, like, orq, limit]);
}

export async function eventsForRecord(db, userId, app, recordId, limit = 100) {
  return db.query(`SELECT * FROM asst_events WHERE user_id = $1 AND app = $2 AND record_id = $3 ORDER BY occurred_at, seq LIMIT $4`, [userId, app, recordId, limit]);
}

// Changes the assistant learned about since `since`: by when we received them
// OR when they happened, so a change made offline on Saturday and synced on
// Tuesday is still reported once.
export async function eventsSince(db, userId, app, sinceIso) {
  return db.query(`SELECT v.*, e.title, e.data->>'status' AS status FROM asst_events v LEFT JOIN asst_external_records e ON e.id = v.external_id
    WHERE v.user_id = $1 AND v.app = $2 AND (v.received_at >= $3 OR v.occurred_at >= $3) ORDER BY v.occurred_at`, [userId, app, sinceIso]);
}

export async function mirrorCount(db, userId, app) {
  const r = await db.query('SELECT count(*)::int AS n FROM asst_external_records WHERE user_id = $1 AND provider = $2', [userId, app]);
  return r[0].n;
}

export async function linkedCaptures(db, userId, externalId) {
  return db.query(`SELECT c.id, c.kind, c.title, c.raw_text, c.summary, c.source_type, c.captured_at, l.relation,
      (SELECT count(*)::int FROM asst_attachments a WHERE a.capture_id = c.id) AS attachment_count
    FROM asst_links l JOIN asst_captures c ON c.id = l.from_id
    WHERE l.user_id = $1 AND l.from_type = 'capture' AND l.to_type = 'external' AND l.to_id = $2 ORDER BY c.captured_at`, [userId, externalId]);
}
