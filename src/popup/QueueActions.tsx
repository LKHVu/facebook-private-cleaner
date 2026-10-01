/**
 * V3B popup UI: the Cleanup queue. Splits every eligible ONLY_ME post of the current scan into
 * batches of at most MAX_BATCH_SIZE and walks the user through them ONE AT A TIME.
 *
 *   Build cleanup queue   plan only (facebookQueue.ts): no checkbox, no scrolling, no Trash
 *   Review batch          hands the current batch to the V2B Cleanup batch panel as a plan in
 *                         REVIEW; its live preflight runs there. Every Facebook step after that
 *                         (select, Trash, Facebook's confirmation) is V2B's, each confirmed by the user.
 *   Continue to batch N   after a SUCCESS only: a fresh scan, reconciliation by permalink, then
 *                         batch N becomes current. It is NOT selected: the user reviews it again.
 *
 * There is deliberately no "run all": a success never starts the next batch, and a PARTIAL /
 * INCONCLUSIVE / FAILED batch stops the queue until the user rescans and resumes.
 * The queue lives in chrome.storage.session (useCleanupQueue) so it survives the tester closing.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActionState, BatchSnapshot, PopupRequest, ScanResult } from '../shared/types';
import { MAX_BATCH_SIZE, SCANNER_PROTOCOL, isBatchActive } from '../shared/types';
import { BUILD_ID } from '../shared/build';
import { PostLine, PostMeta, newPlan, planTo, type BatchPlan, type QueueLink } from './BatchActions';
import { fetchActionState } from './CheckboxActions';
import {
  ATTENTION_ITEM,
  QUEUE_KEY,
  QUEUE_LOG_KEY,
  appendLog,
  batchNo,
  buildQueue,
  currentBatch,
  endReview,
  excludeItems,
  invalidItems,
  isFinalStatus,
  isNotStarted,
  isRunningStatus,
  loadQueue,
  looksLikeQueue,
  markStale,
  partition,
  pauseQueue,
  plannedItems,
  queueBatchTargets,
  queueDebugJson,
  queueEligible,
  queueView,
  reconcile,
  recordPreflight,
  resumeQueue,
  saveQueue,
  skipCurrent,
  startReview,
  stopQueue,
  summarize,
  syncFromSnapshot,
  type Change,
  type CleanupQueue,
  type QueueBatch,
  type QueueBatchStatus,
  type QueueContext,
  type QueueLogEntry,
  type QueueState,
} from './facebookQueue';
import {
  MAX_AUTORUN_POSTS,
  RUN_KEY,
  loadRun,
  looksLikeRun,
  planRun,
  resumeNeedsReconcile,
  runOwnsQueue,
  sameApproval,
  type QueueRun,
  type RunPlan,
} from './facebookQueueRun';
import { RunApproval, RunPanel, runButtonLabel, sendRunRequest } from './QueueRun';
import { HighlightButton } from './HighlightButton';
import { normalizeResult, type SafeResult } from './normalize';

// ---------------------------------------------------------------------------
// The stored queue
// ---------------------------------------------------------------------------

export interface QueueApi {
  loaded: boolean;
  queue: CleanupQueue | null;
  /** Queue-level events (kept when a queue is discarded). */
  log: QueueLogEntry[];
  /** V4: the cleanup run (active, paused, or ended and not yet closed), or null. */
  run: QueueRun | null;
  /** The queue right now, including changes not yet rendered. */
  current(): CleanupQueue | null;
  /** Applies a change and persists it. Returns why it was refused, or null. */
  apply(fn: (q: CleanupQueue | null) => Change | string | null): string | null;
  /** Writes the in-memory queue to session storage now (before the background worker reads it). */
  flush(): Promise<void>;
  /** V4: a run is being started: refuse every change here until storage says who owns the queue. */
  claimForRun(on: boolean): void;
}

interface Stored {
  loaded: boolean;
  queue: CleanupQueue | null;
  log: QueueLogEntry[];
  run: QueueRun | null;
}

/**
 * Loads the queue from chrome.storage.session, keeps it in step with the V2B batch it started
 * (ActionState.batch), and marks it stale when the Facebook tab reloads, navigates or closes.
 *
 * V4: while a cleanup run owns the queue (runOwnsQueue), the background worker is its only
 * writer: every change here is refused, and the queue, log and run are taken from storage as the
 * worker writes them (it always writes the run with them). Afterwards this hook owns it again.
 */
