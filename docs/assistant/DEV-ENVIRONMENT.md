# Personal Assistant — environments and the development deployment

## The three environments

| | LOCAL | DEVELOPMENT (this phase) | PRODUCTION (later) |
|---|---|---|---|
| What | your computer / tests | the real beta you use every day | the finished app |
| Address | `http://localhost:8787/assistant/` | **https://assistant-dev.automatedpest.com/assistant/** | not decided; not deployed |
| Data | synthetic (PGlite in memory, demo Google) | **real**: your captures, your Google, your Dream Board | real |
| Who | anyone running the code | only `ASSISTANT_ALLOWED_EMAILS` | only the allow-list |
| Badge | `LOCAL` | `DEV · <build>` | none |
| Git | any branch | branch **`dev`** | `main` (after a deliberate release) |

Development data is real data. It is not reset, re-seeded or used for
automated tests. Tests run only on in-memory PGlite with made-up users, and
the database driver refuses to connect while tests run (`ASSISTANT_TEST=1`).

## Branch flow

```
claude/… (feature work) ──► dev ──► Vercel preview deployment, served at
                                     https://assistant-dev.automatedpest.com
                              later: dev ──► main ──► production (not in this phase)
```

* This Vercel project deploys **`main` to production** (the Sales Tracker at
  www.automatedpest.com). Pushes to any other branch make preview deployments
  only. The assistant work therefore goes to `dev`, never to `main`.
* The domain `assistant-dev.automatedpest.com` is attached to the project
  with **git branch = `dev`**, so it always serves the latest `dev`
  deployment. It is a stable address (unlike the per-deployment
  `*-<hash>-alp-marko-s.vercel.app` URLs).
* `automatedpest.com` uses Vercel DNS, so the subdomain needed no DNS work.

### Why a custom subdomain (and what protects it)

The project has Vercel Deployment Protection set to *all deployments except
custom domains* (Vercel login + password). Every `*.vercel.app` address,
including the branch alias, is behind it. That would stop the phone PWA
(manifest, service worker) and Dream Board's server from reaching the
assistant. The custom subdomain is outside that protection. The assistant's
own gate protects it instead:

