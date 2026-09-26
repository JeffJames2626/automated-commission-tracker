// Backups of the assistant's own data (the asst_* tables only — never the
// tracker's). Two shapes:
//
//   dumpAll(db)               every row of every assistant table, byte for byte
//                             (attachments and encrypted Google tokens
//                             included). For scripts/assistant-backup.mjs,
//                             run by the owner against the real database.
//   dumpUser(db, userId)      one person's data as readable JSON for the
//                             in-app "Export my data": no secrets, attachment
//                             details without the file bytes.
//
// restore(db, dump) puts a dump back. It never overwrites: rows that already
// exist are left alone and counted as skipped.

// Parents before children, so foreign keys hold during a restore. Rate-limit
// counters and short-lived connection requests are not data and are skipped.
export const TABLES = [
  'asst_users', 'asst_connections', 'asst_projects', 'asst_captures', 'asst_organizations', 'asst_people',
  'asst_identities', 'asst_tags', 'asst_links', 'asst_memories', 'asst_attachments', 'asst_conversations',
  'asst_messages', 'asst_external_records', 'asst_actions', 'asst_apps', 'asst_app_ops', 'asst_events',
];

// Never in a personal export: they only work together with server secrets.
const SECRET_COLUMNS = {
  asst_connections: ['access_token_enc', 'refresh_token_enc'],
  asst_apps: ['token_hash', 'pair_code_hash'],
  asst_attachments: ['data_b64'],
};

async function columns(db, table) {
  const r = await db.query(`SELECT column_name, data_type, is_generated FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`, [table]);
  return r.map(c => ({ name: c.column_name, json: /json/.test(c.data_type), generated: c.is_generated === 'ALWAYS' || /tsvector/.test(c.data_type) }));
}

// Read in pages by id, so no single query returns more than a few MB (Neon's
// HTTP driver caps a response at 64 MB; photos are stored in the database).
async function readAll(db, table, cols, where = '', params = []) {
  if (!cols.includes('id')) return db.query(`SELECT ${cols.map(q).join(', ')} FROM ${table}${where ? ' WHERE ' + where : ''}`, params);
  const page = table === 'asst_attachments' ? 8 : 500, rows = [];
  for (let after = '';;) {
    const got = await db.query(`SELECT ${cols.map(q).join(', ')} FROM ${table} WHERE id > $${params.length + 1}${where ? ' AND ' + where : ''} ORDER BY id LIMIT ${page}`, params.concat([after]));
    rows.push(...got);
    if (got.length < page) return rows;
    after = got[got.length - 1].id;
  }
}

export async function dumpAll(db) {
  const out = { format: 'assistant-backup', version: 1, createdAt: new Date().toISOString(), tables: {} };
  for (const t of TABLES) {
    const cols = (await columns(db, t)).filter(c => !c.generated).map(c => c.name);
    if (!cols.length) continue;
    out.tables[t] = await readAll(db, t, cols);
  }
  return out;
}

export async function dumpUser(db, userId) {
  const out = { format: 'assistant-export', version: 1, createdAt: new Date().toISOString(), tables: {} };
  for (const t of TABLES) {
    const all = await columns(db, t);
    const cols = all.filter(c => !c.generated && !(SECRET_COLUMNS[t] || []).includes(c.name)).map(c => c.name);
    const key = t === 'asst_users' ? 'id' : all.some(c => c.name === 'user_id') ? 'user_id' : null;
    if (!key) continue;
    out.tables[t] = await readAll(db, t, cols, `${q(key)} = $1`, [userId]);
  }
  return out;
}

export async function restore(db, dump) {
  if (!dump || dump.format !== 'assistant-backup' || !dump.tables) throw new Error('Not an assistant backup file.');
  const report = {};
  for (const t of TABLES) {
    const rows = dump.tables[t] || [];
    if (!rows.length) continue;
    const cols = new Map((await columns(db, t)).filter(c => !c.generated).map(c => [c.name, c]));
    let inserted = 0, orphaned = 0;
    for (const row of rows) {
      const keys = Object.keys(row).filter(k => cols.has(k));
      const vals = keys.map(k => (cols.get(k).json && row[k] != null ? JSON.stringify(row[k]) : row[k]));
      try {
        const r = await db.query(`INSERT INTO ${t} (${keys.map(q).join(', ')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(', ')})
          ON CONFLICT DO NOTHING RETURNING 1`, vals);
        inserted += r.length;
      } catch (e) {
        // A row written while the backup ran can point at a parent the backup
        // read before it existed. It is reported, not a reason to stop.
        if (e && e.code === '23503') { orphaned++; continue; }
        throw e;
      }
    }
    report[t] = { inserted, skipped: rows.length - inserted - orphaned, orphaned };
  }
  return report;
}

const q = name => '"' + String(name).replace(/"/g, '""') + '"';
