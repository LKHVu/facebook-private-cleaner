/**
 * facebookQueueRun.ts
 *
 * V4 "Run remaining batches": the cleanup run's data model and its pure rules. Shared by the
 * tester (QueueRun.tsx: approval screen and run panel) and the background service worker
 * (background/queueRunner.ts: the orchestration). No React and no Facebook access here.
 *
 * A run is an explicit snapshot of a cleanup queue's remaining batches, approved once by the user:
 * each batch's key and the normalised permalinks of its planned posts. The run may act on exactly
 * those posts, in exactly that partitioning, and nothing else: posts a later scan discovers are
 * never added, a batch is never refilled, re-ordered or skipped. Anything that no longer matches
 * the snapshot stops the run.
 *
 * Every Facebook step of a run's batch is an ordinary V2B batch step (facebookBatchAction.ts),
 * and every queue change goes through the V3B functions (facebookQueue.ts). What V4 adds is the
 * orchestration: the user's single approval stands in for the per-batch confirmations.
 *
 * Stored in chrome.storage.session (RUN_KEY) next to the queue: ids, permalinks, counts, states,
 * timestamps and stop reasons. Never post text.
 */

import type { RunApproval, RunApprovedBatch } from '../shared/types';
import { MAX_BATCH_SIZE } from '../shared/types';
import { isActivityLogUrl } from '../content/facebookSelectors';
import { batchNo, currentBatch, invalidItems, isFinalStatus, plannedItems, type CleanupQueue, type QueueBatch, type QueueItemStatus } from './facebookQueue';

export const RUN_KEY = 'fpc:queueRun';
const RUN_VERSION = 1;

/** Safety cap for one run. Whole batches only: a larger queue is offered as "Run first N posts", never truncated silently. */
export const MAX_AUTORUN_POSTS = 100;
/** Fixed cooldown after a successful batch's rescan and reconciliation, before the next batch starts. Not randomised. */
export const BETWEEN_BATCH_DELAY_MS = 2500;
/** Countdown before each batch's final Facebook confirm. Stop during it cancels Facebook's dialog and unselects. */
export const CONFIRM_COUNTDOWN_MS = 3000;

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

/**
 * IDLE (no run) is never stored.
 *   PREPARING       page, tab, visibility and plan checks before a batch (read-only)
 *   PREFLIGHTING    V2B PREFLIGHT of the batch (read-only)
 *   SELECTING       V2B SELECT (ticks the batch's checkboxes, verified after each)
 *   OPENING_DIALOG  toolbar check, then V2B OPEN_DIALOG (clicks Facebook's Trash button once)
 *   COUNTDOWN       Facebook's dialog is open and HIGH; the countdown before the confirm click
 *   CONFIRMING      V2B CONFIRM (one click on Facebook's confirm, then V2B's own verification)
 *   VERIFYING       checking the verified outcome
 *   CONFIRM_RESULT_UNKNOWN  the CONFIRM request got no answer and the same tab reloaded: waiting for
 *                   the Activity Log to load again (Confirm is never sent again)
 *   POST_CONFIRM_VERIFY     fresh scan of the reloaded page: is each approved target still listed?
 *   TAB_RELOADING   Facebook reloaded the tab after a verified SUCCESS: waiting for the Activity Log to load again
 *   ROLLING_BACK    stopping: cancelling Facebook's dialog and unselecting the batch
 *   RESCANNING      fresh scan (read-only)
 *   RECONCILING     V3B reconciliation by permalink, then the approved plan is checked
 *   ADVANCING       cooldown before the next approved batch
 *   PAUSED          waits for the user (Facebook not visible); still holds the approval
 *   COMPLETE / STOPPED / FAILED   ended; the panel stays until "End run"
 */