* Google sign-in, then the explicit allow-list (`ASSISTANT_ALLOWED_EMAILS`).
  In development and production an empty list lets **nobody** in (it never
  falls back to the tracker's admin users).
* Anyone else sees only: *This Personal Assistant is private.* No user row is
  created for them, and every data endpoint answers `401`.
* On this host only `/assistant/…` and `/api/assistant…` are served;
  everything else redirects to `/assistant/` (`vercel.json`, host rule). The
  dev address is not a second front door to the Sales Tracker.
* The page itself (HTML/JS/CSS) is public, as for any web app; it holds no data.

## Environment variables (Vercel → Settings → Environment Variables)

All assistant variables for development are scoped to **Preview, git branch
`dev` only**. Production and other previews do not get them.

| Variable | Set by | Notes |
|---|---|---|
| `ASSISTANT_ENV` = `development` | Claude (done) | the DEV badge, and requires the explicit allow-list |
| `ASSISTANT_PUBLIC_URL` = `https://assistant-dev.automatedpest.com` | Claude (done) | sign-in always happens here, so one Google redirect URI |
| `ASSISTANT_ALLOWED_EMAILS` = `jeff@automatedlawnandpest.com` | Claude (done) | comma-separated; case doesn't matter |
| `ASSISTANT_SESSION_SECRET` | Claude (generated, sensitive) | signs the session cookie. Changing it signs everyone out. |
| `ASSISTANT_TOKEN_KEY` | Claude (generated, sensitive) | encrypts Google tokens at rest. Changing it means reconnecting Google (no data lost). |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | **you** | see below. Sensitive. |
| `ANTHROPIC_API_KEY` | **you** | Without it the app works, but capture is filed by simple rules and Ask answers with search results only. Sensitive. |
| `ASSISTANT_DATABASE_URL` | optional | a separate database/Neon branch for the assistant (see Database) |
| `DATABASE_URL` (+ `POSTGRES_*`) | already there (Neon integration) | shared with the Sales Tracker, all environments |

None of these reach the browser. The page gets only the build id and
environment name. Check what's missing (names only, never values):
`https://assistant-dev.automatedpest.com/api/assistant?r=health`.

The existing `GOOGLE_CLIENT_ID` (production only) belongs to the tracker's
own sign-in and is untouched.

## Google OAuth for the dev address (your step)

Google Cloud Console, in the project that owns the automatedlawnandpest.com
Workspace:

1. **APIs & Services → Library**: enable Gmail API, Google Calendar API,
   Google Drive API, Google Sheets API, People API.
2. **OAuth consent screen**: User type **Internal**. Only
   automatedlawnandpest.com accounts can grant access, and the read-only Gmail
   and Drive scopes need no Google verification. Scopes (all read-only):
   `openid email profile gmail.readonly calendar.events.readonly
   calendar.calendarlist.readonly drive.readonly spreadsheets.readonly
   contacts.readonly`.
3. **Credentials → Create credentials → OAuth client ID → Web application**,
   named e.g. "Personal Assistant (dev)":
   * Authorized JavaScript origin: `https://assistant-dev.automatedpest.com`
   * Authorized redirect URI:
     `https://assistant-dev.automatedpest.com/api/assistant/auth/callback`
4. Put the client ID and secret in Vercel as `GOOGLE_OAUTH_CLIENT_ID` /
   `GOOGLE_OAUTH_CLIENT_SECRET` (**Preview → branch `dev`**, Sensitive), and add
   `ANTHROPIC_API_KEY` the same way.
5. Redeploy `dev`: Vercel → Deployments → latest `dev` → Redeploy. A new
   variable only reaches new deployments.

How sign-in behaves:

* **Session.** 30 days, an HttpOnly cookie on assistant-dev.automatedpest.com.
* **Logout.** More → Sign out ends this device. *Sign out on every device*
  ends every session and every Dream Board link.
* **Reconnect.** More → Connections → Connect again. It asks Google for
  consent and replaces the stored tokens.
* **One identity per person.** The user row is keyed by Google's account id,
  and emails are stored in lower case. A different host or a change of email
  case never creates a second account.
* **Other addresses.** Opening the app on another address (e.g. the
  `vercel.app` alias) still signs in at the public URL.

## Database

* **Where.** Development uses the **same Neon database as the Sales Tracker**
  (the only database connected to this Vercel project; `DATABASE_URL` applies
  to every environment).
* **Separation.**
  * The assistant's data lives only in `asst_*` tables, created on first use.
  * The assistant never writes a tracker table.
  * With the allow-list set, it reads none either. The only non-assistant
    query is the old admin-fallback read of `users`, which is off in
    development.
* **Moving the assistant out.** To give the assistant its own database (a
  Neon branch or a new database), set `ASSISTANT_DATABASE_URL` for
  Preview/`dev`. Before switching, restore a backup into it, or the
  assistant will start empty.
* **Tests** never touch it (see above).

Backups and recovery: [BACKUP-RECOVERY.md](BACKUP-RECOVERY.md).

## Diagnostics

* **Server logs** (Vercel → project → Logs, filter `assistant`): one JSON line
  per request, e.g.
  `{"req":"req_3f…","method":"POST","route":"capture","status":201,"ms":812,"user":"usr_…"}`.
  * Errors add `err`, `code`, `at` (file:line) and a scrubbed `msg`.
  * Logs never contain capture text, questions, email, file names, search
    words or tokens.
* **What you see on a failure.** A plain sentence plus *Reference: req_…*
  when the server itself failed. Quote it in **More → Report a problem**.
* **What's running.** **More → About this build** shows the environment,
  commit, branch and deploy time. The same is at `/api/assistant?r=health`.

## Not in this phase

* Production.
* Gmail sending, Calendar writes, and other write scopes.
* RingCentral, Sales Tracker, Service Autopilot, Pricing App and EOS
  integrations.
* Analytics and push notifications.
