# Connected apps — the Life Hub contract

The assistant is where things are **captured, remembered, found and routed**.
The apps we build own the structured records in their domain. Dream Board is
the first connected app; the ALP Sales Tracker, the Pricing App, EOS/Traction
and GemMasters plug in the same way (see the last section).

> I capture something once. The assistant understands what it is. The right
> app owns the structured record. The assistant remembers it, can find it
> later, and can tell me what happened to it.

## 1. Who owns what (no duplicate truths)

| Data | Owner (source of truth) | What the assistant keeps |
|---|---|---|
| A dream/goal: title, status, amounts, dates, milestones, notes, images, category | **Dream Board** | A read-only **mirror** row (`asst_external_records`, `provider = 'dreamboard'`) with the last snapshot the board published. It is replaced wholesale by each newer snapshot and never edited by the assistant. It exists so the assistant can search and answer while the PC is off. Every screen labels it with "as of" the last sync. |
| What changed in a dream, and when | Derived from Dream Board's snapshots | `asst_events`: one row per record version, with each change as `{kind, from, to, at}` |
| What the owner said: words, photo, voice, time | **The assistant** | `asst_captures` + `asst_attachments`: the raw capture is never rewritten |
| Where a capture went, and whether it arrived | **The assistant** | `asst_app_ops` (routing state, trace, result) + an `asst_links` edge from the capture to the dream (`routed_to`, `attached_to`, `added_to`) |
| Projects, people, memories, conversations | **The assistant** | Everything |
| Email, calendar, files | Google | Only metadata pointers for things that were cited (unchanged from V1) |

A capture filed to Dream Board gets status **`filed`**. It leaves the inbox,
open lists and the classifier's reach, but stays searchable with a "Dream
Board" badge. The dream itself lives in Dream Board. The assistant has no
second, competing "dream" object.

## 2. Data model added in Phase 2

| Table | Purpose |
|---|---|
| `asst_apps` | One row per (user, app). Holds the pairing-code hash (10 min, single use) and the bearer-token hash, plus `session_epoch` so the token dies with "sign out everywhere". Also the bound `instance_id`, the app's `epoch` and `max_seq`, the `resync` flag, `history_since` (when changes started being known), `base_url` (confirmed by the owner) and `link_template` (declared by the app), and `last_seen_at`, `caught_up_at` and `last_error`. |
| `asst_app_ops` | Work queued for an app. **The row id is the op id** the app deduplicates on. The partial unique index `asst_app_ops_live` allows at most one live op per capture. Other columns: `status`, `target_id`, `depends_on` (a pending create), `payload`, `result`, `attempts`, `delivered_at` / `done_at` / `linked_at`, and `trace` (the Captured → Routed → Queued → Sent → Acknowledged → Linked timeline). |
| `asst_external_records` (+ columns) | The mirror: `app_epoch`, `app_seq` (version gate), `status`, `data` (normalised snapshot), `aliases` (former titles), `search_text` + generated `search` tsvector, `deleted_at`, `missing_at` (gone after a restore; hidden, never hard-deleted), `synced_at`. |
| `asst_events` | Derived changes, unique on `(user, app, record, epoch, seq)` so a duplicate snapshot can't double count. `progress` marks forward movement. `op_ids` marks changes that were the assistant's own ops coming back, so they're told once and as "you did this". |
| `asst_memories.origin` | `stated` (typed on the Memory screen), `conversation` (the owner said "remember…"), `extracted` (the classifier took it from a capture), `inferred` (reserved; nothing writes it). |
| `asst_actions.op_id` | Links a confirmed change card to the op that carries it. |
| `asst_identities.project_id` | Maps an app's own category id (`dreamboard:category`) to an assistant project, so renaming the category in the app keeps the link. |
| `asst_projects.source_app` | The project that is an app's hub ("Dream Board" → `dreamboard`). |
| `asst_users.last_catchup_at` | "Since you last looked." |

## 3. Memory model

