import { newId } from '../ids.mjs';

export async function createConversation(db, userId, title) {
  const r = await db.query('INSERT INTO asst_conversations (id, user_id, title) VALUES ($1,$2,$3) RETURNING *',
    [newId('conversation'), userId, String(title || 'New conversation').slice(0, 120)]);
  return r[0];
}

export async function getConversation(db, userId, id) {
  const r = await db.query('SELECT * FROM asst_conversations WHERE id = $1 AND user_id = $2', [id, userId]);
  if (!r[0]) return null;
  r[0].messages = await db.query(`SELECT id, role, content, sources, trace, actions, model, created_at
      FROM asst_messages WHERE conversation_id = $1 AND user_id = $2 ORDER BY created_at, id`, [id, userId]);
  return r[0];
}

export async function listConversations(db, userId, limit = 30) {
  return db.query(`SELECT c.id, c.title, c.updated_at,
      (SELECT left(m.content, 160) FROM asst_messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last
    FROM asst_conversations c WHERE c.user_id = $1 ORDER BY c.updated_at DESC LIMIT $2`, [userId, limit]);
}

export async function addMessage(db, userId, conversationId, { role, content, sources = [], trace = [], actions = [], model = null }) {
  const r = await db.query(`INSERT INTO asst_messages (id, user_id, conversation_id, role, content, sources, trace, actions, model)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, role, content, sources, trace, actions, model, created_at`,
    [newId('message'), userId, conversationId, role, content || '', JSON.stringify(sources), JSON.stringify(trace), JSON.stringify(actions), model]);
  await db.query('UPDATE asst_conversations SET updated_at = now() WHERE id = $1', [conversationId]);
  return r[0];
}

export async function getMessage(db, userId, id) {
  const r = await db.query('SELECT * FROM asst_messages WHERE id = $1 AND user_id = $2', [id, userId]);
  return r[0] || null;
}

export async function deleteConversation(db, userId, id) {
  const r = await db.query('DELETE FROM asst_conversations WHERE id = $1 AND user_id = $2 RETURNING id', [id, userId]);
  return !!r[0];
}

export async function renameConversation(db, userId, id, title) {
  await db.query('UPDATE asst_conversations SET title = $3 WHERE id = $1 AND user_id = $2', [id, userId, String(title || '').slice(0, 120)]);
}