export function useCleanupQueue(opts: { enabled: boolean; tabId: number | null; batchSnap: BatchSnapshot | null; onTabEvent(): void }): QueueApi {
  const { enabled, tabId, batchSnap } = opts;
  const [stored, setStored] = useState<Stored>({ loaded: false, queue: null, log: [], run: null });
  // Changes apply to the latest value at once (several can happen before React re-renders).
  const ref = useRef(stored);
  /** A run owns the queue (or is being started): no change is made here. */
  const owned = useRef(false);
  /** The worker's writes arrived before the first load: the load's (older) values are not used. */
  const adopted = useRef(false);
  const onTabEvent = useRef(opts.onTabEvent);
  onTabEvent.current = opts.onTabEvent;

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const set = (next: Stored) => {
      ref.current = next;
      owned.current = runOwnsQueue(next.run);
      setStored(next);
    };
    Promise.all([loadQueue(), loadRun()]).then(
      ([r, run]) => {
        if (live && !adopted.current) set({ loaded: true, ...r, run });
      },
      () => {
        if (live && !adopted.current) set({ loaded: true, queue: null, log: [], run: null });
      },
    );
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'session' || !(RUN_KEY in changes)) return;
      const cur = ref.current;
      const v = changes[RUN_KEY].newValue;
      const next: Stored = { ...cur, loaded: true, run: looksLikeRun(v) ? v : null };
      if (QUEUE_KEY in changes) next.queue = looksLikeQueue(changes[QUEUE_KEY].newValue) ? changes[QUEUE_KEY].newValue : null;
      if (QUEUE_LOG_KEY in changes) next.log = Array.isArray(changes[QUEUE_LOG_KEY].newValue) ? changes[QUEUE_LOG_KEY].newValue : cur.log;
      adopted.current = true;
      if (live) set(next);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => {
      live = false;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, [enabled]);

  const apply = useCallback((fn: (q: CleanupQueue | null) => Change | string | null): string | null => {
    const cur = ref.current;
    if (!cur.loaded) return 'the queue is still loading.';
    if (owned.current) return 'a cleanup run controls the queue right now.';
    const r = fn(cur.queue);
    if (r === null) return null;
    if (typeof r === 'string') return r;
    if (r.queue === cur.queue && r.events.length === 0) return null;
    const log = appendLog(cur.log, r.queue?.queueId ?? cur.queue?.queueId ?? '(none)', r.events);
    ref.current = { ...cur, loaded: true, queue: r.queue, log };
    setStored(ref.current);
    saveQueue(r.queue, log).catch(() => {}); // session storage only; the in-memory copy stays authoritative
    return null;
  }, []);

  const flush = useCallback(async () => {
    if (!owned.current) await saveQueue(ref.current.queue, ref.current.log);
  }, []);

  const claimForRun = useCallback((on: boolean) => {
    owned.current = on || runOwnsQueue(ref.current.run);
  }, []);

  // Follow the V2B batch this queue started (idempotent; every action-state poll lands here).
  useEffect(() => {
    if (batchSnap) apply((q) => (q ? syncFromSnapshot(q, batchSnap) : null));
  }, [apply, stored.loaded, stored.run?.state, batchSnap?.batchId, batchSnap?.state]);

  // A reload, navigation or closed tab: the scan's item ids are gone, so the queue needs a fresh scan + reconcile.
  // (While a run owns the queue the background worker records this itself.)
  useEffect(() => {
    if (!enabled || tabId === null) return;
    const stale = (why: string) => {
      // V4: while a cleanup run owns the queue, its background worker handles every tab event of its
      // tab (a same-page reload after a verified batch is part of its rescan); nothing is marked here.
      if (!owned.current) apply((q) => (q && q.tabId === tabId ? markStale(q, why) : null));
      onTabEvent.current();
    };
    const onUpdated = (id: number, info: chrome.tabs.OnUpdatedInfo) => {
      if (id !== tabId) return;
      if (info.url !== undefined) stale('the Facebook tab navigated.');
      else if (info.status === 'loading') stale('the Facebook tab reloaded.');
    };
    const onRemoved = (id: number) => {
      if (id === tabId) stale('the Facebook tab was closed.');
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    return () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    };
  }, [enabled, tabId, apply]);

  return { ...stored, current: () => ref.current.queue, apply, flush, claimForRun };
}

// ---------------------------------------------------------------------------
// Plans handed to the V2B Cleanup batch panel
// ---------------------------------------------------------------------------

/** The V2B plan for the batch's PLANNED posts, in scan order, with the scan's own permalinks. A reason if any is not in this scan. */
function planFor(b: QueueBatch, safe: SafeResult, runBatchId: string): BatchPlan | string {
  const t = queueBatchTargets(b, safe);
  if (typeof t === 'string') return t;
  const plan = { ...newPlan(safe.scanSessionId!, t.itemIds, t.permalinks), batchId: runBatchId };
  return planTo(plan, 'REVIEW');
}