| Kind | Where | How the assistant presents it |
|---|---|---|
| **Raw capture** | `asst_captures.raw_text` + attachments | Quoted as what the owner said at the time. Never silently rewritten: a transcript fix keeps the old wording in `details.raw_history`. |
| **Extracted fact** | `asst_memories` (`origin = extracted`) with `source_id` → the capture | "taken from a capture on {date}" |
| **Canonical record** | The owning app. The assistant keeps the mirror (Dream Board) or fetches live (Google). | "Dream Board (as of …)" |
| **Event** | `asst_events` | "target amount $1.2M → $1.8M on {date}" |
| **Relationship** | `asst_links`, `asst_identities` | Capture → dream, capture → person, category → project |
| **Assistant inference** | Only in the answer text | Never stored as a memory. The system prompt forbids presenting it as something the owner said. |

**Temporal memory.** Nothing is overwritten without history. The mirror holds
the *current* value, and `asst_events` holds every change with its time.
`get_dream` returns them as separate sections: CURRENT, CHANGES and the
OWNER'S OWN WORDS. The assistant can then say "originally $1.2M (Jan), now
$1.8M (Sep)". A memory the owner edits is *superseded*, not replaced, so "what
did we decide before?" still has an answer.

**Superseded vs contradictory.**
* *Superseded*: an older value from the same authority was later replaced
  ($1.2M → $1.8M in Dream Board). That's history, and it's reported as such.
* *Contradictory*: two current sources disagree, e.g. a stated memory says
  "lake house budget is $2M" while Dream Board says $1.8M. The assistant shows
  both, with dates and citations, and names the record-holder. `get_dream`
  lists matching memories under a heading that says exactly that.

## 4. Source precedence (per domain)

| Domain | Precedence (highest first) |
|---|---|
| Dreams and goals | Dream Board's current record → structured changes (events) → the owner's captured words → assistant inference |
| Meetings and appointments | Google Calendar → notes about the meeting |
| What someone said | The email itself → notes about it |
| Numbers in a sheet | The sheet cells (quoted with tab and range) → notes |
| Decisions and preferences | Stated memory → extracted memory → inference |

This is enforced in three places, with no generic engine:
1. `get_dream` returns sections in this order.
2. The system prompt ("Which source wins") states the rules.
3. Every answer cites its sources, with dates.

## 5. The adapter contract

Every source declares what it can do in `lib/assistant/integrations/registry.mjs`.
The Connections screen renders exactly that list, and the assistant is only
offered tools for sources that are connected.

| Capability | Meaning | Dream Board | Gmail | Calendar |
|---|---|---|---|---|
| `search` | Find records by words | ✓ | ✓ | ✓ |
| `read` | Open one record | ✓ | ✓ | ✓ |
| `create` | Add a record from a capture | ✓ (Add dreams) | — | ○ later (Create events) |
| `attach` | Add a capture/photo to a record | ✓ | — | — |
| `events` | Report what changed | ✓ (Receive progress) | — | — |
| `milestone`, `update` | Change a record | confirm | — | — |
| `draft` / `send` | Email | — | ○ later / ✕ off | — |
| `delete` | Delete or merge | ✕ never | — | — |

The owner's operation names map onto the contract like this:

| Contract operation | Where it lives |
|---|---|
| `search` | `searchMirror` (`repo/mirror.mjs`), shown as its own group in universal search and in `search_my_notes` |
| `getRecord` | `dreamView` (`apps/dreams.mjs`) → `GET dream`, the `get_dream` tool |
| `getRecentChanges` | `eventsSince` / `changesSince` (`apps/digest.mjs`) → Today, Catch Me Up, the `catch_up` tool |
| `createFromCapture` | ops `create_goal`, `attach`, `add_item` (`apps/routing.mjs`) |
| `getCanonicalLink` | `canonicalLink` (`apps/records.mjs`): the owner-confirmed `base_url` plus the app's declared path template |
| `getCapabilities` | `APPS[app].capabilities` (`integrations/registry.mjs`) |

### 5.1 Why the app calls us

Our own apps run where the assistant can't reach them: Dream Board is on a
private PC and will never be exposed publicly. So the **app's server polls the
assistant**. The protocol is three endpoints and nothing else. None of them
reads a cookie, and a bearer token is never accepted anywhere else.

