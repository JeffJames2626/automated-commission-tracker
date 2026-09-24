# Automated Commission Tracker

A single-file sales and commission tracker for Automated Lawn & Pest.
Takes CSV/exports from Service Autopilot and Elevation Advisor and makes it
easy to track sales, invoices, payments, and commissions.

## Files
- `ALP Sales Tracker.html` — the whole app. Open it in a browser.
- `alp-regression-tests.js` — regression tests for the commission/data logic.

## Running the tests
Open `ALP Sales Tracker.html#selftest` in a browser, or call
`ALP_runRegression()` from the console.

## Important
This app stores all data in the browser (localStorage). **Customer data
(backups, CSV/XLS exports) is never committed to this repo** — see `.gitignore`.

## Personal Assistant (`/assistant/`)

A separate, mobile-first app in the same repo and Vercel project: capture
anything in seconds (text, voice, photo, file, link) and ask an AI assistant
about your notes plus connected Gmail, Calendar, Drive, Sheets and Contacts
(read-only), with every answer citing its sources.

- `assistant/` — the PWA (no build step)
- `api/assistant.mjs` + `lib/assistant/` — the API, Google adapters, Claude
- `docs/assistant/SETUP.md` — Google OAuth client + environment variables
- `docs/assistant/ARCHITECTURE.md` — data model, sources of truth, security

```
npm run dev:assistant           # local demo at http://localhost:8787/__dev/login
npm run test:assistant          # API + integration tests
npm run test:assistant:browser  # Chromium end-to-end
```
