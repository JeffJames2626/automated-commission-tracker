import { newId } from '../ids.mjs';
import { DEFAULT_PROJECTS, PROJECT_KINDS } from '../kinds.mjs';

// Projects, businesses, topics and areas. Captures point at one primary
// project; anything else relates through asst_links.

export async function listProjects(db, userId) {
  return db.query(`SELECT p.*,
      (SELECT count(*)::int FROM asst_captures c WHERE c.project_id = p.id AND c.kind <> 'question') AS capture_count,
      (SELECT max(c.captured_at) FROM asst_captures c WHERE c.project_id = p.id) AS last_capture_at
    FROM asst_projects p WHERE p.user_id = $1 ORDER BY p.status = 'archived', last_capture_at DESC NULLS LAST, p.name`, [userId]);
}

export async function getProject(db, userId, id) {
  const r = await db.query('SELECT * FROM asst_projects WHERE id = $1 AND user_id = $2', [id, userId]);
  return r[0] || null;
}

// Find by name or alias, case-insensitive, exact. Never fuzzy: a near-miss
// creates a suggestion, not a silent merge into the wrong project.
export async function findProjectByName(db, userId, name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  const r = await db.query(`SELECT * FROM asst_projects WHERE user_id = $1 AND (lower(name) = $2
      OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(aliases) a WHERE lower(a) = $2)) LIMIT 1`, [userId, n]);
  return r[0] || null;
}

export async function createProject(db, userId, { name, kind = 'project', description = null, emoji = null, aliases = [], source_app = null }) {
  const clean = String(name || '').trim().slice(0, 80);
  if (!clean) return null;
  const existing = await findProjectByName(db, userId, clean);
  if (existing) return existing;
  const r = await db.query(`INSERT INTO asst_projects (id, user_id, name, kind, description, emoji, aliases, source_app)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (user_id, lower(name)) DO NOTHING RETURNING *`,
    [newId('project'), userId, clean, PROJECT_KINDS.includes(kind) ? kind : 'project', description, emoji, JSON.stringify(aliases.slice(0, 12)), source_app]);
  return r[0] || findProjectByName(db, userId, clean);
}

export async function updateProject(db, userId, id, patch) {
  const sets = [], vals = [id, userId];
  const put = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (typeof patch.name === 'string' && patch.name.trim()) put('name', patch.name.trim().slice(0, 80));
  if (PROJECT_KINDS.includes(patch.kind)) put('kind', patch.kind);
  if (typeof patch.description === 'string') put('description', patch.description.slice(0, 2000));
  if (typeof patch.emoji === 'string') put('emoji', patch.emoji.slice(0, 8));
  if (Array.isArray(patch.aliases)) put('aliases', JSON.stringify(patch.aliases.map(String).map(s => s.trim()).filter(Boolean).slice(0, 12)));
  if (patch.status === 'active' || patch.status === 'archived') put('status', patch.status);
  if (!sets.length) return getProject(db, userId, id);
  const r = await db.query(`UPDATE asst_projects SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING *`, vals);
  return r[0] || null;
}

export async function deleteProject(db, userId, id) {
  // Captures stay (project_id → NULL); only the grouping disappears.
  const r = await db.query('DELETE FROM asst_projects WHERE id = $1 AND user_id = $2 RETURNING id', [id, userId]);
  if (r[0]) await db.query("DELETE FROM asst_links WHERE user_id = $1 AND to_type = 'project' AND to_id = $2", [userId, id]);
  return !!r[0];
}

export async function seedDefaultProjects(db, userId) {
  const n = await db.query('SELECT count(*)::int AS n FROM asst_projects WHERE user_id = $1', [userId]);
  if (n[0].n) return;
  for (const p of DEFAULT_PROJECTS) await createProject(db, userId, p);
}

// Which known projects a piece of text names outright (word-boundary match on
// name or alias). Used by the offline classifier and as a hint to the AI.
export function mentionedProjects(projects, text) {
  const t = ' ' + String(text || '').toLowerCase().replace(/[^a-z0-9&']+/g, ' ') + ' ';
  const hits = [];
  for (const p of projects) {
    const names = [p.name].concat(p.aliases || []);
    for (const n of names) {
      const k = String(n).toLowerCase().replace(/[^a-z0-9&']+/g, ' ').trim();
      if (k && t.includes(' ' + k + ' ')) { hits.push({ project: p, length: k.length }); break; }
    }
  }
  return hits.sort((a, b) => b.length - a.length).map(h => h.project);
}