```
POST /api/assistant/apps/v1/pair     one-time code → token
POST /api/assistant/apps/v1/sync     (Authorization: Bearer dbc_…)
GET  /api/assistant/apps/v1/files?id=&op=   (Authorization: Bearer dbc_…)
```

**Pair.** The owner taps *Connect* on the Connections screen and gets
`ABCD-EFGH` (single use, 10 minutes; making a new code revokes the current
token). They type it into the app, and the app's server calls:

```json
POST apps/v1/pair
{ "app": "dreamboard", "code": "ABCD-EFGH",
  "instance_id": "stable id of this app database", "instance_label": "Jeff's PC",
  "link_template": "/?goal={id}" }
→ 200 { "token": "dbc_…43 chars", "app": "dreamboard", "next_poll_seconds": 1 }
→ 410 expired / used / wrong app
```

The row is now bound to `instance_id`. Any other database (a `zz-*` test
workspace, a restored copy) gets `409 {"error":"wrong_board"}` and can never
drain the real queue. Switching boards takes a deliberate re-pair.

**Sync.** This is one round trip: results in, records in, ops out.

```json
POST apps/v1/sync
{
  "instance_id": "…", "epoch": "e7", "seq": 1234,
  "results": [ Result, … ],          // for ops received earlier; re-send until acked
  "records": [ Record, … ],          // seq > the last "since", ascending, ≤ 100
  "backfill": { "start_seq": 1200, "done": true, "ids": ["g1", "g2"] }   // only while resyncing
}
→ 200 {
  "resync": false,        // true: send every live record, then backfill.done with ids
  "since": 1234,          // next time, send records with seq > since
  "ops": [ Op, … ],       // ≤ 20, oldest first; re-delivered every sync until a result arrives
  "acks": ["op_…"],       // results processed; stop re-sending these
  "next_poll_seconds": 15 // 1 while there is more; 15 when active; 60 when idle
}
→ 401 { "error": "reconnect" }   token unknown/revoked, owner signed out everywhere, or no longer allowed
→ 409 { "error": "wrong_board" } a different instance
→ 429                             rate limited (30/min, 20k/day per owner)
```

* **Versions.** `seq` is the app server's sequence: one number, bumped by
  every change that affects a published record. `epoch` changes whenever the
  app's history is rewound (restore from backup, rollback). A new epoch, or a
  `seq` lower than the one the assistant has seen, makes the assistant ask for
  a **resync**. The app sends every live record with `backfill.start_seq`
  (its `seq` when it began), and on the last page `done: true` plus the ids of
  every live record. Records not listed get `missing_at`: hidden, but kept so
  links and history still explain themselves. Anything changed during the
  resend has `seq > start_seq` and is sent again as a normal update.
* **Record** (the universal source record, as an app publishes it):

```json
{ "type": "goal", "id": "g-123", "seq": 1233,
  "title": "Lake House", "description": "…", "status": "in_progress",
  "category": { "id": "cat-home", "name": "Home" }, "board": { "id": "b1", "name": "Main" },
  "fields": { "target_amount": 1800000, "saved_amount": 200000, "target_date": "2029-06" },
  "field_times": { "target_amount": "2026-09-20T15:02:11Z" },
  "milestones": [ { "id": "m1", "title": "Pick the lake", "done": true, "done_at": "…", "created_at": "…" } ],
  "notes": [ { "id": "n1", "text": "…", "created_at": "…" } ],
  "images": [ { "id": "i1", "created_at": "…" } ],
  "created_at": "…", "updated_at": "…" }
// or a tombstone: { "type": "goal", "id": "g-123", "seq": 1240, "deleted": true }
```

  Presentation (position, size, rotation, crop, z-order) is never part of a
  record, so it can never become an event. Everything is validated and clipped
  (`normalizeRecord`): ids `[A-Za-z0-9_:.-]{1,120}`, title ≤ 300 characters,
  description ≤ 4,000, notes ≤ 20,000 characters in total, ≤ 30 scalar
  `fields` with snake_case keys, ≤ 100 milestones, ≤ 200 image references.
  Image bytes never go from the app to the assistant.