export type RunState =
  | 'IDLE'
  | 'PREPARING'
  | 'PREFLIGHTING'
  | 'SELECTING'
  | 'OPENING_DIALOG'
  | 'COUNTDOWN'
  | 'CONFIRMING'
  | 'VERIFYING'
  | 'CONFIRM_RESULT_UNKNOWN'
  | 'POST_CONFIRM_VERIFY'
  | 'TAB_RELOADING'
  | 'ROLLING_BACK'
  | 'RESCANNING'
  | 'RECONCILING'
  | 'ADVANCING'
  | 'PAUSED'
  | 'COMPLETE'
  | 'STOPPED'
  | 'FAILED';

export type RunStopReason =
  | 'USER_STOPPED'
  | 'INTERRUPTED'
  | 'PREFLIGHT_FAILED'
  | 'SELECTION_FAILED'
  | 'SELECTED_COUNT_MISMATCH'
  | 'NON_TARGET_SELECTED'
  | 'MASTER_FULLY_SELECTED'
  | 'TOOLBAR_NOT_HIGH'
  | 'DIALOG_FAILED'
  | 'DIALOG_NOT_HIGH'
  | 'CONFIRM_REFUSED'
  | 'BATCH_PARTIAL'
  | 'BATCH_INCONCLUSIVE'
  | 'BATCH_FAILED'
  | 'SCAN_FAILED'
  | 'RECONCILE_FAILED'
  | 'APPROVED_ITEM_CHANGED'
  | 'PLAN_CHANGED'
  | 'URL_CHANGED'
  | 'TAB_DISCONNECTED'
  /** The same tab reloaded where the run can't recover from it (before a verified SUCCESS, or twice). */
  | 'TAB_RELOADED'
  | 'QUEUE_STALE'
  | 'ACTIONS_LOCKED'
  | 'PAGE_STATE_UNEXPECTED'
  | 'ROLLBACK_INCOMPLETE'
  | 'NO_RESPONSE'
  | 'INTERNAL_ERROR';

/**
 * Debug record of the latest same-tab reload of the Facebook tab during the run. No post content.
 * A reload after the current batch's verified SUCCESS is recovered (wait for the Activity Log,
 * fresh scan, reconcile); anywhere else it stops the run.
 */
export interface RunReloadInfo {
  sameTabReloadDetected: true;
  detectedAt: string;
  /** The run state when Chrome reported the reload. */
  reloadDetectedAtState: RunState;
  /** When it was handled: the run had already accepted the batch's verified SUCCESS (N of N). */
  batchAlreadyVerifiedSuccess: boolean | null;
  /** Queue batch number of that verified batch. */
  afterBatch: number | null;
  reloadRecoveryStarted: string | null;
  /** WAITING, RESTORED (the Activity Log answers again), RESCANNED, RECONCILED, or FAILED: … */
  reloadRecoveryResult: string | null;
  urlBefore: string;
  urlAfter: string | null;
}

/** One target of the batch whose final confirm was sent: identity by permalink, guarded by its scan-order neighbours. */
export interface ConfirmTarget {
  /** Its itemId in the scan the batch ran on (the V2B batch's own id for it). */
  itemId: string;
  /** Normalised permalink. */
  permalink: string;
  /** Normalised permalinks of the nearest non-target rows before / after it in that scan, or null. */
  before: string | null;
  after: string | null;
}

/**
 * Written to session storage BEFORE the final CONFIRM request is sent, so a lost answer (Facebook
 * reloading the page right after the click, or the worker restarting) can be resolved by looking
 * at Facebook, never by clicking again. Ids, permalinks, counts and timestamps only.
 */
export interface RunConfirmRecord {
  /** The V2B batchId. */
  batchId: string;
  /** Queue batch key and number. */
  batchKey: string;
  batchNo: number;
  /** The scan the batch ran on. */
  scanSessionId: string;
  expected: number;
  targets: ConfirmTarget[];
  /** Facebook's dialog confirm (and Cancel) were HIGH when the request was sent. */
  dialogVerifiedHigh: boolean;
  confirmRequestSentAt: string;
  confirmResponseReceived: boolean;
  confirmResponseLost: boolean;
  reloadDuringConfirm: boolean;
  postConfirmRecoveryStarted: string | null;
  postConfirmFreshScanId: string | null;
  postConfirmTargetsAbsent: number | null;
  postConfirmTargetsPresent: number | null;
  postConfirmTargetsUncertain: number | null;
  postConfirmRecoveryResult: string | null;
  /** The batch's outcome is recorded in the queue (from the answer, or from the post-reload verification). */
  outcomeRecorded: boolean;
}

