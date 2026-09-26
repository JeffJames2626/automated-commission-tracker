// Full backup of the assistant's data (asst_* tables only), run by the owner
// from their own computer:
//
//   ASSISTANT_BACKUP_URL='postgres://…' node scripts/assistant-backup.mjs [file]
//
// Writes every row — including photos/files and the (encrypted) Google tokens
// — to a local JSON file. Keep it somewhere private: it is your data. The
// Google tokens in it only work together with ASSISTANT_TOKEN_KEY, which is
// not in the file. See docs/assistant/BACKUP-RECOVERY.md.
import fs from 'node:fs';
import { neonDb } from '../lib/assistant/db/index.mjs';
import { dumpAll } from '../lib/assistant/backup.mjs';

const url = process.env.ASSISTANT_BACKUP_URL;
if (!url) { console.error('Set ASSISTANT_BACKUP_URL to the database to back up (read-only access is enough).'); process.exit(2); }
const file = process.argv[2] || `assistant-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
const dump = await dumpAll(neonDb(url));
fs.writeFileSync(file, JSON.stringify(dump));
const counts = Object.entries(dump.tables).map(([t, rows]) => `${t.replace('asst_', '')} ${rows.length}`).join(', ');
console.log(`Wrote ${file}\n${counts}`);
