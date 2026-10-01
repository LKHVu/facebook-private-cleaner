/**
 * autoLoad.ts
 *
 * V3A: loads older Activity Log entries by scrolling the list to its bottom, over and over,
 * until Facebook adds no more rows or a limit is reached. READ-ONLY with respect to Facebook's
 * content: it only moves the scroll position (facebookScroll.ts). It never selects, clicks,
 * opens menus, trashes, archives, changes an audience or deletes anything.
 *
 * Loading and scanning are separate phases. Starting a run discards the current scan session
 * (so no action can use rows mapped before the list changed), holds the shared busy flag and
 * publishes AUTOLOAD_ACTIVE, so every scan and action is refused until the run ends. The popup
 * then runs a completely fresh scan. Nothing from the old scan is carried over.
 *
 * Growth is detected with a MutationObserver on the list region whose callback only schedules a
 * throttled, cheap count of per-row markers (ItemStrategy.markers): no control discovery, no
 * classification, no item mapping. Each observer is disconnected as soon as its wait ends.
 *
 * Stops: the user (after the current scroll/wait iteration), navigation, Activity Log no longer
 * detected, MAX_NO_GROWTH attempts in a row without new rows, MAX_AUTO_LOAD_MS, MAX_AUTO_LOADED_ROWS,
 * or (Load next N / V5 load up to N) the target. The log records counts, attempts, duration and the stop reason only.
 */

import type { AutoLoadRequest, AutoLoadResponse, AutoLoadSnapshot, AutoLoadStopReason } from '../shared/types';
import {
  AUTOLOAD_MAX_MS as MAX_AUTO_LOAD_MS,
  AUTOLOAD_MAX_NO_GROWTH as MAX_NO_GROWTH,
  LOAD_NEXT_ROWS,
  MAX_AUTO_LOADED_ROWS,
  SCANNER_PROTOCOL,
  isAutoLoadActive,
} from '../shared/types';
import * as fba from './facebookActions';
import * as fbs from './facebookScroll';
import * as fb from './facebookSelectors';
import * as fbt from './facebookToolbar';

/** How long one attempt waits for new rows after scrolling. */
const ATTEMPT_TIMEOUT_MS = 5000;
/** Mutations only schedule a count; at most one count per this interval. */
const CHECK_THROTTLE_MS = 200;
/** After growth: wait until the list has been quiet this long (Facebook appends a chunk in several steps)… */
const SETTLE_QUIET_MS = 400;
/** …but no longer than this. */
const SETTLE_MAX_MS = 2500;
/** Pause between the nudge up and the scroll back down after a no-growth attempt. */
const NUDGE_WAIT_MS = 300;
/** How often a wait checks for Stop / navigation / the time limit. */
const ABORT_POLL_MS = 200;
const MAX_NOTES = 10;

export interface AutoLoadDeps {
  /** Exact row count, with the same strategy choice the scan makes. Read-only; maps nothing. */
  countRows(strategy?: string): { strategy: string | null; rows: number };
  /** Discards the current scan session (and anything tied to it) before the list starts changing. */
  discardSession(): void;
}

interface Run {
  snap: AutoLoadSnapshot;
  started: number;
  url: string;
  hadMain: boolean;
  /** The popup's forced strategy, used again for the final exact count. */
  requestedStrategy: string | undefined;
  /** The strategy whose markers are counted while loading. */
  strategy: string;
  /** Marker count when loading started: currentRows = startingRows + (markers now - markerStart). */
  markerStart: number;
  stopRequested: boolean;
}

let run: Run | null = null;

type End = { failed: boolean; reason: AutoLoadStopReason; message: string };

function publish(r: Run): void {
  r.snap.elapsedMs = Math.round(performance.now() - r.started);
  r.snap.updatedAt = new Date().toISOString();
  fba.publishAutoLoad({ ...r.snap, notes: [...r.snap.notes] });
}

function note(r: Run, text: string): void {
  if (r.snap.notes.length < MAX_NOTES) r.snap.notes.push(text);
}

