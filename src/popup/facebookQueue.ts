/**
 * facebookQueue.ts
 *
 * V3B: the automatic cleanup queue PLAN. Pure planning, partitioning and reconciliation, plus its
 * session-only persistence. It never talks to Facebook: every Facebook step of a queue batch is an
 * ordinary V2B batch (BatchActions.tsx → facebookBatchAction.ts), started only by the user.
 *
 *   build       every eligible ONLY_ME post of the CURRENT scan (V2B eligibility, and not in Scan
 *               health's "Items needing review", and a permalink no other row has), in scan order,
 *               split into batches of at most MAX_BATCH_SIZE. Deterministic batch keys.
 *   reconcile   after a fresh scan: every still-planned post is found again by its normalised
 *               permalink (never by text) and gets the new scan's itemId, or is marked MISSING /
 *               CHANGED / NEEDS_REVIEW. The partitioning never changes: nothing is pulled from a
 *               later batch, nothing is reshuffled.
 *   sync        mirrors the V2B batch's own state (ActionState.batch) onto the queue batch that
 *               started it, and records each post's verified outcome.
 *
 * Nothing here advances to a batch's Facebook selection: the queue only says which batch is
 * current. The user reviews it, selects it and confirms it through V2B's own screens, and after a
 * success must press Continue, which rescans and reconciles before the next batch becomes current.
 *
 * Stored (chrome.storage.session, cleared when the browser or extension restarts): queue id, tab
 * id, normalised permalinks, the partitioning, statuses, the current scan's item ids, counts and
 * timestamps. Never post text, previews or screenshots.
 */

import type { BatchPreflight, BatchSnapshot, BatchState } from '../shared/types';
import { MAX_BATCH_SIZE, isBatchActive } from '../shared/types';
import { normalizePostUrl } from '../content/facebookControls';
import type { SafeItem, SafeResult } from './normalize';
import { batchIneligibility, reviewReasons } from './safetyRules';

export const QUEUE_KEY = 'fpc:cleanupQueue';
export const QUEUE_LOG_KEY = 'fpc:cleanupQueueLog';
const QUEUE_VERSION = 1;
const MAX_QUEUE_LOG = 200;

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

/**
 * IDLE (no queue) is not stored. STALE is never stored either: it is derived (see queueView) from
 * the scan the queue is mapped to, the tab, and a recorded tab reload / navigation.
 *   READY          the current batch can be reviewed
 *   RUNNING_BATCH  the current batch is under review or running through V2B
 *   BATCH_DONE     the current batch succeeded; Continue rescans, reconciles and moves on
 *   PAUSED         by the user, or after a failed batch was reconciled; Resume continues
 *   FAILED         a batch ended PARTIAL / INCONCLUSIVE / FAILED: advancement stopped
 *   COMPLETE       no batch is left to run
 *   STOPPED        ended by the user; kept for reading until discarded
 */
export type QueueState = 'IDLE' | 'READY' | 'RUNNING_BATCH' | 'BATCH_DONE' | 'PAUSED' | 'FAILED' | 'COMPLETE' | 'STOPPED' | 'STALE';
type StoredQueueState = Exclude<QueueState, 'IDLE' | 'STALE'>;

/**
 * WAITING / READY / NEEDS_REVIEW are the queue's own. REVIEW is V2B's popup-side review of this
 * batch. SELECTING … FAILED mirror the V2B batch that ran it. SKIPPED is final.
 */
export type QueueBatchStatus =
  | 'WAITING'
  | 'READY'
  | 'NEEDS_REVIEW'
  | 'REVIEW'
  | 'SELECTING'
  | 'SELECTED'
  | 'DIALOG_OPEN'
  | 'CONFIRMING'
  | 'VERIFYING'
  | 'SUCCESS'
  | 'PARTIAL'
  | 'INCONCLUSIVE'
  | 'FAILED'
  | 'SKIPPED';

/**
 *   PLANNED       still to be moved; itemId is its row in the mapped scan
 *   REMOVED       verified removed by its batch
 *   SKIPPED       its batch was skipped (kept, so a later queue could be built from them)
 *   MISSING       not in the latest scan
 *   CHANGED       the latest scan classifies it as something other than ONLY_ME
 *   NEEDS_REVIEW  found, but no longer eligible (evidence, controls, or its permalink in several rows)
 *   EXCLUDED      taken out of its batch by the user (e.g. it failed the preflight)
 *   UNCERTAIN     its batch confirmed Facebook's Trash but it was not verified removed
 *   NOT_REMOVED   its batch stopped before Facebook's Trash was confirmed
 * Only PLANNED posts are ever put into a V2B batch. Nothing else is retried automatically.
 */
export type QueueItemStatus = 'PLANNED' | 'REMOVED' | 'SKIPPED' | 'MISSING' | 'CHANGED' | 'NEEDS_REVIEW' | 'EXCLUDED' | 'UNCERTAIN' | 'NOT_REMOVED';

export interface QueueItem {
  /** Normalised permalink: the post's identity across scans. */
  permalink: string;
  /** Its itemId in CleanupQueue.mappedScan; null when not PLANNED or not mapped. */
  itemId: string | null;
  status: QueueItemStatus;
  /** Why it is not PLANNED (codes and counts only, never post text). */
  note: string | null;
}

