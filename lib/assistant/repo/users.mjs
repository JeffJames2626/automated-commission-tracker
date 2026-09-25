import { newId } from '../ids.mjs';

export async function findUserById(db, id) {
  const r = await db.query('SELECT * FROM asst_users WHERE id = $1', [id]);
  return r[0] || null;
}

// Identity is the Google subject id (stable forever); the email can change.
export async function upsertUserFromGoogle(db, { sub, email, name, picture }) {
  const bySub = await db.query('SELECT * FROM asst_users WHERE google_sub = $1', [sub]);
  if (bySub[0]) {
    const r = await db.query(
      'UPDATE asst_users SET email = $2, name = $3, picture = $4, updated_at = now() WHERE id = $1 RETURNING *',
      [bySub[0].id, email, name || bySub[0].name, picture || bySub[0].picture]);
    return { user: r[0], created: false };
  }
  // A row created before we knew the sub (e.g. seeded by email) is claimed once.
  const byEmail = await db.query('SELECT * FROM asst_users WHERE email = $1 AND google_sub IS NULL', [email]);
  if (byEmail[0]) {
    const r = await db.query('UPDATE asst_users SET google_sub = $2, name = $3, picture = $4, updated_at = now() WHERE id = $1 RETURNING *',
      [byEmail[0].id, sub, name, picture]);
    return { user: r[0], created: false };
  }
  const r = await db.query(
    'INSERT INTO asst_users (id, email, google_sub, name, picture) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [newId('user'), email, sub, name, picture]);
  return { user: r[0], created: true };
}

export async function setUserTz(db, userId, tz) {
  if (!tz || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(tz)) return;
  await db.query('UPDATE asst_users SET tz = $2 WHERE id = $1 AND (tz IS DISTINCT FROM $2)', [userId, tz]);
}

export async function bumpSessionEpoch(db, userId) {
  await db.query('UPDATE asst_users SET session_epoch = session_epoch + 1, updated_at = now() WHERE id = $1', [userId]);
}

// Who may sign in. ASSISTANT_ALLOWED_EMAILS wins; without it, the tracker's
// admins (its `users` table) are the allowed set, so the owner is covered
// without extra setup. Fails closed when neither exists.
export async function isAllowedEmail(db, email, allowList) {
  const e = String(email || '').toLowerCase();
  if (!e) return false;
  if (allowList && allowList.length) return allowList.includes(e);
  try {
    const r = await db.query("SELECT 1 FROM users WHERE lower(email) = $1 AND role = 'admin'", [e]);
    return r.length > 0;
  } catch { return false; }
}
