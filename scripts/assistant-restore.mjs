// Put a full backup back (scripts/assistant-backup.mjs), normally into a NEW,
// empty database or Neon branch that the assistant is then pointed at
// (ASSISTANT_DATABASE_URL). It never overwrites: rows already there are kept
// and counted as skipped.
//
//   ASSISTANT_RESTORE_URL='postgres://…' node scripts/assistant-restore.mjs backup.json --confirm
//
// The target is a separate variable on purpose, so a restore can't land on
// the wrong database by accident. See docs/assistant/BACKUP-RECOVERY.md.
import fs from 'node:fs';
import { neonDb } from '../lib/assistant/db/index.mjs';
import { migrate } from '../lib/assistant/db/schema.mjs';
import { restore } from '../lib/assistant/backup.mjs';

const url = process.env.ASSISTANT_RESTORE_URL;
const file = process.argv[2];
if (!url || !file) { console.error('Usage: ASSISTANT_RESTORE_URL=… node scripts/assistant-restore.mjs backup.json --confirm'); process.exit(2); }
const dump = JSON.parse(fs.readFileSync(file, 'utf8'));
const host = (() => { try { return new URL(url).host; } catch { return 'the target database'; } })();
if (!process.argv.includes('--confirm')) {
  console.log(`Would restore ${file} (made ${dump.createdAt}) into ${host}. Re-run with --confirm.`);
  process.exit(0);
}
const db = neonDb(url);
await migrate(db);
const report = await restore(db, dump);
for (const [t, r] of Object.entries(report)) console.log(`${t.padEnd(24)} inserted ${r.inserted}  skipped ${r.skipped}${r.orphaned ? `  orphaned ${r.orphaned} (parent missing in the backup)` : ""}`);
