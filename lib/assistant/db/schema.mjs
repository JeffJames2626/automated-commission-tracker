// The assistant's canonical tables. Every statement is idempotent so this can
// run on every cold start; each is sent on its own because Neon's HTTP driver
// runs one statement per request. All tables are prefixed asst_ so they sit
// safely beside the tracker's tables in the same database.

const TS = 'TIMESTAMPTZ NOT NULL DEFAULT now()';

export const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS asst_users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    google_sub TEXT UNIQUE,
    name TEXT, picture TEXT, tz TEXT,
    session_epoch INT NOT NULL DEFAULT 0,
    created_at ${TS}, updated_at ${TS})`,

  `CREATE TABLE IF NOT EXISTS asst_connections (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES asst_users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    account_id TEXT NOT NULL,
    account_email TEXT,
    granted_scopes JSONB NOT NULL DEFAULT '[]',
    disabled_services JSONB NOT NULL DEFAULT '[]',
    refresh_token_enc TEXT,
    access_token_enc TEXT,
    access_expires_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'connected',
    status_detail TEXT,
    last_refreshed_at TIMESTAMPTZ, last_used_at TIMESTAMPTZ,
    created_at ${TS}, updated_at ${TS},
    UNIQUE (user_id, provider, account_id))`,

  `CREATE TABLE IF NOT EXISTS asst_projects (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES asst_users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'project',
    description TEXT, emoji TEXT,
    aliases JSONB NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'active',
    created_at ${TS}, updated_at ${TS})`,
  `CREATE UNIQUE INDEX IF NOT EXISTS asst_projects_name ON asst_projects (user_id, lower(name))`,

  `CREATE TABLE IF NOT EXISTS asst_captures (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES asst_users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'note',
    status TEXT NOT NULL DEFAULT 'inbox',
    title TEXT,
    raw_text TEXT,
    summary TEXT,
    next_action TEXT,
    source_type TEXT NOT NULL DEFAULT 'text',
    url TEXT,
    project_id TEXT REFERENCES asst_projects(id) ON DELETE SET NULL,
    details JSONB NOT NULL DEFAULT '{}',
    ai JSONB NOT NULL DEFAULT '{}',
    classification_state TEXT NOT NULL DEFAULT 'pending',
    client_ref TEXT,
    due_at TIMESTAMPTZ, completed_at TIMESTAMPTZ,
    captured_at ${TS}, created_at ${TS}, updated_at ${TS},
    search tsvector GENERATED ALWAYS AS (to_tsvector('english',
      coalesce(title,'') || ' ' || coalesce(raw_text,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(next_action,'') || ' ' || coalesce(url,''))) STORED,
    UNIQUE (user_id, client_ref))`,
  `CREATE INDEX IF NOT EXISTS asst_captures_list ON asst_captures (user_id, status, captured_at DESC)`,
  `CREATE INDEX IF NOT EXISTS asst_captures_project ON asst_captures (user_id, project_id)`,
  `CREATE INDEX IF NOT EXISTS asst_captures_due ON asst_captures (user_id, due_at) WHERE due_at IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS asst_captures_search ON asst_captures USING gin (search)`,

  `CREATE TABLE IF NOT EXISTS asst_organizations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES asst_users(id) ON DELETE CASCADE,
    name TEXT NOT NULL, domain TEXT,
    created_at ${TS}, updated_at ${TS})`,
  `CREATE UNIQUE INDEX IF NOT EXISTS asst_orgs_name ON asst_organizations (user_id, lower(name))`,

  `CREATE TABLE IF NOT EXISTS asst_people (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES asst_users(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    aliases JSONB NOT NULL DEFAULT '[]',
    org_id TEXT REFERENCES asst_organizations(id) ON DELETE SET NULL,
    role TEXT, notes TEXT,
    merged_into TEXT,
    created_at ${TS}, updated_at ${TS})`,
  `CREATE INDEX IF NOT EXISTS asst_people_name ON asst_people (user_id, lower(display_name))`,

  // A person's stable ids in other systems: normalised email, Google Contacts
  // resourceName, … One provider id can belong to exactly one person.
  `CREATE TABLE IF NOT EXISTS asst_identities (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES asst_users(id) ON DELETE CASCADE,
    person_id TEXT NOT NULL REFERENCES asst_people(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    label TEXT,
    created_at ${TS},
    UNIQUE (user_id, provider, provider_id))`,

  `CREATE TABLE IF NOT EXISTS asst_tags (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES asst_users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at ${TS})`,
  `CREATE UNIQUE INDEX IF NOT EXISTS asst_tags_name ON asst_tags (user_id, lower(name))`,

  // Relationships instead of folders.
  `CREATE TABLE IF NOT EXISTS asst_links (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES asst_users(id) ON DELETE CASCADE,
    from_type TEXT NOT NULL, from_id TEXT NOT NULL,
    to_type TEXT NOT NULL, to_id TEXT NOT NULL,
    relation TEXT NOT NULL DEFAULT 'related',
    origin TEXT NOT NULL DEFAULT 'user',
    created_at ${TS},
    UNIQUE (user_id, from_type, from_id, to_type, to_id, relation))`,
  `CREATE INDEX IF NOT EXISTS asst_links_to ON asst_links (user_id, to_type, to_id)`,

  `CREATE TABLE IF NOT EXISTS asst_memories (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES asst_users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'fact',
    statement TEXT NOT NULL,
    subject_type TEXT, subject_id TEXT,
    source_type TEXT, source_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    superseded_by TEXT,
    created_at ${TS}, updated_at ${TS},
    search tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(statement,''))) STORED)`,
  `CREATE INDEX IF NOT EXISTS asst_memories_search ON asst_memories USING gin (search)`,

  `CREATE TABLE IF NOT EXISTS asst_attachments (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES asst_users(id) ON DELETE CASCADE,
    capture_id TEXT NOT NULL REFERENCES asst_captures(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    mime TEXT, name TEXT, size INT,
    sha256 TEXT NOT NULL,
    data_b64 TEXT,
    transcript TEXT,
    created_at ${TS},
    UNIQUE (user_id, capture_id, sha256))`,

  `CREATE TABLE IF NOT EXISTS asst_conversations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES asst_users(id) ON DELETE CASCADE,
    title TEXT,
    created_at ${TS}, updated_at ${TS})`,
  `CREATE TABLE IF NOT EXISTS asst_messages (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES asst_users(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL REFERENCES asst_conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    sources JSONB NOT NULL DEFAULT '[]',
    trace JSONB NOT NULL DEFAULT '[]',
    actions JSONB NOT NULL DEFAULT '[]',
    model TEXT,
    created_at ${TS})`,
  `CREATE INDEX IF NOT EXISTS asst_messages_conv ON asst_messages (conversation_id, created_at)`,

  // Pointers to Google objects that were cited or linked — metadata only.
  `CREATE TABLE IF NOT EXISTS asst_external_records (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES asst_users(id) ON DELETE CASCADE,
    connection_id TEXT,
    provider TEXT NOT NULL,
    provider_record_id TEXT NOT NULL,
    kind TEXT, title TEXT, url TEXT,
    occurred_at TIMESTAMPTZ,
    meta JSONB NOT NULL DEFAULT '{}',
    person_id TEXT, project_id TEXT,
    first_seen_at ${TS}, last_seen_at ${TS},
    UNIQUE (user_id, provider, provider_record_id))`,

  `CREATE TABLE IF NOT EXISTS asst_actions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES asst_users(id) ON DELETE CASCADE,
    message_id TEXT,
    kind TEXT NOT NULL,
    summary TEXT,
    payload JSONB NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'proposed',
    result JSONB,
    created_at ${TS}, decided_at TIMESTAMPTZ)`,

  `CREATE TABLE IF NOT EXISTS asst_rate (
    user_id TEXT NOT NULL,
    bucket TEXT NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    count INT NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, bucket, window_start))`,

  // ---------------- Phase 2: connected apps (docs/assistant/CONNECTED-APPS.md) ----------------

  // One row per (user, app) such as Dream Board. The app's server calls us with
  // a bearer token (stored only as a SHA-256 hash) obtained by redeeming a
  // one-time pairing code. The row is bound to one app database (instance_id)
  // so a test board or a restored copy can never drain the real queue.
  `CREATE TABLE IF NOT EXISTS asst_apps (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES asst_users(id) ON DELETE CASCADE,
    app TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'disconnected',
    token_hash TEXT UNIQUE,
    token_hint TEXT,
    pair_code_hash TEXT UNIQUE,
    pair_expires_at TIMESTAMPTZ,
    session_epoch INT NOT NULL DEFAULT 0,
    instance_id TEXT, instance_label TEXT,
    epoch TEXT, max_seq BIGINT NOT NULL DEFAULT 0,
    resync BOOLEAN NOT NULL DEFAULT false,
    base_url TEXT, link_template TEXT,
    history_since TIMESTAMPTZ,
    last_seen_at TIMESTAMPTZ, caught_up_at TIMESTAMPTZ,
    last_error TEXT,
    created_at ${TS}, updated_at ${TS},
    UNIQUE (user_id, app))`,

  // Operations queued for an app (create a dream, attach a photo …). The row
  // id is the op id the app deduplicates on. A capture has at most one live op
  // per app; rejected/cancelled/superseded rows stay as routing history.
  `CREATE TABLE IF NOT EXISTS asst_app_ops (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES asst_users(id) ON DELETE CASCADE,
    app TEXT NOT NULL,
    kind TEXT NOT NULL,
    capture_id TEXT REFERENCES asst_captures(id) ON DELETE SET NULL,
    action_id TEXT,
    depends_on TEXT,
    target_id TEXT,
    payload JSONB NOT NULL DEFAULT '{}',
    status TEXT NOT NULL,
    reason TEXT,
    result JSONB,
    attempts INT NOT NULL DEFAULT 0,
    delivered_at TIMESTAMPTZ, done_at TIMESTAMPTZ, linked_at TIMESTAMPTZ,
    trace JSONB NOT NULL DEFAULT '[]',
    created_at ${TS}, updated_at ${TS})`,
  `CREATE UNIQUE INDEX IF NOT EXISTS asst_app_ops_live ON asst_app_ops (user_id, app, capture_id)
    WHERE capture_id IS NOT NULL AND status NOT IN ('rejected','cancelled','superseded')`,
  `CREATE INDEX IF NOT EXISTS asst_app_ops_queue ON asst_app_ops (user_id, app, status, created_at)`,

  // The read-only mirror of app records lives in asst_external_records: these
  // columns stay empty for Google pointers.
  `ALTER TABLE asst_external_records ADD COLUMN IF NOT EXISTS app_epoch TEXT`,
  `ALTER TABLE asst_external_records ADD COLUMN IF NOT EXISTS app_seq BIGINT`,
  `ALTER TABLE asst_external_records ADD COLUMN IF NOT EXISTS status TEXT`,
  `ALTER TABLE asst_external_records ADD COLUMN IF NOT EXISTS data JSONB`,
  `ALTER TABLE asst_external_records ADD COLUMN IF NOT EXISTS aliases JSONB NOT NULL DEFAULT '[]'`,
  `ALTER TABLE asst_external_records ADD COLUMN IF NOT EXISTS search_text TEXT`,
  `ALTER TABLE asst_external_records ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`,
  `ALTER TABLE asst_external_records ADD COLUMN IF NOT EXISTS missing_at TIMESTAMPTZ`,
  `ALTER TABLE asst_external_records ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ`,
  `ALTER TABLE asst_external_records ADD COLUMN IF NOT EXISTS search tsvector GENERATED ALWAYS AS
    (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(search_text,''))) STORED`,
  `CREATE INDEX IF NOT EXISTS asst_external_search ON asst_external_records USING gin (search)`,

  // What changed in an app record, derived by diffing successive snapshots.
  // One row per (record, version); changes caused by our own ops carry op_ids.
  `CREATE TABLE IF NOT EXISTS asst_events (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES asst_users(id) ON DELETE CASCADE,
    app TEXT NOT NULL,
    external_id TEXT,
    record_id TEXT NOT NULL,
    epoch TEXT NOT NULL DEFAULT '',
    seq BIGINT NOT NULL,
    changes JSONB NOT NULL DEFAULT '[]',
    progress BOOLEAN NOT NULL DEFAULT false,
    op_ids JSONB NOT NULL DEFAULT '[]',
    occurred_at TIMESTAMPTZ NOT NULL,
    received_at ${TS},
    UNIQUE (user_id, app, record_id, epoch, seq))`,
  `CREATE INDEX IF NOT EXISTS asst_events_recent ON asst_events (user_id, received_at DESC)`,

  // Memory provenance: stated (the owner told us directly), conversation (the
  // owner asked the assistant to remember), extracted (AI pulled it from a
  // capture), inferred (an AI conclusion — never presented as the owner's words).
  `ALTER TABLE asst_memories ADD COLUMN IF NOT EXISTS origin TEXT`,
  `UPDATE asst_memories SET origin = CASE source_type WHEN 'capture' THEN 'extracted' WHEN 'conversation' THEN 'conversation' ELSE 'stated' END WHERE origin IS NULL`,

  // Identities can also pin a project/business to an app's own id (e.g. a
  // Dream Board category or a Sales Tracker business) so renames never split it.
  `ALTER TABLE asst_identities ALTER COLUMN person_id DROP NOT NULL`,
  `ALTER TABLE asst_identities ADD COLUMN IF NOT EXISTS project_id TEXT REFERENCES asst_projects(id) ON DELETE CASCADE`,
  `ALTER TABLE asst_projects ADD COLUMN IF NOT EXISTS source_app TEXT`,
  `UPDATE asst_projects SET source_app = 'dreamboard' WHERE source_app IS NULL AND lower(name) = 'dream board'`,
  `ALTER TABLE asst_users ADD COLUMN IF NOT EXISTS last_catchup_at TIMESTAMPTZ`,
  `ALTER TABLE asst_actions ADD COLUMN IF NOT EXISTS op_id TEXT`,
];

export async function migrate(db) {
  for (const s of STATEMENTS) await db.query(s);
}
