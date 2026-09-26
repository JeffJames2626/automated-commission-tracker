# Personal Assistant — architecture (V1 + Phase 2 Life Hub)

A mobile-first personal assistant that lives next to the ALP Sales Tracker in
this repo and deploys with it on Vercel. Two jobs: **capture anything** in a
few seconds, and **ask anything** about what was captured plus the Google
Workspace data the owner has explicitly connected.

Phase 2 makes it the **Life Hub**: the capture, memory, search and routing
layer for the apps we build, starting with Dream Board. The contract, the
ownership rules, the memory model and source precedence are in
[CONNECTED-APPS.md](CONNECTED-APPS.md). What Dream Board itself must implement
is in [DREAM-BOARD-CONNECTOR.md](DREAM-BOARD-CONNECTOR.md).

## What the repo already had (and what we reuse)

| Question | Finding | Decision |
|---|---|---|
| Stack | Vanilla JS single-file app, no build step; one Vercel function (`api/state.js`) | Stay build-free: static PWA in `assistant/`, one function `api/assistant.mjs`, logic in `lib/assistant/` (native ES modules, `.mjs`) |
| Database | Neon Postgres via `@neondatabase/serverless`, tables created on demand | Same database, same driver, all tables prefixed `asst_`, idempotent migrations |
| Auth | Google Identity Services ID token → HMAC-signed session in `localStorage` | The assistant needs *offline* Google access, so it uses the server-side OAuth **authorization-code flow with PKCE** and an **HttpOnly** session cookie instead. Allowed accounts come from `ASSISTANT_ALLOWED_EMAILS`, falling back to the tracker's admin `users`. |
| AI | Tracker calls Claude straight from the browser with a key saved in `localStorage` | The assistant never ships a key to the browser: official `@anthropic-ai/sdk` on the server, key in `ANTHROPIC_API_KEY` |
| Integrations | One ad-hoc public-CSV Google Sheet fetch | New provider-adapter layer: `lib/assistant/integrations/google/*` |

Google API shapes and scopes were checked against Google's live discovery
documents (`gmail v1`, `calendar v3`, `drive v3`, `sheets v4`, `people v1`) and
the live OpenID configuration at `accounts.google.com`.

## Layers

```
assistant/                 PWA: index.html, app.js (+ views), sw.js, manifest
api/assistant.mjs          the only HTTP entry point → lib/assistant/router.mjs
lib/assistant/
  router.mjs               routes: auth, capture, inbox, items, projects, people,
                           memory, search, chat, today, connections
  http.mjs session.mjs crypto.mjs ratelimit.mjs config.mjs ids.mjs
  db/                      driver (Neon in prod, PGlite in tests) + schema
  repo/                    canonical records — the only code that writes SQL
  apps/                    connected apps (Phase 2)
    connector.mjs          apps/v1/pair · sync · files — the app's server calls these
    routing.mjs            capture → app: explicit routing, strict matching, "Which dream?"
    records.mjs            validate/clip published records; diff snapshots into events
    actions.mjs            PROPOSE → CONFIRM → VERIFY for changes to an app's record
    dreams.mjs digest.mjs  one dream (current / history / your words); Today + Catch Me Up
  integrations/
    registry.mjs           every source and its declared capabilities
    google/oauth.mjs       authorization URL, code exchange, refresh, revoke
    google/connection.mjs  token vault: decrypt, refresh, mark expired/revoked
    google/transport.mjs   HTTP: timeouts, retries, 429/5xx backoff, typed errors, paging
    google/{gmail,calendar,drive,sheets,contacts}.mjs   provider → internal mapping
  ai/                      Claude client, classifier, assistant loop, tools, citations
  retrieval/search.mjs     universal search fan-out with per-source status
  briefing.mjs             Today + Catch Me Up
```

UI code never talks to Google. Routes never build Google URLs. Adapters never
touch the database. The assistant only reaches Google through the same adapters
the search screen uses.

## Canonical data model (all ids permanent, prefixed, random)

