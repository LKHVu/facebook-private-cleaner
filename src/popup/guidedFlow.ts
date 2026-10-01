/**
 * guidedFlow.ts
 *
 * V5 "Clean up private posts": the guided flow's data model, its pure helpers and its
 * session-only persistence. No React, no Facebook access. The flow only ORCHESTRATES the
 * validated modules: V3A loading (autoLoad.ts), the ordinary fresh scan, the V3B queue
 * (facebookQueue.ts: buildQueue, excludeItems, reconcile) and the V4 run (facebookQueueRun.ts +
 * background/queueRunner.ts). It adds no eligibility rule, no Facebook step and no safety check of
 * its own, and it never loosens one: everything it shows is computed by those modules.
 *
 *   IDLE               no guided cleanup (not stored)
 *   SETUP              Step 1: how far to load (nothing is loaded yet)
 *   LOADING            Step 1: V3A loads older posts (read-only scrolling)
 *   SCANNING           a completely fresh scan (read-only)
 *   SUMMARY            Step 2: scan summary and exceptions
 *   PLAN_READY         Step 3: a V3B queue of every eligible ONLY_ME post (plan only, nothing selected)
 *   AWAITING_APPROVAL  Step 4: the one final approval of the V4 run
 *   RUNNING            the V4 run (authoritative: the flow only displays it, and may ask it to stop)
 *   STOPPED            the V4 run ended without COMPLETE
 *   COMPLETE           the V4 run ended COMPLETE
 *
 * Stored in chrome.storage.session (GUIDED_KEY; cleared when the browser or the extension
 * restarts): ids, the step, the load choice, counts and the normalised permalinks of posts whose
 * Trash outcome was not verified. Never post text. Nothing destructive is ever started from a
 * restored state: a run starts only from the Step 4 button, and a paused run resumes only from
 * its own Resume button.
 */

import { MAX_AUTO_LOADED_ROWS } from '../shared/types';
import type { CleanupQueue } from './facebookQueue';
import { normalizePermalink, queueEligible } from './facebookQueue';
import type { QueueRun, RunStopReason } from './facebookQueueRun';
import { MAX_AUTORUN_POSTS } from './facebookQueueRun';
import type { SafeControl, SafeResult } from './normalize';
import { reviewReasons } from './safetyRules';

export const GUIDED_KEY = 'fpc:guidedFlow';
const GUIDED_VERSION = 1;

export type GuidedStep = 'IDLE' | 'SETUP' | 'LOADING' | 'SCANNING' | 'SUMMARY' | 'PLAN_READY' | 'AWAITING_APPROVAL' | 'RUNNING' | 'STOPPED' | 'COMPLETE';
type StoredStep = Exclude<GuidedStep, 'IDLE'>;

export type LoadChoice = 'CURRENT' | 'UP_TO_250' | 'UP_TO_500' | 'UNTIL_END';

export const LOAD_CHOICES: { value: LoadChoice; label: string; rows: number | null }[] = [
  { value: 'CURRENT', label: 'Current loaded posts only', rows: null },
  { value: 'UP_TO_250', label: 'Load up to 250 posts', rows: 250 },
  { value: 'UP_TO_500', label: `Load up to ${MAX_AUTO_LOADED_ROWS} posts`, rows: MAX_AUTO_LOADED_ROWS },
  { value: 'UNTIL_END', label: 'Load until Facebook stops returning posts', rows: null },
];

export interface GuidedRunRecord {
  runId: string;
  state: string;
  removed: number;
}

export interface GuidedFlow {
  version: number;
  flowId: string;
  /** The Facebook tab the flow works on. */
  tabId: number;
  step: StoredStep;
  startedAt: string;
  updatedAt: string;
  loadChoice: LoadChoice;
  /** The V3A run this flow started (LOADING). */
  autoLoadRunId: string | null;
  /** Where SCANNING goes next: the summary (Step 2), or straight to the plan (Clean remaining / rebuild). */
  afterScan: 'SUMMARY' | 'PLAN';
  /** The scan the summary / plan belongs to (id only). */
  scanSessionId: string | null;
  /** Optional "only the first N posts" (testing). The run cap applies on top. */
  limit: number | null;
  /** The V3B queue this flow built. */
  queueId: string | null;
  /** The V4 run of that queue, once it exists. */
  runId: string | null;
  /** V4 runs that ended in this flow. */
  runs: GuidedRunRecord[];
  /** Normalised permalinks whose Trash outcome was not verified by an earlier run of this flow: never planned again by it. */
  uncertainPermalinks: string[];
  /** The stopped run's queue was rescanned and reconciled (STOPPED screen). */
  reconciledAt: string | null;
}

