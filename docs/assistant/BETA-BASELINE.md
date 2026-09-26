# PERSONAL ASSISTANT — REAL-WORLD BETA BASELINE

The checkpoint the everyday beta starts from. What comes next should be
driven by what you find using the assistant for a few days, not by more
building on speculation.

| | |
|---|---|
| Address | **https://assistant-dev.automatedpest.com/assistant/** |
| Environment | DEVELOPMENT: real account, real data (see [DEV-ENVIRONMENT.md](DEV-ENVIRONMENT.md)) |
| Git | branch `dev` at commit `6e333a7` ("Beta baseline checkpoint…"). The app code is exactly as smoke-tested at `d458189`; the later commits change docs only. To mark it, run on your machine: `git tag -a pa-beta-baseline-2026-09-26 6e333a7 -m "beta baseline" && git push origin pa-beta-baseline-2026-09-26` (this session can push branches but not tags). |
| Vercel | preview deployments of branch `dev` (project automated-commission-tracker). Tested: `dpl_3H4JuPuy8qKJp3WxTXvMG9W1TBjb`, built 2026-09-26 03:35 UTC. |
| Production | not deployed; `main` untouched |

## What is in this baseline

* **Capture, never lost.** Text, voice, photo, file, link, paste and share.
  The phone keeps each capture in its outbox until the server has it, and
  the server saves the raw words before any AI runs.
* **Journal.** Just talk. The entry is kept whole, and the assistant files
  the tasks, ideas and Dream Board items in it. If the AI fails, the entry
  stays saved and is retried automatically.
* **Filing you can check.** *Capture review* (More) shows the raw words next
  to the type, project, people, due date, routing, confidence and reason.
  Tentative wording ("maybe we should…") is never filed as a decision or
  remembered. Unsure filing stays in the Inbox.
* **Today, Inbox, Ask, Dreams, Search, More.** Today and Catch Me Up are
  built only from your real data, with sources. Ask cites every fact.
  Search covers notes, Gmail, Calendar, Drive, Sheets, Contacts and Dream
  Board.
* **Google, read-only.** Gmail, Calendar, Drive/Docs, Sheets and Contacts,
  each with minimal read-only scopes.
* **Dream Board.** *Connect Personal Assistant* is ready on the assistant
  side. The Dreams tab shows real records with how fresh they are, and says
  so plainly when the board is offline or not connected.
* **Beta tools.**
  * More → *Report a problem / Idea*: it lands in your Personal Assistant
    project.
  * *About this build*, and the `DEV · <build>` badge.
  * *Export my data*.
* **Private.** Only `jeff@automatedlawnandpest.com`. Anyone else sees *This
  Personal Assistant is private.*

## Verified before and after deploying

Before pushing (local, synthetic data only):

* **API tests.** 146 tests on real Postgres (PGlite in memory), with made-up
  users. They include:
  * private access: strangers get only the private sentence, no session, no
    user row, `401` on every data endpoint;
  * one sign-in address, and the return to the right screen;
  * no duplicate users from email case or host;
  * no content in logs;
  * Report / Idea, Capture review and export without secrets;
  * backup round trip with photos, paged, skipping orphans;
  * the tentative-wording rules;
  * the journal: never lost, retried while the AI is down, never processed
    twice;
  * the Dream Board Connect flow: allow, deny, expiry, signed-out,
    rollback, sign-out-everywhere;
  * the demo fenced off;
  * tests cannot reach a real database.
* **Browser tests** (Chromium, simulated iPhone 14, Pixel 7, desktop, light
  mode): 30 checks. They include the private sign-in, the return to a Dream
  Board request after sign-in, the DEV/LOCAL badge, About, Report / Idea,
  Capture review, approving a Dream Board connection, and no horizontal
  scroll on an Android-size screen.
* **`npm run check:assistant`**: every file parses, the function loads with
  no environment, no secret or debug/demo code in shipped files, and the
  build step runs.
