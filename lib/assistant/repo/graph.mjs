import { newId } from '../ids.mjs';

// Relationships and tags. Information never moves into folders; it is linked.

export async function link(db, userId, from, to, relation = 'related', origin = 'user') {
  await db.query(`INSERT INTO asst_links (id, user_id, from_type, from_id, to_type, to_id, relation, origin)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
    [newId('link'), userId, from.type, from.id, to.type, to.id, relation, origin]);
}

export async function unlink(db, userId, from, to, relation) {
  const vals = [userId, from.type, from.id, to.type, to.id];
  let rel = '';
  if (relation) { vals.push(relation); rel = ' AND relation = $6'; }
  await db.query(`DELETE FROM asst_links WHERE user_id = $1 AND from_type = $2 AND from_id = $3 AND to_type = $4 AND to_id = $5${rel}`, vals);
}

export async function ensureTag(db, userId, name) {
  const n = String(name || '').trim().replace(/^#/, '').slice(0, 40);
  if (!n) return null;
  await db.query('INSERT INTO asst_tags (id, user_id, name) VALUES ($1,$2,$3) ON CONFLICT (user_id, lower(name)) DO NOTHING', [newId('tag'), userId, n]);
  const r = await db.query('SELECT * FROM asst_tags WHERE user_id = $1 AND lower(name) = lower($2)', [userId, n]);
  return r[0] || null;
}

export async function setCaptureTags(db, userId, captureId, names, origin = 'user') {
  await db.query("DELETE FROM asst_links WHERE user_id = $1 AND from_type = 'capture' AND from_id = $2 AND to_type = 'tag'", [userId, captureId]);
  for (const n of names.slice(0, 12)) {
    const t = await ensureTag(db, userId, n);
    if (t) await link(db, userId, { type: 'capture', id: captureId }, { type: 'tag', id: t.id }, 'tagged', origin);
  }
}

export async function addCaptureTags(db, userId, captureId, names, origin = 'ai') {
  for (const n of names.slice(0, 8)) {
    const t = await ensureTag(db, userId, n);
    if (t) await link(db, userId, { type: 'capture', id: captureId }, { type: 'tag', id: t.id }, 'tagged', origin);
  }
}