function markerCount(r: Run): number {
  return fb.rowMarkers(r.strategy, fb.getScanRoot(document).root).length;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

// ---------------------------------------------------------------------------
// Stop conditions
// ---------------------------------------------------------------------------

/** Conditions that end a wait early: Stop, navigation / page change, the time limit. */
function interruption(r: Run): End | null {
  if (r.stopRequested) return { failed: false, reason: 'USER_STOPPED', message: 'Loading stopped by user.' };
  const p = fbs.activityLogProblem(r.url, r.hadMain);
  if (p) return { failed: true, reason: p.navigated ? 'NAVIGATED' : 'PAGE_STATE_UNEXPECTED', message: p.why };
  if (performance.now() - r.started >= MAX_AUTO_LOAD_MS) {
    return { failed: false, reason: 'TIME_LIMIT', message: `Stopped at the time limit (${MAX_AUTO_LOAD_MS / 60_000} minutes).` };
  }
  return null;
}

/** Checked before every attempt: interruptions, then the row limits, then "no more rows". */
function endBeforeAttempt(r: Run): End | null {
  const i = interruption(r);
  if (i) return i;
  const s = r.snap;
  if (s.currentRows >= s.maxRows) return { failed: false, reason: 'SAFETY_CAP', message: `Stopped at safety limit: ${s.maxRows} loaded rows.` };
  if (s.targetRows !== null && s.currentRows >= s.targetRows) {
    const asked = s.mode === 'UP_TO' ? `up to ${s.targetRows} rows in total` : `about ${LOAD_NEXT_ROWS}`;
    return { failed: false, reason: 'TARGET_REACHED', message: `Loaded ${s.addedRows} more rows (asked for ${asked}).` };
  }
  if (s.consecutiveNoGrowth >= MAX_NO_GROWTH) return { failed: false, reason: 'NO_MORE_ROWS', message: `No new rows after ${MAX_NO_GROWTH} attempts.` };
  return null;
}

// ---------------------------------------------------------------------------
// Waiting (MutationObserver + timeout; every observer is disconnected when its wait ends)
// ---------------------------------------------------------------------------

/**
 * Resolves 'grew' once grew() is true, 'timeout' after ATTEMPT_TIMEOUT_MS, or 'aborted'.
 * The observer callback does no work itself: it only schedules one throttled grew() check.
 */
function waitForGrowth(root: Element, grew: () => boolean, aborted: () => boolean): Promise<'grew' | 'timeout' | 'aborted'> {
  return new Promise((resolve) => {
    let done = false;
    let check: number | null = null;
    const finish = (result: 'grew' | 'timeout' | 'aborted') => {
      if (done) return;
      done = true;
      observer.disconnect();
      window.clearTimeout(timeout);
      window.clearInterval(poll);
      if (check !== null) window.clearTimeout(check);
      resolve(result);
    };
    const observer = new MutationObserver(() => {
      if (check !== null || done) return;
      check = window.setTimeout(() => {
        check = null;
        if (aborted()) finish('aborted');
        else if (grew()) finish('grew');
      }, CHECK_THROTTLE_MS);
    });
    observer.observe(root, { childList: true, subtree: true });
    const timeout = window.setTimeout(() => finish(grew() ? 'grew' : 'timeout'), ATTEMPT_TIMEOUT_MS);
    const poll = window.setInterval(() => {
      if (aborted()) finish('aborted');
    }, ABORT_POLL_MS);
  });
}

/** After growth: resolves once the list has been quiet for SETTLE_QUIET_MS (at most SETTLE_MAX_MS), or on abort. */
function waitForQuiet(root: Element, aborted: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    let quiet = 0;
    const finish = () => {
      if (done) return;
      done = true;
      observer.disconnect();
      window.clearTimeout(quiet);
      window.clearTimeout(max);
      window.clearInterval(poll);
      resolve();
    };
    const observer = new MutationObserver(() => {
      window.clearTimeout(quiet);
      quiet = window.setTimeout(finish, SETTLE_QUIET_MS);
    });
    observer.observe(root, { childList: true, subtree: true });
    quiet = window.setTimeout(finish, SETTLE_QUIET_MS);
    const max = window.setTimeout(finish, SETTLE_MAX_MS);
    const poll = window.setInterval(() => {
      if (aborted()) finish();
    }, ABORT_POLL_MS);
  });
}

/** While the tab is hidden Facebook may not load anything: wait until it is visible again (or abort). */
function waitUntilVisible(aborted: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      document.removeEventListener('visibilitychange', onChange);
      window.clearInterval(poll);
      resolve();
    };
    const onChange = () => {
      if (!document.hidden) finish();
    };
    document.addEventListener('visibilitychange', onChange);
    const poll = window.setInterval(() => {
      if (!document.hidden || aborted()) finish();
    }, ABORT_POLL_MS);
  });
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

