import { newId } from '../ids.mjs';
import { KIND_KEYS, STATUS_KEYS } from '../kinds.mjs';

// Captures: every thought, task, idea, photo and link. The raw text a person
// typed or said is written once at capture time and kept beside whatever the
// AI later makes of it.

const LIST_COLS = `c.id, c.kind, c.status, c.title, c.summary, c.next_action, c.source_type, c.url, c.project_id,
  c.classification_state, c.due_at, c.completed_at, c.captured_at, c.updated_at,
  left(c.raw_text, 280) AS raw_preview, c.details,
  p.name AS project_name, p.emoji AS project_emoji,
  (SELECT count(*)::int FROM asst_attachments a WHERE a.capture_id = c.id) AS attachment_count,
  (SELECT o.status FROM asst_app_ops o WHERE o.capture_id = c.id AND o.status IN ('routing','needs_choice','waiting','queued') LIMIT 1) AS route_status`;

export async function createCapture(db, userId, { clientRef, rawText, sourceType = 'text', url = null, capturedAt = null, details = {}, kind = null }) {
  const id = newId('capture');
  const r = await db.query(`INSERT INTO asst_captures (id, user_id, kind, raw_text, source_type, url, client_ref, details, captured_at, title)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8, COALESCE($9::timestamptz, now()), $10)
      ON CONFLICT (user_id, client_ref) DO NOTHING RETURNING *`,
    [id, userId, kind || 'note', rawText || '', sourceType, url, clientRef || null, JSON.stringify(details || {}), capturedAt, provisionalTitle(rawText, url)]);
  if (r[0]) return { capture: r[0], duplicate: false };
  // Same client_ref already stored: the phone retried after a flaky network.
  const ex = await db.query('SELECT * FROM asst_captures WHERE user_id = $1 AND client_ref = $2', [userId, clientRef]);
  return { capture: ex[0], duplicate: true };
}

export function provisionalTitle(text, url) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t) return t.length > 80 ? t.slice(0, 77).trimEnd() + '…' : t;
  return url ? String(url).replace(/^https?:\/\/(www\.)?/, '').slice(0, 80) : 'Untitled capture';
}

// Apply what the classifier decided. A capture the owner already edited by
// hand ('manual') keeps their choices.
export async function applyClassification(db, userId, id, c) {
  const r = await db.query(`UPDATE asst_captures SET
      kind = CASE WHEN classification_state = 'manual' THEN kind ELSE $3 END,
      title = CASE WHEN classification_state = 'manual' THEN title ELSE $4 END,
      summary = $5,
      next_action = $6,
      project_id = CASE WHEN classification_state = 'manual' THEN project_id ELSE $7 END,
      due_at = COALESCE(due_at, $8::timestamptz),
      status = CASE WHEN $9::text IS NOT NULL AND classification_state <> 'manual' AND status <> 'filed' THEN $9 ELSE status END,
      ai = $10,
      details = details || $11::jsonb,
      classification_state = CASE WHEN classification_state = 'manual' THEN 'manual' ELSE $12 END,
      updated_at = now()
    WHERE id = $1 AND user_id = $2 RETURNING *`,
    [id, userId, c.kind, c.title, c.summary || null, c.nextAction || null, c.projectId || null, c.dueAt || null,
      c.status || null, JSON.stringify(c.ai || {}), JSON.stringify(c.details || {}), c.state || 'done']);
  return r[0] || null;
}

const EDITABLE = {
  kind: v => KIND_KEYS.includes(v) ? v : undefined,
  // 'filed' is set only by routing: it means an app really has it.
  status: v => STATUS_KEYS.includes(v) && v !== 'filed' ? v : undefined,
  title: v => typeof v === 'string' ? v.slice(0, 300) : undefined,
  summary: v => typeof v === 'string' ? v.slice(0, 4000) : undefined,
  next_action: v => typeof v === 'string' ? v.slice(0, 1000) : undefined,
  project_id: v => v === null || typeof v === 'string' ? v : undefined,
  due_at: v => v === null || (typeof v === 'string' && !isNaN(Date.parse(v))) ? v : undefined,
  completed_at: v => v === null || (typeof v === 'string' && !isNaN(Date.parse(v))) ? v : undefined,
};