export interface QueueRun {
  version: number;
  runId: string;
  queueId: string;
  tabId: number;
  /** The Facebook tab's URL when the run was approved. Any other URL stops the run. */
  url: string;
  /** The URL the run's first scan reported; every later scan must report the same. Null before it. */
  scanUrl: string | null;
  /** The tester's forced row strategy ('' = auto), so the run's scans split the page like the user's. */
  strategy: string;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  /** Exactly what the user approved (batch keys and permalinks). Never extended. */
  approved: RunApprovedBatch[];
  /** The approved queue batch keys, in order. */
  approvedRemainingBatchIds: string[];
  approvedPosts: number;
  /** Index into `approved` of the batch being run, or of the next one. */
  currentBatchIndex: number;
  state: RunState;
  /** Approved batch keys that ended SUCCESS in this run. */
  completedBatchIds: string[];
  /** Posts verified moved to Trash by this run. */
  removedCount: number;
  stopReason: RunStopReason | null;
  /** One line: what stopped the run, and what was rolled back. No post text. */
  stopDetail: string | null;
  /** Stop was pressed: the run stops at its next safe point. */
  stopRequestedAt: string | null;
  /** PAUSED only: why. */
  pauseReason: string | null;
  /** COUNTDOWN only: when Facebook's confirm will be clicked. */
  countdownEndsAt: string | null;
  /** The V2B batchId of the current batch attempt, or of the last one. */
  runBatchId: string | null;
  /** On start and resume: a fresh scan and reconciliation come before any batch. */
  rescanFirst: boolean;
  /** The state the run was in when it ended. */
  endedIn: RunState | null;
  /** Ended without Facebook's state being verified (a write step was in flight, or a rollback incomplete): inspect by hand. */
  uncertain: boolean;
  /** "End run" closed the panel. Kept so the next approval of this queue can require a fresh reconcile. */
  dismissed: boolean;
  /** Same-tab reloads of the Facebook tab seen during the run, and the latest one. Absent in older runs. */
  reloads?: number;
  reload?: RunReloadInfo | null;
  /** The latest batch's final-confirm record (see RunConfirmRecord). Absent in older runs. */
  confirm?: RunConfirmRecord | null;
  /** BUILD_ID of the background worker that ran it. */
  workerBuild?: string;
}

const ENDED: readonly RunState[] = ['COMPLETE', 'STOPPED', 'FAILED'];
/** Before Facebook's final confirm: a reload here leaves the selection / dialog state unknown, so the run stops. */
export const PRE_CONFIRM_STATES: readonly RunState[] = ['PREFLIGHTING', 'SELECTING', 'OPENING_DIALOG', 'COUNTDOWN', 'ROLLING_BACK'];
/** A run interrupted in one of these may have left Facebook mid-step (selected checkboxes, an open dialog, an unverified Trash). */
export const WRITE_STATES: readonly RunState[] = ['SELECTING', 'OPENING_DIALOG', 'COUNTDOWN', 'CONFIRMING', 'VERIFYING', 'CONFIRM_RESULT_UNKNOWN', 'POST_CONFIRM_VERIFY', 'ROLLING_BACK'];
/** The final CONFIRM may have been sent and its outcome may not be recorded yet. */
export const CONFIRM_SENT_STATES: readonly RunState[] = ['CONFIRMING', 'VERIFYING', 'CONFIRM_RESULT_UNKNOWN', 'POST_CONFIRM_VERIFY'];

export const isRunEnded = (run: QueueRun) => ENDED.includes(run.state);

