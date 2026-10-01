/**
 * queueRunner.ts
 *
 * V4 "Run remaining batches": the orchestration, in the background service worker so it does not
 * depend on the tester window being focused, visible or even open. It adds no way of touching
 * Facebook: every Facebook step is the V2B batch step the Cleanup batch panel sends
 * (FPC_BATCH: PREFLIGHT, SELECT, OPEN_DIALOG, CONFIRM, and CANCEL_DIALOG / UNSELECT to roll back),
 * the read-only toolbar discovery, and the ordinary scan. Every queue change is a V3B function
 * (startReview, recordPreflight, syncFromSnapshot, reconcile, endReview, markStale).
 *
 * Per approved batch:
 *   PREPARING → PREFLIGHTING → SELECTING → (toolbar check) → OPENING_DIALOG → COUNTDOWN →
 *   CONFIRMING → VERIFYING → RESCANNING → RECONCILING → ADVANCING → next batch
 * Any refusal, anomaly or non-SUCCESS outcome throws RunHalt: the run stops at once (never
 * retried, never skipped over), the current batch is rolled back where it can be (Facebook's
 * dialog cancelled, its checkboxes unselected), and the run ends FAILED (or STOPPED for Stop).
 *
 * Same-tab reloads: Facebook may reload / recreate the Activity Log document after a bulk Trash.
 * Chrome's tab events only record such a reload (Driver.reload); the run decides where it can act on
 * it. After the current batch's verified SUCCESS (N of N, accepted below as verifiedBatchId), a
 * reload of the same Activity Log is part of the normal post-batch rescan: wait for the tab, fresh
 * scan (injecting the scanner as a normal scan does), reconcile, continue only if clean
 * (toNextBatch / recoverFromReload, once per batch boundary). Before Facebook's final confirm, or
 * while the Trash outcome is not verified, it stops the run (TAB_RELOADED). A closed / replaced /
 * discarded tab, or a URL off the approved Activity Log page, still stops it at once.
 *
 * A lost final-confirm answer: the CONFIRM request is recorded in session storage before it is sent
 * (RunConfirmRecord). If its answer never arrives and the same tab reloads (within
 * CONFIRM_RELOAD_GRACE_MS either way round), the outcome is decided by looking at Facebook after the
 * reload (verifyLostConfirm): the old page's own V2B result if it survived, otherwise a fresh scan
 * checking each approved target's permalink, guarded by its neighbours. Confirm is never sent twice:
 * no code path sends CONFIRM for a batch whose record exists, and a restarted worker only verifies.
 *
 * While a run owns the queue (runOwnsQueue) this worker is the only writer of the queue, its log
 * and the run (chrome.storage.session); the tester only displays them. Post text (the scans) stays
 * in memory and is handed to an open tester by message, never stored.
 */

import type {
  ActionState,
  ActionStateResponse,
  BatchRequest,
  BatchResponse,
  BatchItemOutcome,
  BatchSnapshot,
  BatchState,
  BatchStep,
  BatchTrashVerification,
  PopupRequest,
  RunApprovedBatch,
  RunBroadcast,
  ScanResponse,
  SimpleResponse,
  ToolbarDiscovery,
  ToolbarResponse,
} from '../shared/types';
import { SCANNER_PROTOCOL, isAutoLoadActive, isBatchActive } from '../shared/types';
import { isActivityLogUrl } from '../content/facebookSelectors';
import { BUILD_ID } from '../shared/build';
import {
  QUEUE_KEY,
  QUEUE_LOG_KEY,
  appendLog,
  currentBatch,
  endReview,
  loadQueue,
  markStale,
  normalizePermalink,
  queueBatchTargets,
  reconcile,
  recordPreflight,
  resumeQueue,
  startReview,
  summarize,
  syncFromSnapshot,
  type Change,
  type CleanupQueue,
  type QueueLogEntry,
} from '../popup/facebookQueue';
import {
  BETWEEN_BATCH_DELAY_MS,
  CONFIRM_COUNTDOWN_MS,
  CONFIRM_SENT_STATES,
  PRE_CONFIRM_STATES,
  RUN_KEY,
  WRITE_STATES,
  approvedBatchProblem,
  elapsedMs,
  isRunEnded,
  loadRun,
  newRun,
  planRun,
  resumeNeedsReconcile,
  runOwnsQueue,
  sameActivityLog,
  sameApproval,
  type ConfirmTarget,
  type QueueRun,
  type RunConfirmRecord,
  type RunState,
  type RunStopReason,
} from '../popup/facebookQueueRun';
import { normalizeResult, type SafeResult } from '../popup/normalize';
import { toolbarReady } from '../popup/safetyRules';
import { forward } from './forward';

/** Countdown / cooldown granularity: how quickly Stop takes effect while waiting. */
const TICK_MS = 250;
/** Keeps the service worker alive while a run is active (an extension API call resets its idle timer). */
const KEEPALIVE_MS = 20_000;
/** A same-tab reload after a verified SUCCESS: how long the Activity Log may take to load again. */
const RELOAD_WAIT_MS = 30_000;
/** The reloaded tab must stay loaded (no further reload event) this long before it is scanned. */
const RELOAD_SETTLE_MS = 1500;
const RELOAD_POLL_MS = 250;
/** After a verified SUCCESS, an unreachable tab is given this long for Chrome's reload event to arrive. */
const RELOAD_EVENT_GRACE_MS = 2000;
/** CONFIRM got no answer: how long a same-tab reload may take to show up (before or after the lost answer) to explain it. */
const CONFIRM_RELOAD_GRACE_MS = 3000;
/** A surviving old page still verifying the batch: how long to wait for its own result. */
const OLD_PAGE_VERIFY_WAIT_MS = 40_000;

type RunRequest = Extract<PopupRequest, { type: 'FPC_RUN_START' | 'FPC_RUN_STOP' | 'FPC_RUN_RESUME' | 'FPC_RUN_END' }>;

/** The run this worker is driving now. Storage holds the same run, queue and log for the tester and for recovery. */
interface Driver {
  run: QueueRun;
  queue: CleanupQueue;
  log: QueueLogEntry[];
  /** The run's latest scan. Memory only: it holds post text. */
  scan: SafeResult | null;
  /** Stop was pressed. */
  stop: boolean;
  /** The Facebook tab closed, was replaced / discarded, or left the approved Activity Log page: ends the run at its next check. */
  tabProblem: { reason: RunStopReason; detail: string } | null;
  /** A same-tab reload of the approved Activity Log page, not handled yet. `atState`: where the run was when the first event of it arrived. */
  reload: { atState: RunState } | null;
  /** Same-tab reload events so far. A change during a read-only step means its result may describe the old page. */
  reloadCount: number;
  /** reloadCount when the scan the queue is mapped to was taken. */
  mappedAtReloadCount: number;
  /** The V2B batch whose verified SUCCESS (N of N) this run accepted. Cleared when the next batch starts. */
  verifiedBatchId: string | null;
  /** Resolving a lost CONFIRM answer by looking at the reloaded page: the reload that caused it is expected. */
  postConfirm: boolean;
}

function newDriver(run: QueueRun, queue: CleanupQueue, log: QueueLogEntry[], stop = false): Driver {
  return { run, queue, log, scan: null, stop, tabProblem: null, reload: null, reloadCount: 0, mappedAtReloadCount: 0, verifiedBatchId: null, postConfirm: false };
}

let driver: Driver | null = null;
/** The tab of the stored run while it owns the queue (driven or paused), so tab events elsewhere cost nothing. */
let watchedTab: number | null = null;

/** Stops the run. `uncertain`: Facebook's state after it is not verified. */
class RunHalt extends Error {
  constructor(
    readonly reason: RunStopReason,
    detail: string,
    readonly uncertain = false,
  ) {
    super(detail);
  }
}

/** Pauses the run before a batch starts (Facebook not visible). */
class RunPause extends Error {}

const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---------------------------------------------------------------------------
// State, queue and log (this worker is their only writer while the run owns the queue)
// ---------------------------------------------------------------------------

async function save(d: Driver): Promise<void> {
  d.run.updatedAt = now();
  watchedTab = runOwnsQueue(d.run) ? d.run.tabId : null;
  await chrome.storage.session.set({ [RUN_KEY]: d.run, [QUEUE_KEY]: d.queue, [QUEUE_LOG_KEY]: d.log });
}

async function enter(d: Driver, state: RunState, extra: Partial<QueueRun> = {}): Promise<void> {
  Object.assign(d.run, extra, { state });
  await save(d);
}

/** Applies a V3B queue change (its events are tagged with the run). A refusal stops the run. */
function applyQ(d: Driver, r: Change | string, reason: RunStopReason = 'PLAN_CHANGED'): void {
  if (typeof r === 'string') throw new RunHalt(reason, `The queue refused a change: ${r}`);
  if (r.queue) d.queue = r.queue;
  d.log = appendLog(d.log, d.queue.queueId, r.events.map((e) => ({ ...e, runId: d.run.runId })));
}

/** A run-level log event: ids, counts, states and reasons only. */
function event(d: Driver, name: string, result: string, extra: { batch?: number | null; counts?: Record<string, number>; scanSessionId?: string | null } = {}): void {
  const counts = {
    batches: d.run.approved.length,
    completed: d.run.completedBatchIds.length,
    removed: d.run.removedCount,
    elapsedMs: elapsedMs(d.run),
    ...extra.counts,
  };
  d.log = appendLog(d.log, d.queue.queueId, [
    { event: name, batch: extra.batch ?? null, scanSessionId: extra.scanSessionId ?? d.queue.mappedScan, counts, result, runId: d.run.runId },
  ]);
}