export async function updateCapture(db, userId, id, patch) {
  const sets = [], vals = [id, userId];
  for (const [k, check] of Object.entries(EDITABLE)) {
    if (!(k in patch)) continue;
    const v = check(patch[k]);
    if (v === undefined) continue;
    vals.push(v);
    sets.push(`${k} = $${vals.length}`);
  }
  // The raw thought is not normally edited, but a person may correct a
  // mis-heard transcript — the original is preserved in details.raw_history.
  if (typeof patch.raw_text === 'string') {
    vals.push(patch.raw_text.slice(0, 20000));
    sets.push(`details = jsonb_set(details, '{raw_history}', coalesce(details->'raw_history','[]'::jsonb) || jsonb_build_array(jsonb_build_object('text', raw_text, 'replaced_at', now()))), raw_text = $${vals.length}`);
  }
  if (!sets.length) return getCapture(db, userId, id);
  if ('kind' in patch || 'project_id' in patch || 'title' in patch) sets.push(`classification_state = 'manual'`);
  if (patch.project_id) {
    const ok = await db.query('SELECT 1 FROM asst_projects WHERE id = $1 AND user_id = $2', [patch.project_id, userId]);
    if (!ok.length) return null;
  }
  const r = await db.query(`UPDATE asst_captures SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING id`, vals);
  return r[0] ? getCapture(db, userId, id) : null;
}

export async function mergeDetails(db, userId, id, obj) {
  await db.query('UPDATE asst_captures SET details = details || $3::jsonb, updated_at = now() WHERE id = $1 AND user_id = $2', [id, userId, JSON.stringify(obj)]);
}

// Enrichment that adds to what was captured (a link's page title) — never replaces it.
export async function appendRawText(db, userId, id, text) {
  await db.query("UPDATE asst_captures SET raw_text = coalesce(raw_text,'') || $3, updated_at = now() WHERE id = $1 AND user_id = $2", [id, userId, String(text).slice(0, 1000)]);
}

export async function deleteCapture(db, userId, id) {
  const r = await db.query('DELETE FROM asst_captures WHERE id = $1 AND user_id = $2 RETURNING id', [id, userId]);
  if (r[0]) await db.query("DELETE FROM asst_links WHERE user_id = $1 AND ((from_type = 'capture' AND from_id = $2) OR (to_type = 'capture' AND to_id = $2))", [userId, id]);
  return !!r[0];
}

export async function getCapture(db, userId, id) {
  const r = await db.query(`SELECT c.*, p.name AS project_name, p.emoji AS project_emoji
      FROM asst_captures c LEFT JOIN asst_projects p ON p.id = c.project_id
      WHERE c.id = $1 AND c.user_id = $2`, [id, userId]);
  const c = r[0];
  if (!c) return null;
  delete c.search;
  const [atts, people, tags, ext] = await Promise.all([
    db.query('SELECT id, kind, mime, name, size, transcript, created_at FROM asst_attachments WHERE capture_id = $1 AND user_id = $2 ORDER BY created_at', [id, userId]),
    db.query(`SELECT pe.id, pe.display_name FROM asst_links l JOIN asst_people pe ON pe.id = l.to_id
        WHERE l.user_id = $1 AND l.from_type = 'capture' AND l.from_id = $2 AND l.to_type = 'person'`, [userId, id]),
    db.query(`SELECT t.id, t.name FROM asst_links l JOIN asst_tags t ON t.id = l.to_id
        WHERE l.user_id = $1 AND l.from_type = 'capture' AND l.from_id = $2 AND l.to_type = 'tag' ORDER BY t.name`, [userId, id]),
    db.query(`SELECT e.id, e.provider, e.kind, e.title, e.url, e.occurred_at FROM asst_links l JOIN asst_external_records e ON e.id = l.to_id
        WHERE l.user_id = $1 AND l.from_type = 'capture' AND l.from_id = $2 AND l.to_type = 'external'`, [userId, id]),
  ]);
  return Object.assign(c, { attachments: atts, people, tags, sources: ext });
}

