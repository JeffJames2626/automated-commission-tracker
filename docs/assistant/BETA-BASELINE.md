# PERSONAL ASSISTANT — REAL-WORLD BETA BASELINE

The checkpoint the everyday beta starts from. What comes next should be
driven by what you find using the assistant for a few days, not by more
building on speculation.

| | |
|---|---|
| Address | **https://assistant-dev.automatedpest.com/assistant/** |
| Environment | DEVELOPMENT: real account, real data (see [DEV-ENVIRONMENT.md](DEV-ENVIRONMENT.md)) |
| Git | branch `dev` @ `{{SHA}}`, tag `pa-beta-baseline-2026-09-26` |
| Vercel | preview deployment `{{DEPLOYMENT}}` (project automated-commission-tracker), built {{BUILT}} |
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

{{VERIFIED}}

## Not verified (needs you)

{{NOT_VERIFIED}}

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

* The app: put branch `dev` back to the tag (`git push origin
  pa-beta-baseline-2026-09-26:dev --force-with-lease`, or revert the bad
  commit). The dev address follows the newest `dev` deployment. **Do not use
  Vercel's "Promote"** on a dev deployment: that would make it production.
* Your data: [BACKUP-RECOVERY.md](BACKUP-RECOVERY.md). Never restore the
  shared database's main branch for an assistant problem.