/** The queue batch number of approved batch `i`, or null past the last one. */
const queueNo = (d: Driver, i = d.run.currentBatchIndex): number | null => (d.run.approved[i] ? d.run.approved[i].index + 1 : null);

/**
 * A pending same-tab reload is recoverable only if it did not hit before Facebook's final confirm,
 * and either the batch's verified SUCCESS was accepted or the run is resolving a lost CONFIRM
 * answer by looking at the reloaded page.
 */
function reloadRecoverable(d: Driver): boolean {
  return !!d.reload && (d.verifiedBatchId !== null || d.postConfirm) && !PRE_CONFIRM_STATES.includes(d.reload.atState);
}

/** Why an unrecoverable same-tab reload stops the run, and whether Facebook's state is then unknown. */
function reloadHalt(d: Driver): RunHalt {
  const at = d.reload?.atState ?? d.run.state;
  if (PRE_CONFIRM_STATES.includes(at)) {
    return new RunHalt(
      'TAB_RELOADED',
      `Facebook reloaded the tab while the run was ${at}, before the final confirm: the batch's selection and dialog state are no longer known.`,
      at !== 'PREFLIGHTING',
    );
  }
  if (at === 'CONFIRMING' || at === 'VERIFYING') {
    return new RunHalt('TAB_RELOADED', `Facebook reloaded the tab while the run was ${at}, before the batch's Trash outcome was verified.`, true);
  }
  return new RunHalt('TAB_RELOADED', `Facebook reloaded the tab while the run was ${at}, before any batch of this run had been verified.`);
}

/**
 * Stop pressed, the tab changed, or a reload the run can't recover from: the run ends here (callers
 * are at a safe point). `ignoreStop`: while finding out what a sent CONFIRM did, Stop waits for the
 * answer (it is read-only), like it does during V2B's own verification.
 */
function checkpoint(d: Driver, ignoreStop = false): void {
  if (d.tabProblem) throw new RunHalt(d.tabProblem.reason, d.tabProblem.detail);
  if (d.reload && !reloadRecoverable(d)) throw reloadHalt(d);
  if (d.stop && !ignoreStop) throw new RunHalt('USER_STOPPED', 'Stopped by you.');
}

async function waitFor(d: Driver, ms: number, ignoreStop = false): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    checkpoint(d, ignoreStop);
    await sleep(Math.min(TICK_MS, until - Date.now()));
  }
  checkpoint(d, ignoreStop);
}

// ---------------------------------------------------------------------------
// Talking to the Facebook tab (the same content-script requests the tester sends)
// ---------------------------------------------------------------------------

interface Ids {
  batchId: string;
  scanSessionId: string;
  itemIds: string[];
  permalinks: string[];
}

/**
 * One V2B batch step. Write steps carry `confirmed: true`: the user's run approval is the
 * confirmation (V4). The content script re-checks every safety condition before each click.
 */
function batchRequest(step: BatchStep, ids: Ids): BatchRequest {
  return {
    protocol: SCANNER_PROTOCOL,
    scanSessionId: ids.scanSessionId,
    batchId: ids.batchId,
    step,
    itemIds: [...ids.itemIds],
    permalinks: [...ids.permalinks],
    confirmed: step !== 'PREFLIGHT',
  };
}

async function batchStep(d: Driver, step: BatchStep, ids: Ids): Promise<BatchResponse> {
  // CONFIRM is sent only from runBatch (once, after its durable record): never through here.
  if (step === 'CONFIRM') throw new RunHalt('INTERNAL_ERROR', 'CONFIRM must not be sent through batchStep.');
  try {
    return await forward<BatchResponse>(d.run.tabId, { type: 'FPC_BATCH', request: batchRequest(step, ids) }, false);
  } catch (e) {
    throw new RunHalt('NO_RESPONSE', `No answer from the Facebook tab during ${step}: ${message(e)}`, step !== 'PREFLIGHT');
  }
}

async function readActionState(tabId: number): Promise<ActionState> {
  let res: ActionStateResponse;
  try {
    res = await forward<ActionStateResponse>(tabId, { type: 'FPC_ACTION_STATE' }, false);
  } catch (e) {
    throw new RunHalt('TAB_DISCONNECTED', `Could not read the Facebook tab's state: ${message(e)}`);
  }
  if (!res.ok) throw new RunHalt('TAB_DISCONNECTED', `Could not read the Facebook tab's state: ${res.error}`);
  return res.state;
}

/** Nothing else may be going on in the Facebook tab. */
function pageCheck(s: ActionState): void {
  if (s.locked) throw new RunHalt('ACTIONS_LOCKED', `Actions are locked in the Facebook tab: ${s.locked}`);
  if (s.pendingTrash) throw new RunHalt('PAGE_STATE_UNEXPECTED', 'A single-post Trash is waiting for confirmation in the Facebook tab.');
  if (isAutoLoadActive(s.autoLoad?.state)) throw new RunHalt('PAGE_STATE_UNEXPECTED', 'Older Activity Log entries are loading in the Facebook tab.');
}

/** The run's tab, still open and not discarded. */
async function getTab(d: Driver): Promise<chrome.tabs.Tab> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(d.run.tabId);
  } catch {
    throw new RunHalt('TAB_DISCONNECTED', 'The Facebook tab was closed.');
  }
  if (tab.discarded) throw new RunHalt('TAB_DISCONNECTED', 'Chrome discarded the Facebook tab.');
  return tab;
}

/** The tab still exists, is not discarded, and shows exactly the URL the run was approved on (or recovered to). */
async function tabCheck(d: Driver): Promise<chrome.tabs.Tab> {
  const tab = await getTab(d);
  if (!tab.url || !isActivityLogUrl(tab.url)) throw new RunHalt('URL_CHANGED', 'The Facebook tab is no longer on the Activity Log.');
  if (tab.url !== d.run.url) throw new RunHalt('URL_CHANGED', "The Facebook tab's URL changed since the run was approved.");
  return tab;
}

/** The Facebook page is visible: its tab active, its window not minimized, and the page itself reports visible. */
async function facebookVisible(tab: chrome.tabs.Tab, s: ActionState): Promise<boolean> {
  if (!tab.active || s.pageVisible !== true) return false;
  try {
    return (await chrome.windows.get(tab.windowId)).state !== 'minimized';
  } catch {
    return false;
  }
}

async function readToolbar(d: Driver, scanSessionId: string): Promise<ToolbarDiscovery> {
  let res: ToolbarResponse;
  try {
    res = await forward<ToolbarResponse>(d.run.tabId, { type: 'FPC_TOOLBAR_DISCOVER', scanSessionId }, false);
  } catch (e) {
    throw new RunHalt('TOOLBAR_NOT_HIGH', `Could not read Facebook's bulk toolbar: ${message(e)}`);
  }
  if (!res.ok) throw new RunHalt('TOOLBAR_NOT_HIGH', `Could not read Facebook's bulk toolbar: ${res.error}`);
  return res.toolbar;
}

// ---------------------------------------------------------------------------
// Rescan and reconcile (read-only on Facebook)
// ---------------------------------------------------------------------------

/**
 * A completely fresh scan of the run's tab (the ordinary scan request; `inject` after a reload, as
 * a normal scan would), checked to be the approved Activity Log page, and handed to an open tester.
 */
async function freshScan(d: Driver, inject: boolean, batch: number | null): Promise<SafeResult> {
  let res: ScanResponse;
  try {
    // After a reload the page is a new document: the scanner is injected like for any normal scan.
    res = await forward<ScanResponse>(d.run.tabId, { type: 'FPC_SCAN', strategy: d.run.strategy || undefined }, inject);
  } catch (e) {
    if (inject) throw new RunHalt('TAB_DISCONNECTED', `The Facebook tab could not be scanned after it reloaded: ${message(e)}`);
    throw new RunHalt('SCAN_FAILED', `The scan did not complete: ${message(e)}`);
  }
  if (!res.ok) throw new RunHalt('SCAN_FAILED', `The scan did not complete: ${res.error}`);
  const r = res.result;
  if (r.protocol !== SCANNER_PROTOCOL) throw new RunHalt('SCAN_FAILED', 'The scan came from a different scanner build. Reload the Facebook tab.');
  if (r.pageKind !== 'ACTIVITY_LOG') throw new RunHalt('URL_CHANGED', 'The scanned page is not the Activity Log.');
  if (d.run.scanUrl === null) {
    if (!sameActivityLog(r.url, d.run.url)) throw new RunHalt('URL_CHANGED', 'The scanned page is not the Activity Log page the run was approved on.');
    d.run.scanUrl = r.url;
  } else if (r.url !== d.run.scanUrl) throw new RunHalt('URL_CHANGED', "The Facebook page's URL changed during the run.");
  const safe = normalizeResult(r);
  if (!safe.scanSessionId) throw new RunHalt('SCAN_FAILED', 'The scan has no session id.');
  d.scan = safe;
  // An open tester shows this scan (not stored: it holds post text). Nobody listening is fine.
  const b: RunBroadcast = { type: 'FPC_RUN_SCAN', tabId: d.run.tabId, runId: d.run.runId, result: r };
  chrome.runtime.sendMessage(b).catch(() => {});
  event(d, 'RUN_RESCAN', `SUCCESS:${r.total} rows, ${r.counts.ONLY_ME} ONLY_ME${inject ? ', after reload' : ''}`, { batch, scanSessionId: safe.scanSessionId, counts: { rows: r.total } });
  return safe;
}