// Open work the assistant still owns. A capture filed to an app lives there
// now — except a task or reminder with a due time: the app won't remind the
// owner, so it stays on the assistant's lists.
const STILL_MINE = "(c.status <> 'filed' OR (c.kind IN ('task','reminder') AND c.due_at IS NOT NULL))";

// Inbox / lists. Keyset pagination on (captured_at, id) keeps page 50 as fast
// as page 1 with thousands of captures.
export async function listCaptures(db, userId, { status, kind, projectId, limit = 40, before, includeQuestions = false, openTasks = false } = {}) {
  const where = ['c.user_id = $1'], vals = [userId];
  const add = (sql, v) => { vals.push(v); where.push(sql.replace('?', '$' + vals.length)); };
  if (status === 'open') where.push("c.status NOT IN ('archived','built','filed')");
  else if (status) add('c.status = ?', status);
  if (kind) add('c.kind = ?', kind);
  if (projectId) add('c.project_id = ?', projectId);
  if (!includeQuestions) where.push("c.kind <> 'question'");
  if (openTasks) where.push(`c.kind IN ('task','reminder') AND c.completed_at IS NULL AND ${STILL_MINE}`);
  if (before) {
    const [ts, id] = String(before).split('|');
    if (ts && id && !isNaN(Date.parse(ts))) {
      vals.push(ts, id);
      where.push(`(c.captured_at, c.id) < ($${vals.length - 1}::timestamptz, $${vals.length})`);
    }
  }
  vals.push(Math.min(Math.max(1, limit), 100) + 1);
  const rows = await db.query(`SELECT ${LIST_COLS} FROM asst_captures c LEFT JOIN asst_projects p ON p.id = c.project_id
      WHERE ${where.join(' AND ')} ORDER BY c.captured_at DESC, c.id DESC LIMIT $${vals.length}`, vals);
  const more = rows.length > limit;
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, next: more && last ? new Date(last.captured_at).toISOString() + '|' + last.id : null };
}

// Full-text search over everything captured. Items matching every word rank
// first (websearch_to_tsquery: natural input, quoted phrases, -exclusions);
// items matching any word follow, so "sprinkler pricing" still surfaces a
// note that only says "sprinkler". A substring match catches names and codes
// the English stemmer would miss.
export function anyWordQuery(text) {
  const words = String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 1 && !/^(or|and|the|a|an|of|to|in|for|on|my|me|i)$/.test(w)).slice(0, 12);
  return words.join(' | ');
}

export async function searchCaptures(db, userId, q, { limit = 15, kinds } = {}) {
  const text = String(q || '').trim().slice(0, 300);
  if (!text) return [];
  const orq = anyWordQuery(text) || 'zzzznomatch';
  const vals = [userId, text, '%' + text.replace(/[\\%_]/g, m => '\\' + m) + '%', Math.min(limit, 50), orq];
  let kindSql = '';
  if (kinds && kinds.length) { vals.push(kinds); kindSql = ` AND c.kind = ANY($${vals.length})`; }
  return db.query(`SELECT ${LIST_COLS},
        (c.search @@ websearch_to_tsquery('english', $2)) AS all_words,
        ts_rank(c.search, websearch_to_tsquery('english', $2)) * 2 + ts_rank(c.search, to_tsquery('english', $5)) AS rank,
        ts_headline('english', coalesce(c.raw_text,'') || ' ' || coalesce(c.summary,''), to_tsquery('english', $5),
          'MaxWords=24,MinWords=8,StartSel=«,StopSel=»') AS headline
      FROM asst_captures c LEFT JOIN asst_projects p ON p.id = c.project_id
      WHERE c.user_id = $1 AND c.kind <> 'question' AND (c.search @@ to_tsquery('english', $5)
        OR c.title ILIKE $3 OR c.raw_text ILIKE $3)${kindSql}
      ORDER BY all_words DESC, rank DESC, c.captured_at DESC LIMIT $4`, vals);
}

