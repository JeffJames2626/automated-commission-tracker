# Personal Assistant — backup and recovery

## What lives where

| Data | Where | Backed up by |
|---|---|---|
| Captures, journal, projects, people, memory, conversations, Dream Board mirror, photos/files you captured | Neon Postgres, `asst_*` tables (photos as base64 in `asst_attachments`) | Neon history (1), backup script (2), export (3) |
| Google tokens | same, encrypted with `ASSISTANT_TOKEN_KEY` | as above; useless without the key |
| Your email, calendar, Drive, Sheets, contacts | Google (the assistant keeps only titles/links of what it cited) | Google |
| Dreams and goals | Dream Board on your PC | Dream Board's own backups |
| Captures not yet synced | the phone's IndexedDB (the "saved on phone" pill) | nothing: let them sync before clearing site data |

## 1. Neon point-in-time restore (first choice after a bad day)

Neon keeps the database's history for a window set by your plan (Neon
console → project → Settings → history / restore window). To recover:

1. Neon console → **Branches → Create branch**, *from a point in time* just
   before the problem. This copies the whole database at that moment and
   leaves the live one untouched.
2. Check the new branch (SQL editor): e.g.
   `SELECT count(*), max(captured_at) FROM asst_captures;`
3. Point only the assistant at it: Vercel → env `ASSISTANT_DATABASE_URL` =
   the branch's pooled connection string (Preview, branch `dev`), then
   redeploy `dev`.

**Never restore or reset the main branch for an assistant problem.** It
holds the Sales Tracker's data too, and a restore would roll that back as
well.

## 2. Full backup to your computer (weekly, and before big changes)

```
ASSISTANT_BACKUP_URL='<Neon connection string>' node scripts/assistant-backup.mjs
```

* Writes `assistant-backup-<date>.json` with every row of every `asst_*`
  table, photos included.
* Read-only access is enough.
* Keep the file private: it is your data.

Restore it into a **new, empty** database or Neon branch, then point the
assistant at that database (`ASSISTANT_DATABASE_URL`):

```
ASSISTANT_RESTORE_URL='<new database>' node scripts/assistant-restore.mjs assistant-backup-<date>.json            # dry run
ASSISTANT_RESTORE_URL='<new database>' node scripts/assistant-restore.mjs assistant-backup-<date>.json --confirm
```

* The restore never overwrites. Rows that already exist are kept and
  reported as skipped.
* The target is its own variable, so a restore can't land on the tracker's
  database by accident.
* `tests/assistant/devlaunch.test.mjs` proves the round trip, including
  photos.

## 3. Export from the app (any time)

**More → Export my data** downloads a readable JSON of your assistant data:
captures, projects, people, memory, conversations and the Dream Board
mirror. It has no secrets and no photo bytes (photo details are listed). It
is good for keeping a copy or reading elsewhere, but it can't be restored.
Use (2) for that.

## Secrets

| Lost or changed | Effect | Fix |
|---|---|---|
| `ASSISTANT_TOKEN_KEY` | stored Google tokens can't be read | Connections → Connect again (no data lost) |
| `ASSISTANT_SESSION_SECRET` | everyone is signed out | sign in again |
| Dream Board token | board shows "Reconnect" | Dream Board → Connect Personal Assistant again |
| Google OAuth secret | sign-in fails | new secret in Google Cloud → Vercel → redeploy |

## Things that are not a backup

* **"Reset demo".** It only exists in the standalone demo page. It clears
  that demo's own browser storage. It refuses to run at `/assistant/`, and
  the server has no reset, wipe or seed endpoint of any kind (a test
  enforces this).
* **Sign out / Disconnect.** These don't delete data. *Forget Dream Board
  data* in Connections deletes only the mirror of the board, never your
  captures.