/** While true only the background worker changes the queue (the tester shows it read-only). PAUSED included: it still holds the approval. */
export function runOwnsQueue(run: QueueRun | null | undefined): boolean {
  return !!run && !ENDED.includes(run.state);
}

export function newRun(p: { queueId: string; tabId: number; url: string; strategy: string; approval: RunApproval }): QueueRun {
  const at = new Date().toISOString();
  return {
    version: RUN_VERSION,
    runId: crypto.randomUUID(),
    queueId: p.queueId,
    tabId: p.tabId,
    url: p.url,
    scanUrl: null,
    strategy: p.strategy,
    startedAt: at,
    updatedAt: at,
    endedAt: null,
    approved: p.approval.batches.map((b) => ({ key: b.key, index: b.index, permalinks: [...b.permalinks] })),
    approvedRemainingBatchIds: p.approval.batches.map((b) => b.key),
    approvedPosts: p.approval.posts,
    currentBatchIndex: 0,
    state: 'PREPARING',
    completedBatchIds: [],
    removedCount: 0,
    stopReason: null,
    stopDetail: null,
    stopRequestedAt: null,
    pauseReason: null,
    countdownEndsAt: null,
    runBatchId: null,
    rescanFirst: true,
    endedIn: null,
    uncertain: false,
    dismissed: false,
    reloads: 0,
    reload: null,
    confirm: null,
  };
}

// ---------------------------------------------------------------------------
// The approval snapshot
// ---------------------------------------------------------------------------

export interface RunPlan {
  approval: RunApproval;
  /** Every open batch of the queue. */
  remainingBatches: number;
  remainingPosts: number;
  /** Left for a later run by MAX_AUTORUN_POSTS. */
  leftBatches: number;
  leftPosts: number;
  capped: boolean;
}

/** Why this queue batch may not be part of a run, or null. */
function approvalProblem(b: QueueBatch): string | null {
  if (b.status === 'REVIEW') return 'is under review in the Cleanup batch panel. Go back to the queue first.';
  if (b.status !== 'READY' && b.status !== 'WAITING') return `is ${b.status}.`;
  const invalid = invalidItems(b).length;
  if (invalid > 0) return `has ${invalid} post(s) that could not be reconciled (MISSING / CHANGED / NEEDS_REVIEW). Remove them from the batch first.`;
  const planned = plannedItems(b);
  if (planned.length === 0) return 'has no posts left.';
  if (planned.length > MAX_BATCH_SIZE) return `holds more than ${MAX_BATCH_SIZE} posts.`;
  if (planned.some((i) => i.itemId === null)) return 'is not mapped to the current scan. Rescan and reconcile first.';
  return null;
}

/**
 * The run "Run remaining batches" would approve now: the queue's open batches in order, whole
 * batches only, as long as they total at most `maxPosts`. A reason instead when the queue can't
 * run, or a batch inside that window is not clean (never skipped over).
 */
export function planRun(q: CleanupQueue, maxPosts = MAX_AUTORUN_POSTS): RunPlan | string {
  if (q.state !== 'READY' && q.state !== 'PAUSED') return `the queue is ${q.state}.`;
  if (q.staleReason) return `the queue is stale: ${q.staleReason}`;
  const open = q.batches.filter((b) => !isFinalStatus(b.status));
  if (open.length === 0) return 'no batch is left to run.';
  const chosen: QueueBatch[] = [];
  let posts = 0;
  for (const b of open) {
    const n = plannedItems(b).length;
    if (posts + n > maxPosts) break;
    chosen.push(b);
    posts += n;
  }
  if (chosen.length === 0) return `Batch ${batchNo(open[0])} alone holds more than ${maxPosts} posts.`;
  for (const b of chosen) {
    const why = approvalProblem(b);
    if (why) return `Batch ${batchNo(b)} ${why}`;
  }
  const remainingPosts = open.reduce((n, b) => n + plannedItems(b).length, 0);
  return {
    approval: { queueId: q.queueId, batches: chosen.map((b) => ({ key: b.key, index: b.index, permalinks: plannedItems(b).map((i) => i.permalink) })), posts },
    remainingBatches: open.length,
    remainingPosts,
    leftBatches: open.length - chosen.length,
    leftPosts: remainingPosts - posts,
    capped: chosen.length < open.length,
  };
}