/**
 * A completely fresh scan, the V3B reconciliation by permalink, then the approved plan from
 * approved batch `next` on must be unchanged. `advance`: after a SUCCESS, the queue moves on to
 * its next batch (exactly V3B's "Continue").
 */
async function rescanAndReconcile(d: Driver, advance: boolean, next: number, afterReload = false): Promise<void> {
  const reloadsAtScan = d.reloadCount;
  await enter(d, 'RESCANNING');
  const safe = await freshScan(d, afterReload, queueNo(d, next));
  if (afterReload && d.run.reload) d.run.reload.reloadRecoveryResult = 'RESCANNED';

  await enter(d, 'RECONCILING');
  const s = await readActionState(d.run.tabId);
  pageCheck(s);
  applyQ(d, reconcile(d.queue, safe, d.run.tabId, s.batch, advance), 'RECONCILE_FAILED');
  const sum = summarize(d.queue);
  event(d, 'RUN_RECONCILED', `SUCCESS:${sum.remainingPlanned} planned remaining`, { batch: queueNo(d, next), counts: { remaining: sum.remainingPlanned, needsReview: sum.needsReview } });
  if (next < d.run.approved.length) {
    const p = approvedBatchProblem(d.queue, d.run, next);
    if (p) throw new RunHalt(p.code, `After reconciling: ${p.why}`);
  }
  d.mappedAtReloadCount = reloadsAtScan;
  if (afterReload && d.run.reload) d.run.reload.reloadRecoveryResult = 'RECONCILED';
  await save(d);
}

// ---------------------------------------------------------------------------
// From one batch to the next (read-only), with same-tab reload recovery
// ---------------------------------------------------------------------------

/**
 * Waits until the run's tab has (re)loaded the approved Activity Log page and stayed loaded with no
 * further reload for RELOAD_SETTLE_MS, then makes its URL the run's new baseline (every later
 * action-time check compares with it exactly). Never clicks. Gives up after RELOAD_WAIT_MS.
 */
async function waitForActivityLog(d: Driver, what: string, ignoreStop = false): Promise<string> {
  const deadline = Date.now() + RELOAD_WAIT_MS;
  for (;;) {
    checkpoint(d, ignoreStop);
    if (Date.now() > deadline) throw new RunHalt('TAB_RELOADED', `${what}, and the Activity Log did not finish loading within ${RELOAD_WAIT_MS / 1000} s.`);
    const tab = await getTab(d);
    if (tab.url && !sameActivityLog(d.run.url, tab.url)) throw new RunHalt('URL_CHANGED', `${what}: the tab is not on the Activity Log page the run was approved on.`);
    if (tab.status !== 'complete' || !tab.url) {
      await sleep(RELOAD_POLL_MS);
      continue;
    }
    const seen = d.reloadCount;
    await waitFor(d, RELOAD_SETTLE_MS, ignoreStop);
    const again = await getTab(d);
    if (seen === d.reloadCount && again.status === 'complete' && again.url && sameActivityLog(d.run.url, again.url)) {
      d.run.url = again.url;
      d.run.scanUrl = null;
      return again.url;
    }
  }
}

/**
 * A same-tab reload after the batch's verified SUCCESS: waits until the tab has loaded the same
 * Activity Log page and stayed loaded, then makes that URL the run's new baseline. Never clicks.
 * The fresh scan and reconciliation that follow decide whether the run may continue.
 */
async function recoverFromReload(d: Driver): Promise<void> {
  const lastKey = d.run.completedBatchIds[d.run.completedBatchIds.length - 1];
  const after = lastKey ? (d.run.approved.find((a) => a.key === lastKey)?.index ?? -1) + 1 || null : null;
  const info = d.run.reload ?? {
    sameTabReloadDetected: true as const,
    detectedAt: now(),
    reloadDetectedAtState: d.reload!.atState,
    batchAlreadyVerifiedSuccess: null,
    afterBatch: null,
    reloadRecoveryStarted: null,
    reloadRecoveryResult: null,
    urlBefore: d.run.url,
    urlAfter: null,
  };
  d.run.reload = { ...info, batchAlreadyVerifiedSuccess: true, afterBatch: after, reloadRecoveryStarted: now(), reloadRecoveryResult: 'WAITING' };
  event(d, 'RUN_RELOAD_RECOVERY_STARTED', `WAITING:after batch ${after ?? '?'} (verified SUCCESS); reload detected while ${d.run.reload.reloadDetectedAtState}`, { batch: after });
  await enter(d, 'TAB_RELOADING');
  const url = await waitForActivityLog(d, `Facebook reloaded the tab after Batch ${after ?? '?'}`);
  d.reload = null;
  d.run.reload = { ...d.run.reload, urlAfter: url, reloadRecoveryResult: 'RESTORED' };
  await save(d);
}

/**
 * Everything read-only between a verified SUCCESS (or the run's start) and the next batch's first
 * Facebook step: rescan + reconcile, the cooldown, the pre-batch checks. A same-tab reload in here
 * after a verified SUCCESS is recovered once (recoverFromReload, then a fresh scan + reconcile and
 * the checks again); a second one, or any other problem, stops the run. Returns false when no
 * approved batch is left.
 */