* **Op** (what the app receives: only what it needs):

```json
{ "op_id": "op_…", "kind": "create_goal", "created_at": "…",
  "title": "Lake House", "title_origin": "words",          // words | ai | owner
  "note": "Save this for my Dream Board — someday I want a lake house with a dock",
  "captured_at": "…", "source_type": "voice", "capture_id": "cap_…",
  "attachments": [ { "id": "att_…", "mime": "image/jpeg", "size": 81234, "sha256": "…",
                     "path": "apps/v1/files?id=att_…&op=op_…" } ] }
```

  | kind | fields | confirm? |
  |---|---|---|
  | `create_goal` | title, title_origin, note, attachments | no (the owner said "Dream Board") |
  | `attach` | goal_id, note, attachments | no (the owner named the dream; strict match or chosen) |
  | `add_item` | note, attachments (an unsorted board item) | no |
  | `update_goal` | goal_id, `set: {field: value}`, `expect: {field: old value}`, confirmed_at | **yes** |
  | `add_milestone` | goal_id, `milestone: {title}`, confirmed_at | **yes** |

* **Result**:

```json
{ "op_id": "op_…", "status": "applied", "seq": 1241,
  "record": { "type": "goal", "id": "g-123" },
  "created": { "goal": "g-123", "notes": ["n-…"], "images": ["i-…"], "milestones": [] } }
{ "op_id": "op_…", "status": "rejected", "reason": "target_deleted" }   // target_missing | conflict | invalid | unsupported
```

**Idempotency, both directions.** The app keeps `op_id → result`. A
re-delivered op returns the stored result and never applies twice. Every
entity an op creates gets an id **derived from the op id**, so even a crash
between applying and recording can't make a second copy. Each op is applied
in one transaction. The assistant treats the app's word as final: a result
for an op the owner cancelled meanwhile is still recorded as applied. Every
follow-up step (placeholder record, capture → dream link, releasing dependent
ops, verifying a confirmed change) is idempotent and re-run by `sweep` on
every sync.

**Files.** A photo is served only to the app whose **queued** op lists it,
and only while it is queued. The app checks `sha256`.

## 6. Capture → app routing

Deterministic on purpose. A capture goes to Dream Board only when the owner's
own words say so:

* "…dream board…" / "vision board" → `create_goal`. With a photo and no
  wanting-words, it becomes `add_item`.
* "add/put/attach/save … to/on/in my **X** dream/goal" → `attach` to X.

A dream the AI merely recognises stays in the assistant, with a
**Send to Dream Board** button.

Matching a spoken name to a goal (`matchGoals`) is strict. It targets a goal
only when exactly one live goal (current title or a former title) is named
exactly, or the phrase contains every word of exactly one title and no other
title contains every word of the phrase. Achieved or archived goals are
candidates, never automatic targets. Pending creates are included, so "add
this to my lake house dream" while the PC is off waits for the new Lake House
instead of creating a second one. Anything else asks **Which dream?**. The
same check stops `create_goal` from silently making a second dream with an
existing name.

