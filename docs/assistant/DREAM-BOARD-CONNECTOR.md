# Dream Board side of the connection — handoff

What Dream Board needs, so that captures reach the board and the board's
progress reaches the assistant. The contract itself is in
[CONNECTED-APPS.md §5](CONNECTED-APPS.md#5-the-adapter-contract).
`tests/assistant/fake-dreamboard.mjs` in this repo is a small executable
reference of the server behaviour below. Every rule here is exercised by
`tests/assistant/dreamboard.test.mjs`.

Dream Board's existing rules still apply. The real board is untouched by
tests (use `?workspace=zz-<name>`). Every content change is a pure op in
`lib/ops.ts` through `store.commit`. Entity ids are permanent. Git stays local.

## Status (development launch, 2026-09-26)

**The assistant side is done and deployed to development:**

* the link flow below (`apps/v1/link/start`, `apps/v1/link/poll`, and the
  approve page at `/assistant/#/link?code=…`);
* sync, files and pairing;
* the Dreams tab, freshness and routing.

It is tested against `tests/assistant/fake-dreamboard.mjs`.

**The Dream Board side is not built yet.** Until it is, the Dreams tab
honestly says *Not connected*. Nothing is faked with demo data. The exact
missing piece is items 1–6 below, in the Dream Board repo:

* **Smallest useful slice:** items 1, 2, 3, 4 and 5. Those make the board's
  goals appear in the assistant.
* **Captures filed to a dream reach the board** only once item 6 exists.

Corrections from reading the real Dream Board export (it differs from this
repo's fake board):

* **Status.** Goal `status` is `dream | planned | in_progress | achieved`.
  Send it as is; the assistant already understands `dream`.
* **Money.** Money is one `{target, current}` object in **dollars**. Publish
  it as `fields.target_amount` / `fields.saved_amount` (dollars). For
  `update_goal`, write the whole money object in one merge.
* **Dates.** `targetDate` (YYYY-MM-DD) or `targetYear` → `fields.target_date`
  / `fields.target_year`.
* **Archived.** A goal has no `archivedAt`. It is archived when all its cards
  are archived: publish `status` unchanged, plus `fields.archived: true`.
* **Ids.** Goal ids are `gol_…`. Ids you create for assistant ops must keep
  the board's prefixes (`gol_`, `img_`…). Dream Board's image GC deletes
  images whose ids don't start `img_`.
* **Opening a goal.** There is no route that opens one goal (`?goal=`).
  Until there is, send **no** `link_template`, and the assistant hides
  "Open in Dream Board".
* **Hooks.** Bump the assistant sequence inside the same `store.push` /
  commit that merges the change. Start the poll loop from
  `instrumentation.ts` (the server has no background jobs today).
* **Storage.** Keep `instance_id` and the token in the data dir
  (`~/.dream-board-server/assistant.json`), not in `board.db`. A restored
  `board.db` then keeps the same instance but gets a new epoch, which
  triggers a full resend.

## What to build (server + one settings panel)

1. **Settings → Personal Assistant** (UI): a **Connect Personal Assistant**
   button. The panel shows the state, e.g. *Connected as
   jeff@automatedlawnandpest.com · last sync 2 min ago · 1 waiting*, and has
   *Disconnect*.
2. **Connect** (preferred; server + browser). There's no code to type:
   1. The server POSTs `apps/v1/link/start`:
      `{app: "dreamboard", instance_id, instance_label}`, plus `link_template`
      once a goal route exists. It gets back
      `{device_code, user_code, approve_url, expires_in: 600, interval: 3}`.
   2. The settings page opens `approve_url` in the browser
      (`window.open`) and shows `user_code` ("Check the assistant shows
      CTK6-BGES").
   3. In the browser the owner presses **Continue with Google** (only if not
      signed in), checks the code and presses **Allow**. The token is bound
      to that Google account.
   4. The server polls `apps/v1/link/poll` `{device_code}` every `interval`
      seconds:
      * `pending` → keep waiting;
      * `approved` → the response carries `token`, exactly once;
      * `denied` / `expired` → stop and say so.
   5. Store the token in the data dir, never in the browser or `board.db`.

   Fallback: the typed one-time code (Connections → Dream Board → Connect in
   the assistant, then POST `apps/v1/pair` with `{app, code, instance_id,
   instance_label}`) still works.

   Either way:
   * `instance_id` is a stable random id stored in the data dir, one per
     workspace.
   * A `zz-*` test workspace has its own instance id. Pointing it at the real
     assistant gets `409 wrong_board`, and nothing is drained.
   * The dev server (`~/.dream-board-server-dev`) should not connect to the
     real assistant at all.
   * The development assistant is at
     `https://assistant-dev.automatedpest.com` (all API paths are under
     `/api/assistant/`).
3. **Assistant sequence and epoch** (server).
   * `assistant_seq`: one integer in the server DB. Bump it in the **same
     transaction** as any merged op that changes a goal's published fields,
     milestones, notes, images, category or status, or deletes a goal.
     Presentation-only ops (move, resize, rotate, crop, z-order) don't bump it.
     Store the goal's current value on the goal (`published_seq`).
   * `epoch`: reuse the board's existing epoch. A restore or rollback that
     Dream Board already detects gives a new epoch.
4. **The poll loop** (server). Runs while the server runs.
   * Each tick sends
     `{instance_id, instance_label, epoch, seq: assistant_seq, results, records}`.
     `records` holds goals with `published_seq > since`, in ascending order,
     at most 100, with tombstones for deleted goals.
   * After each response:
     * Store `since`.
     * Drop acked results.
     * Apply the returned ops.
     * Sleep `next_poll_seconds`: 1 while there is more, 15 when active,
       60 when idle.
   * `resync: true` means: remember `start_seq = assistant_seq`, send every
     live goal (pages of 100), and on the last page send
     `backfill: {start_seq, done: true, ids: [all live goal ids]}`.
   * `401` → stop polling and show "Reconnect in Settings".
   * `409 wrong_board` → stop and show the message.
   * Network errors → back off (15 s, 30 s, … up to 5 min) and keep results
     for the next try.
5. **Publishing a goal.** Map Goal + its Milestones, Notes, Images and Category
   to the record in CONNECTED-APPS.md §5.1.
   * Put money and dates in `fields` (`target_amount`, `saved_amount`,
     `target_date`) and any other scalar the board has (e.g. `focus: true`).
   * `field_times[k]` comes from the HLC stamp of that field's last merge.
     This is what lets the assistant say *when* the target changed, even if
     the PC synced days later.
   * Achievement → `status: "achieved"`.
6. **Applying an op.** Apply it as the virtual device "Personal Assistant",
   through `store.commit` like any other device, so sync, conflicts and undo
   work as usual.
   * **Deduplicate.** Look up `assistant_ops(op_id PRIMARY KEY, result JSON,
     applied_at)`. If the op is already there, return the stored result
     unchanged.
   * **Derive ids.** Every entity the op creates gets an id derived from the
     op id (e.g. `pa-<op_id>-goal`, `pa-<op_id>-note`,
     `pa-<op_id>-img-<attachment id>`). A replay after a crash then finds the
     same entity instead of creating a second one.
   * **Download photos first** (`GET <path>` with the bearer token). Check
     `sha256`, then store them write-once like any image.
   * **Commit once.** Commit the op's changes, the `assistant_seq` bump and
     the `assistant_ops` row in **one transaction**.
   * **Which ops:**
     * `create_goal`: a new goal titled `title`, with `note` as its first
       note. Mark it "from Personal Assistant" if the board shows provenance.
     * `attach`: add the note and photos to `goal_id`. Reject with
       `target_missing` if the goal is unknown, `target_deleted` if it is
       deleted.
     * `add_item`: an unsorted board item with the photo(s) and the note as
       its caption.
     * `update_goal`: first compare `expect` with the current values. On any
       difference, reject with `conflict` and change nothing. Otherwise set
       `set`.
     * `add_milestone`: append a milestone with the derived id.
     * Unknown kind → `rejected` / `unsupported`.
   * **Report back.** Queue the result
     `{op_id, status, seq, record, created}` and send it with every poll until
     it is acked.

## What Dream Board must never do

* Send presentation changes as record changes.
* Send data from another workspace.
* Apply an op twice, or apply half of one.
* Overwrite a value the owner changed after the assistant's card was made
  (`expect`).
* Delete, merge or mark a goal achieved because of an assistant op.
  `update_goal` with `status` only happens after the owner confirmed a card
  in the assistant.
* Put the token, codes or capture text in logs.

## Acceptance tests for the Dream Board side

Run them against a `zz-assistant` workspace with a local assistant (the
assistant's `npm run dev:assistant` pairs its own fake board, so turn that
off with `DEV_DREAMBOARD=0` and pair the real zz board instead).

1. Connect Personal Assistant → the browser opens the assistant → Allow →
   Connected within one poll. Don't allow → the board says so and stays
   disconnected. The typed code also works once; the same code again →
   refused.
2. Capture "Dream board: someday a lake house with a dock" on the phone.
   Within one poll the board has a *Lake House* goal whose first note is
   exactly those words. The assistant's item page shows "Saved to Dream
   Board".
3. **Kill the server after the commit but before the next poll** (or drop
   the response). On restart there is still exactly one Lake House, and the
   result is re-sent.
4. Photo capture "add this to my lake house dream" → the image is on Lake
   House, and its bytes match `sha256`.
5. Change the target amount on the board → the assistant's dream page shows
   the new value and "target amount $1.2M → $1.8M" with the edit's time.
6. Move, resize and rotate cards → nothing new appears in the assistant.
7. Complete a milestone → Today shows "1 milestone completed this month", and
   Catch Me Up mentions it.
8. Delete a goal while an attach for it is queued → the attach comes back
   `target_deleted`, and the assistant asks "Which dream?".
9. Restore the board from an older backup → a new epoch, a full resend.
   Goals created after the backup disappear from the assistant (kept as
   missing).
10. Confirm "change Lake House target to $2M" in the assistant, but edit the
    target on the board first → rejected `conflict`. The board keeps your
    value, and the card says "Not changed".
11. Point a `zz-*` workspace at the real pairing → `409 wrong_board`, and
    nothing is drained.
12. "Sign out everywhere" in the assistant → the next poll gets `401`, and
    the board shows "Reconnect".
13. 150 goals changed at once → sent in pages of 100, polling at 1 s until
    caught up.