const now = () => new Date().toISOString();

export function newFlow(tabId: number, step: StoredStep = 'SETUP'): GuidedFlow {
  const at = now();
  return {
    version: GUIDED_VERSION,
    flowId: crypto.randomUUID(),
    tabId,
    step,
    startedAt: at,
    updatedAt: at,
    loadChoice: 'CURRENT',
    autoLoadRunId: null,
    afterScan: 'SUMMARY',
    scanSessionId: null,
    limit: null,
    queueId: null,
    runId: null,
    runs: [],
    uncertainPermalinks: [],
    reconciledAt: null,
  };
}

export function stepNumber(step: GuidedStep): number | null {
  switch (step) {
    case 'SETUP':
    case 'LOADING':
      return 1;
    case 'SCANNING':
    case 'SUMMARY':
      return 2;
    case 'PLAN_READY':
      return 3;
    case 'AWAITING_APPROVAL':
      return 4;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Scan summary (counts only; the rules are Scan health's and the queue's)
// ---------------------------------------------------------------------------

export interface GuidedScanSummary {
  scanned: number;
  onlyMe: number;
  friends: number;
  public: number;
  unknown: number;
  strong: number;
  /** Checkbox AND menu HIGH, unambiguous. */
  controlsHigh: number;
  /** Scan health's "Items needing review" (any audience). */
  needsReview: number;
  /** ONLY_ME posts a cleanup queue may take (V3B queueEligible: V2B eligibility, no review reason, unique permalink). */
  eligible: number;
  /** ONLY_ME posts that are not eligible. */
  excludedOnlyMe: number;
}

/** Scan health's "HIGH": found, HIGH confidence, no ambiguous candidates. */
function isHigh(d: SafeControl | undefined): boolean {
  return !!d && d.found && d.confidence === 'HIGH' && d.ambiguousCandidates === 0;
}

export function scanSummary(safe: SafeResult): GuidedScanSummary {
  const items = safe.items;
  const by = (a: string) => items.filter((it) => it.audience === a).length;
  const onlyMe = by('ONLY_ME');
  const eligible = queueEligible(safe).length;
  return {
    scanned: items.length,
    onlyMe,
    friends: by('FRIENDS'),
    public: by('PUBLIC'),
    unknown: by('UNKNOWN'),
    strong: items.filter((it) => it.audienceBasis === 'strong' && it.audience !== 'UNKNOWN').length,
    controlsHigh: items.filter((it) => isHigh(it.controls?.checkbox) && isHigh(it.controls?.menuButton)).length,
    needsReview: items.filter((it) => reviewReasons(it).length > 0).length,
    eligible,
    excludedOnlyMe: onlyMe - eligible,
  };
}

/** Eligible posts of this scan the flow may still plan (not ones a run of it left uncertain). */
export function remainingEligible(safe: SafeResult, flow: GuidedFlow | null): number {
  const skip = new Set(flow?.uncertainPermalinks ?? []);
  return queueEligible(safe).filter((it) => !skip.has(normalizePermalink(it.controls!.permalink.href!))).length;
}

/** The size of a queue limit for a plan: the user's "first N" (if any), never above the run cap. */
export function planLimit(limit: number | null): number {
  return Math.min(limit ?? MAX_AUTORUN_POSTS, MAX_AUTORUN_POSTS);
}

/** "5 × 20" / "2 × 20 + 1 × 10". */
export function batchShape(sizes: number[]): string {
  const groups: { size: number; n: number }[] = [];
  for (const s of sizes) {
    const last = groups[groups.length - 1];
    if (last && last.size === s) last.n++;
    else groups.push({ size: s, n: 1 });
  }
  return groups.map((g) => `${g.n} × ${g.size}`).join(' + ');
}

// ---------------------------------------------------------------------------
// Run outcome (read from the V4 run and the V3B queue; counts only)
// ---------------------------------------------------------------------------

export interface RunOutcome {
  removed: number;
  /** Approved posts whose batch stopped before Facebook's Trash was confirmed. */
  failed: number;
  /** Approved posts whose Trash outcome was not verified. */
  uncertain: number;
  /** Approved posts that left the plan (MISSING / CHANGED / NEEDS_REVIEW / EXCLUDED). */
  needsReview: number;
  /** Approved posts still PLANNED (their batch never started). */
  notStarted: number;
}

export function runOutcome(run: QueueRun, queue: CleanupQueue | null): RunOutcome {
  const approved = new Set(run.approved.flatMap((a) => a.permalinks));
  const items = queue && queue.queueId === run.queueId ? queue.batches.flatMap((b) => b.items).filter((i) => approved.has(i.permalink)) : [];
  const count = (...s: string[]) => items.filter((i) => s.includes(i.status)).length;
  return {
    removed: run.removedCount,
    failed: count('NOT_REMOVED'),
    uncertain: count('UNCERTAIN'),
    needsReview: count('MISSING', 'CHANGED', 'NEEDS_REVIEW', 'EXCLUDED'),
    notStarted: count('PLANNED'),
  };
}

/**
 * Permalinks whose Trash outcome a stopped run left unknown: UNCERTAIN posts, and, when the run
 * ended uncertain, every not-removed post of the batch it was in. A later plan of the flow leaves
 * them out (they are never retried automatically, V3B / V4).
 */
export function uncertainPermalinks(run: QueueRun | null, queue: CleanupQueue): string[] {
  const out = new Set(queue.batches.flatMap((b) => b.items.filter((i) => i.status === 'UNCERTAIN').map((i) => i.permalink)));
  if (run && run.queueId === queue.queueId && run.uncertain) {
    const a = run.approved[run.currentBatchIndex];
    const b = a ? queue.batches.find((x) => x.key === a.key) : undefined;
    for (const i of b?.items ?? []) if (i.status !== 'REMOVED') out.add(i.permalink);
  }
  return [...out];
}

/** V4 stop reasons, in plain words. The code and the run's own detail are always shown next to it. */
export const STOP_REASON_TEXT: Record<RunStopReason, string> = {
  USER_STOPPED: 'You stopped the run.',
  INTERRUPTED: 'The extension was restarted during the run. It is never resumed automatically.',
  PREFLIGHT_FAILED: 'A post failed the live check before selection (it changed on Facebook, or its controls could not be confirmed).',
  SELECTION_FAILED: 'A checkbox could not be selected and verified.',
  SELECTED_COUNT_MISMATCH: 'Facebook reported a different number of selected posts than planned.',
  NON_TARGET_SELECTED: 'A post that was not in the batch became selected.',
  MASTER_FULLY_SELECTED: "Facebook's select-all checkbox became fully selected.",
  TOOLBAR_NOT_HIGH: "Facebook's bulk toolbar or its Trash button could not be identified with certainty.",
  DIALOG_FAILED: "Facebook's Trash dialog did not open as expected.",
  DIALOG_NOT_HIGH: "Facebook's Trash dialog could not be identified with certainty.",
  CONFIRM_REFUSED: "The final confirm was refused by the extension's safety checks.",
  BATCH_PARTIAL: 'Only some posts of a batch were verified moved to Trash.',
  BATCH_INCONCLUSIVE: 'The batch result could not be verified.',
  BATCH_FAILED: 'The batch failed.',
  SCAN_FAILED: 'A fresh scan did not complete.',
  RECONCILE_FAILED: 'The remaining posts could not be matched again after a rescan.',
  APPROVED_ITEM_CHANGED: 'An approved post changed (removed, no longer Only me, or needs review) after a rescan.',
  PLAN_CHANGED: 'The approved plan no longer matches the queue.',
  URL_CHANGED: 'The Facebook tab left the Activity Log page.',
  TAB_DISCONNECTED: 'The Facebook tab was closed, replaced or could not be reached.',
  TAB_RELOADED: 'Facebook reloaded the page where the run could not safely continue.',
  QUEUE_STALE: 'The plan no longer matches the page.',
  ACTIONS_LOCKED: 'Actions are locked in the Facebook tab.',
  PAGE_STATE_UNEXPECTED: 'The Facebook page was in an unexpected state.',
  ROLLBACK_INCOMPLETE: 'Stopping could not fully cancel and unselect the batch.',
  NO_RESPONSE: 'The Facebook tab did not answer.',
  INTERNAL_ERROR: 'An unexpected error occurred in the extension.',
};

// ---------------------------------------------------------------------------
// Session-only persistence (the tester window is its only writer)
// ---------------------------------------------------------------------------

export function looksLikeFlow(v: unknown): v is GuidedFlow {
  const f = v as GuidedFlow;
  return !!f && typeof f === 'object' && f.version === GUIDED_VERSION && typeof f.flowId === 'string' && typeof f.tabId === 'number' && typeof f.step === 'string' && Array.isArray(f.runs);
}

export async function loadFlow(): Promise<GuidedFlow | null> {
  const got = await chrome.storage.session.get(GUIDED_KEY);
  return looksLikeFlow(got[GUIDED_KEY]) ? got[GUIDED_KEY] : null;
}

export async function saveFlow(flow: GuidedFlow | null): Promise<void> {
  if (flow) await chrome.storage.session.set({ [GUIDED_KEY]: { ...flow, updatedAt: now() } });
  else await chrome.storage.session.remove(GUIDED_KEY);
}
