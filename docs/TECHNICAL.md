# Facebook Private Cleaner — technical notes (V5)

Scans the currently loaded items in the Facebook Activity Log and classifies each
item's audience as `ONLY_ME`, `FRIENDS`, `PUBLIC` or `UNKNOWN`.

V1A: after a confirmation in the popup, it can select (and unselect) the checkbox of **one**
`ONLY_ME` post. V1B: it can then move **that one selected post** to Facebook's Trash through
the Activity Log's own bulk toolbar, after two separate confirmations. V2A / V2B: a **cleanup
batch** of up to **20** hand-picked `ONLY_ME` posts can be moved to Trash with one bulk Trash
operation. V3A: **Load more posts** scrolls the Activity Log to load older entries (read-only),
then runs a fresh scan. V3B: a **cleanup queue** splits every eligible loaded `ONLY_ME` post into
batches of up to 20 and guides you through them one batch at a time; each batch is still reviewed,
selected and confirmed by you. V4: **Run remaining batches** lets you approve the queue's remaining batches
(at most 100 posts) once; the extension then runs them one verified batch at a time and stops at the first
anomaly. V5: **Clean up private posts** (the tester's default *Simple* mode) chains these into one guided flow
(load → scan → plan → one final approval → V4 run), reusing them unchanged; *Developer* mode keeps every tool. It never deletes permanently, archives, changes audiences, opens menus, uses Select All, trashes
while loading, retries, scrolls during a run, adds posts to an approved run, or works through the account on its own.
No backend, and nothing leaves the browser.

## Build

```bash
npm install
npm run build        # typecheck + build into dist/
```

Load `dist/` in Chrome or Edge as an unpacked extension (`chrome://extensions` → Developer mode → Load unpacked).

## Layout

| Path | Role |
| --- | --- |
| `public/manifest.json` | MV3 manifest (copied into `dist/`) |
| `src/popup/` | React UI. `index.html`: compact popup (tab detection, quick scan, opens the tester). `tester.html`: persistent tester window with the full scan / debug / V1A / V1B UI |
| `src/background/serviceWorker.ts` | Relays messages (`forward.ts` injects the scanner on demand; refuses non-Facebook tabs) and hosts the V4 run |
| `src/background/queueRunner.ts` | **V4 orchestration**: the cleanup run's per-batch loop, stop conditions, safe stop / rollback, pause, worker-restart recovery. Only sends the existing V2B batch steps, toolbar discovery and scans |
| `src/content/scanner.ts` | Content script: runs the scan and decides each item's audience |
| `src/content/facebookSelectors.ts` | **Facebook-specific DOM knowledge**: URLs, audience phrases, item strategies |
| `src/content/facebookControls.ts` | **Facebook-specific control discovery** inside each mapped row (discovery only, never clicks) |
| `src/content/facebookToolbar.ts` | **Facebook-specific discovery** of the bulk toolbar, the selection count and the Trash confirmation dialog (discovery only, never clicks) |
| `src/content/facebookActions.ts` | **Writes, V1A**: safety checks, one checkbox click, verification; also the shared action log, lock and busy state |
| `src/content/facebookTrashAction.ts` | **Writes, V1B**: moves one selected post to Trash (toolbar click, dialog confirm), verification. Exports the toolbar gate, dialog open / re-check / cancel primitives V2A reuses |
| `src/content/facebookBatchAction.ts` | **Writes, V2A / V2B**: the batch state machine: read-only preflight, selecting up to 20 checkboxes with re-render checks and rollback, one bulk Trash, per-post verification, published progress |
| `src/content/autoLoad.ts` | **V3A, read-only**: the auto-load loop (scroll, MutationObserver wait, stop conditions, published progress). Only moves the scroll position |
| `src/content/facebookScroll.ts` | **Facebook-specific** scroll-container discovery and scrolling (`scrollTo` / `scrollIntoView` only) |
| `src/popup/AutoLoad.tsx` | V3A UI: Load next 50 / Auto-load until no more posts, progress, Stop, result |
| `src/popup/ScanHealth.tsx` | V3A UI: aggregate scan diagnostics and the "Items needing review" exception list |
| `src/popup/BatchActions.tsx` | V2A / V2B UI: the extension-side plan ("Add first 20 eligible"), review with live preflight, progress, the two confirmations, results and batch debug. Also runs each V3B queue batch (`QueueLink`) |
| `src/popup/facebookQueue.ts` | **V3B, plan only**: queue eligibility, partitioning into batches of 20, permalink reconciliation, following the V2B batch's outcome, session-only persistence |
| `src/popup/QueueActions.tsx` | V3B UI: Build cleanup queue, batch table, current batch (Review / Skip / Pause / Continue), needs-review list, queue debug. V4: Run remaining batches |
| `src/popup/facebookQueueRun.ts` | **V4, pure**: the run model, the approval snapshot (`planRun`, max 100 posts), plan checks during the run, constants |
| `src/popup/QueueRun.tsx` | V4 UI: approval screen, live run panel (progress, countdown, Stop), paused / stopped / complete views, inspect |
| `src/popup/guidedFlow.ts` | **V5, pure**: the guided flow's states, scan summary counts, run outcome, stop-reason texts, session-only persistence |
| `src/popup/GuidedCleanup.tsx` | V5 UI (Simple mode): Clean up private posts, Steps 1–4, run / finished / stopped screens. Orchestrates V3A, the scan, V3B and V4 only |
| `src/popup/safetyRules.ts` | Pure eligibility / toolbar rules shared by the popup screens and the V4 run (no React) |
| `src/shared/types.ts` | Shared types and message contracts |

`vite.config.ts` builds the popup and service worker. `vite.content.config.ts` builds the
content script as a single IIFE, because injected scripts can't be ES modules.

## Persistent tester

Extension popups close whenever they lose focus. For live testing, click **Open persistent tester** in the
popup (on the Activity Log tab): it opens `popup/tester.html` in a separate window that stays open until you
close it. The tester works on the exact tab it was opened from, never on whichever tab happens to be active.
That tab id (and the tester's window id) are kept in `chrome.storage.session`, and no Facebook content is stored.
If the tab closes or leaves facebook.com, the tester shows **Facebook tab disconnected** and sends nothing
until you click **Reconnect to current Facebook tab**. Opening the tester again focuses the existing window.

## How classification works

1. **Find items.** Several strategies run (`role=article`, `role=listitem`, one row per "…" menu
   button, one row per checkbox, and a fallback of one row per audience icon). Auto mode picks the
   primary strategy with the most items. You can force a strategy in the debug panel.
2. **Collect evidence** in each item:
   - *strong*: `aria-label`, `aria-labelledby`, `title`, `data-tooltip-content`, `alt`, `<svg><title>`
   - *weak*: short visible text fragments (≤ 40 characters)
3. **Match** the evidence against `AUDIENCE_PHRASES`, either as a whole label ("Only me") or wrapped
   in a longer label ("Shared with Only me").
4. **Decide.** Strong evidence beats weak evidence. If every piece of evidence in the winning tier
   agrees, the item gets that audience. If they conflict, the item is `UNKNOWN`, to be safe.

## Control discovery (V0.5, diagnostic only)

For every row the scan mapped, `facebookControls.ts` looks **inside that exact element** for its
selection checkbox, "…" menu button, "View" button, audience indicator and permalink. Each gets
`found`, a `HIGH` / `MEDIUM` / `LOW` confidence, a reason and the signals it was based on. When
several candidates match equally well, it reports the ambiguity and picks none.
The content script keeps the exact elements in the scan session, so the debug panel's
**Highlight checkbox / menu / view / audience** buttons outline them without looking them up
again. Nothing is clicked. Discovery never affects a post's classification.

## Selecting one post (V1A)

For an `ONLY_ME` item decided by strong evidence (an accessibility label) whose checkbox was
discovered with `HIGH` confidence, the item's details offer **Select this post**. It asks for
confirmation first. `facebookActions.ts` then re-checks, on the live page, that the scan is current,
the row and the stored checkbox element are still connected and strictly inside that row, the row
still classifies as `ONLY_ME` from strong evidence, discovery still picks the same checkbox with
`HIGH` confidence and the row still links to the same post, and the checkbox is not the master
"Tất cả" checkbox. Only then does it call the stored element's native `click()`, once.

Afterwards it compares the target, the previous and next rows' checkboxes, the master checkbox and
every other checkbox on the page with their state before the click. Anything unexpected shows a
warning and locks all further actions until the Facebook tab is reloaded. Every attempt is recorded
in an in-memory **Action log** (ids, classification, confidence and result only; no Facebook content).

## Moving one post to Trash (V1B)

After an `ONLY_ME` post was selected with **Select this post**, its details offer **Move this post
to Trash**. The flow uses Facebook's own Activity Log toolbar and stops twice:

1. **Our confirmation** shows privacy, date, preview and permalink, and a live, read-only check of
   the toolbar. **Continue** is only enabled when the toolbar's Trash button is `HIGH` confidence
   and exactly one checkbox is selected.
2. `facebookTrashAction.ts` re-checks everything (V1A's checks, plus: the post has a permalink, this
   extension selected it in this scan, it is still checked, nothing else on the page is selected,
   the toolbar and its Trash button are `HIGH`), clicks the toolbar's Trash button once, and then
   **only discovers** Facebook's confirmation dialog.
3. **Facebook's confirmation** is shown in the popup: the dialog's name and text, its buttons, and
   which one confirms / cancels. **Confirm move to Trash** re-checks everything again and clicks
   Facebook's `HIGH`-confidence confirm button once. **Cancel** clicks Facebook's Cancel button only
   if it is `HIGH` confidence; otherwise you close the dialog yourself.
4. Verification uses the post's permalink: the target row is gone, its link is nowhere on the page,
   every other scanned row (or its re-rendered copy) is still there, nothing is selected, the URL
   is unchanged and the dialog closed. Anything less is `INCONCLUSIVE`.

A scan used for step 3 is retired: nothing more happens until you scan again. Anything unexpected
after a click (no dialog, an unidentifiable dialog, a changed URL, a leftover selection) locks all
actions until the Facebook tab is reloaded.

**Bulk toolbar** in Developer / debug discovers the toolbar on demand (read-only) and can outline
the Trash button with **Highlight Trash**. The toolbar is the smallest ancestor of the master
select-all checkbox that holds buttons for at least two bulk actions and no post row.

## Cleanup batch (V2A)

ONLY_ME rows that qualify (strong audience evidence, `HIGH` unambiguous checkbox, a permalink)
get an **Add to batch** tickbox in the tester's item list. It belongs to the extension, not to
Facebook: ticking it only adds the post to a plan (`DRAFT`), shown in the **Cleanup batch** panel
as `N / 20 selected`. The limit is 20 (V2A: 5); one more is refused. The content script refuses more than 20
too (`BATCH_TOO_LARGE`), never truncating.

1. **Review batch** (`REVIEW`) lists every post with its date, preview and permalink. Nothing on
   Facebook has changed yet.
2. **Select these N posts** (`SELECTING` → `SELECTED`): `facebookBatchAction.ts` first checks
   every item (V1A's checks, plus the reviewed permalink, enabled, unchecked, and nothing on the
   page already selected). If any item fails, no checkbox is touched and each item's result is
   shown. Then it clicks each stored checkbox once, one at a time, verifying after each click
   that the target is checked, earlier targets still are, no non-target row or other checkbox
   changed, the master is not fully checked and the URL is unchanged. On any failure it
   unselects only what this batch selected; if that rollback is incomplete, everything locks
   until the tab is reloaded.
3. **Continue to Facebook confirmation** (`DIALOG_OPEN`) re-checks every item, requires the
   toolbar and its Trash button `HIGH` and exactly N selected (`SELECTED_COUNT_MISMATCH`
   otherwise), clicks Trash once and discovers Facebook's dialog. **Cancel and unselect**
   unselects everything instead (`CANCELLED`).
4. **Confirm move N posts to Trash** (`CONFIRMING` → `VERIFYING`) re-checks the dialog and every
   item once more, clicks Facebook's confirm once, then reports each target as `REMOVED`,
   `STILL_PRESENT` or `UNCERTAIN`, and the batch as `SUCCESS`, `PARTIAL`, `INCONCLUSIVE` or
   `FAILED`. The scan is retired either way: nothing is retried and a rescan is required.

While a batch is `SELECTING` … `VERIFYING`, single-post Select / Trash, new scans and new batches
are refused (in the content script as well as the UI). **Batch debug** shows ids, states,
per-item audience / checkbox / Facebook-selected state, and can outline all batch checkboxes.

## Larger batches (V2B)

The limit is now **20** (`MAX_BATCH_SIZE`), enforced by the tester UI, the popup's request code and
the content script (`BATCH_TOO_LARGE`, never truncated). Every V2A check is unchanged.

- **Add first 20 eligible** adds the currently scanned eligible ONLY_ME posts (the same rules as
  "Add to batch") to the plan, in scan order, up to 20. Posts already in the plan stay. It only
  changes the extension's plan: no Facebook checkbox, no scrolling, no loading of older posts. It
  says how many eligible posts remain outside the batch. Each planned post shows its date,
  preview, audience, evidence and checkbox confidence, and can be unticked; **Clear all** empties it.
- **Review batch** runs a read-only **preflight** (`PREFLIGHT` step) of every post on the live page:
  Ready / Failed, and per group ONLY_ME strong, Checkbox HIGH, Identity unchanged, Currently
  unchecked (an item stops at its first failing check; later groups show as "not evaluated").
  **Select these N posts** is enabled only when all N pass and nothing on the page is selected.
  Failed items are listed with their reason and can be removed from the plan. SELECT runs the same
  preflight again and clicks nothing if even one item fails.
- While a step runs, the content script publishes its **progress** (`SELECTING 7 / 18, current
  item-14`, `UNSELECTING`, `OPENING_DIALOG`, `VERIFYING 11 / 18`) and the tester polls it. Display only.
- **Re-rendering**: after every selection click, every target must still pass the full target
  validation with the same row and stored checkbox element, and every mapped row that was on the
  page when selection began must still be there. Otherwise the selection stops and is rolled back;
  a rollback that can't be verified locks all actions until the tab is reloaded. Targets are never
  re-found by text.
- **Master select-all**: unchecked or indeterminate is fine; fully checked at any point stops,
  rolls back and returns `MASTER_FULLY_SELECTED`, even if every loaded row is a target. The review
  warns when every loaded row is in the batch.
- **Toolbar**: Continue still needs the toolbar and its Trash button `HIGH` and exactly N checked
  checkboxes. Facebook's own "N selected" text, if found in the toolbar, is shown as a diagnostic only.
- **Verification** reads every link on the page once. The target's normalised permalink is its
  identity. `STILL_PRESENT`: the link is anywhere on the page (even in a re-rendered row).
  Otherwise, if the original row element is gone, or is still connected but no longer represents
  the target, the post is `REMOVED`, provided its nearest non-target neighbours are still listed
  (else `UNCERTAIN`: it looks like virtualization). A still-connected row is classified from its
  links and controls, never its text: `DIFFERENT_POST` (it links post URLs, none of which the
  target row had at scan time: Facebook recycled the row), `STALE_SHELL` (no post link and no
  checkbox / audience / View / menu control), `SAME_TARGET`, or `UNKNOWN` (still post-like with no
  link, or one of the target's scan-time links remains), which stays `UNCERTAIN`. **Target
  verification details** in the result shows every signal per target. Nothing is retried.
- **Action log**: item ids are listed once per batch (`BATCH_CREATED`); other entries give counts,
  state changes (`BATCH_STATE`) and the failing item id. No permalinks, no post text.

## Loading older posts (V3A)

**Load more posts** (tester, next to Scan) loads older Activity Log entries so they don't have to be
scrolled in by hand. It only scrolls: nothing is selected, clicked, trashed, archived or changed.

- **Load next 50** aims for about 50 more rows (`LOAD_NEXT_ROWS`; stopping a little above is normal,
  Facebook loads in chunks). **Auto-load until no more posts** keeps going until a stop condition.
- Loading and scanning are separate phases. Starting discards the current scan session (content
  script and tester) and the batch plan. It is refused while a checkbox action runs, a Trash waits
  for confirmation, a batch is `SELECTING` … `VERIFYING`, actions are locked, or any checkbox on the
  page is selected. While loading, Scan, V1A / V1B, batch creation / review and highlights are refused
  in the content script and disabled in the tester ("Facebook is currently loading older Activity Log entries.").
- Each attempt: count the rows (a cheap per-row marker of the scan's own row strategy:
  `ItemStrategy.markers`, no control discovery, no item mapping), scroll the scroll container to its
  bottom, then wait with a `MutationObserver` on the list region (its callback only schedules a
  throttled count) for up to 5 s. Growth → wait until the list is quiet, record it, continue. No
  growth → one no-growth attempt; the next attempt first scrolls up half a screen, then back down.
  Every observer is disconnected when its wait ends.
- The scroll container is the nearest ancestor of the last row that actually scrolls vertically,
  otherwise the document (`facebookScroll.ts`). Scrolling uses `scrollTo` (or `scrollIntoView` of the
  last row if the container can't scroll); no synthetic wheel / pointer events.
- Stops: **Stop loading** (after the current scroll/wait iteration), navigation, Activity Log no longer
  detected, no new rows after 3 attempts in a row (`AUTOLOAD_MAX_NO_GROWTH`), 10 minutes
  (`AUTOLOAD_MAX_MS`), **500 loaded rows** (`MAX_AUTO_LOADED_ROWS`), or the Load-next target. While the
  Facebook tab is hidden, no-growth attempts are not counted (Facebook may not load in a hidden tab).
- Progress (`IDLE` / `LOADING` / `STOPPING` / `COMPLETE` / `FAILED`, starting / current / added rows,
  attempts, no-growth streak, last growth, elapsed, stop reason, scroll container and position) is
  published in the action state and polled by the tester. At the end the rows are counted exactly
  once more.
- When loading stops (finished or stopped by you) the tester runs one completely fresh scan (new
  `scanSessionId`, nothing merged, no old item ids), unless **Scan automatically when loading stops**
  is unticked. A failed run (navigation, page changed, error) is not followed by an automatic scan.
- **Scan health** shows rows, audiences, strong vs weak/unknown evidence, Checkbox / Menu HIGH and
  permalinks as totals, and **Items needing review** lists only rows with an UNKNOWN audience, weak
  evidence, a checkbox or menu that isn't HIGH, an ambiguous control or permalink, or no permalink.
- Action log: `AUTOLOAD_STARTED`, `AUTOLOAD_GROWTH`, `AUTOLOAD_STOPPED`, `AUTOLOAD_COMPLETE`,
  `AUTOLOAD_FAILED` with row counts, attempts, duration and stop reason only.

## Cleanup queue (V3B)

The **Cleanup queue** panel (tester, above Cleanup batch) plans the cleanup of every eligible post that is
*already loaded*. It never loads, scrolls, selects or trashes by itself, and there is no "run all".

- **Build cleanup queue** takes every post of the current scan that V2B could batch (ONLY_ME from strong
  evidence, HIGH unambiguous checkbox, a permalink, valid data), that Scan health does not list under
  *Items needing review*, and whose permalink no other row has. In scan order, it splits them into
  batches of at most 20 (`Batch 1: 20 … Batch 6: 11`), with deterministic keys `queueId:N`.
  **Only the first N eligible posts** (optional) limits it for testing. Building touches nothing on Facebook.
- One batch is current. **Review batch** hands its posts to the V2B **Cleanup batch** panel as a plan in
  review, whose live preflight runs at once (Ready / Failed, ONLY_ME strong, Checkbox HIGH, Identity
  unchanged, Currently unchecked). Failed posts can be removed from *that* batch; no post from a later batch
  takes their place. From there every Facebook step is V2B's, unchanged: **Select these N posts**, the toolbar
  check, **Continue to Facebook confirmation**, **Confirm move N posts to Trash**, verification.
- The queue follows the V2B batch's own state (`SELECTING` … `SUCCESS` / `PARTIAL` / `INCONCLUSIVE` /
  `FAILED`; `CANCELLED` makes the batch ready to review again with a new V2B batch id) and records each
  post's verified outcome.
- After a **SUCCESS** the queue waits (`BATCH_DONE`): **Continue to batch N** runs a completely fresh scan,
  reconciles, and makes batch N current. It is not selected: you review it again. After the last batch the
  queue is `COMPLETE`.
- **Reconciliation** matches every still-planned post by its normalised permalink only (never by text) and
  gives it the new scan's item id. Not found: `MISSING`; no longer ONLY_ME: `CHANGED`; found but no longer
  eligible, or in several rows: `NEEDS_REVIEW`. Such posts stay out of every batch; the batch shows
  *Needs review* until you remove them from it (or skip it). The partitioning never changes.
- **PARTIAL / INCONCLUSIVE / FAILED** stop the queue ("Queue paused because Batch 3 was INCONCLUSIVE."):
  **Rescan and reconcile** (then **Resume queue** moves on to the next batch) or **Stop queue**. Posts not
  verified removed are `UNCERTAIN` (or `NOT_REMOVED` if Trash was never confirmed) and are never retried.
- **Pause queue** / **Resume queue** (only while no V2B batch is selecting or trashing); **Skip batch** only
  before selection started (its posts stay listed as `SKIPPED`, not re-added).
- **Stale**: a new scan, a different or reloaded / navigated / closed Facebook tab, a reopened tester (no
  scan), or a Trash that used the mapped scan make the queue `STALE`: its item ids are not used until
  **Rescan and reconcile queue**. A tab reload during a batch makes that batch `INCONCLUSIVE`.
- While a queue is open, **Load more posts** and hand-picked batches are unavailable; **Discard queue**
  (nothing selected, no batch step running) re-enables them.
- Stored in `chrome.storage.session` only (`fpc:cleanupQueue`, `fpc:cleanupQueueLog`): queue id, tab id,
  normalised permalinks, partitioning, statuses, current item ids, counts and timestamps. No post text.
  It survives closing the tester, not a browser / extension restart.
- **Queue debug**: ids, built-from / mapped / current scan, per-batch planned / reconciled / invalid counts,
  **Highlight current batch**, **Copy queue debug JSON** (no post text). The action log also lists
  `QUEUE_CREATED`, `QUEUE_BATCH_REVIEWED`, `QUEUE_BATCH_STARTED`, `QUEUE_BATCH_SUCCESS` / `_PARTIAL` /
  `_INCONCLUSIVE` / `_FAILED`, `QUEUE_RECONCILED`, `QUEUE_PAUSED`, `QUEUE_RESUMED`, `QUEUE_COMPLETE` (and
  skipped / stale / stopped / discarded) with counts only.

## Run remaining batches (V4)

An optional layer on top of the cleanup queue: manual queue processing works exactly as before.

- On a `READY` / `PAUSED`, non-stale queue, **Run remaining batches** (or **Run first N posts** when more
  than `MAX_AUTORUN_POSTS` = 100 remain) opens an approval screen: remaining posts / batches, what this run
  covers (whole batches only, never truncated silently), every stop condition, and that posts go to
  Facebook's Trash. Nothing starts until you press **Run N remaining batches**.
- Approval snapshots each approved batch's key and the normalised permalinks of its planned posts. The run
  may act on exactly those. Posts later scans discover are never added; a batch is never refilled, skipped
  or re-ordered. The background worker refuses to start if the stored queue differs from the snapshot.
- The run lives in the **background service worker** (`queueRunner.ts`), so focusing Facebook or another
  window does not stop it, and the tester can be closed and reopened (it rebuilds the run panel from
  `chrome.storage.session`). While a run owns the queue the worker is its only writer; every other action in
  the tester (scan, Load more posts, V1A / V1B, hand-picked batches, queue buttons) is disabled.
- Per batch: checks (tab, URL, lock, no other batch / pending Trash / loading, Facebook **visible**, queue
  mapped to the latest scan, batch exactly as approved) → V2B `PREFLIGHT` (every post must pass) → V2B
  `SELECT` (exact selection counts required) → read-only toolbar check (HIGH toolbar and Trash, exactly N
  selected, select-all not fully checked) → V2B `OPEN_DIALOG` (confirm **and** Cancel must be HIGH) → a
  3-second countdown with **Stop run** → V2B `CONFIRM` (one click; V2B re-checks everything first and
  verifies every post) → only `SUCCESS` continues → fresh scan → V3B reconcile by permalink → every remaining
  approved post must still be `PLANNED` → `BETWEEN_BATCH_DELAY_MS` (2500 ms) → next batch.
- Anything else stops the whole run at once: never retried, never skipped over. The batch is rolled back
  where it safely can be (Facebook's HIGH Cancel, then V2B's verified unselect). The panel shows the batch,
  the reason (e.g. `BATCH_INCONCLUSIVE`), removed-before-stop, and **Inspect problem** / **Rescan and
  reconcile** / **End run**.
- **Stop run**: before selection, between batches or during a read-only step, stops at once (after that
  step); during selection / opening the dialog / the countdown, never clicks confirm, cancels the dialog and
  unselects; once confirm was clicked, finishes the verification first.
- **Same-tab reloads.** Facebook may reload the Activity Log after a bulk Trash. A reload of the *same*
  Activity Log page (same tab; facebook.com, `/allactivity`, same `category_key`; `/me/` → `/<id>/`, a
  trailing slash or re-ordered parameters are fine) is only recorded when Chrome reports it; the run decides:
  after the batch's verified SUCCESS (N of N) was accepted it waits for the tab to finish loading and stay
  loaded (up to 30 s), takes the reloaded URL as the new baseline for its exact URL checks, rescans
  (injecting the scanner like a normal scan), reconciles, and continues only if that is clean — once per batch
  boundary. Before the final confirm, or while the Trash outcome is not yet verified, it stops
  (`TAB_RELOADED`, uncertain where Facebook's state is unknown). A closed / replaced / discarded tab, or a
  URL off that Activity Log page, still stops it at once. While a run owns the queue, a same-page reload never
  marks the queue stale (neither the tester's V3B handler nor the worker); only a run that then stops does.
  **Run debug** shows the reload fields; the log adds `RUN_RELOAD_DETECTED` (when Chrome reports it),
  `RUN_RELOAD_RECOVERY_STARTED` and `RUN_RELOAD_RECOVERED` (after the clean reconcile).
- **Build check.** Chrome keeps an already-running service worker after `dist/` is rebuilt until the extension
  is reloaded. The tester compares its build with the worker's, warns on a mismatch, and a run refuses to
  start with one.
- **Lost final-confirm answer.** Before the CONFIRM request is sent, the run stores (session storage) the
  batch id, its approved target permalinks with each target's scan-order neighbours, the expected count and
  the send time. If no answer arrives and the same tab reloads the same Activity Log page (reload seen before,
  or within 3 s after, the lost answer), Confirm is **never sent again**: the run waits for the page, then
  uses the old page's own V2B result if it survived, otherwise a fresh scan: a target whose permalink is
  still listed is `STILL_PRESENT`; absent while its neighbours (at least the next post) are listed is
  `REMOVED`; anything else `UNCERTAIN`. All N removed with nothing selected on the reloaded page = SUCCESS
  ("response lost, verified after reload") and the run continues; otherwise it stops with the counts. A lost
  answer without such a reload is still `NO_RESPONSE`. A worker restart in this phase verifies the same way
  and ends the run as interrupted. The log adds `RUN_CONFIRM_RESPONSE_LOST`, `RUN_POST_CONFIRM_VERIFIED`,
  `RUN_RESTART_DURING_CONFIRM`.
- If the Facebook tab is not visible (inactive tab, minimized window, or the page reports hidden), the run
  **pauses before the next batch** (nothing selected); **Resume** rescans and reconciles first.
- After a stop, continuing needs a fresh **Rescan and reconcile** and a new approval; the old approval never
  carries over. A worker restart mid-run marks the run **interrupted** (uncertain if it was in a write step);
  nothing is clicked or resumed automatically.
- Stored in `chrome.storage.session` (`fpc:queueRun`): ids, approved permalinks, counts, states, stop
  reasons, timestamps. No post text (the run's scans are handed to an open tester by message only). The
  action log adds `RUN_APPROVED`, `RUN_STARTED`, `RUN_BATCH_STARTED`, `RUN_BATCH_SUCCESS`, `RUN_RESCAN`,
  `RUN_RECONCILED`, `RUN_PAUSED`, `RUN_RESUMED`, `RUN_STOPPED`, `RUN_FAILED`, `RUN_COMPLETE` with the run id,
  counts and elapsed time; the V2B batch entries stay underneath.
- Scanner protocol 11: the action state reports page visibility. Reload the Facebook tab after updating.

## Guided cleanup (V5)

The tester opens in **Simple** mode (switch at the top; the choice is remembered in `localStorage`).
**Developer** mode is the full V0–V4 tester, unchanged. Both modes share the same scan, queue and run, so
switching never starts, stops or changes anything.

**Clean up private posts** (never deletes anything by itself). On a freshly loaded Activity Log (page or
extension just reloaded) the scanner is not injected yet; that alone does not disable the button (such a page
has no lock, batch, pending Trash or loading run). Step 1 then shows **Initializing scanner…**: one fresh
read-only scan through the normal Scan posts request, which injects the scanner, and gives the loaded count.
If it fails: **Could not initialize Facebook scanner** with **Try again**. A wrong page, a disconnected tab, a
lock, an active batch / load / pending Trash or a running cleanup still disable it.

1. **Find older posts** — the current row count (a read-only scan), then: current loaded posts only, load
   up to 250, up to 500 (`MAX_AUTO_LOADED_ROWS`), or until Facebook stops returning posts. Loading is V3A
   (new `UP_TO` mode with `targetRows`); **Stop** keeps what is loaded. When loading stops, the ordinary
   fresh scan runs automatically.
2. **Scan complete** — scanned / Only me / Friends / Public / Unknown, strong evidence, controls HIGH
   (checkbox and menu), needs review (Scan health's rules). **Review exceptions** lists them; they are
   never planned.
3. **Cleanup plan** — a V3B queue (`buildQueue`) of every eligible `ONLY_ME` post (V3B `queueEligible`),
   capped at `MAX_AUTORUN_POSTS` = 100; the batch sizes, "moved to Trash, NOT permanently deleted", and the
   excluded count. With more eligible posts: "This run can clean the first 100 posts. N posts will remain
   for another cleanup run." and **Run first 100** (never truncated silently). **Limit this run** (testing)
   rebuilds the plan from the same scan with "only the first N". Nothing on Facebook is selected yet.
4. **Final approval** — "Move N private posts to Trash?" with audience (`ONLY_ME` only), evidence (strong
   only), batches (e.g. `5 × 20`), and the run's behaviour. This button is the approval of the V4 run
   (`FPC_RUN_START` with `planRun`'s snapshot; the worker re-checks it against the stored queue).

The run screen shows overall progress, batch N / M and the current step in plain words ("Selecting 8 / 20",
the confirm countdown); **Show technical details** opens the V4 run debug. **Cleanup finished** shows moved /
failed / uncertain / need review and the eligible posts still loaded (from the run's final scan);
**Clean remaining N** always rescans and builds a **new** plan (a finished run's mapping is never reused),
**Load older posts** returns to Step 1, **Done** ends. **Cleanup stopped** shows removed-before-stop,
remaining planned, the reason in words plus the V4 code and detail, "No action will be retried
automatically", and **Inspect problem** / **Rescan and reconcile** (V3B reconcile) / **End cleanup**. Posts a
stopped run left `UNCERTAIN` (or every not-removed post of the batch it stopped in, when the stop was
uncertain) are left out of every later plan of the same guided cleanup.

Session persistence: `chrome.storage.session` (`fpc:guidedFlow`) holds the step, load choice, ids, limit,
per-run removed counts and uncertain permalinks — no post text. A reopened tester restores the step: loading
and the run are re-read from the Facebook tab / the worker; a lost scan or plan is never reused ("Scan
again" rebuilds it); a restored final-approval screen goes back to the plan; an active V4 run (also one started
in Developer mode) is shown; a paused run resumes only from its **Resume** button; an interrupted run shows as
stopped. A browser or extension restart clears everything. Scanner protocol 12 (the `UP_TO` load mode):
reload the extension and the Facebook tab after updating.

## When Facebook changes its DOM

Open the popup → **Developer / debug**:
- **Strategy attempts** shows how many items each strategy found.
- Each item lists its evidence, the rule that fired, and every label inside it.
- **Label inventory** lists the most common label strings on the page.
- **Copy full result as JSON** copies everything for offline inspection.

Then update `AUDIENCE_PHRASES`, `SHARED_WITH_PATTERNS` or `ROW_MENU_LABEL_RE` in
`facebookSelectors.ts`, or `MENU_LABEL_PREFIXES` / `VIEW_PHRASES` in `facebookControls.ts`.
Every V1B string (toolbar action names, dialog confirm / cancel / close names, Trash and
permanent-delete wording) is in the "Bulk toolbar and Trash dialog vocabulary" block of
`facebookSelectors.ts`.
Each item's **Controls in this row → Interactive elements** list shows the role, accessible name and
aria-* signals of every button and link in the row.