async function loop(r: Run): Promise<End> {
  const s = r.snap;
  const aborted = () => interruption(r) !== null;
  for (;;) {
    const end = endBeforeAttempt(r);
    if (end) return end;

    const root = fb.getScanRoot(document).root;
    const markers = fb.rowMarkers(r.strategy, root);
    if (markers.length === 0) return { failed: true, reason: 'PAGE_STATE_UNEXPECTED', message: 'No Activity Log rows are on the page any more.' };
    const before = markers.length;
    const last = markers[markers.length - 1];

    // Re-discovered every attempt: Facebook may re-render the layout.
    const target = fbs.findScrollContainer(last);
    s.container = target.description;
    s.attempts++;
    if (s.consecutiveNoGrowth > 0) {
      fbs.nudgeUp(target);
      await fba.sleep(NUDGE_WAIT_MS);
    }
    const scrolled = fbs.scrollToBottom(target, last);
    s.scrollTop = scrolled.after.top;
    s.scrollHeight = scrolled.after.height;
    if (s.attempts === 1) note(r, `Scrolling ${scrolled.method}: position ${scrolled.before.top} → ${scrolled.after.top} of ${scrolled.after.height} px.`);
    publish(r);

    const outcome = await waitForGrowth(root, () => markerCount(r) > before, aborted);
    if (outcome === 'grew') await waitForQuiet(root, aborted);

    const now = markerCount(r);
    const growth = now - before;
    s.currentRows = s.startingRows + (now - r.markerStart);
    s.addedRows = s.currentRows - s.startingRows;
    const pos = fbs.readScroll(target);
    s.scrollTop = pos.top;
    s.scrollHeight = pos.height;

    if (growth > 0) {
      s.consecutiveNoGrowth = 0;
      s.lastGrowth = growth;
      publish(r);
      fba.recordAutoLoad('AUTOLOAD_GROWTH', s, `SUCCESS:+${growth} rows, ${s.currentRows} loaded, attempt ${s.attempts}`);
      continue;
    }

    s.lastGrowth = 0;
    if (growth < 0) note(r, `Attempt ${s.attempts}: the row count went down by ${-growth} (Facebook may have re-rendered or unloaded rows).`);
    if (outcome !== 'aborted') {
      if (document.hidden) {
        // Not counted as "no more rows": Facebook may simply not load in a hidden tab.
        s.pageHidden = true;
        publish(r);
        await waitUntilVisible(aborted);
        s.pageHidden = false;
      } else {
        s.consecutiveNoGrowth++;
      }
    }
    publish(r);
  }
}