async function toNextBatch(d: Driver, next: number, opts: { rescan: boolean; advance: boolean; cooldown: boolean }): Promise<boolean> {
  let rescan = opts.rescan;
  let cooldown = opts.cooldown;
  let recovered = false;
  for (;;) {
    try {
      if (d.reload) {
        checkpoint(d); // a reload the run can't recover from stops here
        if (recovered) throw new RunHalt('TAB_RELOADED', 'Facebook reloaded the tab again while the run was recovering from a reload.');
        await recoverFromReload(d);
        recovered = true;
        rescan = true;
      }
      if (rescan) {
        await rescanAndReconcile(d, opts.advance, next, recovered);
        rescan = false;
        if (recovered && !d.reload) {
          event(d, 'RUN_RELOAD_RECOVERED', 'RECOVERED:fresh scan of the reloaded page reconciled cleanly', { batch: queueNo(d, next) });
          await save(d);
        }
      }
      if (d.reload) continue; // the scan may describe the page before the reload
      d.run.currentBatchIndex = next;
      if (next >= d.run.approved.length) return false;
      if (cooldown) {
        await enter(d, 'ADVANCING');
        await waitFor(d, BETWEEN_BATCH_DELAY_MS);
        cooldown = false;
      }
      if (d.reload) continue;
      await prepare(d, next);
      if (d.reload) continue;
      return true;
    } catch (e) {
      // A step that failed because Facebook reloaded the page is redone on the reloaded page (once).
      if (d.reload && reloadRecoverable(d) && !d.stop && !d.tabProblem) continue;
      throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// One batch
// ---------------------------------------------------------------------------

/** Read-only checks before approved batch `i` starts. Pauses (nothing started) when Facebook is not visible. */
async function prepare(d: Driver, i: number): Promise<void> {
  await enter(d, 'PREPARING', { runBatchId: null, countdownEndsAt: null });
  checkpoint(d);
  const tab = await tabCheck(d);
  const s = await readActionState(d.run.tabId);
  pageCheck(s);
  if (isBatchActive(s.batch?.state)) throw new RunHalt('PAGE_STATE_UNEXPECTED', `A cleanup batch is ${s.batch!.state} in the Facebook tab.`);
  if (!(await facebookVisible(tab, s))) throw new RunPause('Cleanup paused because Facebook is not visible.');
  if (d.queue.staleReason) throw new RunHalt('QUEUE_STALE', `The queue is stale: ${d.queue.staleReason}`);
  if (!d.scan || d.scan.scanSessionId !== d.queue.mappedScan || s.retiredSessions.includes(d.queue.mappedScan)) {
    throw new RunHalt('QUEUE_STALE', "The queue is not mapped to the run's latest scan.");
  }
  const p = approvedBatchProblem(d.queue, d.run, i);
  if (p) throw new RunHalt(p.code, p.why);
}

/** Problems with the selection SELECT reported, or null. Stricter than V2B's own check: every number must match exactly. */
function selectionProblem(snap: BatchSnapshot | null, n: number): { reason: RunStopReason; why: string } | null {
  const v = snap?.selection;
  if (!snap || snap.state !== 'SELECTED' || !v) return { reason: 'SELECTION_FAILED', why: `the batch is ${snap?.state ?? 'missing'}, not SELECTED.` };
  if (v.masterState === 'checked') return { reason: 'MASTER_FULLY_SELECTED', why: "Facebook's select-all checkbox is fully checked." };
  if (v.nonTargetRows.selected > 0) return { reason: 'NON_TARGET_SELECTED', why: `${v.nonTargetRows.selected} non-target row(s) are selected.` };
  if (v.otherCheckboxes.changed > 0) return { reason: 'NON_TARGET_SELECTED', why: `${v.otherCheckboxes.changed} other checkbox(es) changed state.` };
  if (v.unexpected.length > 0) return { reason: 'SELECTION_FAILED', why: v.unexpected.join(' ') };
  if (v.expected !== n || v.targetsSelected !== n || snap.selectedByBatch.length !== n || snap.itemIds.length !== n || v.pageSelected !== n) {
    return { reason: 'SELECTED_COUNT_MISMATCH', why: `${v.targetsSelected} of ${n} targets selected, ${v.pageSelected} checkbox(es) selected on the page.` };
  }
  if (!v.urlUnchanged) return { reason: 'URL_CHANGED', why: 'the page URL changed during the selection.' };
  return null;
}

const OUTCOME_REASON: Record<string, RunStopReason> = { PARTIAL: 'BATCH_PARTIAL', INCONCLUSIVE: 'BATCH_INCONCLUSIVE', FAILED: 'BATCH_FAILED' };

/** Approved batch `i`, through V2B's own steps. Returns only on a verified SUCCESS. */
async function runBatch(d: Driver, i: number): Promise<void> {
  const a = d.run.approved[i];
  const no = a.index + 1;
  const n = a.permalinks.length;
  const t = queueBatchTargets(currentBatch(d.queue)!, d.scan!);
  if (typeof t === 'string') throw new RunHalt('PLAN_CHANGED', `Batch ${no}: ${t}`);
  if (t.itemIds.length !== n) throw new RunHalt('PLAN_CHANGED', `Batch ${no} maps to ${t.itemIds.length} posts, not the ${n} approved.`);
  const ids: Ids = { batchId: crypto.randomUUID(), scanSessionId: d.scan!.scanSessionId!, ...t };
  // A new batch: from here until its own verified SUCCESS, a same-tab reload stops the run.
  d.verifiedBatchId = null;

  // The V3B queue's own "Review batch", with a fresh V2B batch id for this attempt.
  applyQ(d, startReview(d.queue, ids.batchId));
  d.run.runBatchId = ids.batchId;
  event(d, 'RUN_BATCH_STARTED', `STARTED:${n} posts`, { batch: no, counts: { posts: n } });

  // 1. PREFLIGHT (read-only). Even one failure stops the run.
  await enter(d, 'PREFLIGHTING');
  const pf = await batchStep(d, 'PREFLIGHT', ids);
  if (!pf.ok) throw new RunHalt('PREFLIGHT_FAILED', `${pf.code}: ${pf.error}`);
  if (!pf.preflight) throw new RunHalt('PREFLIGHT_FAILED', 'The preflight returned no result.');
  applyQ(d, recordPreflight(d.queue, pf.preflight));
  const p = pf.preflight;
  if (!p.ok || p.failed > 0 || p.ready !== n || p.items.length !== n || p.pageProblems.length > 0) {
    const failed = p.items.filter((c) => !c.ok).map((c) => `${c.itemId} ${c.code}`);
    throw new RunHalt('PREFLIGHT_FAILED', `${p.ready} of ${n} ready, ${p.failed} failed${failed.length ? ` (${failed.slice(0, 5).join(', ')}${failed.length > 5 ? ', …' : ''})` : ''}${p.pageProblems.length ? `. ${p.pageProblems.join(' ')}` : ''}`);
  }
  checkpoint(d);

  // 2. SELECT: V2B preflights again, then ticks each checkbox once, verifying after each (rolls back itself on failure).
  await enter(d, 'SELECTING');
  const sel = await batchStep(d, 'SELECT', ids);
  if (sel.batch) applyQ(d, syncFromSnapshot(d.queue, sel.batch));
  if (!sel.ok) {
    if (sel.batch?.rollback && !sel.batch.rollback.complete) throw new RunHalt('ROLLBACK_INCOMPLETE', `${sel.code}: ${sel.error}`, true);
    const reason: RunStopReason = sel.code === 'MASTER_FULLY_SELECTED' ? 'MASTER_FULLY_SELECTED' : sel.code === 'BATCH_PREFLIGHT_FAILED' ? 'PREFLIGHT_FAILED' : 'SELECTION_FAILED';
    throw new RunHalt(reason, `${sel.code}: ${sel.error}`);
  }
  const bad = selectionProblem(sel.batch, n);
  if (bad) throw new RunHalt(bad.reason, `After selecting Batch ${no}: ${bad.why}`);
  checkpoint(d);

  // 3. The bulk toolbar, read-only: HIGH toolbar, HIGH Trash, exactly n selected (as the V2B screen requires).
  const tb = await readToolbar(d, ids.scanSessionId);
  if (tb.masterState === 'checked') throw new RunHalt('MASTER_FULLY_SELECTED', "Facebook's select-all checkbox is fully checked.");
  const notReady = toolbarReady(tb, n);
  if (notReady) throw new RunHalt('TOOLBAR_NOT_HIGH', `Facebook's toolbar is not ready: ${notReady}.`);
  checkpoint(d);

  // 4. OPEN_DIALOG: V2B re-checks everything, clicks the HIGH Trash button once, discovers Facebook's dialog.
  await enter(d, 'OPENING_DIALOG');
  const od = await batchStep(d, 'OPEN_DIALOG', ids);
  if (od.batch) applyQ(d, syncFromSnapshot(d.queue, od.batch));
  if (!od.ok) {
    const reason: RunStopReason =
      od.code === 'MASTER_FULLY_SELECTED' ? 'MASTER_FULLY_SELECTED' : od.code === 'TOOLBAR_NOT_HIGH' ? 'TOOLBAR_NOT_HIGH' : od.code === 'DIALOG_NOT_HIGH' ? 'DIALOG_NOT_HIGH' : 'DIALOG_FAILED';
    throw new RunHalt(reason, `${od.code}: ${od.error}`, od.clicked);
  }
  const dlg = od.batch?.dialog;
  if (od.batch?.state !== 'DIALOG_OPEN' || !dlg) throw new RunHalt('DIALOG_FAILED', `The batch is ${od.batch?.state ?? 'missing'}, not DIALOG_OPEN.`, true);
  if (dlg.confirm.confidence !== 'HIGH' || dlg.confirm.ambiguousCandidates > 0) throw new RunHalt('DIALOG_NOT_HIGH', "Facebook's confirm button is not HIGH.");
  // Stricter than the manual screen: without a HIGH Cancel the run could not stop safely at this dialog.
  if (dlg.cancel.confidence !== 'HIGH' || dlg.cancel.ambiguousCandidates > 0) throw new RunHalt('DIALOG_NOT_HIGH', `Facebook's Cancel button is ${dlg.cancel.confidence ?? 'not found'}, not HIGH.`);
  checkpoint(d);

  // 5. Countdown. Stop now cancels Facebook's dialog and unselects (see settle).
  await enter(d, 'COUNTDOWN', { countdownEndsAt: new Date(Date.now() + CONFIRM_COUNTDOWN_MS).toISOString() });
  await waitFor(d, CONFIRM_COUNTDOWN_MS);
  await tabCheck(d);

  // 6. CONFIRM: V2B checks everything again, clicks Facebook's HIGH confirm once, and verifies every post.
  // Recorded durably BEFORE it is sent: if the answer is lost, the worker still knows exactly which
  // approved posts were involved, and resolves it by looking at Facebook, never by sending it again.
  const rec: RunConfirmRecord = {
    batchId: ids.batchId,
    batchKey: a.key,
    batchNo: no,
    scanSessionId: ids.scanSessionId,
    expected: n,
    targets: confirmTargets(d.scan!, ids),
    dialogVerifiedHigh: true,
    confirmRequestSentAt: now(),
    confirmResponseReceived: false,
    confirmResponseLost: false,
    reloadDuringConfirm: false,
    postConfirmRecoveryStarted: null,
    postConfirmFreshScanId: null,
    postConfirmTargetsAbsent: null,
    postConfirmTargetsPresent: null,
    postConfirmTargetsUncertain: null,
    postConfirmRecoveryResult: null,
    outcomeRecorded: false,
  };
  await enter(d, 'CONFIRMING', { countdownEndsAt: null, confirm: rec });
  checkpoint(d); // the last check before the click request (synchronous with the send below)
  let cf: BatchResponse;
  try {
    cf = await forward<BatchResponse>(d.run.tabId, { type: 'FPC_BATCH', request: batchRequest('CONFIRM', ids) }, false);
  } catch (e) {
    // No answer. Facebook may have reloaded the page right after the click (the old page then can't
    // answer). That is decided by looking at Facebook after the reload; the click is never sent again.
    rec.confirmResponseLost = true;
    await save(d);
    if (!(await reloadAfterLostConfirm(d))) {
      throw new RunHalt('NO_RESPONSE', `No answer from the Facebook tab during CONFIRM, and no same-tab reload followed within ${CONFIRM_RELOAD_GRACE_MS / 1000} s: ${message(e)}`, true);
    }
    await verifyLostConfirm(d, a);
    return;
  }
  rec.confirmResponseReceived = true;
  rec.outcomeRecorded = true;
  if (cf.batch) applyQ(d, syncFromSnapshot(d.queue, cf.batch));
  if (!cf.ok) throw new RunHalt('CONFIRM_REFUSED', `${cf.code}: ${cf.error}`, cf.clicked);

  // 7. The verified outcome. Only SUCCESS continues.
  await enter(d, 'VERIFYING');
  const out = cf.batch?.state;
  const v = cf.batch?.verification;
  if (out !== 'SUCCESS') {
    throw new RunHalt(OUTCOME_REASON[out ?? ''] ?? 'BATCH_INCONCLUSIVE', `Batch ${no} was ${out ?? 'not reported'}: ${v ? `${v.removed} of ${n} verified removed` : 'not verified'}.`);
  }
  if (!v || v.removed !== n) throw new RunHalt('BATCH_INCONCLUSIVE', `Batch ${no} reported SUCCESS but ${v?.removed ?? 0} of ${n} were verified removed.`);
  // Accepted: V2B verified every post removed on the page that answered. From here on a same-tab
  // reload of the Activity Log is part of the normal post-batch rescan, not a disconnect.
  d.verifiedBatchId = ids.batchId;
  d.run.completedBatchIds.push(a.key);
  d.run.removedCount += v.removed;
  event(d, 'RUN_BATCH_SUCCESS', `SUCCESS:${v.removed}/${n} removed`, { batch: no, scanSessionId: ids.scanSessionId, counts: { posts: n } });
  await save(d);
  // The tab's lock. Skipped when Facebook already replaced the document (a reload resets the lock; the
  // fresh scan, reconcile and the next preflight check the new page). An unreachable tab gets a moment
  // for Chrome's reload event to arrive; without one it is a disconnect.
  if (!d.reload) {
    let s: ActionState | null = null;
    try {
      s = await readActionState(d.run.tabId);
    } catch (e) {
      // The batch is verified, so this is checked before any disconnect: a tab that is still open on
      // the approved Activity Log page has been reloaded (Chrome's event may simply not have arrived
      // yet), which is the normal post-batch rescan. Only a closed / discarded tab or another page is a disconnect.
      await sleep(RELOAD_EVENT_GRACE_MS);
      if (!d.reload && !d.tabProblem) {
        const tab = await getTab(d);
        if (!tab.url || !sameActivityLog(d.run.url, tab.url)) throw e;
        recordSameTabReload(d, tab.url);
      }
    }
    if (s?.locked) throw new RunHalt('ACTIONS_LOCKED', `Actions are locked in the Facebook tab: ${s.locked}`);
  }
}

// ---------------------------------------------------------------------------
// A lost final-confirm answer: find out what Facebook did (read-only)
// ---------------------------------------------------------------------------

/** Each target's normalised permalink and its nearest non-target neighbours (with a permalink) in scan order. */
function confirmTargets(scan: SafeResult, ids: Ids): ConfirmTarget[] {
  const rows = [...scan.items].sort((x, y) => x.position - y.position);
  const target = new Set(ids.itemIds);
  const link = (k: number) => {
    const href = rows[k]?.controls?.permalink.href;
    return href ? normalizePermalink(href) : null;
  };
  const near = (from: number, step: number): string | null => {
    for (let k = from + step; k >= 0 && k < rows.length; k += step) {
      if (rows[k].itemId && target.has(rows[k].itemId!)) continue;
      const l = link(k);
      if (l) return l;
    }
    return null;
  };
  return ids.itemIds.map((itemId, i) => {
    const k = rows.findIndex((it) => it.itemId === itemId);
    return { itemId, permalink: normalizePermalink(ids.permalinks[i]), before: k < 0 ? null : near(k, -1), after: k < 0 ? null : near(k, 1) };
  });
}

/**
 * CONFIRM got no answer: was it because the same tab reloaded? Either order counts: the reload
 * recorded before the answer was lost, or arriving within CONFIRM_RELOAD_GRACE_MS after it (or the
 * tab seen loading the same Activity Log page). Anything else is an ordinary NO_RESPONSE.
 */
async function reloadAfterLostConfirm(d: Driver): Promise<boolean> {
  const until = Date.now() + CONFIRM_RELOAD_GRACE_MS;
  for (;;) {
    if (d.tabProblem) throw new RunHalt(d.tabProblem.reason, `${d.tabProblem.detail} (while Facebook's final confirm was being sent)`, true);
    if (d.reload) return true;
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(d.run.tabId);
    } catch {
      return false;
    }
    if (tab.status === 'loading' && sameActivityLog(d.run.url, tab.url ?? tab.pendingUrl)) return true;
    if (Date.now() >= until) return false;
    await sleep(100);
  }
}

/** The V2B batch snapshot the post-reload verification stands in for. Ids, outcomes and counts only. */
function verifiedSnapshot(rec: RunConfirmRecord, state: BatchState, v: BatchTrashVerification, error: string | null): BatchSnapshot {
  return {
    batchId: rec.batchId,
    scanSessionId: rec.scanSessionId,
    createdAt: rec.confirmRequestSentAt,
    state,
    itemIds: rec.targets.map((t) => t.itemId),
    selectedByBatch: [],
    history: [{ state, at: now() }],
    preflight: null,
    progress: null,
    selection: null,
    toolbar: null,
    dialog: null,
    rollback: null,
    verification: v,
    lastError: error ? { code: 'CONFIRM_RESPONSE_LOST', error } : null,
  };
}

/**
 * The reloaded page, freshly scanned: for each approved target of the batch,
 *   its permalink is a row's permalink                                   STILL_PRESENT
 *   its link is on a row, but not as that row's permalink                UNCERTAIN
 *   absent, and its neighbours from the old scan (the next post after it
 *     at least) are listed in the fresh scan                             REMOVED
 *   absent, but a neighbour is missing too or there is none after it     UNCERTAIN (the reloaded
 *     page may simply not have loaded that far)
 * plus the page checks: no checkbox selected, select-all not checked, no further reload. SUCCESS
 * only when every target is REMOVED and every page check passes (same rule as V2B's judge).
 */
async function verifyByFreshScan(d: Driver, rec: RunConfirmRecord, oldPageGone: boolean): Promise<BatchSnapshot> {
  await enter(d, 'POST_CONFIRM_VERIFY');
  rec.postConfirmRecoveryResult = 'SCANNING';
  const started = performance.now();
  const reloadsBefore = d.reloadCount;
  let safe: SafeResult;
  try {
    safe = await freshScan(d, true, rec.batchNo);
  } catch (e) {
    throw new RunHalt('BATCH_INCONCLUSIVE', `Batch ${rec.batchNo}: the final-confirm answer was lost and the reloaded page could not be verified: ${message(e)}`, true);
  }
  rec.postConfirmFreshScanId = safe.scanSessionId;
  let tb: ToolbarDiscovery | null = null;
  try {
    tb = await readToolbar(d, safe.scanSessionId!);
  } catch {
    tb = null;
  }

  const chosen = new Set<string>();
  const linked = new Set<string>();
  for (const it of safe.items) {
    const href = it.controls?.permalink.href;
    if (href) chosen.add(normalizePermalink(href));
    for (const h of it.controls?.permalink.candidateHrefs ?? []) linked.add(normalizePermalink(h));
    if (it.permalink) linked.add(normalizePermalink(it.permalink));
  }
  const listed = (p: string) => chosen.has(p) || linked.has(p);
  const items = rec.targets.map((t) => {
    let outcome: BatchItemOutcome;
    let reason: string;
    let neighbours: boolean | null = null;
    if (chosen.has(t.permalink)) {
      outcome = 'STILL_PRESENT';
      reason = 'its permalink is still listed in the fresh scan';
    } else if (linked.has(t.permalink)) {
      outcome = 'UNCERTAIN';
      reason = "its link is on the page, but not as a row's permalink";
    } else if (!t.after) {
      outcome = 'UNCERTAIN';
      reason = 'absent, but no later post was loaded before the reload, so the fresh list may not reach it';
    } else if (!listed(t.after) || (t.before !== null && !listed(t.before))) {
      neighbours = false;
      outcome = 'UNCERTAIN';
      reason = 'absent, but a post next to it is missing from the fresh scan too: the reloaded page may not have loaded that far';
    } else {
      neighbours = true;
      outcome = 'REMOVED';
      reason = 'absent from the fresh scan; the posts around it are listed';
    }
    return {
      itemId: t.itemId,
      outcome,
      rowDisconnected: true,
      permalinkAbsent: outcome !== 'STILL_PRESENT',
      neighboursListed: neighbours,
      rowIdentity: null,
      currentRowPermalink: null,
      currentRowPostUrls: null,
      currentRowPostLike: null,
      reason,
    };
  });
  const notes: string[] = [];
  if (d.reloadCount !== reloadsBefore) notes.push('Facebook reloaded the page again during the verification.');
  if (!tb) notes.push('The selection on the reloaded page could not be read.');
  else if (tb.selectedCount > 0 || tb.masterState === 'checked' || tb.masterState === 'mixed') {
    notes.push(`${tb.selectedCount} checkbox(es) are selected on the reloaded page (select-all ${tb.masterState}).`);
  }
  if (!oldPageGone) notes.push("The old page is still there (it reported this batch without a verification), so Facebook's dialog could not be proven closed.");
  for (const i of items) if (i.outcome !== 'REMOVED') notes.push(`${i.itemId}: ${i.reason}.`);
  const n = rec.expected;
  const removed = items.filter((i) => i.outcome === 'REMOVED').length;
  const still = items.filter((i) => i.outcome === 'STILL_PRESENT').length;
  const uncertain = items.filter((i) => i.outcome === 'UNCERTAIN').length;
  const state: BatchState =
    removed === n ? (notes.length === 0 ? 'SUCCESS' : 'INCONCLUSIVE') : removed > 0 ? 'PARTIAL' : still === n ? 'FAILED' : 'INCONCLUSIVE';
  rec.postConfirmTargetsAbsent = removed;
  rec.postConfirmTargetsPresent = still;
  rec.postConfirmTargetsUncertain = uncertain;
  rec.postConfirmRecoveryResult = state;
  event(d, 'RUN_POST_CONFIRM_VERIFIED', `${state}:${removed}/${n} absent, ${still} still present, ${uncertain} uncertain`, {
    batch: rec.batchNo,
    scanSessionId: safe.scanSessionId,
    counts: { absent: removed, present: still, uncertain },
  });
  await save(d);
  const v: BatchTrashVerification = {
    items,
    removed,
    stillPresent: still,
    uncertain,
    otherRows: { total: 0, connected: 0, rerendered: 0, missing: 0, missingIds: [] },
    selectedCount: tb?.selectedCount ?? 0,
    urlUnchanged: true,
    dialogClosed: oldPageGone,
    waitedMs: Math.round(performance.now() - started),
    notes,
  };
  return verifiedSnapshot(rec, state, v, state === 'SUCCESS' ? null : 'The final-confirm answer was lost when Facebook reloaded; verified by a fresh scan.');
}

/**
 * What a sent CONFIRM whose answer was lost actually did. Read-only: waits for the tab to load the
 * approved Activity Log page again, then uses the old page's own V2B result if that page survived
 * (waiting for its verification if needed), otherwise verifyByFreshScan. A batch the old page still
 * reports SELECTED / DIALOG_OPEN was never confirmed (and is rolled back by settle).
 */
async function confirmOutcome(d: Driver, rec: RunConfirmRecord, what: string): Promise<BatchSnapshot> {
  rec.postConfirmRecoveryStarted = now();
  rec.postConfirmRecoveryResult = 'WAITING_FOR_RELOAD';
  await enter(d, 'CONFIRM_RESULT_UNKNOWN');
  await waitForActivityLog(d, what, true);
  d.reload = null;

  let old: BatchSnapshot | null = null;
  try {
    old = (await readActionState(d.run.tabId)).batch;
  } catch {
    old = null; // the old page (and its scanner) is gone
  }
  if (old && old.batchId === rec.batchId) {
    const until = Date.now() + OLD_PAGE_VERIFY_WAIT_MS;
    while ((old.state === 'CONFIRMING' || old.state === 'VERIFYING') && Date.now() < until) {
      await sleep(500);
      try {
        old = (await readActionState(d.run.tabId)).batch ?? old;
      } catch {
        break;
      }
    }
    if (old.state === 'SELECTED' || old.state === 'DIALOG_OPEN') {
      rec.postConfirmRecoveryResult = `NOT_CONFIRMED:${old.state}`;
      throw new RunHalt('NO_RESPONSE', `The final-confirm request got no answer, but the old page still reports the batch ${old.state}: Facebook's confirm was not clicked.`, true);
    }
    if (!isBatchActive(old.state) && old.verification) {
      rec.postConfirmTargetsAbsent = old.verification.removed;
      rec.postConfirmTargetsPresent = old.verification.stillPresent;
      rec.postConfirmTargetsUncertain = old.verification.uncertain;
      rec.postConfirmRecoveryResult = `V2B_${old.state}`;
      return old;
    }
    // Still verifying, or ended without a verification: decide from a fresh scan.
  }
  return verifyByFreshScan(d, rec, !old || old.batchId !== rec.batchId);
}

/**
 * The CONFIRM answer was lost and the same tab reloaded. Decides the batch's outcome from Facebook
 * (confirmOutcome), records it in the queue exactly like a V2B result, and either continues (SUCCESS:
 * every target verified absent) or stops. Never sends CONFIRM again.
 */
async function verifyLostConfirm(d: Driver, a: RunApprovedBatch): Promise<void> {
  const rec = d.run.confirm!;
  rec.reloadDuringConfirm = true;
  d.postConfirm = true;
  event(d, 'RUN_CONFIRM_RESPONSE_LOST', 'UNKNOWN:Facebook reloaded during the final confirmation; verifying', { batch: rec.batchNo });
  try {
    const snap = await confirmOutcome(d, rec, `Facebook reloaded the tab during Batch ${rec.batchNo}'s final confirmation`);
    applyQ(d, syncFromSnapshot(d.queue, snap));
    rec.outcomeRecorded = true;
    const v = snap.verification!;
    if (snap.state === 'SUCCESS' && v.removed === rec.expected) {
      d.verifiedBatchId = rec.batchId;
      d.run.completedBatchIds.push(a.key);
      d.run.removedCount += v.removed;
      event(d, 'RUN_BATCH_SUCCESS', `SUCCESS:${v.removed}/${rec.expected} removed (final-confirm answer lost in a reload; verified after it)`, {
        batch: rec.batchNo,
        counts: { posts: rec.expected },
      });
      await save(d);
      return;
    }
    d.reload = null; // a further reload during the verification is already part of its verdict
    await save(d);
    throw new RunHalt(
      OUTCOME_REASON[snap.state] ?? 'BATCH_INCONCLUSIVE',
      `Final confirmation response was lost during Facebook reload. Fresh verification: removed ${v.removed}, still present ${v.stillPresent}, uncertain ${v.uncertain}. Nothing will be retried automatically.`,
      v.uncertain > 0 || snap.state === 'INCONCLUSIVE',
    );
  } catch (e) {
    // Stopped before the outcome was known (tab closed, page never loaded, …): Facebook's state is not verified.
    if (!rec.outcomeRecorded) {
      const h = e instanceof RunHalt ? e : new RunHalt('INTERNAL_ERROR', message(e));
      throw new RunHalt(h.reason, `Batch ${rec.batchNo}'s final-confirm answer was lost in a reload, and its outcome could not be verified: ${h.message}`, true);
    }
    throw e;
  } finally {
    d.postConfirm = false;
  }
}

/**
 * The worker restarted while a batch's final CONFIRM was sent and its outcome not recorded. CONFIRM
 * is never sent again: the outcome is decided from Facebook (confirmOutcome), recorded in the queue,
 * and the run ends INTERRUPTED. It never continues by itself.
 */
async function verifyAfterRestart(d: Driver): Promise<void> {
  const keep = setInterval(() => void chrome.runtime.getPlatformInfo().catch(() => {}), KEEPALIVE_MS);
  const rec = d.run.confirm!;
  const at = d.run.state;
  let detail: string;
  let uncertain: boolean;
  try {
    rec.confirmResponseLost = true;
    d.postConfirm = true;
    event(d, 'RUN_RESTART_DURING_CONFIRM', `UNKNOWN:worker restarted while ${at}; verifying Batch ${rec.batchNo}`, { batch: rec.batchNo });
    try {
      const snap = await confirmOutcome(d, rec, `The background worker restarted during Batch ${rec.batchNo}'s final confirmation`);
      applyQ(d, syncFromSnapshot(d.queue, snap));
      rec.outcomeRecorded = true;
      const v = snap.verification!;
      if (snap.state === 'SUCCESS' && v.removed === rec.expected) {
        d.run.completedBatchIds.push(rec.batchKey);
        d.run.removedCount += v.removed;
      }
      detail = `The background worker restarted while Batch ${rec.batchNo}'s final confirmation was in flight. Confirm was not sent again. Verified on Facebook: ${snap.state}, removed ${v.removed}, still present ${v.stillPresent}, uncertain ${v.uncertain}. The run does not continue by itself.`;
      uncertain = snap.state !== 'SUCCESS';
    } catch (e) {
      const s = await settle(d).catch(() => ({ clean: false, note: null }));
      detail = `The background worker restarted while Batch ${rec.batchNo}'s final confirmation was in flight. Confirm was not sent again, and its outcome could not be verified: ${message(e)}${s.note ? ` ${s.note}` : ''}`;
      uncertain = true;
    }
    try {
      applyQ(d, markStale(d.queue, 'the run was interrupted during a final confirmation.'));
    } catch {
      /* ended anyway */
    }
    d.run.state = at;
    await finish(d, 'STOPPED', 'INTERRUPTED', detail, uncertain);
  } finally {
    d.postConfirm = false;
    clearInterval(keep);
    if (driver === d) driver = null;
  }
}

// ---------------------------------------------------------------------------
// Stopping safely
// ---------------------------------------------------------------------------

/** A rollback step; never throws (a failure is reported by the batch state it leaves). */
async function tryStep(d: Driver, step: BatchStep, snap: BatchSnapshot): Promise<BatchSnapshot> {
  try {
    const r = await batchStep(d, step, { batchId: snap.batchId, scanSessionId: snap.scanSessionId, itemIds: snap.itemIds, permalinks: [] });
    if (r.batch) applyQ(d, syncFromSnapshot(d.queue, r.batch));
    return r.batch ?? snap;
  } catch {
    return snap;
  }
}

/**
 * After a halt: leaves Facebook as clean as it safely can. The run's V2B batch, if still active,
 * is rolled back with V2B's own steps (Facebook's HIGH Cancel, then "Cancel and unselect"). A
 * batch confirming / verifying is never touched. Returns a note, and whether Facebook is verified clean.
 */
async function settle(d: Driver): Promise<{ clean: boolean; note: string | null }> {
  const id = d.run.runBatchId;
  let note: string | null = null;
  let clean = true;
  if (d.reload && id && d.verifiedBatchId !== id) {
    // The page that held the batch is gone: nothing there can be rolled back or checked.
    note = 'Facebook replaced the page, so the batch on the old page could not be checked or rolled back. Check the Facebook tab, then rescan and reconcile.';
  } else if (id) {
    let snap: BatchSnapshot | null = null;
    try {
      snap = (await readActionState(d.run.tabId)).batch;
    } catch {
      return { clean: false, note: 'Could not read the Facebook tab to check the batch.' };
    }
    if (snap && snap.batchId === id) {
      if (snap.state === 'DIALOG_OPEN' || snap.state === 'SELECTED') await enter(d, 'ROLLING_BACK');
      if (snap.state === 'DIALOG_OPEN') snap = await tryStep(d, 'CANCEL_DIALOG', snap);
      if (snap.state === 'SELECTED') snap = await tryStep(d, 'UNSELECT', snap);
      try {
        applyQ(d, syncFromSnapshot(d.queue, snap));
      } catch {
        /* the queue keeps what it had */
      }
      if (snap.state === 'CANCELLED') note = "Facebook's dialog was cancelled and every post of the batch was unselected (verified). Nothing was moved.";
      else if (isBatchActive(snap.state)) {
        clean = false;
        note = `The batch is still ${snap.state} on Facebook: finish it in the Cleanup batch panel (Cancel / Cancel and unselect), or reload the Facebook tab.`;
      }
    }
  }
  const cur = currentBatch(d.queue);
  if (cur?.status === 'REVIEW') applyQ(d, endReview(d.queue));
  return { clean, note };
}

async function finish(d: Driver, state: 'COMPLETE' | 'STOPPED' | 'FAILED', reason: RunStopReason | null, detail: string | null, uncertain: boolean): Promise<void> {
  d.run.endedIn = d.run.state;
  d.run.state = state;
  d.run.endedAt = now();
  d.run.stopReason = reason;
  d.run.stopDetail = detail;
  d.run.uncertain = uncertain;
  d.run.countdownEndsAt = null;
  d.run.pauseReason = null;
  const name = state === 'COMPLETE' ? 'RUN_COMPLETE' : state === 'STOPPED' ? 'RUN_STOPPED' : 'RUN_FAILED';
  event(d, name, state === 'COMPLETE' ? `COMPLETE:${d.run.removedCount}/${d.run.approvedPosts} removed` : `${state}:${reason}${uncertain ? ', UNCERTAIN' : ''}`, {
    batch: state === 'COMPLETE' ? null : queueNo(d),
  });
  await save(d);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function drive(d: Driver): Promise<void> {
  driver = d;
  const keep = setInterval(() => void chrome.runtime.getPlatformInfo().catch(() => {}), KEEPALIVE_MS);
  try {
    let more = await toNextBatch(d, d.run.currentBatchIndex, { rescan: d.run.rescanFirst, advance: false, cooldown: false });
    d.run.rescanFirst = false;
    while (more) {
      const i = d.run.currentBatchIndex;
      await runBatch(d, i);
      // A Stop pressed while confirming / verifying takes effect here, after the verification.
      // (A same-tab reload after the verified SUCCESS does not: toNextBatch recovers from it.)
      checkpoint(d);
      more = await toNextBatch(d, i + 1, { rescan: true, advance: true, cooldown: true });
    }
    await finish(d, 'COMPLETE', null, null, false);
  } catch (e) {
    if (e instanceof RunPause && !d.stop && !d.tabProblem && !(d.reload && !reloadRecoverable(d))) {
      d.run.rescanFirst = true;
      await enter(d, 'PAUSED', { pauseReason: e.message, runBatchId: null });
      event(d, 'RUN_PAUSED', 'PAUSED:FACEBOOK_NOT_VISIBLE', { batch: queueNo(d) });
      await save(d);
      return;
    }
    let halt: RunHalt;
    if (e instanceof RunHalt) halt = e;
    else if (e instanceof RunPause) {
      // Stop pressed (or the tab changed) just as the run was about to pause: it ends instead.
      try {
        checkpoint(d);
        halt = new RunHalt('INTERNAL_ERROR', e.message);
      } catch (h) {
        halt = h as RunHalt;
      }
    } else halt = new RunHalt('INTERNAL_ERROR', message(e), WRITE_STATES.includes(d.run.state));
    // A step that failed because the page reloaded under it: report the reload.
    if (d.reload && !reloadRecoverable(d) && halt.reason !== 'USER_STOPPED' && halt.reason !== 'TAB_RELOADED') {
      const r = reloadHalt(d);
      halt = new RunHalt('TAB_RELOADED', `${r.message} (${halt.reason}: ${halt.message})`, r.uncertain || halt.uncertain);
    }
    if (d.run.reload?.reloadRecoveryStarted && d.run.reload.reloadRecoveryResult !== 'RECONCILED') {
      d.run.reload = { ...d.run.reload, reloadRecoveryResult: `FAILED: ${halt.reason}` };
    }
    // The queue's item ids describe a page that was reloaded since: it needs a fresh scan + reconcile (V3B).
    if (d.reloadCount !== d.mappedAtReloadCount) {
      try {
        applyQ(d, markStale(d.queue, 'the Facebook tab reloaded.'));
      } catch {
        /* ended anyway */
      }
    }
    const at = d.run.state;
    let s: { clean: boolean; note: string | null };
    try {
      s = await settle(d);
    } catch (err) {
      s = { clean: false, note: `Stopping safely failed: ${message(err)}` };
    }
    d.run.state = at; // finish records where the run was when it stopped, not the rollback
    const user = halt.reason === 'USER_STOPPED';
    await finish(d, user ? 'STOPPED' : 'FAILED', halt.reason, [halt.message, s.note].filter(Boolean).join(' '), halt.uncertain || !s.clean).catch(() => {});
  } finally {
    clearInterval(keep);
    if (driver === d) driver = null;
  }
}

// ---------------------------------------------------------------------------
// Requests from the tester
// ---------------------------------------------------------------------------

const ok = (): SimpleResponse => ({ ok: true });
const fail = (error: string): SimpleResponse => ({ ok: false, error });

/** Session storage as this worker found it: the run is recovered first (see recoverInterruptedRun). */
let recovered: Promise<void> = Promise.resolve();

/** A START is being checked (its awaits must not let a second one through). */
let starting = false;

async function start(msg: Extract<RunRequest, { type: 'FPC_RUN_START' }>): Promise<SimpleResponse> {
  if (driver || starting) return fail('A cleanup run is already active.');
  starting = true;
  try {
    return await startChecked(msg);
  } finally {
    starting = false;
  }
}

async function startChecked(msg: Extract<RunRequest, { type: 'FPC_RUN_START' }>): Promise<SimpleResponse> {
  if (msg.build !== BUILD_ID) {
    return fail(
      `This background worker is build ${BUILD_ID}, the tester is build ${msg.build ?? 'unknown'}. Reload the extension at chrome://extensions, then refresh the Facebook tab and the tester.`,
    );
  }
  const [{ queue, log }, last] = await Promise.all([loadQueue(), loadRun()]);
  if (runOwnsQueue(last)) return fail('A cleanup run is already active or paused. Stop or end it first.');
  if (!queue) return fail('There is no cleanup queue.');
  if (queue.queueId !== msg.approval.queueId) return fail('The queue changed (a different queue is stored). Review it again.');
  if (queue.tabId !== msg.tabId) return fail('The queue belongs to a different Facebook tab.');
  const plan = planRun(queue);
  if (typeof plan === 'string') return fail(`The queue can't run: ${plan}`);
  if (!sameApproval(plan.approval, msg.approval)) return fail('The queue changed after you reviewed the run. Review it again.');
  const again = resumeNeedsReconcile(last, queue);
  if (again) return fail(again);

  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(msg.tabId);
  } catch {
    return fail('The Facebook tab is closed.');
  }
  if (!tab.url || !isActivityLogUrl(tab.url)) return fail('The Facebook tab is not on the Activity Log.');
  let s: ActionState;
  try {
    s = await readActionState(msg.tabId);
    pageCheck(s);
  } catch (e) {
    return fail(message(e));
  }
  if (isBatchActive(s.batch?.state)) return fail(`A cleanup batch is ${s.batch!.state} in the Facebook tab. Finish or cancel it first.`);

  const d = newDriver(newRun({ queueId: queue.queueId, tabId: msg.tabId, url: tab.url, strategy: msg.strategy ?? '', approval: msg.approval }), queue, log);
  d.run.workerBuild = BUILD_ID;
  if (queue.state === 'PAUSED') applyQ(d, resumeQueue(queue));
  event(d, 'RUN_APPROVED', `APPROVED:${msg.approval.posts} posts in ${msg.approval.batches.length} batch(es)`, {
    counts: { posts: msg.approval.posts, leftPosts: plan.leftPosts },
  });
  event(d, 'RUN_STARTED', 'STARTED');
  driver = d;
  await save(d);
  void drive(d);
  return ok();
}

async function stop(runId: string): Promise<SimpleResponse> {
  if (driver && driver.run.runId === runId) {
    driver.stop = true;
    driver.run.stopRequestedAt = now();
    await save(driver);
    return ok();
  }
  const run = await loadRun();
  if (!run || run.runId !== runId) return fail('No such cleanup run.');
  if (isRunEnded(run)) return ok();
  // Not driven by this worker: paused, or (after a worker restart) interrupted.
  const { queue, log } = await loadQueue();
  if (!queue) return fail('The cleanup queue is gone.');
  const d = newDriver(run, queue, log, true);
  if (run.state === 'PAUSED') await finish(d, 'STOPPED', 'USER_STOPPED', 'Stopped by you while paused.', false);
  else await finish(d, 'STOPPED', 'INTERRUPTED', `The background worker restarted while the run was ${run.state}.`, WRITE_STATES.includes(run.state));
  return ok();
}

async function resume(runId: string): Promise<SimpleResponse> {
  if (driver || starting) return fail('A cleanup run is already active.');
  starting = true;
  try {
    return await resumeChecked(runId);
  } finally {
    starting = false;
  }
}

async function resumeChecked(runId: string): Promise<SimpleResponse> {
  const run = await loadRun();
  if (!run || run.runId !== runId) return fail('No such cleanup run.');
  if (run.state !== 'PAUSED') return fail(`The run is ${run.state}, not PAUSED.`);
  const { queue, log } = await loadQueue();
  if (!queue || queue.queueId !== run.queueId) return fail('The cleanup queue is gone.');
  const d = newDriver(run, queue, log);
  try {
    const tab = await tabCheck(d);
    const s = await readActionState(run.tabId);
    if (!(await facebookVisible(tab, s))) return fail('Facebook is still not visible. Show the Facebook tab first.');
  } catch (e) {
    return fail(message(e));
  }
  d.run.rescanFirst = true;
  d.run.pauseReason = null;
  d.run.state = 'PREPARING';
  event(d, 'RUN_RESUMED', 'RESUMED', { batch: queueNo(d) });
  driver = d;
  await save(d);
  void drive(d);
  return ok();
}

/** "End run": closes the panel of an ended run. Only the run is written: the queue is the tester's again. */
async function end(runId: string): Promise<SimpleResponse> {
  const run = await loadRun();
  if (!run || run.runId !== runId) return ok();
  if (!isRunEnded(run)) return fail('The run is still active. Stop it first.');
  await chrome.storage.session.set({ [RUN_KEY]: { ...run, dismissed: true, updatedAt: now() } });
  return ok();
}

export async function handleRunRequest(msg: RunRequest): Promise<SimpleResponse> {
  await recovered;
  try {
    switch (msg.type) {
      case 'FPC_RUN_START':
        return await start(msg);
      case 'FPC_RUN_STOP':
        return await stop(msg.runId);
      case 'FPC_RUN_RESUME':
        return await resume(msg.runId);
      case 'FPC_RUN_END':
        return await end(msg.runId);
    }
  } catch (e) {
    return fail(message(e));
  }
}

export function isRunRequest(msg: PopupRequest): msg is RunRequest {
  return msg.type === 'FPC_RUN_START' || msg.type === 'FPC_RUN_STOP' || msg.type === 'FPC_RUN_RESUME' || msg.type === 'FPC_RUN_END';
}

// ---------------------------------------------------------------------------
// Tab events and worker restarts
// ---------------------------------------------------------------------------

/** A run paused (not driven) when its tab changes: it ends; nothing was in progress on Facebook. */
async function endPausedRun(tabId: number, reason: RunStopReason, detail: string): Promise<void> {
  await recovered;
  if (driver) return;
  const run = await loadRun();
  if (!run || run.tabId !== tabId || run.state !== 'PAUSED') return;
  const { queue, log } = await loadQueue();
  if (!queue) return;
  const d = newDriver(run, queue, log);
  applyQ(d, markStale(queue, detail));
  await finish(d, 'FAILED', reason, detail, false);
}

/**
 * A same-tab reload (or URL rewrite) of the approved Activity Log page. Only recorded and logged:
 * the queue is NOT marked stale here (the run owns it) and the run is not stopped here. The run
 * decides at its next step (reloadRecoverable): recovered after a verified SUCCESS, or a stop that
 * then marks the queue stale. The first event of a reload decides where it hit (atState).
 */
function recordSameTabReload(d: Driver, url: string): void {
  d.reloadCount++;
  d.run.reloads = (d.run.reloads ?? 0) + 1;
  if (!d.reload) {
    d.reload = { atState: d.run.state };
    d.run.reload = {
      sameTabReloadDetected: true,
      detectedAt: now(),
      reloadDetectedAtState: d.run.state,
      batchAlreadyVerifiedSuccess: null,
      afterBatch: null,
      reloadRecoveryStarted: null,
      reloadRecoveryResult: null,
      urlBefore: d.run.url,
      urlAfter: url,
    };
    event(d, 'RUN_RELOAD_DETECTED', `RELOADED:same Activity Log page, while ${d.run.state}`, { batch: queueNo(d) });
  } else if (d.run.reload) d.run.reload = { ...d.run.reload, urlAfter: url };
  void save(d).catch(() => {});
}

/**
 * Chrome reported a load or URL change in a tab. For the run's tab: the same approved Activity Log
 * page is a same-tab reload, recorded for the run to handle (see reloadRecoverable); anything else
 * (another Facebook page, another Activity Log category, off facebook.com) stops it.
 */
function onTabLoad(tabId: number, url: string | null): void {
  void recovered.then(() => {
    if (tabId !== watchedTab) return;
    const d = driver;
    if (!d) {
      void endPausedRun(tabId, url && isActivityLogUrl(url) ? 'TAB_RELOADED' : 'URL_CHANGED', 'The Facebook tab reloaded or navigated while the run was paused.').catch(() => {});
      return;
    }
    if (tabId !== d.run.tabId) return;
    if (!url || !sameActivityLog(d.run.url, url)) {
      tabProblem(tabId, 'URL_CHANGED', 'The Facebook tab left the Activity Log page the run was approved on.');
      return;
    }
    recordSameTabReload(d, url);
  });
}

function onTabProblem(tabId: number, reason: RunStopReason, detail: string): void {
  // Right after a worker restart the watched tab is known only once recovery has read the stored run.
  void recovered.then(() => {
    if (tabId === watchedTab) tabProblem(tabId, reason, detail);
  });
}

function tabProblem(tabId: number, reason: RunStopReason, detail: string): void {
  const d = driver;
  if (!d) {
    void endPausedRun(tabId, reason, detail).catch(() => {});
    return;
  }
  if (tabId !== d.run.tabId) return;
  d.tabProblem ??= { reason, detail };
  // The mapping is no longer trusted (V3B): the queue needs a fresh scan + reconcile.
  try {
    applyQ(d, markStale(d.queue, detail));
  } catch {
    /* ended anyway */
  }
}

/**
 * Called once when the service worker starts. A run stored as active that no worker drives was
 * interrupted (the worker was stopped or restarted). It is never resumed and nothing is clicked:
 * it is marked STOPPED / INTERRUPTED, uncertain if it was in a write step. A PAUSED run stays
 * paused (nothing was in progress). If its batch's final CONFIRM was sent without a recorded
 * outcome, that outcome is first verified on Facebook (verifyAfterRestart), read-only.
 */
async function recoverInterruptedRun(): Promise<void> {
  const run = await loadRun();
  if (!run || !runOwnsQueue(run) || driver) return;
  watchedTab = run.tabId;
  if (run.state === 'PAUSED') return;
  const { queue, log } = await loadQueue();
  if (!queue) {
    await chrome.storage.session.set({ [RUN_KEY]: { ...run, state: 'STOPPED', endedIn: run.state, endedAt: now(), stopReason: 'INTERRUPTED', stopDetail: 'The cleanup queue is gone.', uncertain: true } });
    return;
  }
  const d = newDriver(run, queue, log);
  // A final CONFIRM was sent and its outcome is not recorded: never send it again; find out what it did.
  if (run.confirm && !run.confirm.outcomeRecorded && CONFIRM_SENT_STATES.includes(run.state)) {
    d.run.runBatchId = run.confirm.batchId;
    driver = d;
    void verifyAfterRestart(d);
    return;
  }
  const cur = currentBatch(d.queue);
  if (cur?.status === 'REVIEW') applyQ(d, endReview(d.queue));
  const uncertain = WRITE_STATES.includes(run.state);
  await finish(
    d,
    'STOPPED',
    'INTERRUPTED',
    `The background worker restarted while the run was ${run.state}.${uncertain ? ' Facebook may have a batch selected or its dialog open: check the Cleanup batch panel and the Facebook tab before anything else.' : ''}`,
    uncertain,
  );
}

/** Registers the run's listeners. Call once, synchronously, at the service worker's top level. */
export function initQueueRunner(): void {
  recovered = recoverInterruptedRun().catch(() => {});
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.discarded === true) onTabProblem(tabId, 'TAB_DISCONNECTED', 'Chrome discarded the Facebook tab.');
    else if (info.url !== undefined || info.status === 'loading') onTabLoad(tabId, info.url ?? tab.url ?? tab.pendingUrl ?? null);
  });
  chrome.tabs.onRemoved.addListener((tabId) => onTabProblem(tabId, 'TAB_DISCONNECTED', 'The Facebook tab was closed.'));
  chrome.tabs.onReplaced.addListener((_added, removed) => onTabProblem(removed, 'TAB_DISCONNECTED', 'The Facebook tab was replaced.'));
}