export interface QueueBatch {
  /** Deterministic: `${queueId}:${index + 1}`. */
  key: string;
  /** 0-based position; shown as "Batch index + 1". */
  index: number;
  /** Fixed at build time: posts only ever leave a batch, none are added. */
  items: QueueItem[];
  status: QueueBatchStatus;
  /** The V2B batchId of the latest review / run of this batch (a fresh one per attempt). */
  runBatchId: string | null;
  /** Reviews started (each gets a new runBatchId). */
  attempts: number;
  preflight: { at: string; ready: number; failed: number; pageProblems: number } | null;
  result: { at: string; outcome: BatchState; removed: number; total: number } | null;
  note: string | null;
}

export interface CleanupQueue {
  version: number;
  queueId: string;
  /** The Facebook tab the queue was built in. Another tab makes it stale. */
  tabId: number;
  createdAt: string;
  updatedAt: string;
  /** The scan it was built from. */
  builtFromScan: string;
  /** The scan its PLANNED items' itemIds belong to. A different current scan makes it stale. */
  mappedScan: string;
  mappedAt: string;
  state: StoredQueueState;
  /** Why the queue is FAILED / PAUSED / STOPPED / COMPLETE, one line. */
  stateReason: string | null;
  /** Set when the Facebook tab reloaded, navigated or changed: requires a fresh scan + reconcile. */
  staleReason: string | null;
  /** Index of the current batch. */
  currentIndex: number;
  eligibleAtStart: number;
  /** "First N eligible" (testing), or null for all. */
  limit: number | null;
  batches: QueueBatch[];
}

/** One compact queue-level event (no post text, no permalinks). Kept apart from the queue so discarding it keeps the log. */
export interface QueueLogEntry {
  timestamp: string;
  queueId: string;
  event: string;
  /** 1-based batch number, or null for queue-wide events. */
  batch: number | null;
  scanSessionId: string | null;
  counts: Record<string, number>;
  result: string;
  /** V4: the cleanup run that wrote this event, if any. */
  runId?: string;
}