/** Counts exactly once more, records the outcome and releases the busy flag. Never throws. */
function finish(r: Run, end: End, deps: AutoLoadDeps): void {
  const s = r.snap;
  try {
    if (!end.failed) {
      const c = deps.countRows(r.requestedStrategy);
      if (c.strategy !== r.strategy) note(r, `The final count used strategy ${c.strategy ?? 'none'} instead of ${r.strategy}.`);
      s.currentRows = c.rows;
      s.addedRows = s.currentRows - s.startingRows;
    }
  } catch (e) {
    note(r, `The final exact count failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  s.state = end.failed ? 'FAILED' : 'COMPLETE';
  s.stopReason = end.reason;
  s.stopMessage = end.message;
  s.pageHidden = false;
  publish(r);
  const summary = `${s.currentRows} rows (${s.addedRows >= 0 ? '+' : ''}${s.addedRows}), ${s.attempts} attempts, ${seconds(s.elapsedMs)}`;
  if (end.failed) fba.recordAutoLoad('AUTOLOAD_FAILED', s, `FAILED:${end.reason} ${summary}`);
  else if (end.reason === 'USER_STOPPED') fba.recordAutoLoad('AUTOLOAD_STOPPED', s, `SUCCESS:${end.reason} ${summary}`);
  else fba.recordAutoLoad('AUTOLOAD_COMPLETE', s, `SUCCESS:${end.reason} ${summary}`);
  fba.release();
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Validates, discards the current scan session and starts loading in the background. Answers at
 * once with the first snapshot: progress is read through the action state (FPC_ACTION_STATE).
 */
export function startAutoLoad(req: AutoLoadRequest, deps: AutoLoadDeps): AutoLoadResponse {
  const refuse = (code: Extract<AutoLoadResponse, { ok: false }>['code'], error: string): AutoLoadResponse => ({ ok: false, code, error });

  if (req?.protocol !== SCANNER_PROTOCOL) {
    return refuse('PROTOCOL_MISMATCH', 'The popup and the scanner in this tab come from different builds. Reload the Facebook tab, then try again.');
  }
  if (req.mode !== 'NEXT_N' && req.mode !== 'UNTIL_END' && req.mode !== 'UP_TO') return refuse('UNKNOWN_ACTION', 'Malformed auto-load request.');
  if (req.mode === 'UP_TO' && !(Number.isInteger(req.targetRows) && req.targetRows! > 0)) return refuse('UNKNOWN_ACTION', 'Malformed auto-load request.');
  if (req.strategy !== undefined && typeof req.strategy !== 'string') return refuse('UNKNOWN_ACTION', 'Malformed auto-load request.');
  if (fba.autoLoadBlock()) return refuse('AUTOLOAD_ACTIVE', 'Older entries are already being loaded.');
  const lock = fba.getLockReason();
  if (lock) return refuse('LOCKED', `Actions are locked: ${lock} Reload the Facebook tab to reset.`);
  if (fba.getPendingTrash()) return refuse('TRASH_PENDING', 'A single-post Trash is waiting for confirmation. Confirm or cancel it first.');
  const batchState = fba.activeBatchState();
  if (batchState) return refuse('BATCH_ACTIVE', `A cleanup batch is in progress (${batchState}). Finish or cancel it first.`);
  if (!fb.isActivityLogUrl(location.href)) return refuse('PAGE_STATE_UNEXPECTED', 'This tab is not on the Activity Log.');

  // No selection may be left behind on Facebook while the list changes under it.
  const sel = fbt.readSelection(null);
  const selected = sel.checked.length + sel.mixed.length + (sel.masterState === 'checked' || sel.masterState === 'mixed' ? 1 : 0);
  if (selected > 0) {
    return refuse('SELECTION_PRESENT', `${selected} checkbox(es) on the Facebook page are selected. Unselect them (or reload the Facebook tab) before loading more posts.`);
  }

  const counted = deps.countRows(req.strategy || undefined);
  if (!counted.strategy || counted.rows === 0) {
    return refuse('PAGE_STATE_UNEXPECTED', 'No Activity Log rows were found on the page. Wait until Facebook shows some posts, then try again.');
  }
  const markerStart = fb.rowMarkers(counted.strategy, fb.getScanRoot(document).root).length;
  if (markerStart === 0) return refuse('PAGE_STATE_UNEXPECTED', 'Rows were found, but none of their markers could be counted.');
  if (!fba.tryAcquire()) return refuse('BUSY', 'Another action is still running.');

  // The load phase starts here: the old scan is discarded before anything scrolls.
  try {
    deps.discardSession();
    const now = new Date().toISOString();
    const startingRows = counted.rows;
    const r: Run = {
      snap: {
        runId: crypto.randomUUID(),
        mode: req.mode,
        targetRows:
          req.mode === 'NEXT_N' ? Math.min(startingRows + LOAD_NEXT_ROWS, MAX_AUTO_LOADED_ROWS) :
          req.mode === 'UP_TO' ? Math.min(req.targetRows!, MAX_AUTO_LOADED_ROWS) :
          null,
        maxRows: MAX_AUTO_LOADED_ROWS,
        state: 'LOADING',
        startedAt: now,
        updatedAt: now,
        elapsedMs: 0,
        startingRows,
        currentRows: startingRows,
        addedRows: 0,
        attempts: 0,
        consecutiveNoGrowth: 0,
        lastGrowth: null,
        stopReason: null,
        stopMessage: null,
        strategy: counted.strategy,
        container: '(not yet scrolled)',
        scrollTop: 0,
        scrollHeight: 0,
        pageHidden: false,
        notes: [],
      },
      started: performance.now(),
      url: location.href,
      hadMain: fbs.hasMainRegion(),
      requestedStrategy: req.strategy || undefined,
      strategy: counted.strategy,
      markerStart,
      stopRequested: false,
    };
    run = r;
    publish(r);
    fba.recordAutoLoad('AUTOLOAD_STARTED', r.snap, `SUCCESS:${req.mode}, ${startingRows} rows`);

    loop(r)
      .catch((e: unknown): End => ({ failed: true, reason: 'INTERNAL_ERROR', message: `Loading failed: ${e instanceof Error ? e.message : String(e)}` }))
      .then((end) => finish(r, end, deps));
    return { ok: true, autoLoad: { ...r.snap, notes: [...r.snap.notes] } };
  } catch (e) {
    fba.release();
    return refuse('INTERNAL_ERROR', e instanceof Error ? e.message : String(e));
  }
}

/** Asks the run to stop after its current scroll/wait iteration. Stopping is not an error. */
export function stopAutoLoad(runId: unknown): AutoLoadResponse {
  if (!run || typeof runId !== 'string' || run.snap.runId !== runId) {
    return { ok: false, code: 'NO_AUTOLOAD', error: 'That loading run is not known in this tab (the page may have been reloaded).' };
  }
  if (isAutoLoadActive(run.snap.state)) {
    run.stopRequested = true;
    run.snap.state = 'STOPPING';
    publish(run);
  }
  return { ok: true, autoLoad: { ...run.snap, notes: [...run.snap.notes] } };
}