const STOP = new Set('about above after again also because been before being between both could does doing down during each from further have having here into itself just more most myself once only other over same should some such than that their them then there these they this those through under until very were what when where which while with would your yours maybe think want need make like really going thing things idea ideas'.split(' '));

export function keywordsOf(text, max = 8) {
  const seen = new Map();
  String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(w => w.length > 3 && !STOP.has(w) && !/^\d+$/.test(w))
    .forEach(w => seen.set(w, (seen.get(w) || 0) + 1));
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([w]) => w);
}

// "Connect the dots": other captures that share vocabulary with this one.
// Quiet by design — only shown when someone opens the card.
export async function relatedCaptures(db, userId, capture, limit = 5) {
  const words = keywordsOf([capture.title, capture.summary, capture.raw_text].join(' '));
  if (!words.length) return [];
  const tsq = words.join(' | ');
  return db.query(`SELECT ${LIST_COLS}, ts_rank(c.search, to_tsquery('english', $3)) AS rank
      FROM asst_captures c LEFT JOIN asst_projects p ON p.id = c.project_id
      WHERE c.user_id = $1 AND c.id <> $2 AND c.kind <> 'question' AND c.search @@ to_tsquery('english', $3)
      ORDER BY rank DESC LIMIT $4`, [userId, capture.id, tsq, limit]);
}

// Structured filter used by the assistant ("what's due tomorrow", "my open
// goals", "unfinished ideas about ALP").
export async function queryCaptures(db, userId, { kinds, statuses, projectId, dueFrom, dueTo, openOnly, staleDays, limit = 25, order = 'recent' } = {}) {
  const where = ["c.user_id = $1", "c.kind <> 'question'"], vals = [userId];
  const add = (sql, v) => { vals.push(v); where.push(sql.replace(/\?/g, '$' + vals.length)); };
  if (kinds && kinds.length) add('c.kind = ANY(?)', kinds);
  if (statuses && statuses.length) add('c.status = ANY(?)', statuses);
  if (projectId) add('c.project_id = ?', projectId);
  if (dueFrom) add('c.due_at >= ?::timestamptz', dueFrom);
  if (dueTo) add('c.due_at < ?::timestamptz', dueTo);
  if (openOnly) where.push(`c.completed_at IS NULL AND c.status NOT IN ('archived','built') AND ${STILL_MINE}`);
  if (staleDays) add("c.updated_at < now() - (? || ' days')::interval", String(staleDays));
  vals.push(Math.min(Math.max(1, limit), 100));
  const orderSql = order === 'due' ? 'c.due_at ASC NULLS LAST' : order === 'oldest' ? 'c.captured_at ASC' : 'c.captured_at DESC';
  return db.query(`SELECT ${LIST_COLS} FROM asst_captures c LEFT JOIN asst_projects p ON p.id = c.project_id
      WHERE ${where.join(' AND ')} ORDER BY ${orderSql} LIMIT $${vals.length}`, vals);
}

export async function pendingClassification(db, userId, limit = 5) {
  // A capture routed to an app keeps its classification: re-sorting it could
  // turn the words that went to Dream Board into a hidden "question".
  return db.query(`SELECT * FROM asst_captures c WHERE user_id = $1 AND classification_state IN ('pending','failed')
      AND captured_at > now() - interval '30 days' AND NOT EXISTS (SELECT 1 FROM asst_app_ops o WHERE o.capture_id = c.id)
      ORDER BY captured_at DESC LIMIT $2`, [userId, limit]);
}

export async function counts(db, userId) {
  const r = await db.query(`SELECT
      count(*) FILTER (WHERE status = 'inbox' AND kind <> 'question')::int AS inbox,
      count(*) FILTER (WHERE kind IN ('task','reminder') AND completed_at IS NULL AND status NOT IN ('archived','built') AND ${STILL_MINE})::int AS open_tasks,
      count(*) FILTER (WHERE kind <> 'question')::int AS total
    FROM asst_captures c WHERE user_id = $1`, [userId]);
  return r[0];
}