The steps: `startRouting` writes a `routing` op right after the capture row,
before attachments, link previews or AI, so a crash later can't lose it. Then
`resolveRoute` moves it to `queued`, `waiting` (on a pending create, or on the
board's first sync) or `needs_choice`. `sweep` retries anything left in
`routing`. Offline on the phone, the outbox keeps the capture, and the
composer's copy of the rule says "Saved — waiting to add to Dream Board".

## 7. Cross-app writes: READ → PROPOSE → CONFIRM → EXECUTE → VERIFY

| Step | What happens |
|---|---|
| READ | Tools read the mirror only. |
| PROPOSE | `propose_dream_change` → `proposeAppAction` builds the card **from the mirror**: "Change “Lake House” target amount: $1.8M → $2M". AI text never becomes the summary. Allowed fields: title, status, target_amount, target_date; or a new milestone. |
| CONFIRM | The owner taps Confirm. `confirmAppAction` refuses the change if Dream Board changed since the card was made (`changed_since`). Otherwise it creates the op with id `op_<action id>`, so a retried tap finds the same op. |
| EXECUTE | Dream Board applies it on its next sync, comparing `expect` first. If the value moved on, it rejects with `conflict` and nothing is overwritten. |
| VERIFY | When a snapshot at least as new as the result arrives, `verifyAction` compares the values. The card becomes **Done — Dream Board shows the change** or **Not changed** with the reason. |

Never possible from the assistant: deleting or merging dreams, changing
anything without a confirmed card, and any write to Service Autopilot,
RingCentral or the Sales Tracker.

## 8. Observability

Every op carries its trace: `captured`, `routed`, `queued` / `waiting` /
`needs_choice`, `sent` (first delivery and every 10th), `acknowledged` /
`rejected`, and `linked_at`. The item page shows one line plus a *Delivery
details* disclosure. Connections shows freshness, the queue (waiting / needs
you) and the app's `last_error` (bad records, a wrong board trying to sync).
Capture contents are never logged. The server logs only error messages.

## 9. Security summary

* **Pairing and tokens.** The pairing code and the token are stored as
  SHA-256 hashes only. The code is single use and expires. Re-pairing revokes
  the old token. Disconnect kills the token. `session_epoch` and the allow-list
  are re-checked on every call.
* **Separate auth paths.** Bearer routes are carved out before the
  cookie/CSRF gate and read no cookies. Cookie routes ignore `Authorization`.
* **Isolation and limits.** All keys start with `user_id`, and results for
  another user's op are ignored. There are per-owner rate limits (sync, files,
  global pairing) and hard caps per request.
* **What the app receives.** Only the op: the owner's words, time, image
  references and a title. No other captures, memories or Google data.
* **What the AI receives.** Only what a tool asks for. Dream Board text is
  wrapped in `<untrusted_app_data>` and treated as data, never instructions.
* **Links.** A canonical link's origin comes only from the owner-confirmed
  address: https, or http on localhost. The app supplies only a path template
  that starts with `/`.

## 10. Adding the next app

1. **Declare it.** Add an entry to `APPS` in `registry.mjs` with its record
   types, capabilities and allowed ops. The Connections card appears.
2. **Publish records.** The app implements pair + sync and publishes records
   of its types. Extend `normalizeRecord` with the new `type` and its fields,
   and teach `diffRecords` which changes count as progress.
3. **Add tools.** Add read tools for its questions and put them in the
   system prompt's source-picking line.
4. **Writes.** Only ops the owner will confirm. Each gets a row in the op
   table above.

| App | Records it would publish | Capabilities | Questions it answers | Writes |
|---|---|---|---|---|
| **ALP Sales Tracker** | `rep` (name, role), `sale` (client, service, amount, rep, date, status), `period_total` (rep, period, revenue, commission) | search, read, events | "How is Zach doing this month?", "What did we sell to the Hendersons?" Joins people by email to the assistant's People. | None this phase (read-only by rule) |
| **Pricing App** | `price` (service, unit, price, effective_from), `quote` (client, lines, total, status) | search, read, events | "What's our fertilizer price per 1k sq ft?" Precedence: Pricing App beats notes and old emails. | Later: draft quote (confirm) |
| **EOS / Traction** | `rock` (owner, due, status), `issue`, `todo`, `scorecard_metric` (week, value, goal) | search, read, events | "Which rocks are off track?", "What did we decide in L10 about routes?" Rocks are goals, so the Dream Board pattern (progress events) carries over. | Later: add to-do / issue (confirm) |
| **GemMasters** | Its domain records (for example `gem`, `order`, `customer`), same shape | search, read, events | Lookups and "what changed this week" | Per its own rules, confirm-first |

Each follows the same sync contract, gets its own project hub
(`asst_projects.source_app`), and shows up in universal search as its own
group. None needs a new table: records go in the mirror, changes in
`asst_events`, work in `asst_app_ops`.
