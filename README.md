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