export type Event = Omit<QueueLogEntry, 'timestamp' | 'queueId'>;
export interface Change {
  queue: CleanupQueue | null;
  events: Event[];
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const now = () => new Date().toISOString();

/** Queue batch statuses in which V2B is selecting / has selected / is trashing: the queue must not be touched. */
const RUNNING: readonly QueueBatchStatus[] = ['SELECTING', 'SELECTED', 'DIALOG_OPEN', 'CONFIRMING', 'VERIFYING'];
const FINAL: readonly QueueBatchStatus[] = ['SUCCESS', 'PARTIAL', 'INCONCLUSIVE', 'FAILED', 'SKIPPED'];
/** Not started on Facebook yet (the batch may still be skipped or edited). */
const NOT_STARTED: readonly QueueBatchStatus[] = ['WAITING', 'READY', 'NEEDS_REVIEW', 'REVIEW'];
const INVALID_ITEM: readonly QueueItemStatus[] = ['MISSING', 'CHANGED', 'NEEDS_REVIEW'];
/** Items listed under "Queue items needing review". */
export const ATTENTION_ITEM: readonly QueueItemStatus[] = ['MISSING', 'CHANGED', 'NEEDS_REVIEW', 'EXCLUDED', 'UNCERTAIN', 'NOT_REMOVED'];

export const isRunningStatus = (s: QueueBatchStatus) => RUNNING.includes(s);
export const isFinalStatus = (s: QueueBatchStatus) => FINAL.includes(s);
export const isNotStarted = (s: QueueBatchStatus) => NOT_STARTED.includes(s);

export function batchNo(b: QueueBatch): number {
  return b.index + 1;
}

export function currentBatch(q: CleanupQueue): QueueBatch | null {
  return q.batches[q.currentIndex] ?? null;
}

export function plannedItems(b: QueueBatch): QueueItem[] {
  return b.items.filter((i) => i.status === 'PLANNED');
}

export function invalidItems(b: QueueBatch): QueueItem[] {
  return b.items.filter((i) => INVALID_ITEM.includes(i.status));
}

/** Future use: the posts of skipped batches, still identified by permalink, could seed another queue. Not rebuilt automatically. */
export function skippedItems(q: CleanupQueue): QueueItem[] {
  return q.batches.flatMap((b) => b.items.filter((i) => i.status === 'SKIPPED'));
}

function touch(q: CleanupQueue): CleanupQueue {
  return { ...q, updatedAt: now() };
}

function mapBatch(q: CleanupQueue, index: number, fn: (b: QueueBatch) => QueueBatch): CleanupQueue {
  return { ...q, batches: q.batches.map((b) => (b.index === index ? fn(b) : b)) };
}

export function normalizePermalink(href: string): string {
  return normalizePostUrl(href);
}

// ---------------------------------------------------------------------------
// Eligibility and partitioning
// ---------------------------------------------------------------------------

/**
 * Why a scanned post may not enter a queue, or null. V2B's batch eligibility (ONLY_ME, strong
 * evidence, HIGH unambiguous checkbox, permalink, valid shape), and not an item Scan health
 * lists under "Items needing review".
 */
export function queueIneligibility(it: SafeItem): string | null {
  const v2b = batchIneligibility(it);
  if (v2b) return v2b;
  const review = reviewReasons(it);
  return review.length > 0 ? `needs review: ${review.join(', ')}` : null;
}

/** Scanned posts whose permalink appears in more than one row: they can't be reconciled safely. */
function permalinkCounts(items: SafeItem[]): Map<string, SafeItem[]> {
  const by = new Map<string, SafeItem[]>();
  for (const it of items) {
    const href = it.controls?.permalink.href;
    if (!href) continue;
    const key = normalizePermalink(href);
    by.set(key, [...(by.get(key) ?? []), it]);
  }
  return by;
}

/** Every post of this scan that may enter a queue, in scan order. */
export function queueEligible(safe: SafeResult): SafeItem[] {
  const by = permalinkCounts(safe.items);
  return safe.items.filter((it) => queueIneligibility(it) === null && by.get(normalizePermalink(it.controls!.permalink.href!))!.length === 1);
}

/**
 * The V2B batch request for a queue batch's PLANNED posts: their itemIds in `safe` (scan order) and
 * the scan's own permalinks. A reason instead if any planned post is not in this scan.
 * Used by "Review batch" (V3B) and by the cleanup run (V4).
 */
export function queueBatchTargets(b: QueueBatch, safe: SafeResult): { itemIds: string[]; permalinks: string[] } | string {
  if (!safe.scanSessionId) return 'the scan has no session id.';
  const pos = new Map(safe.items.filter((it) => it.itemId).map((it) => [it.itemId!, it]));
  const items: SafeItem[] = [];
  for (const q of plannedItems(b)) {
    const it = q.itemId ? pos.get(q.itemId) : undefined;
    const href = it?.controls?.permalink.href;
    if (!it || !href) return `a planned post (${q.itemId ?? 'unmapped'}) is not in the current scan. Rescan and reconcile.`;
    items.push(it);
  }
  if (items.length === 0) return 'no posts left in this batch.';
  if (items.length > MAX_BATCH_SIZE) return `a batch holds at most ${MAX_BATCH_SIZE} posts.`;
  items.sort((a, c) => a.position - c.position);
  return { itemIds: items.map((it) => it.itemId!), permalinks: items.map((it) => it.controls!.permalink.href!) };
}

/** Consecutive chunks of at most `size`, order kept. */
export function partition<T>(xs: readonly T[], size = MAX_BATCH_SIZE): T[][] {
  if (size < 1) throw new Error('Batch size must be at least 1.');
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

export function buildQueue(safe: SafeResult, tabId: number, limit: number | null): Change | string {
  if (!safe.scanSessionId) return 'this scan has no session id. Scan again.';
  const all = queueEligible(safe);
  const chosen = limit !== null && limit > 0 ? all.slice(0, limit) : all;
  if (chosen.length === 0) return 'no eligible ONLY_ME post in the current scan.';
  const queueId = crypto.randomUUID();
  const at = now();
  const batches: QueueBatch[] = partition(chosen).map((chunk, index) => ({
    key: `${queueId}:${index + 1}`,
    index,
    items: chunk.map((it) => ({ permalink: normalizePermalink(it.controls!.permalink.href!), itemId: it.itemId, status: 'PLANNED' as const, note: null })),
    status: index === 0 ? 'READY' : 'WAITING',
    runBatchId: null,
    attempts: 0,
    preflight: null,
    result: null,
    note: null,
  }));
  const queue: CleanupQueue = {
    version: QUEUE_VERSION,
    queueId,
    tabId,
    createdAt: at,
    updatedAt: at,
    builtFromScan: safe.scanSessionId,
    mappedScan: safe.scanSessionId,
    mappedAt: at,
    state: 'READY',
    stateReason: null,
    staleReason: null,
    currentIndex: 0,
    eligibleAtStart: chosen.length,
    limit: limit !== null && limit > 0 ? limit : null,
    batches,
  };
  return {
    queue,
    events: [{
      event: 'QUEUE_CREATED',
      batch: null,
      scanSessionId: safe.scanSessionId,
      counts: { eligible: chosen.length, eligibleInScan: all.length, batches: batches.length },
      result: `SUCCESS:${chosen.length} posts in ${batches.length} batch(es)`,
    }],
  };
}

// ---------------------------------------------------------------------------
// Batch readiness and advancement (never touches Facebook)
// ---------------------------------------------------------------------------

/** READY: every remaining post is PLANNED and mapped. NEEDS_REVIEW: some are MISSING / CHANGED / NEEDS_REVIEW. EMPTY: none left. */
function readiness(b: QueueBatch): 'READY' | 'NEEDS_REVIEW' | 'EMPTY' {
  if (invalidItems(b).length > 0) return 'NEEDS_REVIEW';
  if (plannedItems(b).length === 0) return 'EMPTY';
  return b.items.every((i) => i.status !== 'PLANNED' || i.itemId !== null) ? 'READY' : 'NEEDS_REVIEW';
}

/** Makes batch `index` current with its readiness; an empty batch is skipped and the next one tried. */
function makeCurrent(q: CleanupQueue, index: number, events: Event[]): CleanupQueue {
  for (let i = index; i < q.batches.length; i++) {
    const b = q.batches[i];
    if (isFinalStatus(b.status)) continue;
    const r = readiness(b);
    if (r === 'EMPTY') {
      q = mapBatch(q, i, (x) => ({ ...x, status: 'SKIPPED', note: 'no posts left in this batch' }));
      events.push({ event: 'QUEUE_BATCH_SKIPPED', batch: i + 1, scanSessionId: q.mappedScan, counts: { posts: 0 }, result: 'SKIPPED:EMPTY' });
      continue;
    }
    q = mapBatch({ ...q, currentIndex: i }, i, (x) => ({ ...x, status: r }));
    if (r === 'NEEDS_REVIEW') {
      events.push({ event: 'QUEUE_BATCH_NEEDS_REVIEW', batch: i + 1, scanSessionId: q.mappedScan, counts: { invalid: invalidItems(q.batches[i]).length }, result: 'NEEDS_REVIEW' });
    }
    return { ...q, state: 'READY', stateReason: null };
  }
  const s = summarize(q);
  events.push({ event: 'QUEUE_COMPLETE', batch: null, scanSessionId: q.mappedScan, counts: { removed: s.removed, skipped: s.skipped, needsReview: s.needsReview }, result: 'COMPLETE' });
  return { ...q, currentIndex: Math.max(0, q.batches.length - 1), state: 'COMPLETE', stateReason: null };
}

/** From a final current batch to the next batch that still has work. */
function advance(q: CleanupQueue, events: Event[]): CleanupQueue {
  const cur = currentBatch(q);
  if (cur && !isFinalStatus(cur.status)) return q;
  return makeCurrent(q, q.currentIndex + 1, events);
}

// ---------------------------------------------------------------------------
// User actions on the plan (none of them touches Facebook)
// ---------------------------------------------------------------------------

/** "Review batch": a fresh V2B batch id for this attempt; the caller hands V2B the plan. */
export function startReview(q: CleanupQueue, runBatchId: string): Change {
  const b = currentBatch(q)!;
  const next = mapBatch(q, b.index, (x) => ({ ...x, status: 'REVIEW', runBatchId, attempts: x.attempts + 1, preflight: null }));
  return { queue: touch({ ...next, state: 'RUNNING_BATCH', stateReason: null }), events: [] };
}

/** Leaves the review (Back, a new scan, or Pause): the batch is ready to review again. */
export function endReview(q: CleanupQueue): Change {
  const b = currentBatch(q);
  if (!b || b.status !== 'REVIEW') return { queue: q, events: [] };
  const next = mapBatch(q, b.index, (x) => ({ ...x, status: readiness(x) === 'READY' ? 'READY' : 'NEEDS_REVIEW' }));
  return { queue: touch({ ...next, state: q.state === 'RUNNING_BATCH' ? 'READY' : q.state }), events: [] };
}

/** The live V2B preflight of the batch under review (read-only on Facebook). */
export function recordPreflight(q: CleanupQueue, pf: BatchPreflight): Change {
  const b = q.batches.find((x) => x.runBatchId === pf.batchId);
  if (!b) return { queue: q, events: [] };
  const next = mapBatch(q, b.index, (x) => ({ ...x, preflight: { at: pf.checkedAt, ready: pf.ready, failed: pf.failed, pageProblems: pf.pageProblems.length } }));
  return {
    queue: touch(next),
    events: [{
      event: 'QUEUE_BATCH_REVIEWED',
      batch: batchNo(b),
      scanSessionId: q.mappedScan,
      counts: { ready: pf.ready, failed: pf.failed, pageProblems: pf.pageProblems.length },
      result: pf.ok ? `READY:${pf.ready}/${pf.items.length}` : `NEEDS_ATTENTION:${pf.failed} failed${pf.pageProblems.length ? ', page state' : ''}`,
    }],
  };
}

/**
 * "Remove failed / invalid items from this batch": they become EXCLUDED (listed for review, never
 * retried). The batch keeps its place; nothing is pulled in from a later batch.
 */
export function excludeItems(q: CleanupQueue, index: number, match: (i: QueueItem) => boolean, note: (i: QueueItem) => string): Change {
  const b = q.batches[index];
  if (!b || !isNotStarted(b.status)) return { queue: q, events: [] };
  let removed = 0;
  let next = mapBatch(q, index, (x) => ({
    ...x,
    items: x.items.map((i) => {
      if (i.status === 'EXCLUDED' || i.status === 'REMOVED' || !match(i)) return i;
      removed++;
      return { ...i, status: 'EXCLUDED' as const, itemId: null, note: note(i) };
    }),
  }));
  const events: Event[] = [{
    event: 'QUEUE_BATCH_ITEMS_REMOVED',
    batch: index + 1,
    scanSessionId: q.mappedScan,
    counts: { removed, left: plannedItems(next.batches[index]).length },
    result: `SUCCESS:${removed} removed from the batch`,
  }];
  const nb = next.batches[index];
  if (plannedItems(nb).length === 0 && invalidItems(nb).length === 0) {
    // Nothing left to run: the batch is over, and the next one becomes current (no Facebook change).
    next = mapBatch(next, index, (x) => ({ ...x, status: 'SKIPPED', note: 'every post was removed from this batch' }));
    events.push({ event: 'QUEUE_BATCH_SKIPPED', batch: index + 1, scanSessionId: q.mappedScan, counts: { posts: 0 }, result: 'SKIPPED:EMPTY' });
    if (index === q.currentIndex) next = advance({ ...next, state: 'READY' }, events);
  } else if (nb.status !== 'REVIEW') {
    const r = readiness(nb);
    next = mapBatch(next, index, (x) => ({ ...x, status: index === q.currentIndex ? (r === 'READY' ? 'READY' : 'NEEDS_REVIEW') : 'WAITING' }));
  }
  return { queue: touch(next), events };
}

/** "Skip batch": only before V2B selected anything. Its posts are kept as SKIPPED; the next batch becomes current. */
export function skipCurrent(q: CleanupQueue): Change | string {
  const b = currentBatch(q);
  if (!b || !isNotStarted(b.status)) return 'the batch has already started on Facebook.';
  const events: Event[] = [{
    event: 'QUEUE_BATCH_SKIPPED',
    batch: batchNo(b),
    scanSessionId: q.mappedScan,
    counts: { posts: plannedItems(b).length },
    result: 'SKIPPED:BY_USER',
  }];
  let next = mapBatch(q, b.index, (x) => ({
    ...x,
    status: 'SKIPPED',
    note: 'skipped by the user',
    items: x.items.map((i) => (i.status === 'PLANNED' ? { ...i, status: 'SKIPPED' as const, itemId: null, note: 'batch skipped' } : i)),
  }));
  next = advance({ ...next, state: q.state === 'PAUSED' ? 'PAUSED' : 'READY' }, events);
  return { queue: touch(next), events };
}

export function pauseQueue(q: CleanupQueue): Change {
  const ended = endReview(q).queue!;
  return {
    queue: touch({ ...ended, state: 'PAUSED', stateReason: 'Paused by the user.' }),
    events: [{ event: 'QUEUE_PAUSED', batch: batchNo(currentBatch(q)!), scanSessionId: q.mappedScan, counts: summaryCounts(q), result: 'PAUSED' }],
  };
}

/** Resume after a pause, or after a failed batch was reconciled: the next batch with work becomes current. */
export function resumeQueue(q: CleanupQueue): Change {
  const events: Event[] = [];
  let next: CleanupQueue = { ...q, state: 'READY', stateReason: null };
  const cur = currentBatch(next);
  if (cur && isFinalStatus(cur.status)) next = advance(next, events);
  else if (cur) next = makeCurrent(next, cur.index, events);
  events.unshift({ event: 'QUEUE_RESUMED', batch: batchNo(currentBatch(next)!), scanSessionId: q.mappedScan, counts: summaryCounts(next), result: next.state });
  return { queue: touch(next), events };
}

export function stopQueue(q: CleanupQueue): Change {
  const ended = endReview(q).queue!;
  return {
    queue: touch({ ...ended, state: 'STOPPED', stateReason: 'Stopped by the user. No further batch will run from this queue.' }),
    events: [{ event: 'QUEUE_STOPPED', batch: null, scanSessionId: q.mappedScan, counts: summaryCounts(q), result: 'STOPPED' }],
  };
}

/** The Facebook tab reloaded, navigated or changed. The mapping is no longer trusted until a fresh scan is reconciled. */
export function markStale(q: CleanupQueue, reason: string): Change {
  if (q.staleReason === reason || q.state === 'COMPLETE' || q.state === 'STOPPED') return { queue: q, events: [] };
  return {
    queue: touch({ ...q, staleReason: reason }),
    events: [{ event: 'QUEUE_STALE', batch: null, scanSessionId: q.mappedScan, counts: {}, result: `STALE:${reason}` }],
  };
}

// ---------------------------------------------------------------------------
// Following the V2B batch (read from ActionState.batch)
// ---------------------------------------------------------------------------

/**
 * Mirrors the V2B batch started from a queue batch. Idempotent: called on every action-state
 * poll. SUCCESS never starts the next batch: the queue waits for Continue (BATCH_DONE), or is
 * COMPLETE when nothing is left. PARTIAL / INCONCLUSIVE / FAILED stop the queue (FAILED).
 */
export function syncFromSnapshot(q: CleanupQueue, snap: BatchSnapshot): Change {
  const b = q.batches.find((x) => x.runBatchId === snap.batchId);
  if (!b || isFinalStatus(b.status)) return { queue: q, events: [] };
  const n = batchNo(b);
  const events: Event[] = [];

  if (isBatchActive(snap.state)) {
    if (b.status === snap.state) return { queue: q, events };
    if (!isRunningStatus(b.status)) {
      events.push({ event: 'QUEUE_BATCH_STARTED', batch: n, scanSessionId: snap.scanSessionId, counts: { posts: snap.itemIds.length }, result: snap.state });
    }
    const next = mapBatch(q, b.index, (x) => ({ ...x, status: snap.state as QueueBatchStatus }));
    return { queue: touch({ ...next, state: 'RUNNING_BATCH', stateReason: null }), events };
  }

  if (snap.state === 'CANCELLED') {
    // "Cancel and unselect": nothing was moved, every checkbox was unselected. The batch can be reviewed again.
    if (!isRunningStatus(b.status)) return { queue: q, events };
    events.push({ event: 'QUEUE_BATCH_CANCELLED', batch: n, scanSessionId: snap.scanSessionId, counts: { posts: snap.itemIds.length }, result: 'CANCELLED:UNSELECTED' });
    const next = mapBatch(q, b.index, (x) => ({ ...x, status: readiness(x) === 'READY' ? 'READY' : 'NEEDS_REVIEW' }));
    return { queue: touch({ ...next, state: q.state === 'PAUSED' ? 'PAUSED' : 'READY' }), events };
  }

  if (snap.state !== 'SUCCESS' && snap.state !== 'PARTIAL' && snap.state !== 'INCONCLUSIVE' && snap.state !== 'FAILED') return { queue: q, events };

  // A final V2B outcome: each post's verified outcome, by itemId in the scan the batch ran on.
  const outcome = new Map(snap.verification?.items.map((i) => [i.itemId, i.outcome]) ?? []);
  const trashed = snap.verification !== null;
  const items = b.items.map((i): QueueItem => {
    if (i.status !== 'PLANNED' || !i.itemId || !snap.itemIds.includes(i.itemId)) return i;
    const o = outcome.get(i.itemId);
    if (o === 'REMOVED') return { ...i, status: 'REMOVED', itemId: null, note: null };
    if (!trashed) return { ...i, status: 'NOT_REMOVED', itemId: null, note: `batch ${snap.state} before Facebook's Trash was confirmed` };
    return { ...i, status: 'UNCERTAIN', itemId: null, note: `batch ${snap.state}: ${o ?? 'not verified'}` };
  });
  const removed = items.filter((i) => i.status === 'REMOVED').length;
  const total = snap.itemIds.length;
  let next = mapBatch(q, b.index, (x) => ({ ...x, items, status: snap.state as QueueBatchStatus, result: { at: now(), outcome: snap.state, removed, total } }));

  if (snap.state === 'SUCCESS') {
    events.push({ event: 'QUEUE_BATCH_SUCCESS', batch: n, scanSessionId: snap.scanSessionId, counts: { removed, total }, result: `SUCCESS:${removed}/${total} removed` });
    const more = next.batches.some((x) => x.index > b.index && !isFinalStatus(x.status));
    if (more) next = { ...next, state: 'BATCH_DONE', stateReason: `Batch ${n} completed.` };
    else next = makeCurrent({ ...next, currentIndex: b.index }, b.index + 1, events);
    return { queue: touch(next), events };
  }

  const event = snap.state === 'FAILED' ? 'QUEUE_BATCH_FAILED' : snap.state === 'PARTIAL' ? 'QUEUE_BATCH_PARTIAL' : 'QUEUE_BATCH_INCONCLUSIVE';
  events.push({ event, batch: n, scanSessionId: snap.scanSessionId, counts: { removed, total }, result: `${snap.state}:${removed}/${total} removed${snap.lastError ? `, ${snap.lastError.code}` : ''}` });
  next = { ...next, state: 'FAILED', stateReason: `Queue paused because Batch ${n} was ${snap.state}.` };
  return { queue: touch(next), events };
}

// ---------------------------------------------------------------------------
// Reconciliation after a fresh scan (permalinks only)
// ---------------------------------------------------------------------------

/**
 * Maps the queue onto a fresh scan by normalised permalink. `snap` is the Facebook tab's current
 * batch snapshot (read after the scan), used to settle a batch whose V2B run can no longer be read.
 * `advanceAfter`: Continue after a SUCCESS moves on to the next batch; Rescan-and-reconcile doesn't.
 */
export function reconcile(q: CleanupQueue, safe: SafeResult, tabId: number, snap: BatchSnapshot | null, advanceAfter: boolean): Change | string {
  if (!safe.scanSessionId) return 'the new scan has no session id.';
  if (tabId !== q.tabId) return 'this queue belongs to a different Facebook tab. Discard it and build a new one.';
  const events: Event[] = [];
  let next = q;

  // A run the queue followed but whose V2B batch is gone (the tab reloaded mid-batch): its outcome is unknown.
  const cur = currentBatch(next);
  if (cur && isRunningStatus(cur.status)) {
    if (snap && snap.batchId === cur.runBatchId) {
      if (isBatchActive(snap.state)) return `batch ${batchNo(cur)} is still ${snap.state} on Facebook. Finish or cancel it first.`;
      const synced = syncFromSnapshot(next, snap);
      next = synced.queue!;
      events.push(...synced.events);
    } else {
      const lost = cur.status;
      next = mapBatch(next, cur.index, (x) => ({
        ...x,
        status: 'INCONCLUSIVE',
        note: `its progress was lost while ${lost} (the Facebook tab was reloaded?)`,
        items: x.items.map((i) => (i.status === 'PLANNED' ? { ...i, status: 'UNCERTAIN' as const, itemId: null, note: `batch interrupted while ${lost}` } : i)),
        result: { at: now(), outcome: 'INCONCLUSIVE', removed: 0, total: plannedItems(x).length },
      }));
      next = { ...next, state: 'FAILED', stateReason: `Queue paused because Batch ${batchNo(cur)} was interrupted (${lost}) and is INCONCLUSIVE.` };
      events.push({ event: 'QUEUE_BATCH_INCONCLUSIVE', batch: batchNo(cur), scanSessionId: q.mappedScan, counts: { posts: plannedItems(cur).length }, result: `INCONCLUSIVE:LOST_WHILE_${lost}` });
    }
  }

  const by = permalinkCounts(safe.items);
  const counts = { planned: 0, missing: 0, changed: 0, needsReview: 0, unchanged: 0 };
  next = {
    ...next,
    batches: next.batches.map((b) => {
      if (isFinalStatus(b.status)) {
        // Never retried: only a note on whether an uncertain post is still listed.
        return {
          ...b,
          items: b.items.map((i) => {
            if (i.status !== 'UNCERTAIN' && i.status !== 'NOT_REMOVED') return i;
            const listed = (by.get(i.permalink)?.length ?? 0) > 0;
            const base = (i.note ?? '').replace(/; (still|not) listed after rescan$/, '');
            return { ...i, note: `${base}; ${listed ? 'still' : 'not'} listed after rescan` };
          }),
        };
      }
      const items = b.items.map((i): QueueItem => {
        if (i.status !== 'PLANNED' && !INVALID_ITEM.includes(i.status)) return i;
        // Sticky: a post that could not be reconciled once is never put back into a batch automatically.
        if (i.status !== 'PLANNED') {
          counts.unchanged++;
          return { ...i, itemId: null };
        }
        const found = by.get(i.permalink) ?? [];
        if (found.length === 0) {
          counts.missing++;
          return { ...i, status: 'MISSING', itemId: null, note: 'not in the latest scan' };
        }
        if (found.length > 1) {
          counts.needsReview++;
          return { ...i, status: 'NEEDS_REVIEW', itemId: null, note: `its permalink is in ${found.length} rows` };
        }
        const it = found[0];
        if (it.audience !== 'ONLY_ME') {
          counts.changed++;
          return { ...i, status: 'CHANGED', itemId: null, note: `now ${it.audience}` };
        }
        const why = queueIneligibility(it);
        if (why || !it.itemId) {
          counts.needsReview++;
          return { ...i, status: 'NEEDS_REVIEW', itemId: null, note: why ?? 'no item id' };
        }
        counts.planned++;
        return { ...i, itemId: it.itemId, note: null };
      });
      return { ...b, items };
    }),
  };

  // Every batch that is not current waits; the current one is re-evaluated (never started).
  next = {
    ...next,
    mappedScan: safe.scanSessionId,
    mappedAt: now(),
    staleReason: null,
    batches: next.batches.map((b) => {
      if (isFinalStatus(b.status) || isRunningStatus(b.status)) return b;
      if (b.index !== next.currentIndex) return { ...b, status: 'WAITING' };
      const r = readiness(b);
      return { ...b, status: r === 'READY' ? 'READY' : r === 'EMPTY' ? b.status : 'NEEDS_REVIEW' };
    }),
  };
  if (next.state === 'RUNNING_BATCH') next = { ...next, state: 'READY' };
  events.push({ event: 'QUEUE_RECONCILED', batch: batchNo(currentBatch(next)!), scanSessionId: safe.scanSessionId, counts, result: `SUCCESS:${counts.planned} matched by permalink, ${counts.missing} missing, ${counts.changed} changed, ${counts.needsReview} need review` });

  if (advanceAfter && next.state === 'BATCH_DONE') {
    next = advance({ ...next, state: 'READY', stateReason: null }, events);
  } else if (next.state === 'FAILED') {
    // Reconciled after a failure: stay stopped until the user resumes. Nothing is retried.
    next = { ...next, state: 'PAUSED', stateReason: `${next.stateReason ?? 'A batch did not succeed.'} Reconciled: resume to continue with the next batch.` };
  } else if (next.state === 'READY' || next.state === 'PAUSED') {
    const c = currentBatch(next);
    if (c && !isFinalStatus(c.status) && readiness(c) === 'EMPTY') next = makeCurrent(next, c.index, events);
  }
  return { queue: touch(next), events };
}

// ---------------------------------------------------------------------------
// What the UI shows
// ---------------------------------------------------------------------------

export interface QueueSummary {
  eligibleAtStart: number;
  batches: number;
  completedBatches: number;
  /** Batches not final (waiting, ready, under review or running). */
  openBatches: number;
  removed: number;
  skipped: number;
  needsReview: number;
  remainingPlanned: number;
}

export function summarize(q: CleanupQueue): QueueSummary {
  const items = q.batches.flatMap((b) => b.items);
  return {
    eligibleAtStart: q.eligibleAtStart,
    batches: q.batches.length,
    completedBatches: q.batches.filter((b) => b.status === 'SUCCESS').length,
    openBatches: q.batches.filter((b) => !isFinalStatus(b.status)).length,
    removed: items.filter((i) => i.status === 'REMOVED').length,
    skipped: items.filter((i) => i.status === 'SKIPPED').length,
    needsReview: items.filter((i) => ATTENTION_ITEM.includes(i.status)).length,
    remainingPlanned: q.batches.filter((b) => !isFinalStatus(b.status)).reduce((n, b) => n + plannedItems(b).length, 0),
  };
}

function summaryCounts(q: CleanupQueue): Record<string, number> {
  const s = summarize(q);
  return { removed: s.removed, skipped: s.skipped, needsReview: s.needsReview, remaining: s.remainingPlanned };
}

export interface QueueContext {
  tabId: number | null;
  scanSessionId: string | null;
  /** The mapped scan was used for a Trash (V1B / V2B), so its item ids no longer describe the list. */
  mappedRetired: boolean;
}

/** The state to show, and why the mapping can't be used (STALE), or null. */
export function queueView(q: CleanupQueue | null, ctx: QueueContext): { state: QueueState; stale: string | null } {
  if (!q) return { state: 'IDLE', stale: null };
  if (q.state === 'COMPLETE' || q.state === 'STOPPED') return { state: q.state, stale: null };
  const stale =
    q.staleReason ??
    (ctx.tabId !== null && ctx.tabId !== q.tabId ? 'the tester is connected to a different Facebook tab.' : null) ??
    (!ctx.scanSessionId ? 'there is no current scan (the tester was reopened, or Facebook reloaded).' : null) ??
    (ctx.scanSessionId !== q.mappedScan ? 'a new scan replaced the one the queue is mapped to.' : null) ??
    (ctx.mappedRetired ? 'the scan the queue is mapped to was used for a Trash action.' : null);
  const cur = currentBatch(q);
  // A running V2B batch finishes on its own checks; after a success Continue rescans anyway; FAILED offers the rescan itself.
  if ((cur && isRunningStatus(cur.status)) || q.state === 'BATCH_DONE' || q.state === 'FAILED') return { state: q.state, stale };
  return { state: stale ? 'STALE' : q.state, stale };
}

// ---------------------------------------------------------------------------
// Session-only persistence
// ---------------------------------------------------------------------------

export function looksLikeQueue(v: unknown): v is CleanupQueue {
  const q = v as CleanupQueue;
  return !!q && typeof q === 'object' && q.version === QUEUE_VERSION && typeof q.queueId === 'string' && Array.isArray(q.batches) && typeof q.tabId === 'number';
}

export async function loadQueue(): Promise<{ queue: CleanupQueue | null; log: QueueLogEntry[] }> {
  const got = await chrome.storage.session.get([QUEUE_KEY, QUEUE_LOG_KEY]);
  const log = Array.isArray(got[QUEUE_LOG_KEY]) ? (got[QUEUE_LOG_KEY] as QueueLogEntry[]) : [];
  return { queue: looksLikeQueue(got[QUEUE_KEY]) ? got[QUEUE_KEY] : null, log };
}

export async function saveQueue(queue: CleanupQueue | null, log: QueueLogEntry[]): Promise<void> {
  await chrome.storage.session.set({ [QUEUE_KEY]: queue, [QUEUE_LOG_KEY]: log.slice(-MAX_QUEUE_LOG) });
}

export function appendLog(log: QueueLogEntry[], queueId: string, events: Event[]): QueueLogEntry[] {
  if (events.length === 0) return log;
  const at = now();
  return [...log, ...events.map((e) => ({ ...e, timestamp: at, queueId }))].slice(-MAX_QUEUE_LOG);
}

/** Queue debug JSON: ids, permalinks, statuses and counts only (the queue stores no post text). */
export function queueDebugJson(q: CleanupQueue, ctx: QueueContext, log: QueueLogEntry[]): string {
  const view = queueView(q, ctx);
  return JSON.stringify(
    {
      queueId: q.queueId,
      state: view.state,
      storedState: q.state,
      stale: view.stale,
      stateReason: q.stateReason,
      tabId: q.tabId,
      builtFromScan: q.builtFromScan,
      mappedScan: q.mappedScan,
      currentScan: ctx.scanSessionId,
      currentBatch: q.currentIndex + 1,
      summary: summarize(q),
      batches: q.batches.map((b) => ({
        batch: batchNo(b),
        key: b.key,
        status: b.status,
        runBatchId: b.runBatchId,
        attempts: b.attempts,
        planned: b.items.length,
        reconciled: plannedItems(b).filter((i) => i.itemId !== null).length,
        invalid: invalidItems(b).length,
        preflight: b.preflight,
        result: b.result,
        note: b.note,
        items: b.items,
      })),
      log: log.filter((e) => e.queueId === q.queueId),
    },
    null,
    2,
  );
}
