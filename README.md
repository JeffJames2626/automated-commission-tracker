# Automated Commission Tracker

A single-file sales and commission tracker for Automated Lawn & Pest.
Takes CSV/exports from Service Autopilot and Elevation Advisor and makes it
easy to track sales, invoices, payments, and commissions.

## Files
- `ALP Sales Tracker.html` — the whole app. Open it in a browser.
- `alp-regression-tests.js` — regression tests for the commission/data logic.
- `api-projection-tests.js` — tests that the *server* withholds what a person's
  job does not cover, and refuses to let them write back what it never sent.

## Performance Score
The win / strike / major-loss ledger lives on the canonical Employee — it is a
section of the existing employee profile and a **Standings** page, not a second
employee system. Three things to know:

- The score is **derived** on every read (`baseline + un-voided events in the
  period`). No current score is stored anywhere, so the number and the ledger
  under it cannot disagree.
- Events are **append-only**. Points are copied onto the event when it is
  written, so re-pricing a rule never rewrites history, and a mistake is
  **voided with a reason** — never deleted.
- ALP's baseline, bands and rule catalog are **company configuration**, not
  constants in the code. `perfSeedCatalog()` loads ALP's 27 workbook rules as a
  one-time admin action.

Naming: this app already uses *Scoreboard* for sales production against the comp
standard, and reserves *Scorecard* for the EOS weekly KPI feature. This is a
third thing, so it is **Performance Score** throughout (`PERF_UI_NAME`).

## Running the tests
Open `ALP Sales Tracker.html#selftest` in a browser, or call
`ALP_runRegression()` from the console.

## Important
This app stores all data in the browser (localStorage). **Customer data
(backups, CSV/XLS exports) is never committed to this repo** — see `.gitignore`.