* **Independent review** (8 agents) of the launch commit. It found:
  * 1 blocker: path-style API routes got a trailing space on Vercel (sign-in
    and Dream Board broken);
  * 4 medium and 7 low findings.

  All are fixed. Each has a regression test that fails on the unfixed code.

After deploying, against the real address (from Vercel's side; this
session's network cannot reach the domain directly):

* `GET /api/assistant/health` → 200:
  `{"env":"development","sha":"d458189","branch":"dev","builtAt":"2026-09-26T03:35:16Z"}`.
  The only setup item missing is the Google OAuth client.
* `GET /api/assistant?r=bootstrap` without a session → `401 signed_out`,
  with an `x-request-id` header.
* `GET /api/assistant/auth/start` → `302` to the sign-in page ("not set up
  yet" until the Google client exists).
* `/assistant/`, `manifest.webmanifest` and `sw.js` (`asst-v5`, `no-cache`)
  → 200 with the CSP and security headers.
* The Sales Tracker's `/api/state` on the dev host → redirected to
  `/assistant/`.
* Runtime logs show one JSON line per request (route, status, ms, request
  id), with no content.
* The first request created the `asst_*` tables in the shared Neon database:
  the connection works and migrations ran.
* The build ran `vercel-build` (stamp `d458189 dev`), and `.vercelignore`
  removed tests, docs and local tools.

## Not verified (needs you)

* **Real Google sign-in** and every Google source (Gmail, Calendar,
  Drive/Docs, Sheets, Contacts). These need the Google OAuth client for the
  dev address (DEV-ENVIRONMENT.md), and then you.
* **Real AI answers, filing and journal** on your data. These need
  `ANTHROPIC_API_KEY`.
* **A physical phone.** Only simulated iPhone/Android screen sizes were
  tested, which is not the same as a real iPhone: Safari, Add to Home Screen,
  the microphone, the camera and share.
* **Seeing the dev address as a stranger.** The protection exception is set,
  but this session couldn't load the page without Vercel credentials. Open it
  on your phone while signed out of Vercel: you should see *Personal
  Assistant — Private. Sign in to continue.*, not Vercel's "Protected
  Page".
* **Dream Board end to end.** The assistant side is live, but Dream Board
  itself doesn't have the Connect button or sync loop yet (see
  DREAM-BOARD-CONNECTOR.md), so the Dreams tab shows *Not connected*.

## First things to try (15 minutes)

1. On your iPhone in Safari, open the address → **Continue with Google** →
   Share → **Add to Home Screen**. Open it from the icon.
2. More → Connections → **Connect all**, and leave every box ticked.
3. Capture one of each:
   * a typed thought;
   * a voice note ("remind me tomorrow at 9 to call Josh");
   * a photo of a receipt;
   * a PDF;
   * a link shared from Safari (Shortcut, see SETUP.md);
   * something pasted.
4. Journal freely for 30 seconds, including one tentative idea ("maybe we
   should…") and one settled decision ("we decided…"). Then check More →
   **Capture review**: the idea is an idea, the decision is a decision.
5. Ask real questions, and check that each answer cites the right source:
   * "What's on my calendar tomorrow?"
   * "What did <a real person> email me about last week?"
   * "Find the <a real sheet> and tell me <a real cell's meaning>."
   * "What's waiting on me?"
6. Today → **Catch me up**. Every line should trace to a real email, event
   or capture.
7. Search for a real client name. It should find results across notes,
   email, files and contacts.
8. Airplane mode: capture two things → back online → they sync, once each.
9. Anything odd → More → **Report a problem**, with what you expected.

## Rollback

* The app: put branch `dev` back to the baseline (`git push origin
  6e333a7:dev --force-with-lease`, or revert the bad commit). The dev address follows the newest `dev` deployment. **Do not use
  Vercel's "Promote"** on a dev deployment: that would make it production.
* Your data: [BACKUP-RECOVERY.md](BACKUP-RECOVERY.md). Never restore the
  shared database's main branch for an assistant problem.
