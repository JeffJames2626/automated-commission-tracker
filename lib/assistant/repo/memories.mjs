import { newId } from '../ids.mjs';

// Structured memory: short statements the owner told the assistant on
// purpose (a preference, a decision, a goal, a fact about a business), each
// traceable to the capture or message it came from. Not a transcript dump.

export const MEMORY_KINDS = ['fact', 'preference', 'decision', 'goal', 'plan', 'relationship'];

export async function addMemory(db, userId, { kind = 'fact', statement, subjectType = null, subjectId = null, sourceType = null, sourceId = null }) {
  const s = String(statement || '').trim().slice(0, 1000);
  if (!s) return null;
  // The same statement twice is one memory.
  const dup = await db.query("SELECT * FROM asst_memories WHERE user_id = $1 AND status = 'active' AND lower(statement) = lower($2)", [userId, s]);
  if (dup[0]) return dup[0];
  const r = await db.query(`INSERT INTO asst_memories (id, user_id, kind, statement, subject_type, subject_id, source_type, source_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, kind, statement, subject_type, subject_id, source_type, source_id, status, created_at`,
    [newId('memory'), userId, MEMORY_KINDS.includes(kind) ? kind : 'fact', s, subjectType, subjectId, sourceType, sourceId]);
  return r[0];
}

export async function listMemories(db, userId, { status = 'active', limit = 200 } = {}) {
  return db.query(`SELECT m.id, m.kind, m.statement, m.subject_type, m.subject_id, m.source_type, m.source_id, m.status, m.created_at, m.updated_at,
      p.name AS project_name
    FROM asst_memories m LEFT JOIN asst_projects p ON m.subject_type = 'project' AND p.id = m.subject_id
    WHERE m.user_id = $1 AND m.status = $2 ORDER BY m.created_at DESC LIMIT $3`, [userId, status, limit]);
}

export async function searchMemories(db, userId, q, limit = 10) {
  const text = String(q || '').trim().slice(0, 300);
  if (!text) return [];
  return db.query(`SELECT m.id, m.kind, m.statement, m.subject_type, m.subject_id, m.source_type, m.source_id, m.created_at, p.name AS project_name,
        ts_rank(m.search, websearch_to_tsquery('english', $2)) AS rank
      FROM asst_memories m LEFT JOIN asst_projects p ON m.subject_type = 'project' AND p.id = m.subject_id
      WHERE m.user_id = $1 AND m.status = 'active' AND (m.search @@ websearch_to_tsquery('english', $2) OR m.statement ILIKE $3)
      ORDER BY rank DESC, m.created_at DESC LIMIT $4`, [userId, text, '%' + text.replace(/[\\%_]/g, x => '\\' + x) + '%', limit]);
}

// Replacing a memory keeps the old one (superseded) so "what did we decide
// before?" still has an answer.
export async function supersedeMemory(db, userId, id, newStatement) {
  const old = await db.query('SELECT * FROM asst_memories WHERE id = $1 AND user_id = $2', [id, userId]);
  if (!old[0]) return null;
  const m = await addMemory(db, userId, { kind: old[0].kind, statement: newStatement, subjectType: old[0].subject_type, subjectId: old[0].subject_id, sourceType: 'user_edit', sourceId: id });
  if (m && m.id !== id) await db.query("UPDATE asst_memories SET status = 'superseded', superseded_by = $3, updated_at = now() WHERE id = $1 AND user_id = $2", [id, userId, m.id]);
  return m;
}

export async function archiveMemory(db, userId, id) {
  const r = await db.query("UPDATE asst_memories SET status = 'archived', updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING id", [id, userId]);
  return !!r[0];
}
