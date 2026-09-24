import { newId } from '../ids.mjs';

// People. A person is matched by stable identifiers — normalised email or a
// Google Contacts resourceName — never merged just because two names look
// alike. Names only resolve to an existing person when exactly one person
// carries that name or alias; ambiguity creates nothing and links nothing.

export function normEmail(e) { return String(e || '').trim().toLowerCase(); }

export async function getPerson(db, userId, id) {
  const r = await db.query('SELECT * FROM asst_people WHERE id = $1 AND user_id = $2', [id, userId]);
  const p = r[0];
  if (!p) return null;
  p.identities = await db.query('SELECT provider, provider_id, label FROM asst_identities WHERE person_id = $1 AND user_id = $2 ORDER BY provider', [id, userId]);
  return p;
}

export async function listPeople(db, userId, { limit = 200 } = {}) {
  return db.query(`SELECT p.id, p.display_name, p.role, p.aliases,
      (SELECT string_agg(i.provider_id, ', ') FROM asst_identities i WHERE i.person_id = p.id AND i.provider = 'email') AS emails,
      (SELECT count(*)::int FROM asst_links l WHERE l.user_id = p.user_id AND l.to_type = 'person' AND l.to_id = p.id) AS mention_count
    FROM asst_people p WHERE p.user_id = $1 AND p.merged_into IS NULL ORDER BY mention_count DESC, p.display_name LIMIT $2`, [userId, limit]);
}

export async function findByIdentity(db, userId, provider, providerId) {
  const r = await db.query(`SELECT p.* FROM asst_identities i JOIN asst_people p ON p.id = i.person_id
      WHERE i.user_id = $1 AND i.provider = $2 AND i.provider_id = $3`, [userId, provider, providerId]);
  return r[0] || null;
}

export async function findByName(db, userId, name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return [];
  return db.query(`SELECT * FROM asst_people WHERE user_id = $1 AND merged_into IS NULL AND (lower(display_name) = $2
      OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(aliases) a WHERE lower(a) = $2))`, [userId, n]);
}

export async function addIdentity(db, userId, personId, provider, providerId, label) {
  const pid = provider === 'email' ? normEmail(providerId) : String(providerId);
  if (!pid) return false;
  // ON CONFLICT DO NOTHING: an identity already owned by another person stays
  // with that person — we never steal ids between people silently.
  const r = await db.query(`INSERT INTO asst_identities (id, user_id, person_id, provider, provider_id, label)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id, provider, provider_id) DO NOTHING RETURNING id`,
    [newId('identity'), userId, personId, provider, pid, label || null]);
  return !!r[0];
}

export async function createPerson(db, userId, { displayName, aliases = [], role = null }) {
  const r = await db.query('INSERT INTO asst_people (id, user_id, display_name, aliases, role) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [newId('person'), userId, String(displayName).trim().slice(0, 120), JSON.stringify(aliases), role]);
  return r[0];
}

// Resolve a person from whatever we know, strongest id first:
//   1. provider identities (contact resourceName, email)
//   2. a unique name/alias match
//   3. create — only when allowed
export async function resolvePerson(db, userId, { name, email, contactId, create = true }) {
  if (contactId) { const p = await findByIdentity(db, userId, 'google_contacts', contactId); if (p) return { person: p, how: 'contact' }; }
  if (email) { const p = await findByIdentity(db, userId, 'email', normEmail(email)); if (p) return { person: p, how: 'email' }; }
  if (name) {
    const matches = await findByName(db, userId, name);
    if (matches.length === 1) {
      const p = matches[0];
      if (email) await addIdentity(db, userId, p.id, 'email', email);
      if (contactId) await addIdentity(db, userId, p.id, 'google_contacts', contactId);
      return { person: p, how: 'name' };
    }
    if (matches.length > 1) return { person: null, how: 'ambiguous', candidates: matches };
  }
  if (!create || !(name || email)) return { person: null, how: 'none' };
  const p = await createPerson(db, userId, { displayName: name || email });
  if (email) await addIdentity(db, userId, p.id, 'email', email);
  if (contactId) await addIdentity(db, userId, p.id, 'google_contacts', contactId);
  return { person: p, how: 'created' };
}

export async function updatePerson(db, userId, id, patch) {
  const sets = [], vals = [id, userId];
  const put = (c, v) => { vals.push(v); sets.push(`${c} = $${vals.length}`); };
  if (typeof patch.display_name === 'string' && patch.display_name.trim()) put('display_name', patch.display_name.trim().slice(0, 120));
  if (typeof patch.role === 'string') put('role', patch.role.slice(0, 120));
  if (typeof patch.notes === 'string') put('notes', patch.notes.slice(0, 4000));
  if (Array.isArray(patch.aliases)) put('aliases', JSON.stringify(patch.aliases.map(String).map(s => s.trim()).filter(Boolean).slice(0, 12)));
  if (sets.length) await db.query(`UPDATE asst_people SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 AND user_id = $2`, vals);
  if (Array.isArray(patch.emails)) for (const e of patch.emails) await addIdentity(db, userId, id, 'email', e);
  return getPerson(db, userId, id);
}

// Merge `fromId` into `intoId`: identities, links and aliases move; the old
// row is kept as a tombstone (merged_into) so its id still resolves.
export async function mergePeople(db, userId, fromId, intoId) {
  if (fromId === intoId) return null;
  const [a, b] = await Promise.all([getPerson(db, userId, fromId), getPerson(db, userId, intoId)]);
  if (!a || !b) return null;
  await db.query('UPDATE asst_identities SET person_id = $3 WHERE user_id = $1 AND person_id = $2', [userId, fromId, intoId]);
  await db.query(`UPDATE asst_links SET to_id = $3 WHERE user_id = $1 AND to_type = 'person' AND to_id = $2
      AND NOT EXISTS (SELECT 1 FROM asst_links x WHERE x.user_id = asst_links.user_id AND x.from_type = asst_links.from_type
        AND x.from_id = asst_links.from_id AND x.to_type = 'person' AND x.to_id = $3 AND x.relation = asst_links.relation)`, [userId, fromId, intoId]);
  await db.query("DELETE FROM asst_links WHERE user_id = $1 AND to_type = 'person' AND to_id = $2", [userId, fromId]);
  const aliases = [...new Set([...(b.aliases || []), a.display_name, ...(a.aliases || [])])].filter(x => x && x !== b.display_name);
  await db.query('UPDATE asst_people SET aliases = $3, updated_at = now() WHERE id = $2 AND user_id = $1', [userId, intoId, JSON.stringify(aliases.slice(0, 20))]);
  await db.query('UPDATE asst_people SET merged_into = $3, updated_at = now() WHERE id = $2 AND user_id = $1', [userId, fromId, intoId]);
  return getPerson(db, userId, intoId);
}

export async function captureIdsForPerson(db, userId, personId, limit = 30) {
  return db.query(`SELECT c.id, c.kind, c.status, c.title, c.summary, c.captured_at FROM asst_links l JOIN asst_captures c ON c.id = l.from_id
      WHERE l.user_id = $1 AND l.to_type = 'person' AND l.to_id = $2 AND l.from_type = 'capture'
      ORDER BY c.captured_at DESC LIMIT $3`, [userId, personId, limit]);
}