/** What the Cleanup batch panel needs to route a queue batch's review back to the queue. */
export function queueLinkFor(api: QueueApi, safe: SafeResult | null, setPlan: (p: BatchPlan | null) => void): QueueLink | null {
  const q = api.queue;
  const b = q ? currentBatch(q) : null;
  if (!q || !b || !b.runBatchId || q.state === 'COMPLETE' || q.state === 'STOPPED') return null;
  const index = b.index;
  const runBatchId = b.runBatchId;
  return {
    batchId: runBatchId,
    label: `Queue batch ${batchNo(b)} of ${q.batches.length}`,
    onPreflight: (pf) => void api.apply((x) => (x ? recordPreflight(x, pf) : null)),
    onBack: () => {
      api.apply((x) => (x ? endReview(x) : null));
      setPlan(null);
    },
    onRemoveFailed: (ids, pf) => {
      const code = new Map(pf?.items.map((i) => [i.itemId, i.code]) ?? []);
      api.apply((x) =>
        x ? excludeItems(x, index, (i) => i.itemId !== null && ids.includes(i.itemId), (i) => `failed the preflight${code.get(i.itemId!) ? ` (${code.get(i.itemId!)})` : ''}`) : null,
      );
      // The smaller batch is reviewed again (same attempt: nothing was selected yet); nothing is pulled in from later batches.
      const nb = api.current()?.batches[index];
      const next = nb && nb.status === 'REVIEW' && safe ? planFor(nb, safe, runBatchId) : null;
      setPlan(next && typeof next !== 'string' ? next : null);
      if (!next || typeof next === 'string') api.apply((x) => (x ? endReview(x) : null));
    },
  };
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

interface Props {
  api: QueueApi;
  tabId: number | null;
  safe: SafeResult | null;
  protocolOk: boolean;
  actionState: ActionState | null;
  actionStateError: string | null;
  /** A V2B batch request is in flight. */
  busy: string | null;
  scanning: boolean;
  loadBlock: string | null;
  plan: BatchPlan | null;
  setPlan(p: BatchPlan | null): void;
  /** A completely fresh scan through the Workbench (the same as Scan posts). Null if it failed. */
  rescan(): Promise<ScanResult | null>;
  /** The forced row strategy ('' = auto): a cleanup run scans with it too. */
  strategy: string;
  /** Brings the Load more posts panel into view. */
  onLoadOlder(): void;
}

const STATE_TEXT: Record<QueueState, string> = {
  IDLE: 'No queue',
  READY: 'READY',
  RUNNING_BATCH: 'RUNNING BATCH',
  BATCH_DONE: 'BATCH DONE',
  PAUSED: 'PAUSED',
  FAILED: 'FAILED',
  COMPLETE: 'COMPLETE',
  STOPPED: 'STOPPED',
  STALE: 'STALE',
};

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function QueuePanel(p: Props) {
  const { api, tabId, safe, actionState, actionStateError, plan, setPlan } = p;
  const q = api.queue;
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limitText, setLimitText] = useState('');
  // V4: the cleanup run.
  const run = api.run;
  const runActive = runOwnsQueue(run);
  const [approving, setApproving] = useState<RunPlan | null>(null);
  const [starting, setStarting] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const scanSessionId = safe?.scanSessionId ?? null;
  const ctx: QueueContext = {
    tabId,
    scanSessionId,
    mappedRetired: !!q && !!actionState?.retiredSessions.includes(q.mappedScan),
  };
  const view = queueView(q, ctx);
  const cur = q ? currentBatch(q) : null;
  const snap = actionState?.batch ?? null;
  const v2bActive = !!snap && isBatchActive(snap.state) && !actionStateError;

  // A queue batch under review whose V2B plan is gone (a new scan, or the plan was cleared) is back to READY.
  useEffect(() => {
    if (!q || !cur || cur.status !== 'REVIEW' || p.busy || working) return;
    if (!plan || plan.batchId !== cur.runBatchId) api.apply((x) => (x ? endReview(x) : null));
  }, [q, cur?.status, cur?.runBatchId, plan?.batchId, p.busy, working]);

  /** Why nothing may be started from the queue now (the page must be quiet), or null. */
  const quietBlock =
    p.loadBlock ??
    (runActive ? 'a cleanup run is in progress.' : null) ??
    (starting ? 'starting the cleanup run…' : null) ??
    (tabId === null ? 'no Facebook tab connected.' : null) ??
    (!api.loaded ? 'loading the queue…' : null) ??
    (working ? working : null) ??
    (p.busy ? 'a cleanup batch step is running.' : null) ??
    (p.scanning ? 'a scan is running.' : null) ??
    (actionState?.locked ? `actions are locked: ${actionState.locked}` : null) ??
    (actionState?.pendingTrash ? 'a single-post Trash is waiting for confirmation. Confirm or cancel it first.' : null) ??
    (v2bActive ? `a cleanup batch is ${snap!.state} on Facebook. Finish or cancel it first.` : null);

  const scanBlock =
    !safe ? 'scan first.' :
    !p.protocolOk ? 'this scan came from a different scanner build. Reload the Facebook tab and scan again.' :
    !scanSessionId ? 'this scan has no session id. Scan again.' :
    actionState?.retiredSessions.includes(scanSessionId) ? 'this scan was used for a Trash action. Scan again.' :
    !actionState ? (actionStateError ? `could not read the action state (${actionStateError}).` : 'checking the action state…') :
    null;

  /** Returns true when the queue was reconciled with the fresh scan. */
  async function rescanAndReconcile(advanceAfter: boolean): Promise<boolean> {
    if (tabId === null || !q) return false;
    setError(null);
    setWorking(advanceAfter ? 'Running a fresh scan, then reconciling the queue by permalink…' : 'Rescanning, then reconciling the queue by permalink…');
    try {
      const r = await p.rescan();
      if (!r) {
        setError('The scan did not complete (see the scan error above). The queue is unchanged.');
        return false;
      }
      if (r.protocol !== SCANNER_PROTOCOL) {
        setError('This scan came from a different scanner build. Reload the Facebook tab and scan again. The queue is unchanged.');
        return false;
      }
      const fresh = normalizeResult(r);
      // The V2B batch as the Facebook tab sees it now: settles a batch whose progress this window lost.
      let batch: BatchSnapshot | null = null;
      try {
        batch = (await fetchActionState(tabId)).batch;
      } catch {
        batch = null;
      }
      setPlan(null);
      const why = api.apply((x) => (x ? reconcile(x, fresh, tabId, batch, advanceAfter) : null));
      if (why) setError(`Could not reconcile: ${why}`);
      return !why;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setWorking(null);
    }
  }

  function build() {
    if (!safe || tabId === null || quietBlock || scanBlock) return;
    setError(null);
    const n = Number.parseInt(limitText, 10);
    const limit = limitText.trim() === '' ? null : Number.isFinite(n) && n > 0 ? n : NaN;
    if (Number.isNaN(limit)) {
      setError('The limit must be a whole number above 0 (or empty for all eligible posts).');
      return;
    }
    const why = api.apply((old) => {
      if (old && old.state !== 'COMPLETE' && old.state !== 'STOPPED') return 'a queue already exists. Discard it first.';
      return buildQueue(safe, tabId, limit);
    });
    if (why) setError(`Could not build the queue: ${why}`);
  }

  function review() {
    if (!q || !cur || !safe || reviewBlock) return;
    setError(null);
    const runBatchId = crypto.randomUUID();
    const next = planFor(cur, safe, runBatchId);
    if (typeof next === 'string') {
      setError(`Cannot review: ${next}`);
      return;
    }
    api.apply((x) => (x ? startReview(x, runBatchId) : null));
    setPlan(next); // the V2B panel runs the live preflight now
  }

  function clearQueuePlan() {
    const b = api.current() ? currentBatch(api.current()!) : null;
    if (plan && b && plan.batchId === b.runBatchId) setPlan(null);
  }

  function discard() {
    if (quietBlock) return;
    clearQueuePlan();
    setError(null);
    api.apply((x) =>
      x ? { queue: null, events: [{ event: 'QUEUE_DISCARDED', batch: null, scanSessionId: x.mappedScan, counts: { removed: summarize(x).removed }, result: 'DISCARDED' }] } : null,
    );
  }

  const reviewBlock =
    !q || !cur ? 'no queue.' :
    quietBlock ??
    scanBlock ??
    (view.stale ? `the queue is stale: ${view.stale}` : null) ??
    (view.state !== 'READY' ? `the queue is ${STATE_TEXT[view.state]}.` : null) ??
    (cur.status === 'NEEDS_REVIEW' ? 'some posts in this batch need review. Remove them from the batch first.' : null) ??
    (cur.status !== 'READY' ? `the batch is ${cur.status}.` : null);

  // ------------------------------------------------------------------- V4: run remaining batches
  const lastRun = run && q && run.queueId === q.queueId ? run : null;
  const runPlan = q ? planRun(q) : null;
  const runBlock =
    !q ? 'no queue.' :
    quietBlock ??
    scanBlock ??
    (view.stale ? `the queue is stale: ${view.stale} Rescan and reconcile first.` : null) ??
    (view.state !== 'READY' && view.state !== 'PAUSED' ? `the queue is ${STATE_TEXT[view.state]}.` : null) ??
    (typeof runPlan === 'string' ? runPlan : null) ??
    resumeNeedsReconcile(lastRun, q);
  const approvalBlock =
    runBlock ??
    (approving && runPlan && typeof runPlan !== 'string' && !sameApproval(runPlan.approval, approving.approval) ? 'the queue changed since this screen opened. Cancel and review the run again.' : null);

  function openApproval() {
    if (runBlock || !runPlan || typeof runPlan === 'string') return;
    setRunError(null);
    setApproving(runPlan);
  }

  async function approveRun() {
    const cq = api.current();
    if (!approving || !cq || tabId === null || approvalBlock) return;
    const now = planRun(cq);
    if (typeof now === 'string' || !sameApproval(now.approval, approving.approval)) {
      setRunError('The queue changed since this screen opened. Review the run again.');
      setApproving(null);
      return;
    }
    setRunError(null);
    setStarting(true);
    try {
      setPlan(null);
      await api.flush();
      api.claimForRun(true); // from here the background worker owns the queue
      const why = await sendRunRequest({ type: 'FPC_RUN_START', tabId, approval: approving.approval, strategy: p.strategy || undefined, build: BUILD_ID });
      if (why) {
        api.claimForRun(false);
        setRunError(`The run did not start: ${why}`);
      } else setApproving(null);
    } finally {
      setStarting(false);
    }
  }

  async function runRequest(type: 'FPC_RUN_STOP' | 'FPC_RUN_RESUME' | 'FPC_RUN_END') {
    if (!run) return;
    setRunError(null);
    const why = await sendRunRequest({ type, runId: run.runId });
    if (why) setRunError(why);
  }

  /** "Rescan and resume": a fresh scan and reconciliation, then the approval screen again (never a silent restart). */
  async function rescanAndResume() {
    const cq = api.current();
    if (!cq) return;
    if (!(await rescanAndReconcile(cq.state === 'BATCH_DONE'))) return;
    const after = api.current();
    const next = after ? planRun(after) : 'no queue.';
    if (typeof next === 'string') setRunError(`Reconciled, but the remaining batches can't run: ${next}`);
    else setApproving(next);
  }

  const runPanel = lastRun && !lastRun.dismissed && (
    <RunPanel
      run={lastRun}
      queue={q}
      log={api.log}
      actionState={actionState}
      safe={safe}
      tabId={tabId}
      quietBlock={quietBlock}
      error={runError}
      onStop={() => void runRequest('FPC_RUN_STOP')}
      onResume={() => void runRequest('FPC_RUN_RESUME')}
      onEnd={() => void runRequest('FPC_RUN_END')}
      onRescanReconcile={() => void rescanAndReconcile(api.current()?.state === 'BATCH_DONE')}
      onRescanResume={() => void rescanAndResume()}
      onRescan={() => void p.rescan()}
      onLoadOlder={p.onLoadOlder}
      onApproveNew={openApproval}
      approveBlock={runBlock}
    />
  );

  let body;
  if (!api.loaded) {
    body = <p className="muted small">Loading the queue…</p>;
  } else if (!q) {
    body = <BuildView safe={safe} limitText={limitText} setLimitText={setLimitText} block={quietBlock ?? scanBlock} onBuild={build} />;
  } else {
    const s = summarize(q);
    const canDiscard = !quietBlock;
    body = (
      <>
        {runPanel}
        <QueueStateLine q={q} state={view.state} stale={runActive ? null : view.stale} />
        <SummaryTable q={q} />
        <BatchTable q={q} scanSessionId={scanSessionId} />
        {runActive ? (
          <p className="muted small">This queue is controlled by the cleanup run above. It is read-only until the run ends.</p>
        ) : approving ? (
          <RunApproval plan={approving} starting={starting} block={approvalBlock} onCancel={() => setApproving(null)} onApprove={() => void approveRun()} />
        ) : (
          <>
            <CurrentBatch
              q={q}
              state={view.state}
              stale={view.stale}
              safe={safe}
              plan={plan}
              reviewBlock={reviewBlock}
              quietBlock={quietBlock}
              onReview={review}
              onSkip={() => {
                clearQueuePlan();
                const why = api.apply((x) => (x ? skipCurrent(x) : null));
                if (why) setError(`Cannot skip: ${why}`);
              }}
              onPause={() => {
                clearQueuePlan();
                api.apply((x) => (x ? pauseQueue(x) : null));
              }}
              onResume={() => api.apply((x) => (x ? resumeQueue(x) : null))}
              onStop={() => {
                clearQueuePlan();
                api.apply((x) => (x ? stopQueue(x) : null));
              }}
              onRemoveInvalid={() => {
                if (!cur) return;
                api.apply((x) => (x ? excludeItems(x, cur.index, (i) => invalidItems(cur).includes(i), (i) => `removed from the batch: ${i.status}${i.note ? ` (${i.note})` : ''}`) : null));
              }}
              onContinue={() => void rescanAndReconcile(true)}
              onReconcile={() => void rescanAndReconcile(false)}
              onRescan={() => void p.rescan()}
            />
            {(view.state === 'READY' || view.state === 'PAUSED') && s.openBatches > 0 && (
              <RunOffer plan={runPlan} block={runBlock} error={runPanel ? null : runError} onOpen={openApproval} />
            )}
          </>
        )}
        {approving && runError && !runPanel && <p className="error small break">{runError}</p>}
        {!runActive && <AttentionList q={q} />}
        <div className="confirm-buttons batch-plan-buttons">
          <button className="secondary small" disabled={!canDiscard} onClick={discard} title="Forgets the plan. Nothing on Facebook changes.">
            Discard queue
          </button>
          {!canDiscard && <span className="muted small">Discard unavailable: {quietBlock}</span>}
        </div>
        {view.state !== 'COMPLETE' && view.state !== 'STOPPED' && s.openBatches > 0 && (
          <p className="muted small">Load more posts is unavailable while this queue exists. Discard it first; the queue only uses posts that were loaded when it was built.</p>
        )}
        <QueueDebug q={q} ctx={ctx} log={api.log} tabId={tabId} state={view.state} />
      </>
    );
  }

  return (
    <section className="queue-panel">
      <h3>Cleanup queue</h3>
      {body}
      {working && <p className="small muted" role="status">{working}</p>}
      {error && <p className="error small break">{error}</p>}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** V4: "Run remaining batches" (or "Run first N posts"). Opens the approval screen; nothing starts from here. */
function RunOffer(p: { plan: RunPlan | string | null; block: string | null; error: string | null; onOpen(): void }) {
  const plan = p.plan && typeof p.plan !== 'string' ? p.plan : null;
  return (
    <div className="run-offer">
      <div className="confirm-buttons batch-plan-buttons">
        <button className="confirm-go" disabled={!!p.block || !plan} onClick={p.onOpen} title="Shows what would run and asks for your approval. Nothing starts yet.">
          {plan ? runButtonLabel(plan) : 'Run remaining batches'}
        </button>
      </div>
      {plan && (
        <p className="small">
          {plan.approval.posts} posts in {plural(plan.approval.batches.length, 'batch')}
          {plan.capped ? ` (at most ${MAX_AUTORUN_POSTS} per run: ${plan.leftPosts} posts in ${plural(plan.leftBatches, 'batch')} stay for the next run)` : ''}.
        </p>
      )}
      {p.block && <p className="muted small">Run unavailable: {p.block}</p>}
      {p.error && <p className="error small break">{p.error}</p>}
      <p className="muted small">
        Approve the remaining batches once: each is still preflighted, selected, Trashed through Facebook's own dialog and verified, then the
        page is rescanned and the queue reconciled, one batch at a time. Any problem stops the run.
      </p>
    </div>
  );
}

function BuildView(p: { safe: SafeResult | null; limitText: string; setLimitText(s: string): void; block: string | null; onBuild(): void }) {
  if (!p.safe) return <p className="muted small">Scan first. The queue is built from the posts loaded when you build it.</p>;
  const eligible = queueEligible(p.safe);
  const onlyMe = p.safe.items.filter((it) => it.audience === 'ONLY_ME').length;
  const n = Number.parseInt(p.limitText, 10);
  const planned = p.limitText.trim() !== '' && Number.isFinite(n) && n > 0 ? Math.min(n, eligible.length) : eligible.length;
  const sizes = partition(Array.from({ length: planned }, (_, i) => i)).map((c) => c.length);
  return (
    <>
      <p>
        <strong>Eligible private posts: {eligible.length}</strong>{' '}
        <span className="muted small">
          of {onlyMe} ONLY_ME in this scan{onlyMe > eligible.length ? ` (${onlyMe - eligible.length} not eligible or needing review)` : ''}
        </span>
      </p>
      <p className="small">
        {planned > 0 ? (
          <>
            {plural(sizes.length, 'batch')} of up to {MAX_BATCH_SIZE}: {sizes.map((c, i) => `Batch ${i + 1}: ${c}`).join(' · ')}
          </>
        ) : (
          <span className="muted">No eligible post to queue.</span>
        )}
      </p>
      <label className="batch-toggle">
        <span className="small">Only the first</span>
        <input className="limit-input" type="number" min={1} inputMode="numeric" placeholder="all" value={p.limitText} onChange={(e) => p.setLimitText(e.target.value)} />
        <span className="small">eligible posts (optional, for testing)</span>
      </label>
      <div className="confirm-buttons batch-plan-buttons">
        <button className="confirm-go" disabled={!!p.block || planned === 0} onClick={p.onBuild}>
          Build cleanup queue
        </button>
      </div>
      {p.block && <p className="muted small">Unavailable: {p.block}</p>}
      <p className="muted small">
        Builds a plan only: no Facebook checkbox is touched, nothing is scrolled, nothing is moved. Each batch is then reviewed,
        selected and confirmed by you, one batch at a time.
      </p>
    </>
  );
}

const STATE_CLASS: Partial<Record<QueueState, string>> = { READY: 'ok', BATCH_DONE: 'ok', COMPLETE: 'ok', FAILED: 'error', STALE: 'warn', PAUSED: 'warn', STOPPED: 'muted' };

function QueueStateLine({ q, state, stale }: { q: CleanupQueue; state: QueueState; stale: string | null }) {
  return (
    <>
      <p>
        Queue <strong className={STATE_CLASS[state] ?? ''}>{STATE_TEXT[state]}</strong>{' '}
        <span className="muted small">
          built {new Date(q.createdAt).toLocaleTimeString()}
          {q.limit !== null ? ` · first ${q.limit} eligible only` : ''}
        </span>
      </p>
      {q.stateReason && state !== 'STALE' && <p className={`small break ${state === 'FAILED' ? 'error' : ''}`}>{q.stateReason}</p>}
      {stale && <p className="warn small break">Stale: {stale} The mapped item ids are not used until the queue is reconciled with a fresh scan.</p>}
    </>
  );
}

function SummaryTable({ q }: { q: CleanupQueue }) {
  const s = summarize(q);
  return (
    <table className="kv queue-summary">
      <tbody>
        <tr><th>Eligible at start</th><td>{s.eligibleAtStart}</td></tr>
        <tr><th>Batches</th><td>{s.batches} <span className="muted">(up to {MAX_BATCH_SIZE} each)</span></td></tr>
        <tr><th>Completed batches</th><td className={s.completedBatches === s.batches ? 'ok' : ''}>{s.completedBatches} / {s.batches}</td></tr>
        <tr><th>Successfully removed</th><td className={s.removed > 0 ? 'ok' : ''}>{s.removed} / {s.eligibleAtStart}</td></tr>
        <tr><th>Skipped</th><td>{s.skipped}</td></tr>
        <tr><th>Needs review</th><td className={s.needsReview === 0 ? '' : 'warn'}>{s.needsReview}</td></tr>
        <tr><th>Remaining planned</th><td>{s.remainingPlanned}</td></tr>
      </tbody>
    </table>
  );
}

const BATCH_STATUS_CLASS: Partial<Record<QueueBatchStatus, string>> = {
  READY: 'ok',
  SUCCESS: 'ok',
  NEEDS_REVIEW: 'warn',
  PARTIAL: 'error',
  INCONCLUSIVE: 'error',
  FAILED: 'error',
  SKIPPED: 'muted',
  WAITING: 'muted',
};

function BatchTable({ q, scanSessionId }: { q: CleanupQueue; scanSessionId: string | null }) {
  const mapped = scanSessionId === q.mappedScan;
  return (
    <div className="batch-scroll">
      <table className="grid queue-batches">
        <thead><tr><th>Batch</th><th>Posts</th><th>Status</th><th>Removed</th><th>Needs review</th></tr></thead>
        <tbody>
          {q.batches.map((b) => {
            const isCur = b.index === q.currentIndex && q.state !== 'COMPLETE' && q.state !== 'STOPPED';
            const removed = b.items.filter((i) => i.status === 'REMOVED').length;
            const attention = b.items.filter((i) => ATTENTION_ITEM.includes(i.status)).length;
            const open = !isFinalStatus(b.status);
            return (
              <tr key={b.key} className={isCur ? 'chosen' : ''}>
                <td>{isCur ? '▶ ' : ''}Batch {batchNo(b)}</td>
                <td>
                  {open ? plannedItems(b).length : b.items.length}
                  {open && plannedItems(b).length !== b.items.length && <span className="muted"> of {b.items.length}</span>}
                </td>
                <td className={BATCH_STATUS_CLASS[b.status] ?? ''}>
                  {b.status}
                  {b.status === 'REVIEW' && b.preflight && b.preflight.failed > 0 && <span className="error"> ({b.preflight.failed} failed preflight)</span>}
                  {open && !mapped && b.status !== 'WAITING' && <span className="warn"> · stale</span>}
                </td>
                <td>{b.result ? `${removed} / ${b.result.total}` : '—'}</td>
                <td className={attention > 0 ? 'warn' : ''}>{attention || '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CurrentBatch(p: {
  q: CleanupQueue;
  state: QueueState;
  stale: string | null;
  safe: SafeResult | null;
  plan: BatchPlan | null;
  reviewBlock: string | null;
  quietBlock: string | null;
  onReview(): void;
  onSkip(): void;
  onPause(): void;
  onResume(): void;
  onStop(): void;
  onRemoveInvalid(): void;
  onContinue(): void;
  onReconcile(): void;
  onRescan(): void;
}) {
  const { q, state } = p;
  const b = currentBatch(q)!;
  const n = batchNo(b);
  const total = q.batches.length;
  const s = summarize(q);
  const quiet = !p.quietBlock;
  const why = (block: string | null) => block && <p className="muted small">Unavailable: {block}</p>;

  if (state === 'COMPLETE') {
    return (
      <div className="outcome ok-box">
        <p className="ok"><strong>Cleanup queue complete</strong></p>
        <table className="kv">
          <tbody>
            <tr><th>Removed</th><td>{s.removed}</td></tr>
            <tr><th>Skipped</th><td>{s.skipped}</td></tr>
            <tr><th>Needs review</th><td className={s.needsReview === 0 ? '' : 'warn'}>{s.needsReview}</td></tr>
          </tbody>
        </table>
        <p className="small muted">Nothing more is loaded or moved automatically. Load older posts yourself and build a new queue if you want to continue.</p>
        <div className="confirm-buttons batch-plan-buttons">
          <button className="secondary" disabled={!quiet} onClick={p.onRescan}>Rescan Facebook</button>
        </div>
      </div>
    );
  }
  if (state === 'STOPPED') return <p className="small muted">This queue was stopped. No further batch will run from it. Discard it to build a new one.</p>;

  const reconcileButton = (label: string) => (
    <button className="confirm-go" disabled={!quiet} onClick={p.onReconcile} title="Runs a fresh scan, then matches every remaining post by its permalink. Nothing on Facebook is selected.">
      {label}
    </button>
  );

  if (state === 'BATCH_DONE') {
    const next = q.batches.find((x) => x.index > b.index && !isFinalStatus(x.status));
    return (
      <div className="outcome ok-box">
        <p className="ok"><strong>Batch {n} completed.</strong></p>
        <p>Removed: <strong>{b.result?.removed ?? 0} / {b.result?.total ?? 0}</strong></p>
        <p className="small muted">
          Facebook re-renders the Activity Log after a Trash. Continue runs a fresh scan and reconciles the remaining posts by permalink.
          Batch {next ? batchNo(next) : '?'} then waits for your review: nothing is selected automatically.
        </p>
        <div className="confirm-buttons batch-plan-buttons">
          <button className="confirm-go" disabled={!quiet} onClick={p.onContinue}>Continue to batch {next ? batchNo(next) : ''}</button>
        </div>
        {why(p.quietBlock)}
      </div>
    );
  }

  if (state === 'FAILED') {
    return (
      <div className="outcome error-box">
        <p><strong>{q.stateReason ?? `Batch ${n} did not succeed.`}</strong></p>
        <p className="small">Nothing is retried automatically, and no further batch starts. Rescan and reconcile to see where the posts are now.</p>
        <div className="confirm-buttons batch-plan-buttons">
          {reconcileButton('Rescan and reconcile')}
          <button className="secondary" disabled={!quiet} onClick={p.onStop}>Stop queue</button>
        </div>
        {why(p.quietBlock)}
      </div>
    );
  }

  if (state === 'STALE') {
    return (
      <div className="outcome error-box">
        <p><strong>The queue is stale.</strong></p>
        <p className="small break">{p.stale} It must be reconciled with a fresh scan (by permalink) before any batch can be reviewed.</p>
        <div className="confirm-buttons batch-plan-buttons">
          {reconcileButton('Rescan and reconcile queue')}
          {q.state !== 'PAUSED' && <button className="secondary" disabled={!quiet} onClick={p.onPause}>Pause queue</button>}
        </div>
        {why(p.quietBlock)}
      </div>
    );
  }

  const posts = plannedItems(b).map((i) => ({ id: i.itemId ?? '(unmapped)', item: i.itemId && p.safe ? p.safe.items.find((it) => it.itemId === i.itemId) ?? null : null }));
  const postList = (
    <details>
      <summary className="small">Posts in this batch ({posts.length})</summary>
      <ol className="batch-review batch-scroll">
        {posts.map((post, k) => (
          <PostLine key={`${post.id}:${k}`} n={k + 1} post={post} withLink>
            <br />
            <PostMeta item={post.item} />
          </PostLine>
        ))}
      </ol>
    </details>
  );
  const head = (
    <p>
      <strong>Current batch: {n} of {total}</strong> · {plural(plannedItems(b).length, 'post')} <span className={BATCH_STATUS_CLASS[b.status] ?? ''}>{b.status}</span>
    </p>
  );

  if (state === 'PAUSED') {
    return (
      <div className="confirm">
        {head}
        <p className="small">Queue paused. No batch starts until you resume. Facebook is unchanged.</p>
        <div className="confirm-buttons batch-plan-buttons">
          <button className="confirm-go" disabled={!quiet} onClick={p.onResume}>Resume queue</button>
          <button className="secondary" disabled={!quiet} onClick={p.onStop}>Stop queue</button>
        </div>
        {why(p.quietBlock)}
      </div>
    );
  }

  if (isRunningStatus(b.status)) {
    return (
      <div className="progress-box" role="status">
        {head}
        <p className="small">Batch {n} is running through the Cleanup batch panel below ({b.status}). Every Facebook step there still needs your confirmation.</p>
      </div>
    );
  }

  if (b.status === 'REVIEW') {
    const pf = b.preflight;
    return (
      <div className="confirm">
        {head}
        <p className="small">
          Under review in the <strong>Cleanup batch</strong> panel below.{' '}
          {pf ? (
            <span className={pf.failed === 0 && pf.pageProblems === 0 ? 'ok' : 'error'}>
              Preflight: {pf.ready} ready, {pf.failed} failed{pf.pageProblems > 0 ? ', page not ready' : ''}.
            </span>
          ) : (
            <span className="muted">Preflight running…</span>
          )}
        </p>
        {pf && pf.failed > 0 && <p className="small warn">This batch needs attention: remove the failed posts there ("Remove … from the batch"), or skip the batch.</p>}
        <div className="confirm-buttons batch-plan-buttons">
          <button className="secondary" disabled={!quiet} onClick={p.onSkip}>Skip batch</button>
          <button className="secondary" disabled={!quiet} onClick={p.onPause}>Pause queue</button>
        </div>
      </div>
    );
  }

  // READY / NEEDS_REVIEW
  const invalid = invalidItems(b);
  return (
    <div className="confirm">
      {head}
      {invalid.length > 0 && (
        <div className="outcome error-box">
          <p><strong>{plural(invalid.length, 'post')} in this batch could not be reconciled safely</strong></p>
          <ul className="small">
            {invalid.map((i) => (
              <li key={i.permalink} className="break">{i.status}: {i.note ?? ''} <a href={i.permalink} target="_blank" rel="noreferrer">{i.permalink}</a></li>
            ))}
          </ul>
          <p className="small">They will not be put into a batch. Remove them from this batch (no other post takes their place), or skip the batch.</p>
          <div className="confirm-buttons batch-plan-buttons">
            <button className="secondary small" disabled={!quiet} onClick={p.onRemoveInvalid}>Remove {plural(invalid.length, 'post')} from this batch</button>
          </div>
        </div>
      )}
      {postList}
      <div className="confirm-buttons batch-plan-buttons">
        <button className="confirm-go" disabled={!!p.reviewBlock} onClick={p.onReview} title="Opens the V2B review below and runs the live, read-only preflight. Nothing is selected.">
          Review batch
        </button>
        <button className="secondary" disabled={!quiet || !isNotStarted(b.status)} onClick={p.onSkip}>Skip batch</button>
        <button className="secondary" disabled={!quiet} onClick={p.onPause}>Pause queue</button>
      </div>
      {why(p.reviewBlock)}
    </div>
  );
}

function AttentionList({ q }: { q: CleanupQueue }) {
  const rows = q.batches.flatMap((b) => b.items.filter((i) => ATTENTION_ITEM.includes(i.status)).map((i) => ({ b, i })));
  if (rows.length === 0) return <p className="small muted">Queue items needing review: 0</p>;
  return (
    <details open={rows.length <= 5}>
      <summary className="small warn">Queue items needing review: {rows.length}</summary>
      <p className="muted small">Never retried or moved to another batch automatically.</p>
      <div className="batch-scroll">
        <table className="grid">
          <thead><tr><th>Batch</th><th>Status</th><th>Why</th><th>Post link</th></tr></thead>
          <tbody>
            {rows.map(({ b, i }) => (
              <tr key={`${b.key}:${i.permalink}`}>
                <td>{batchNo(b)}</td>
                <td className="warn">{i.status}</td>
                <td className="break small">{i.note ?? '—'}</td>
                <td className="break small"><a href={i.permalink} target="_blank" rel="noreferrer">{i.permalink}</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** Diagnostic: ids, scans, states and per-batch counts. No Facebook content. */
function QueueDebug({ q, ctx, log, tabId, state }: { q: CleanupQueue; ctx: QueueContext; log: QueueLogEntry[]; tabId: number | null; state: QueueState }) {
  const [copied, setCopied] = useState(false);
  const cur = currentBatch(q);
  const mapped = ctx.scanSessionId !== null && ctx.scanSessionId === q.mappedScan && state !== 'STALE';
  const ids = cur && mapped ? plannedItems(cur).map((i) => i.itemId).filter((x): x is string => !!x) : [];
  const highlight: PopupRequest | null =
    tabId !== null && mapped && ids.length > 0 && ids.length <= MAX_BATCH_SIZE && ctx.scanSessionId
      ? { type: 'FPC_BATCH_HIGHLIGHT_TAB', tabId, scanSessionId: ctx.scanSessionId, itemIds: ids }
      : null;
  const s = summarize(q);

  async function copy() {
    await navigator.clipboard.writeText(queueDebugJson(q, ctx, log));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <details className="batch-debug">
      <summary className="small">Queue debug</summary>
      <table className="kv queue-summary">
        <tbody>
          <tr><th>Queue ID</th><td><code>{q.queueId}</code></td></tr>
          <tr><th>Built from scan</th><td><code>{q.builtFromScan.slice(0, 8)}</code></td></tr>
          <tr><th>Mapped to scan</th><td><code>{q.mappedScan.slice(0, 8)}</code> <span className="muted">{new Date(q.mappedAt).toLocaleTimeString()}</span></td></tr>
          <tr><th>Current scan</th><td><code>{ctx.scanSessionId ? ctx.scanSessionId.slice(0, 8) : '—'}</code>{!mapped && <span className="warn"> (not the mapped scan)</span>}</td></tr>
          <tr><th>State</th><td>{state}{state !== q.state ? ` (stored ${q.state})` : ''}</td></tr>
          <tr><th>Current batch</th><td>{cur ? `${batchNo(cur)} · ${cur.status}${cur.runBatchId ? ` · run ${cur.runBatchId.slice(0, 8)} · attempt ${cur.attempts}` : ''}` : '—'}</td></tr>
          <tr><th>Batch count</th><td>{q.batches.length}</td></tr>
          <tr><th>Remaining items</th><td>{s.remainingPlanned}</td></tr>
          <tr><th>Tab</th><td>{q.tabId}</td></tr>
        </tbody>
      </table>
      <div className="batch-scroll">
        <table className="grid">
          <thead><tr><th>Batch</th><th>Planned permalinks</th><th>Reconciled items</th><th>Invalid</th><th>State</th></tr></thead>
          <tbody>
            {q.batches.map((b) => (
              <tr key={b.key}>
                <td>{batchNo(b)}</td>
                <td>{b.items.length}</td>
                <td>{mapped ? plannedItems(b).filter((i) => i.itemId !== null).length : '—'}</td>
                <td className={invalidItems(b).length > 0 ? 'warn' : ''}>{invalidItems(b).length}</td>
                <td>{b.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="confirm-buttons batch-plan-buttons">
        <HighlightButton request={highlight} label="Highlight current batch" />
        <button className="secondary small" onClick={copy}>{copied ? 'Copied ✓' : 'Copy queue debug JSON'}</button>
      </div>
    </details>
  );
}