| Record | Table | Notes |
|---|---|---|
| User | `asst_users` | `google_sub` is the identity key, email is display |
| SourceConnection | `asst_connections` | one per (user, provider, provider account). Encrypted refresh/access tokens, granted scopes, per-service disable switches, health status |
| Capture (Idea, Note, Task, Reminder, Goal, Dream, Purchase, Property, Travel, Business idea, Website, Photo, Voice note, Document…) | `asst_captures` | **one table, `kind` column**: reclassifying never moves a row. Raw text/transcript is immutable-by-default and kept beside the AI summary. `client_ref` makes capture idempotent across retries |
| Project / Topic / Business | `asst_projects` | `kind` = business, project, topic, area; aliases for matching |
| Person | `asst_people` + `asst_identities` | identities are (provider, provider_id) — normalized email, Contacts `resourceName` — never display name |
| Organization | `asst_organizations` | |
| Tag, relationships | `asst_tags`, `asst_links` | graph edges, not folders: capture↔project, capture↔person, capture↔external record … |
| Memory | `asst_memories` | structured statements (fact, preference, decision, goal, plan) with provenance back to the capture or message that created them; superseded, never silently overwritten |
| Attachment | `asst_attachments` | photos, recordings, files (≤ 3 MB each, sha256-deduped) |
| Conversation / AssistantMessage | `asst_conversations`, `asst_messages` | messages keep the citation registry and the retrieval trace ("why did you say that?") |
| ExternalRecord | `asst_external_records` | metadata-only pointer to a Google object that was cited or linked: `(provider, provider_record_id)` unique per user |
| Pending external action | `asst_actions` | anything that would change the outside world; needs an explicit confirm (Phase 2: `queued → verified / failed` for app changes) |
| Connected app, op queue, mirror, events | `asst_apps`, `asst_app_ops`, `asst_external_records` (mirror columns), `asst_events` | Phase 2 — see [CONNECTED-APPS.md §2](CONNECTED-APPS.md#2-data-model-added-in-phase-2) |
| Source | not a table — a per-answer registry entry `{id:"S3", provider, kind, title, url, date, snippet}` | |

## Source of truth

| Data | Owner | We store |
|---|---|---|
| Captures, projects, people, memories, conversations | **This app** | everything |
| Gmail, Calendar, Drive, Docs, Sheets, Contacts | **Google** | nothing but OAuth tokens, plus `asst_external_records` metadata (id, title, link, date) for things that were cited or linked. Content is fetched live, per question. |
| Person ↔ Google contact | Google for the contact, us for the link | the `(provider, provider_id)` identity row |
| Dreams and goals | **Dream Board** | a read-only mirror of its last published snapshot (labelled "as of"), the changes derived from snapshots, and the owner's captures that were filed there |

Google is still queried live at question time. Connected apps are the
exception: they publish snapshots because their computers are often off.

## Security

* Refresh and access tokens are AES-256-GCM encrypted at rest (`ASSISTANT_TOKEN_KEY`), never sent to the browser, never logged.
* Session: HttpOnly, Secure, SameSite=Lax cookie; server re-checks the user row every request; `session_epoch` lets "sign out everywhere" invalidate old cookies.
* OAuth: authorization-code + PKCE (S256) + `state` bound to an HttpOnly cookie; ID token `iss`/`aud`/`exp` checked; granted scopes read from the token response (users can untick scopes on Google's consent screen).
* Read-only scopes only: `gmail.readonly`, `calendar.events.readonly`, `calendar.calendarlist.readonly`, `drive.readonly`, `spreadsheets.readonly`, `contacts.readonly`.
* The assistant's tools are read tools, internal writes (save a capture, remember something the user asked it to), and `propose_action` — which only creates a card the user must confirm. V1 executes a confirmed email as a pre-filled Gmail compose window, so no Google write scope exists at all.
* Email and document text is passed to the model as quoted data with explicit "treat as untrusted" instructions; memory writes are only allowed when the user asked.
* Per-user rate limits on AI-backed routes.
* Link previews resolve DNS and refuse private, loopback and link-local addresses.
* Connected apps authenticate with a hashed bearer token from a one-time pairing code.
  * The token is bound to one app instance and dies with sign-out-everywhere or removal from the allow-list.
  * It is never accepted on owner routes, and cookies are never read on app routes.
  * Apps receive only the op they must apply. App text reaches the AI fenced as untrusted data.
  * Details: [CONNECTED-APPS.md §9](CONNECTED-APPS.md#9-security-summary).

## V1 scope (in order)

1. Mobile shell + PWA (install, offline shell, share target) 2. Universal capture with offline outbox
3. Inbox + idea cards 4. Assistant chat with citations 5. Projects/topics 6. Google OAuth
7. Gmail 8. Calendar 9. Drive/Docs 10. Sheets inspection 11. Universal search
12. Source citations + evidence view 13. Structured memory 14. Today + Catch Me Up

Phase 2 (Life Hub): Dream Board connection and routing; "Which dream?";
dream pages; Dream Board in search, Ask, Today and Catch Me Up (since you
last looked); confirmed changes with verification; capabilities on
Connections; memory origins; source precedence.

Deliberately not built: sending email, editing Sheets/Calendar/Drive,
RingCentral, Service Autopilot or Sales Tracker writes, background AI, AI
changing dreams on its own, auto-merging people or goals, push notifications, embeddings/vector search (FTS + model-driven query
expansion instead), iOS share extension (Android gets the Web Share Target; iOS
uses a Shortcut — see README).