/** The same approval: queue, batches, order and every permalink. */
export function sameApproval(a: RunApproval, b: RunApproval): boolean {
  return (
    a.queueId === b.queueId &&
    a.posts === b.posts &&
    a.batches.length === b.batches.length &&
    a.batches.every((x, i) => {
      const y = b.batches[i];
      return x.key === y.key && x.index === y.index && x.permalinks.length === y.permalinks.length && x.permalinks.every((p, k) => p === y.permalinks[k]);
    })
  );
}

/**
 * V4 §18: after a run of this queue stopped (anything but COMPLETE), another run needs a fresh
 * scan and reconciliation first: the old approval never carries over. A reason, or null.
 */
export function resumeNeedsReconcile(last: QueueRun | null, q: CleanupQueue): string | null {
  if (!last || last.queueId !== q.queueId || last.state === 'COMPLETE' || !last.endedAt) return null;
  return q.mappedAt > last.endedAt ? null : 'the last cleanup run of this queue stopped. Rescan and reconcile the queue first, then approve the run again.';
}

// ---------------------------------------------------------------------------
// Checks during the run
// ---------------------------------------------------------------------------

export type PlanProblem = { code: 'PLAN_CHANGED' | 'APPROVED_ITEM_CHANGED'; why: string };

function countStatuses(xs: (QueueItemStatus | 'NOT IN BATCH')[]): string {
  const by = new Map<string, number>();
  for (const s of xs) by.set(s, (by.get(s) ?? 0) + 1);
  return [...by].map(([s, n]) => `${n} ${s}`).join(', ');
}

/**
 * Every approved batch from `from` on is still exactly as approved: in the queue, not final, every
 * approved post still PLANNED in it, and no other post planned in it. Reconciliation may never
 * change the approved plan silently (MISSING / CHANGED / NEEDS_REVIEW / UNCERTAIN / ... stop the run).
 */
export function upcomingProblem(q: CleanupQueue, run: QueueRun, from: number): PlanProblem | null {
  for (const a of run.approved.slice(from)) {
    const n = a.index + 1;
    const b = q.batches.find((x) => x.key === a.key);
    if (!b) return { code: 'PLAN_CHANGED', why: `approved Batch ${n} is no longer in the queue.` };
    if (isFinalStatus(b.status)) return { code: 'PLAN_CHANGED', why: `approved Batch ${n} is already ${b.status}.` };
    const by = new Map(b.items.map((i) => [i.permalink, i]));
    const notPlanned = a.permalinks.map((p) => by.get(p)?.status ?? ('NOT IN BATCH' as const)).filter((s) => s !== 'PLANNED');
    if (notPlanned.length > 0) {
      return {
        code: 'APPROVED_ITEM_CHANGED',
        why: `approved Batch ${n}: ${notPlanned.length} of its ${a.permalinks.length} approved post(s) are no longer PLANNED (${countStatuses(notPlanned)}). The approved plan is never changed silently.`,
      };
    }
    const extra = plannedItems(b).filter((i) => !a.permalinks.includes(i.permalink)).length;
    if (extra > 0) return { code: 'PLAN_CHANGED', why: `Batch ${n} now plans ${extra} post(s) that were not approved.` };
  }
  return null;
}

