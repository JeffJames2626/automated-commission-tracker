# Personal Assistant — setup

The assistant is served from the same Vercel project as the tracker:

* App: `https://<your-domain>/assistant/`
* API: `https://<your-domain>/api/assistant` (one function, `api/assistant.mjs`)

It uses the tracker's existing Neon database (tables prefixed `asst_`, created
automatically on first request).

## 1. Google Cloud: OAuth client

1. Google Cloud Console → **APIs & Services → Library**: enable **Gmail API**,
   **Google Calendar API**, **Google Drive API**, **Google Sheets API**, **People API**.
2. **OAuth consent screen**: choose **Internal** (the automatedlawnandpest.com
   Workspace). Internal apps skip Google's app verification, which the Gmail
   and Drive read-only scopes would otherwise need.
   Add the scopes:
   `openid`, `email`, `profile`,
   `…/auth/gmail.readonly`, `…/auth/calendar.events.readonly`,
   `…/auth/calendar.calendarlist.readonly`, `…/auth/drive.readonly`,
   `…/auth/spreadsheets.readonly`, `…/auth/contacts.readonly`.
3. **Credentials → Create credentials → OAuth client ID → Web application**.
   Authorized redirect URI:
   `https://<your-domain>/api/assistant/auth/callback`
   (add `http://localhost:8787/api/assistant/auth/callback` only if you test real Google locally).

This must be a *new* Web client with a secret. The tracker's existing client ID
is for Google Identity Services sign-in only and is untouched.

## 2. Vercel environment variables

| Variable | Value |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | from step 1.3 |
| `GOOGLE_OAUTH_CLIENT_SECRET` | from step 1.3 — server only |
| `ASSISTANT_TOKEN_KEY` | `openssl rand -hex 32` — encrypts Google tokens at rest. Changing it later forces a Google reconnect. |
| `ASSISTANT_SESSION_SECRET` | `openssl rand -base64 48` — signs session cookies |
| `ASSISTANT_ALLOWED_EMAILS` | `jeff@automatedlawnandpest.com` (comma-separated). If unset, the tracker's admin users may sign in. |
| `ANTHROPIC_API_KEY` | server-side key for Claude. Without it, capture uses rule-based filing and the assistant answers with search results only. |
| `ASSISTANT_MODEL` | optional, default `claude-opus-5` |
| `ASSISTANT_PUBLIC_URL` | recommended: `https://<your-domain>` — pins the OAuth redirect URI |

`DATABASE_URL` is already set for the tracker.

Check setup at `/api/assistant?r=health` (reports missing settings by name,
never values).

## 3. First run

1. Open `/assistant/` on your phone → **Sign in with Google**.
2. **More → Connections → Connect all**. Leave every box ticked on Google's
   screen; anything you untick shows as "Permission not granted" and can be
   connected later.
3. Safari → Share → **Add to Home Screen**.

### Sharing into the assistant

* **Android**: once installed, the app appears in the system share sheet.
* **iPhone**: Safari web apps cannot join the share sheet. Create a Shortcut:
  *Receive Text/URLs from Share Sheet* → *URL-encode* → *Open URL*
  `https://<your-domain>/assistant/?text=<encoded input>`, and enable
  **Show in Share Sheet**.

## Local development

```
npm install
npm run dev:assistant          # http://localhost:8787/__dev/login — demo data, no credentials
npm run test:assistant         # API/integration tests on real Postgres (PGlite), incl. Dream Board
npm run test:assistant:browser # Chromium end-to-end (iPhone + desktop)
```

`ANTHROPIC_API_KEY=… npm run dev:assistant` runs the real AI against demo
Google data. The dev server also pairs an in-memory Dream Board that syncs
every 2 seconds. `/__dev/dreamboard?offline=1` takes it offline,
`?milestone=Fitness` completes a milestone on the board, and
`DEV_DREAMBOARD=0` turns it off.

## Connecting Dream Board

1. Deploy, then open **Connections → Dream Board → Connect**. You get a
   one-time code (10 minutes).
2. Enter the code in Dream Board → Settings → Personal Assistant. Dream
   Board's server needs the assistant's address (your Vercel URL) and
   outbound HTTPS. The assistant never connects to the PC.
3. Optional: under *Address you open it at*, enter the address you use for
   Dream Board (for example your Tailscale `https://…ts.net` name).
   "Open in Dream Board" links use it.

What Dream Board must implement: [DREAM-BOARD-CONNECTOR.md](DREAM-BOARD-CONNECTOR.md).