/** Approved batch `i` is the queue's current batch, READY, and it and every later approved batch are unchanged. */
export function approvedBatchProblem(q: CleanupQueue, run: QueueRun, i: number): PlanProblem | null {
  const a = run.approved[i];
  if (!a) return { code: 'PLAN_CHANGED', why: 'no such approved batch.' };
  const cur = currentBatch(q);
  if (q.state !== 'READY') return { code: 'PLAN_CHANGED', why: `the queue is ${q.state}, not READY.` };
  if (!cur || cur.key !== a.key) return { code: 'PLAN_CHANGED', why: `the queue's current batch is ${cur ? `Batch ${batchNo(cur)}` : 'none'}, not the approved Batch ${a.index + 1}.` };
  const up = upcomingProblem(q, run, i);
  if (up) return up;
  if (cur.status !== 'READY') return { code: 'PLAN_CHANGED', why: `Batch ${a.index + 1} is ${cur.status}, not READY.` };
  if (plannedItems(cur).some((x) => x.itemId === null)) return { code: 'PLAN_CHANGED', why: `Batch ${a.index + 1} is not mapped to the latest scan.` };
  return null;
}

/**
 * The same Activity Log page, compared by meaning rather than by the raw URL string: facebook.com,
 * the same path from /allactivity on (trailing slash ignored), and the same category_key. So /me/
 * redirected to /<numeric id>/, a trailing slash or re-ordered query parameters still match; any
 * other Facebook page or Activity Log category does not. Used only to accept the URL a same-tab
 * reload lands on after a verified SUCCESS: every action-time check stays an exact comparison
 * (with that URL as the new baseline).
 */
export function sameActivityLog(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!isActivityLogUrl(a) || !isActivityLogUrl(b)) return false;
  const key = (url: string) => {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();
    const tail = path.slice(path.search(/\/allactivity(\/|$)/)).replace(/\/+$/, '');
    return `${tail}|${(u.searchParams.get('category_key') ?? '').toUpperCase()}`;
  };
  return key(a!) === key(b!);
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

export const RUN_STATE_TEXT: Record<RunState, string> = {
  IDLE: 'No run',
  PREPARING: 'Checking the page before the batch…',
  PREFLIGHTING: 'Preflight: checking every post on the live page (read-only)…',
  SELECTING: 'Selecting posts…',
  OPENING_DIALOG: 'Opening Facebook Trash dialog…',
  COUNTDOWN: 'Facebook Trash dialog open (HIGH).',
  CONFIRMING: 'Confirming…',
  VERIFYING: 'Verifying removal…',
  TAB_RELOADING: 'Facebook reloaded. Waiting for the Activity Log…',
  CONFIRM_RESULT_UNKNOWN: 'Facebook reloaded during final confirmation. Waiting for the Activity Log…',
  POST_CONFIRM_VERIFY: 'Verifying what actually happened (fresh scan, by permalink)…',
  ROLLING_BACK: "Stopping safely: cancelling Facebook's dialog and unselecting the batch…",
  RESCANNING: 'Rescanning…',
  RECONCILING: 'Reconciling remaining queue…',
  ADVANCING: 'Batch done.',
  PAUSED: 'Paused.',
  COMPLETE: 'Complete.',
  STOPPED: 'Stopped.',
  FAILED: 'Stopped.',
};

/** A run of the queue, as a batch number ("Batch 3 of 5" counts approved batches). */
export function runBatchLabel(run: QueueRun, i = run.currentBatchIndex): string {
  return `Batch ${Math.min(i + 1, run.approved.length)} of ${run.approved.length}`;
}

export function elapsedMs(run: QueueRun, at = Date.now()): number {
  return Math.max(0, (run.endedAt ? Date.parse(run.endedAt) : at) - Date.parse(run.startedAt));
}

// ---------------------------------------------------------------------------
// Session-only persistence (only the background worker writes it)
// ---------------------------------------------------------------------------

export function looksLikeRun(v: unknown): v is QueueRun {
  const r = v as QueueRun;
  return !!r && typeof r === 'object' && r.version === RUN_VERSION && typeof r.runId === 'string' && typeof r.queueId === 'string' && Array.isArray(r.approved) && typeof r.state === 'string';
}

export async function loadRun(): Promise<QueueRun | null> {
  const got = await chrome.storage.session.get(RUN_KEY);
  return looksLikeRun(got[RUN_KEY]) ? got[RUN_KEY] : null;
}
