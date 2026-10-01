/**
 * V5 popup UI: "Clean up private posts", the guided full cleanup (Simple mode of the tester).
 *
 *   Step 1  Find older posts      V3A auto-load (read-only scrolling), then a fresh scan
 *   Step 2  Scan complete         counts and exceptions (Scan health's rules)
 *   Step 3  Cleanup plan          a V3B queue of every eligible ONLY_ME post (plan only)
 *   Step 4  Final approval        the one approval of the V4 run
 *   Run / result                  the V4 run, read from session storage like the run panel
 *
 * Nothing here talks to Facebook except through the existing requests: FPC_AUTOLOAD_START_TAB /
 * FPC_AUTOLOAD_STOP_TAB (V3A), the Workbench's scan (FPC_SCAN_TAB) and FPC_RUN_START / STOP /
 * RESUME / END (V4). Every queue change is a V3B function applied through useCleanupQueue, so the
 * queue log, the Developer mode panels and the background worker see exactly what a manual queue
 * would. The V4 worker re-checks the approval against the stored queue before it starts, and owns
 * the queue until the run ends.
 *
 * The flow's own state (guidedFlow.ts) lives in chrome.storage.session, so a reopened tester shows
 * the same step. A restored step never starts anything destructive by itself.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ActionState, AutoLoadRequest, AutoLoadResponse, AutoLoadSnapshot, Failure, PopupRequest, ScanResult } from '../shared/types';
import { AUTOLOAD_MAX_NO_GROWTH, MAX_AUTO_LOADED_ROWS, MAX_BATCH_SIZE, SCANNER_PROTOCOL, isAutoLoadActive, isBatchActive, isScannerNotRunningError } from '../shared/types';
import { BUILD_ID } from '../shared/build';
import { PostLine, PostMeta } from './BatchActions';
import { fetchActionState } from './CheckboxActions';
import { buildQueue, excludeItems, isFinalStatus, plannedItems, queueView, reconcile, summarize, type CleanupQueue, type Event, type QueueLogEntry } from './facebookQueue';
import {
  CONFIRM_COUNTDOWN_MS,
  MAX_AUTORUN_POSTS,
  RUN_STATE_TEXT,
  isRunEnded,
  planRun,
  resumeNeedsReconcile,
  runOwnsQueue,
  sameApproval,
  type QueueRun,
  type RunPlan,
} from './facebookQueueRun';
import {
  LOAD_CHOICES,
  STOP_REASON_TEXT,
  batchShape,
  loadFlow,
  newFlow,
  planLimit,
  remainingEligible,
  runOutcome,
  saveFlow,
  scanSummary,
  uncertainPermalinks,
  type GuidedFlow,
  type LoadChoice,
} from './guidedFlow';
import { normalizeResult, type SafeResult } from './normalize';
import { PostConfirmSummary, RunDebug, STOP_HINT, sendRunRequest, useCountdown } from './QueueRun';
import type { QueueApi } from './QueueActions';
import { ReviewList } from './ScanHealth';

/** How often the loading progress is read while V3A loads (same as the Load more posts panel). */
const PROGRESS_POLL_MS = 500;

// ---------------------------------------------------------------------------
// The stored flow
// ---------------------------------------------------------------------------

export interface GuidedApi {
  /** undefined while it is read from session storage; null = no guided cleanup (IDLE). */
  flow: GuidedFlow | null | undefined;
  /** The flow right now, including changes not yet rendered. */
  current(): GuidedFlow | null;
  /** Applies a change and persists it. */
  update(fn: (f: GuidedFlow | null) => GuidedFlow | null): void;
}

export function useGuidedFlow(): GuidedApi {
  const [flow, setFlow] = useState<GuidedFlow | null | undefined>(undefined);
  const ref = useRef<GuidedFlow | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const set = (f: GuidedFlow | null) => {
      if (!live || ref.current !== undefined) return;
      ref.current = f;
      setFlow(f);
    };
    loadFlow().then(set, () => set(null));
    return () => {
      live = false;
    };
  }, []);
  const update = useCallback((fn: (f: GuidedFlow | null) => GuidedFlow | null) => {
    if (ref.current === undefined) return;
    const next = fn(ref.current);
    if (next === ref.current) return;
    ref.current = next ? { ...next, updatedAt: new Date().toISOString() } : null;
    setFlow(ref.current);
    saveFlow(ref.current).catch(() => {}); // session storage only; the in-memory copy stays authoritative
  }, []);
  const current = useCallback(() => ref.current ?? null, []);
  return { flow, current, update };
}

// ---------------------------------------------------------------------------
// The guided cleanup
// ---------------------------------------------------------------------------

export interface GuidedProps {
  guided: GuidedApi;
  tabId: number | null;
  /** The connected tab is on the Facebook Activity Log. */
  activityLog: boolean;
  result: ScanResult | null;
  safe: SafeResult | null;
  scanning: boolean;
  scanError: string | null;
  /** Why the Workbench refuses a scan now, or null. */
  scanBlock: string | null;
  /** The Workbench's completely fresh scan (the same as Scan posts). Null if it failed or was refused. */
  scan(): Promise<ScanResult | null>;
  actionState: ActionState | null;
  actionStateError: string | null;
  refreshActionState(): Promise<void>;
  queueApi: QueueApi;
  /** The forced row strategy ('' = auto): loading and the run count rows like the scans do. */
  strategy: string;
  /** The background worker is another build: a run would be refused. */
  buildMismatch: boolean;
  /** V3A accepted the request and discarded the content script's scan: the Workbench drops its scan and plan. */
  onLoadStarted(): void;
  setLoadStarting(on: boolean): void;
  /** Drops the Workbench's V2B batch plan (the guided flow never uses one). */
  clearPlan(): void;
  onShowDeveloper(): void;
}

function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

const openQueue = (q: CleanupQueue | null): q is CleanupQueue => !!q && q.state !== 'COMPLETE' && q.state !== 'STOPPED';

export function GuidedCleanup(p: GuidedProps) {
  const { guided, tabId, safe, actionState, actionStateError, queueApi: api } = p;
  const flow = guided.flow;
  const latest = useRef(p);
  latest.current = p;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Step 4: exactly what the user is shown and approves (compared with the queue again on approval). */
  const [approving, setApproving] = useState<RunPlan | null>(null);
  const scanInFlight = useRef(false);
  const [scanFailure, setScanFailure] = useState<string | null>(null);

  const run = api.run;
  const q = api.queue;
  const ours = flow && q && flow.queueId === q.queueId ? q : null;
  /** The V4 run of this flow's queue. */
  const myRun = flow && run && (run.runId === flow.runId || (!flow.runId && !!flow.queueId && run.queueId === flow.queueId)) ? run : null;
  const batchSnap = actionState?.batch ?? null;
  const v2bActive = !!batchSnap && isBatchActive(batchSnap.state) && !actionStateError;
  const loadActive = isAutoLoadActive(actionState?.autoLoad?.state) && !actionStateError;

  /**
   * The Facebook tab is a valid page whose scanner simply isn't injected yet (fresh page load or
   * extension reload). Not unsafe: such a page has no lock, batch, pending Trash or loading run (they
   * live in the scanner), and the guided flow's first scan injects the scanner like Scan posts does.
   */
  const scannerAbsent = isScannerNotRunningError(actionStateError);

  /** Why nothing may be started now (the Facebook page must be quiet), or null. Mirrors the queue panel's checks. */
  const quietBlock =
    tabId === null ? 'no Facebook tab is connected.' :
    !p.activityLog ? 'the connected tab is not the Facebook Activity Log. Open Activity Log → Your posts in that tab.' :
    !api.loaded ? 'reading the saved cleanup state…' :
    busy ? busy :
    p.scanning ? 'a scan is running.' :
    runOwnsQueue(run) ? 'a cleanup run is in progress.' :
    scannerAbsent ? null :
    actionStateError ? `could not read the Facebook tab's state (${actionStateError}).` :
    !actionState ? 'checking the Facebook tab…' :
    actionState.locked ? `actions are locked in the Facebook tab: ${actionState.locked}` :
    actionState.pendingTrash ? 'a single-post Trash is waiting for confirmation (Developer mode).' :
    loadActive ? 'Facebook is loading older posts.' :
    v2bActive ? `a cleanup batch is ${batchSnap!.state} on Facebook. Finish or cancel it in Developer mode.` :
    null;
  const foreignQueue = openQueue(q) && (!flow || q.queueId !== flow.queueId) ? q : null;

  /** The scan the flow's current step belongs to is the Workbench's current scan, from this scanner build, and unused. */
  const scanOk =
    !scannerAbsent && !!safe && !!flow?.scanSessionId && safe.scanSessionId === flow.scanSessionId && p.result?.protocol === SCANNER_PROTOCOL &&
    !actionState?.retiredSessions.includes(flow.scanSessionId);

  // ------------------------------------------------------------------ queue helpers (V3B functions only)

  function discardQueue(queueId: string): string | null {
    return api.apply((x) => {
      if (!x || x.queueId !== queueId) return null;
      const events: Event[] = [{ event: 'QUEUE_DISCARDED', batch: null, scanSessionId: x.mappedScan, counts: { removed: summarize(x).removed }, result: 'DISCARDED:GUIDED' }];
      return { queue: null, events };
    });
  }

  /**
   * Retires this flow's queue: remembers the posts whose Trash outcome is unknown (never planned
   * again by this flow), and discards the queue if it is still open (a plan only: nothing on
   * Facebook changes). Returns why it could not, or null.
   */
  function retireFlowQueue(): string | null {
    const f = guided.current();
    const cq = api.current();
    if (!f || !cq || cq.queueId !== f.queueId) return null;
    const unc = uncertainPermalinks(latest.current.queueApi.run, cq);
    if (unc.some((u) => !f.uncertainPermalinks.includes(u))) {
      guided.update((x) => x && { ...x, uncertainPermalinks: [...new Set([...x.uncertainPermalinks, ...unc])] });
    }
    return openQueue(cq) ? discardQueue(cq.queueId) : null;
  }

  /** Closes this flow's ended V4 run panel (Developer mode shows it otherwise). */
  async function dismissRun(r: QueueRun | null) {
    if (r && isRunEnded(r) && !r.dismissed) await sendRunRequest({ type: 'FPC_RUN_END', runId: r.runId });
  }

  /**
   * Step 3: a new V3B queue of every eligible ONLY_ME post of `fresh` (V3B queueEligible), at most
   * the run cap (and the optional "first N"), minus posts an earlier run of this flow left uncertain.
   * Returns false (with the reason shown) when no plan was made.
   */
  function buildPlan(fresh: SafeResult, limit: number | null): boolean {
    if (tabId === null || !guided.current()) return false;
    setError(null);
    const why0 = retireFlowQueue();
    if (why0) {
      setError(`The previous plan could not be discarded: ${why0}`);
      return false;
    }
    if (openQueue(api.current())) {
      setError('A cleanup queue from Developer mode is still open. End this cleanup and discard it first.');
      return false;
    }
    latest.current.clearPlan();
    const f = guided.current()!;
    const skip = new Set(f.uncertainPermalinks);
    const base = { scanSessionId: fresh.scanSessionId, limit, runId: null, reconciledAt: null };
    if (remainingEligible(fresh, f) === 0) {
      guided.update((x) => x && { ...x, ...base, step: 'PLAN_READY', queueId: null });
      return true;
    }
    let newId: string | null = null;
    const why = api.apply((old) => {
      if (openQueue(old)) return 'a cleanup queue is already open.';
      const built = buildQueue(fresh, tabId, planLimit(limit));
      if (typeof built === 'string') return built;
      let next = built.queue!;
      const events = [...built.events];
      for (const b of built.queue!.batches) {
        if (!next.batches[b.index].items.some((i) => skip.has(i.permalink))) continue;
        const c = excludeItems(next, b.index, (i) => skip.has(i.permalink), () => 'its Trash outcome was not verified in an earlier run of this cleanup');
        next = c.queue!;
        events.push(...c.events);
      }
      newId = next.queueId;
      return { queue: next, events };
    });
    if (why || !newId) {
      setError(`Could not build the cleanup plan: ${why ?? 'unknown reason'}`);
      return false;
    }
    const id: string = newId;
    guided.update((x) => x && { ...x, ...base, step: 'PLAN_READY', queueId: id });
    return true;
  }

  // ------------------------------------------------------------------ effects

  // The V4 runner is authoritative: a run that owns the queue is shown (also one started in Developer mode).
  useEffect(() => {
    if (flow === undefined || !api.loaded || !run || !runOwnsQueue(run)) return;
    if (flow && flow.step === 'RUNNING' && flow.runId === run.runId) return;
    guided.update((f) => ({ ...(f ?? newFlow(run.tabId, 'RUNNING')), step: 'RUNNING', runId: run.runId, queueId: run.queueId }));
  }, [flow === undefined, flow?.step, flow?.runId, api.loaded, run?.runId, run?.state]);

  // The run ended: COMPLETE or STOPPED (recorded once).
  useEffect(() => {
    if (!flow || flow.step !== 'RUNNING' || !myRun || !isRunEnded(myRun)) return;
    const r = myRun;
    guided.update((f) =>
      f && f.step === 'RUNNING'
        ? {
            ...f,
            runId: r.runId,
            step: r.state === 'COMPLETE' ? 'COMPLETE' : 'STOPPED',
            runs: f.runs.some((x) => x.runId === r.runId) ? f.runs : [...f.runs, { runId: r.runId, state: r.state, removed: r.removedCount }],
          }
        : f,
    );
  }, [flow?.step, myRun?.runId, myRun?.state]);

  // A flow for another Facebook tab is not continued before a run exists (the scan and plan belong to that tab).
  useEffect(() => {
    if (!flow || tabId === null || flow.tabId === tabId) return;
    if (flow.step === 'RUNNING' || flow.step === 'STOPPED' || flow.step === 'COMPLETE') return;
    guided.update(() => null);
    setError('The tester is connected to a different Facebook tab: the guided cleanup started there was closed. Nothing on Facebook changed.');
  }, [flow?.tabId, flow?.step, tabId]);

  /**
   * Step 1 starts the Facebook scanner when it isn't running yet (fresh page / extension reload) or
   * there is no scan: one fresh read-only scan, the same request as Scan posts, which injects the
   * scanner. It also gives the "Currently loaded" count. Automatic once per guided cleanup; Try again after.
   */
  const [init, setInit] = useState<{ flowId: string; state: 'RUNNING' | 'DONE' | 'FAILED'; error: string | null } | null>(null);
  const needInit = !p.result || scannerAbsent;
  async function initScanner(flowId: string) {
    setInit({ flowId, state: 'RUNNING', error: null });
    const r = await latest.current.scan();
    const fail = (error: string | null) => setInit({ flowId, state: 'FAILED', error });
    if (!r) fail(null); // the scan's own error is shown (p.scanError)
    else if (r.protocol !== SCANNER_PROTOCOL) fail('An older copy of the scanner is still running in the Facebook tab. Refresh the Facebook tab, then try again.');
    else if (r.pageKind !== 'ACTIVITY_LOG') fail('The connected tab is not the Facebook Activity Log. Open Activity Log → Your posts in that tab, then try again.');
    else setInit({ flowId, state: 'DONE', error: null });
    await latest.current.refreshActionState();
  }
  useEffect(() => {
    if (flow?.step !== 'SETUP' || init?.flowId === flow.flowId || p.scanning || p.scanBlock || tabId === null || !p.activityLog) return;
    if (needInit) void initScanner(flow.flowId);
    else setInit({ flowId: flow.flowId, state: 'DONE', error: null });
  }, [flow?.step, flow?.flowId, init?.flowId, needInit, p.scanning, p.scanBlock, tabId, p.activityLog]);
  const initView = flow && init?.flowId === flow.flowId ? init : null;

  // Every step starts from the Facebook tab's current state (a batch or load started in Developer mode blocks it).
  useEffect(() => {
    void latest.current.refreshActionState();
  }, [flow?.step]);

  // LOADING (or a load started in Developer mode): follow V3A's published progress.
  const following = flow?.step === 'LOADING' || loadActive;
  useEffect(() => {
    if (!following) return;
    const t = window.setInterval(() => void latest.current.refreshActionState(), PROGRESS_POLL_MS);
    return () => window.clearInterval(t);
  }, [following]);
  const myLoad: AutoLoadSnapshot | null = flow?.step === 'LOADING' && actionState?.autoLoad?.runId === flow.autoLoadRunId ? actionState.autoLoad : null;
  // Loading stopped (finished, safety limit, or Stop): the existing fresh scan runs automatically.
  useEffect(() => {
    if (!myLoad || myLoad.state !== 'COMPLETE') return;
    guided.update((f) => (f && f.step === 'LOADING' && f.autoLoadRunId === myLoad.runId ? { ...f, step: 'SCANNING' } : f));
  }, [myLoad?.runId, myLoad?.state]);

  // SCANNING: one completely fresh scan, then the summary (or straight to the plan).
  useEffect(() => {
    if (flow?.step !== 'SCANNING' || scanInFlight.current || scanFailure || p.scanning || p.scanBlock || tabId === null) return;
    void doScan();
  }, [flow?.step, scanFailure, p.scanning, p.scanBlock, tabId]);

  async function doScan() {
    scanInFlight.current = true;
    setScanFailure(null);
    try {
      const r = await latest.current.scan();
      const f = guided.current();
      if (!f || f.step !== 'SCANNING') return;
      if (!r) {
        setScanFailure('The scan did not complete.');
        return;
      }
      if (r.protocol !== SCANNER_PROTOCOL) {
        setScanFailure('The scan came from an older copy of the scanner in the Facebook tab. Reload the extension at chrome://extensions, refresh the Facebook tab, and start again.');
        return;
      }
      const fresh = normalizeResult(r);
      if (!fresh.scanSessionId) {
        setScanFailure('The scan has no session id.');
        return;
      }
      // The scan (re)started the scanner if it wasn't running: read the tab's state before the next screen uses it.
      await latest.current.refreshActionState();
      if (guided.current()?.step !== 'SCANNING') return;
      if (f.afterScan === 'PLAN') {
        // Never retried by itself: the reason is shown, and Try again scans again.
        if (!buildPlan(fresh, f.limit)) setScanFailure('The cleanup plan could not be built.');
      } else guided.update((x) => x && { ...x, step: 'SUMMARY', scanSessionId: fresh.scanSessionId });
    } finally {
      scanInFlight.current = false;
    }
  }

  // Step 4 shows a snapshot taken when it opened; a restored Step 4 (nothing captured) goes back to Step 3.
  useEffect(() => {
    if (flow?.step === 'AWAITING_APPROVAL' && !approving) guided.update((f) => f && { ...f, step: 'PLAN_READY' });
  }, [flow?.step, !!approving]);

  // ------------------------------------------------------------------ actions

  function start() {
    if (tabId === null || quietBlock || foreignQueue) return;
    setError(null);
    setScanFailure(null);
    guided.update(() => newFlow(tabId));
  }

  async function startLoading(choice: LoadChoice) {
    if (tabId === null || quietBlock || foreignQueue || !guided.current()) return;
    setError(null);
    setScanFailure(null);
    if (choice === 'CURRENT') {
      guided.update((f) => f && { ...f, loadChoice: choice, step: 'SCANNING', afterScan: 'SUMMARY' });
      return;
    }
    const rows = LOAD_CHOICES.find((c) => c.value === choice)?.rows ?? null;
    setBusy('Starting to load older posts…');
    p.setLoadStarting(true);
    try {
      const request: AutoLoadRequest =
        rows === null
          ? { protocol: SCANNER_PROTOCOL, mode: 'UNTIL_END', strategy: p.strategy || undefined }
          : { protocol: SCANNER_PROTOCOL, mode: 'UP_TO', targetRows: rows, strategy: p.strategy || undefined };
      const msg: PopupRequest = { type: 'FPC_AUTOLOAD_START_TAB', tabId, request };
      const res: AutoLoadResponse | Failure | undefined = await chrome.runtime.sendMessage(msg);
      if (!res) throw new Error('No response from the background service worker.');
      if (!res.ok) {
        setError(`Loading refused (nothing was scrolled): ${res.error}${'code' in res ? ` (${res.code})` : ''}`);
        return;
      }
      p.onLoadStarted();
      const runId = res.autoLoad.runId;
      guided.update((f) => f && { ...f, loadChoice: choice, step: 'LOADING', autoLoadRunId: runId, afterScan: 'SUMMARY', scanSessionId: null });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      await latest.current.refreshActionState();
      latest.current.setLoadStarting(false);
      setBusy(null);
    }
  }

  async function stopLoading() {
    const snap = actionState?.autoLoad;
    if (tabId === null || !snap) return;
    try {
      const msg: PopupRequest = { type: 'FPC_AUTOLOAD_STOP_TAB', tabId, runId: snap.runId };
      const res: AutoLoadResponse | Failure | undefined = await chrome.runtime.sendMessage(msg);
      if (res && !res.ok) setError(res.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      await latest.current.refreshActionState();
    }
  }

  function rescanStep(afterScan: 'SUMMARY' | 'PLAN') {
    setError(null);
    setScanFailure(null);
    guided.update((f) => f && { ...f, step: 'SCANNING', afterScan });
  }

  function toApproval() {
    const cq = api.current();
    if (!cq || !flow || cq.queueId !== flow.queueId) return;
    const plan = planRun(cq);
    if (typeof plan === 'string') {
      setError(`The plan can't run: ${plan}`);
      return;
    }
    setError(null);
    setApproving(plan);
    guided.update((f) => f && { ...f, step: 'AWAITING_APPROVAL' });
  }

  function backToPlan() {
    setApproving(null);
    guided.update((f) => f && { ...f, step: 'PLAN_READY' });
  }

  async function approve() {
    const cq = api.current();
    if (!approving || !cq || !flow || cq.queueId !== flow.queueId || tabId === null || approvalBlock) return;
    const now = planRun(cq);
    if (typeof now === 'string' || !sameApproval(now.approval, approving.approval)) {
      setError('The plan changed since this screen opened. Review it again.');
      backToPlan();
      return;
    }
    setError(null);
    setBusy('Starting the cleanup run…');
    try {
      latest.current.clearPlan();
      await api.flush();
      api.claimForRun(true); // from here the background worker owns the queue
      const why = await sendRunRequest({ type: 'FPC_RUN_START', tabId, approval: approving.approval, strategy: p.strategy || undefined, build: BUILD_ID });
      if (why) {
        api.claimForRun(false);
        setError(`The run did not start: ${why}`);
      } else {
        setApproving(null);
        guided.update((f) => f && { ...f, step: 'RUNNING', runId: null });
      }
    } finally {
      setBusy(null);
    }
  }

  async function runRequest(type: 'FPC_RUN_STOP' | 'FPC_RUN_RESUME') {
    if (!myRun) return;
    setError(null);
    const why = await sendRunRequest({ type, runId: myRun.runId });
    if (why) setError(why);
  }

  /** "Clean remaining": a new plan from a NEW fresh scan (the finished run's mapping is never reused). */
  async function cleanRemaining() {
    if (quietBlock) return;
    await dismissRun(myRun);
    guided.update((f) => f && { ...f, limit: null });
    rescanStep('PLAN');
  }

  /** "Load older posts": back to Step 1 (the finished plan is retired first). */
  async function loadOlder() {
    if (quietBlock) return;
    await dismissRun(myRun);
    const why = retireFlowQueue();
    if (why) {
      setError(`The plan could not be closed: ${why}`);
      return;
    }
    setError(null);
    guided.update((f) => f && { ...f, step: 'SETUP', queueId: null, runId: null, scanSessionId: null, reconciledAt: null, limit: null });
  }

  /** Done / End cleanup / Cancel: the flow ends. An open plan of it is discarded when the page is quiet (nothing on Facebook changes). */
  async function endCleanup() {
    setApproving(null);
    await dismissRun(myRun);
    const f = guided.current();
    const cq = api.current();
    let kept: string | null = null;
    if (f && cq && cq.queueId === f.queueId && openQueue(cq)) {
      kept = quietBlock ?? discardQueue(cq.queueId);
    }
    guided.update(() => null);
    setScanFailure(null);
    setError(kept ? `The cleanup queue was kept because ${kept} Use Developer mode to inspect and discard it.` : null);
  }

  /** STOPPED: the V3B "Rescan and reconcile" of the stopped run's queue (read-only on Facebook). */
  async function rescanAndReconcile() {
    const cq = api.current();
    if (!cq || !flow || cq.queueId !== flow.queueId || tabId === null || quietBlock) return;
    setError(null);
    setBusy('Rescanning, then matching the remaining posts by permalink…');
    try {
      const r = await latest.current.scan();
      if (!r) {
        setError('The scan did not complete. The plan is unchanged.');
        return;
      }
      if (r.protocol !== SCANNER_PROTOCOL) {
        setError('The scan came from a different scanner build. Reload the Facebook tab. The plan is unchanged.');
        return;
      }
      const fresh = normalizeResult(r);
      let batch = null;
      try {
        batch = (await fetchActionState(tabId)).batch;
      } catch {
        batch = null;
      }
      latest.current.clearPlan();
      const why = api.apply((x) => (x ? reconcile(x, fresh, tabId, batch, x.state === 'BATCH_DONE') : null));
      if (why) setError(`Could not reconcile: ${why}`);
      else guided.update((f) => f && { ...f, reconciledAt: new Date().toISOString(), scanSessionId: fresh.scanSessionId });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  // ------------------------------------------------------------------ Step 4 readiness (the V4 worker checks it all again)

  const view = ours ? queueView(ours, { tabId, scanSessionId: safe?.scanSessionId ?? null, mappedRetired: !!actionState?.retiredSessions.includes(ours.mappedScan) }) : null;
  const approvalBlock =
    !ours || !view ? 'the cleanup plan is gone.' :
    p.buildMismatch ? 'the background service worker is a different build. Reload the extension at chrome://extensions, refresh the Facebook tab and reopen the tester.' :
    quietBlock ??
    (p.result?.protocol !== SCANNER_PROTOCOL ? 'the scan came from a different scanner build. Reload the Facebook tab.' : null) ??
    (view.stale ? `the plan no longer matches the page: ${view.stale}` : null) ??
    (view.state !== 'READY' ? `the plan is ${view.state}.` : null) ??
    (() => {
      const now = planRun(ours);
      if (typeof now === 'string') return now;
      return approving && !sameApproval(now.approval, approving.approval) ? 'the plan changed since this screen opened. Go back and review it again.' : null;
    })() ??
    resumeNeedsReconcile(run && run.queueId === ours.queueId ? run : null, ours);

  // ------------------------------------------------------------------ render

  let body: ReactNode;
  const step = flow === undefined ? null : flow?.step ?? 'IDLE';
  if (step === null) {
    body = <p className="muted small">Reading the saved cleanup state…</p>;
  } else if (step === 'IDLE' || !flow) {
    body = <IdleView quietBlock={quietBlock} scannerAbsent={scannerAbsent} foreign={foreignQueue} onStart={start} onDiscardForeign={() => foreignQueue && setError(discardQueue(foreignQueue.queueId))} onShowDeveloper={p.onShowDeveloper} />;
  } else if (step === 'SETUP') {
    body = (
      <SetupView
        loaded={p.result && p.result.protocol === SCANNER_PROTOCOL && !scannerAbsent ? p.result.total : null}
        scanning={p.scanning}
        init={initView ? initView.state : needInit ? 'RUNNING' : 'DONE'}
        initError={initView?.state === 'FAILED' ? initView.error ?? p.scanError ?? 'The scan did not complete.' : null}
        onRetryInit={() => flow && void initScanner(flow.flowId)}
        block={quietBlock ?? (foreignQueue ? 'a cleanup queue from Developer mode is still open.' : null)}
        initial={flow.loadChoice}
        onStart={(c) => void startLoading(c)}
        onCancel={() => void endCleanup()}
      />
    );
  } else if (step === 'LOADING') {
    body = (
      <LoadingView
        snap={myLoad}
        lost={actionStateError ?? (tabId === null ? 'the Facebook tab is disconnected.' : null)}
        onStop={() => void stopLoading()}
        onScanNow={() => rescanStep('SUMMARY')}
        onCancel={() => void endCleanup()}
      />
    );
  } else if (step === 'SCANNING') {
    body = (
      <div className="progress-box" role="status">
        <p className="step-label">Step 2 of 4</p>
        <p><strong>Scanning loaded posts…</strong></p>
        {!p.scanning && p.scanBlock && !scanFailure && <p className="muted small">Waiting: {p.scanBlock}</p>}
        {scanFailure && (
          <div className="outcome error-box">
            <p><strong>{scanFailure}</strong></p>
            {p.scanError && <p className="small break">{p.scanError}</p>}
            <div className="confirm-buttons batch-plan-buttons">
              <button className="confirm-go" onClick={() => setScanFailure(null)}>Try again</button>
              <button className="secondary" onClick={() => void endCleanup()}>Cancel</button>
            </div>
          </div>
        )}
        <p className="muted small">Read-only: nothing on Facebook is selected or changed.</p>
      </div>
    );
  } else if (step === 'SUMMARY') {
    body = scanOk ? (
      <SummaryView safe={safe!} flow={flow} tabId={tabId} block={quietBlock} onContinue={() => buildPlan(safe!, flow.limit)} onLoadOlder={() => void loadOlder()} onCancel={() => void endCleanup()} />
    ) : (
      <LostScan what="scan" onRescan={() => rescanStep('SUMMARY')} onCancel={() => void endCleanup()} block={quietBlock} />
    );
  } else if (step === 'PLAN_READY' || step === 'AWAITING_APPROVAL') {
    const planOk = scanOk && (flow.queueId === null || (!!ours && ours.mappedScan === flow.scanSessionId && !view?.stale));
    if (!planOk) {
      body = <LostScan what="plan" onRescan={() => { const why = retireFlowQueue(); if (why) setError(why); else rescanStep('PLAN'); }} onCancel={() => void endCleanup()} block={quietBlock} />;
    } else if (step === 'AWAITING_APPROVAL' && approving) {
      body = <ApprovalView plan={approving} block={approvalBlock} starting={busy === 'Starting the cleanup run…'} onCancel={backToPlan} onApprove={() => void approve()} />;
    } else {
      body = (
        <PlanView
          safe={safe!}
          flow={flow}
          queue={ours}
          tabId={tabId}
          block={quietBlock}
          onApplyLimit={(limit) => buildPlan(safe!, limit)}
          onContinue={toApproval}
          onLoadOlder={() => void loadOlder()}
          onCancel={() => void endCleanup()}
        />
      );
    }
  } else if (step === 'RUNNING') {
    body = myRun ? (
      <RunningView run={myRun} actionState={actionState} log={api.log} tabId={tabId} onStop={() => void runRequest('FPC_RUN_STOP')} onResume={() => void runRequest('FPC_RUN_RESUME')} />
    ) : (
      <div className="progress-box" role="status">
        <p><strong>Starting the cleanup run…</strong></p>
        {api.loaded && run === null && (
          <>
            <p className="small warn">No cleanup run is stored. If it never started, nothing on Facebook changed.</p>
            <div className="confirm-buttons batch-plan-buttons">
              <button className="secondary" onClick={() => void endCleanup()}>End cleanup</button>
            </div>
          </>
        )}
      </div>
    );
  } else if (step === 'COMPLETE' && myRun) {
    body = (
      <CompleteView
        run={myRun}
        queue={ours}
        flow={flow}
        remaining={remainingCount(safe, p.result, ours, myRun, flow, actionState)}
        block={quietBlock}
        log={api.log}
        onRescan={() => void latest.current.scan()}
        onCleanRemaining={() => void cleanRemaining()}
        onLoadOlder={() => void loadOlder()}
        onDone={() => void endCleanup()}
      />
    );
  } else if (step === 'STOPPED' && myRun) {
    body = (
      <StoppedView
        run={myRun}
        queue={ours}
        flow={flow}
        actionState={actionState}
        log={api.log}
        remaining={flow.reconciledAt && scanOk ? remainingEligible(safe!, flow) : null}
        block={quietBlock}
        onReconcile={() => void rescanAndReconcile()}
        onCleanRemaining={() => void cleanRemaining()}
        onEnd={() => void endCleanup()}
        onShowDeveloper={p.onShowDeveloper}
      />
    );
  } else {
    body = (
      <div className="outcome error-box">
        <p><strong>The cleanup run of this guided cleanup can no longer be found.</strong></p>
        <p className="small">Nothing is started automatically. Developer mode shows the queue and its log.</p>
        <div className="confirm-buttons batch-plan-buttons">
          <button className="secondary" onClick={() => void endCleanup()}>End cleanup</button>
        </div>
      </div>
    );
  }

  return (
    <section className="guided-panel">
      {body}
      {busy && step !== 'AWAITING_APPROVAL' && <p className="muted small" role="status">{busy}</p>}
      {error && <p className="error small break">{error}</p>}
      {p.buildMismatch && step !== 'AWAITING_APPROVAL' && (
        <p className="error small">The background worker is a different build: a cleanup run would be refused. Reload the extension, refresh the Facebook tab and reopen the tester.</p>
      )}
    </section>
  );
}

/** Eligible posts left in a scan taken after the run (its own final rescan, or a later one), or null when there is none. */
function remainingCount(safe: SafeResult | null, result: ScanResult | null, queue: CleanupQueue | null, run: QueueRun, flow: GuidedFlow, s: ActionState | null): number | null {
  if (!safe?.scanSessionId || result?.protocol !== SCANNER_PROTOCOL || s?.retiredSessions.includes(safe.scanSessionId)) return null;
  const afterRun = (queue && safe.scanSessionId === queue.mappedScan) || (!!run.endedAt && safe.scannedAt > run.endedAt);
  return afterRun ? remainingEligible(safe, flow) : null;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function StepHead({ n, title }: { n: number; title: string }) {
  return (
    <>
      <p className="step-label">Step {n} of 4</p>
      <h2 className="guided-title">{title}</h2>
    </>
  );
}

function IdleView(p: { quietBlock: string | null; scannerAbsent: boolean; foreign: CleanupQueue | null; onStart(): void; onDiscardForeign(): void; onShowDeveloper(): void }) {
  return (
    <div className="guided-idle">
      <button className="primary guided-start" disabled={!!p.quietBlock || !!p.foreign} onClick={p.onStart}>
        Clean up private posts
      </button>
      <p className="small muted">
        Finds your "Only me" posts on the Activity Log and moves them to Facebook Trash in verified batches, after one final approval. Nothing is
        changed until you approve the plan.
      </p>
      {p.scannerAbsent && !p.quietBlock && <p className="small muted">The Facebook page was (re)loaded: the scanner starts with a read-only scan when you begin.</p>}
      {p.foreign && (
        <div className="outcome error-box">
          <p><strong>A cleanup queue is still open</strong> <span className="small">({summarize(p.foreign).remainingPlanned} posts planned, built in Developer mode or by an earlier cleanup).</span></p>
          <p className="small">A guided cleanup builds its own plan. Discarding the open queue forgets that plan only: nothing on Facebook changes.</p>
          <div className="confirm-buttons batch-plan-buttons">
            <button className="secondary" disabled={!!p.quietBlock} onClick={p.onDiscardForeign}>Discard the open queue</button>
            <button className="secondary" onClick={p.onShowDeveloper}>Open Developer mode</button>
          </div>
        </div>
      )}
      {p.quietBlock && <p className="muted small">Unavailable: {p.quietBlock}</p>}
    </div>
  );
}

function SetupView(p: {
  loaded: number | null;
  scanning: boolean;
  init: 'RUNNING' | 'DONE' | 'FAILED';
  initError: string | null;
  onRetryInit(): void;
  block: string | null;
  initial: LoadChoice;
  onStart(c: LoadChoice): void;
  onCancel(): void;
}) {
  const [choice, setChoice] = useState<LoadChoice>(p.initial);
  if (p.init !== 'DONE') {
    return (
      <div className="guided-step">
        <StepHead n={1} title="Find older posts" />
        {p.init === 'RUNNING' ? (
          <div className="progress-box" role="status">
            <p><strong>Initializing scanner…</strong></p>
            <p className="muted small">A fresh read-only scan of the loaded posts. Nothing on Facebook is selected or changed.</p>
          </div>
        ) : (
          <div className="outcome error-box">
            <p><strong>Could not initialize Facebook scanner.</strong></p>
            {p.initError && <p className="small break">{p.initError}</p>}
            <div className="confirm-buttons batch-plan-buttons">
              <button className="secondary" onClick={p.onCancel}>Cancel</button>
              <button className="confirm-go" disabled={p.scanning} onClick={p.onRetryInit}>Try again</button>
            </div>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="guided-step">
      <StepHead n={1} title="Find older posts" />
      <p>
        Currently loaded: <strong>{p.loaded ?? (p.scanning ? 'counting…' : 'unknown')}</strong>
        {p.loaded !== null && <span className="muted small"> posts</span>}
      </p>
      <p>How far should we search?</p>
      <div className="choice-list" role="radiogroup">
        {LOAD_CHOICES.map((c) => (
          <label key={c.value} className="choice">
            <input type="radio" name="load-choice" checked={choice === c.value} onChange={() => setChoice(c.value)} />
            <span>{c.label}</span>
          </label>
        ))}
      </div>
      <p className="muted small">
        Loading only scrolls the Facebook page: nothing is selected or changed. It stops when Facebook adds no new posts {AUTOLOAD_MAX_NO_GROWTH} times in a
        row, and never loads more than {MAX_AUTO_LOADED_ROWS} posts. Keep the Facebook tab visible while it loads.
      </p>
      <div className="confirm-buttons batch-plan-buttons">
        <button className="secondary" onClick={p.onCancel}>Cancel</button>
        <button className="confirm-go" disabled={!!p.block} onClick={() => p.onStart(choice)}>Start</button>
      </div>
      {p.block && <p className="muted small">Unavailable: {p.block}</p>}
    </div>
  );
}

function LoadingView(p: { snap: AutoLoadSnapshot | null; lost: string | null; onStop(): void; onScanNow(): void; onCancel(): void }) {
  const { snap } = p;
  const active = !!snap && isAutoLoadActive(snap.state);
  return (
    <div className="guided-step">
      <StepHead n={1} title="Find older posts" />
      {active && snap ? (
        <div className="progress-box" role="status" aria-live="polite">
          <p><strong>{snap.state === 'STOPPING' ? 'Stopping after this attempt…' : 'Loading posts…'}</strong></p>
          <p className="big-number">{snap.currentRows} <span className="small muted">loaded</span></p>
          <p className={snap.addedRows > 0 ? 'ok' : 'muted'}>{snap.addedRows >= 0 ? '+' : ''}{snap.addedRows}</p>
          {snap.targetRows !== null && <progress value={Math.max(0, snap.currentRows - snap.startingRows)} max={Math.max(1, snap.targetRows - snap.startingRows)} />}
          <p className="muted small">
            {snap.targetRows !== null ? `Up to ${snap.targetRows} posts` : `Until Facebook stops returning posts (at most ${snap.maxRows})`}
            {snap.consecutiveNoGrowth > 0 ? ` · no new posts ${snap.consecutiveNoGrowth} / ${AUTOLOAD_MAX_NO_GROWTH}` : ''}
          </p>
          {snap.pageHidden && <p className="warn small">The Facebook tab is hidden. Facebook may not load older posts until it is visible again.</p>}
          <div className="confirm-buttons batch-plan-buttons">
            <button className="secondary" disabled={snap.state === 'STOPPING'} onClick={p.onStop}>Stop</button>
          </div>
          <p className="muted small">Stop keeps what is loaded and scans it.</p>
        </div>
      ) : snap && snap.state === 'FAILED' ? (
        <div className="outcome error-box">
          <p><strong>Loading stopped</strong> <code className="small">{snap.stopReason}</code></p>
          {snap.stopMessage && <p className="small break">{snap.stopMessage}</p>}
          <p className="small">{snap.currentRows} posts are loaded. Nothing on Facebook was changed.</p>
          <div className="confirm-buttons batch-plan-buttons">
            <button className="secondary" onClick={p.onCancel}>Cancel</button>
            <button className="confirm-go" onClick={p.onScanNow}>Scan what is loaded</button>
          </div>
        </div>
      ) : snap && snap.state === 'COMPLETE' ? (
        <p className="ok"><strong>Loading finished: {snap.currentRows} posts.</strong> Scanning…</p>
      ) : (
        <div className="progress-box">
          <p className="muted">{p.lost ? 'Loading progress is not available.' : 'Waiting for loading progress…'}</p>
          {p.lost && <p className="small warn break">{p.lost} If the Facebook tab was reloaded or navigated, loading has stopped.</p>}
          <div className="confirm-buttons batch-plan-buttons">
            <button className="secondary" onClick={p.onCancel}>Cancel</button>
            {p.lost && <button className="confirm-go" onClick={p.onScanNow}>Scan what is loaded</button>}
          </div>
        </div>
      )}
    </div>
  );
}

function LostScan(p: { what: 'scan' | 'plan'; block: string | null; onRescan(): void; onCancel(): void }) {
  return (
    <div className="outcome error-box">
      <p><strong>{p.what === 'scan' ? 'The scan is no longer current.' : 'The cleanup plan no longer matches the page.'}</strong></p>
      <p className="small">
        The tester was reopened, the Facebook tab reloaded, or another scan replaced it. A plan is never reused from an old scan: scan again
        {p.what === 'plan' ? ' and the plan is rebuilt from it (nothing is selected)' : ''}.
      </p>
      <div className="confirm-buttons batch-plan-buttons">
        <button className="secondary" onClick={p.onCancel}>Cancel</button>
        <button className="confirm-go" disabled={!!p.block} onClick={p.onRescan}>Scan again</button>
      </div>
      {p.block && <p className="muted small">Unavailable: {p.block}</p>}
    </div>
  );
}

function SummaryView(p: { safe: SafeResult; flow: GuidedFlow; tabId: number | null; block: string | null; onContinue(): void; onLoadOlder(): void; onCancel(): void }) {
  const s = scanSummary(p.safe);
  const [showReview, setShowReview] = useState(false);
  const cls = (v: number) => (v === s.scanned ? 'ok' : 'warn');
  const eligible = remainingEligible(p.safe, p.flow);
  return (
    <div className="guided-step">
      <StepHead n={2} title="Scan complete" />
      <table className="kv guided-kv">
        <tbody>
          <tr><th>Posts scanned</th><td><strong>{s.scanned}</strong></td></tr>
          <tr><th className="aud-ONLY_ME">Private / Only me</th><td><strong>{s.onlyMe}</strong></td></tr>
          <tr><th className="aud-FRIENDS">Friends</th><td>{s.friends}</td></tr>
          <tr><th className="aud-PUBLIC">Public</th><td>{s.public}</td></tr>
          <tr><th className="aud-UNKNOWN">Unknown</th><td className={s.unknown ? 'warn' : ''}>{s.unknown}</td></tr>
          <tr><th>Strong evidence</th><td className={cls(s.strong)}>{s.strong} / {s.scanned}</td></tr>
          <tr><th>Controls HIGH</th><td className={cls(s.controlsHigh)}>{s.controlsHigh} / {s.scanned}</td></tr>
          <tr><th>Needs review</th><td className={s.needsReview ? 'warn' : ''}>{s.needsReview}</td></tr>
        </tbody>
      </table>
      {s.needsReview > 0 && (
        <div className="outcome">
          <p className="warn">
            <strong>{plural(s.needsReview, 'post needs', 'posts need')} review.</strong> They are excluded from automatic cleanup.
          </p>
          <div className="confirm-buttons batch-plan-buttons">
            <button className="secondary small" onClick={() => setShowReview(!showReview)}>{showReview ? 'Hide exceptions' : 'Review exceptions'}</button>
          </div>
          {showReview && <ReviewList safe={p.safe} tabId={p.tabId} />}
        </div>
      )}
      {eligible === 0 ? (
        <>
          <p><strong>No eligible private posts in the loaded posts.</strong></p>
          <div className="confirm-buttons batch-plan-buttons">
            <button className="secondary" onClick={p.onCancel}>Done</button>
            <button className="confirm-go" disabled={!!p.block} onClick={p.onLoadOlder}>Load older posts</button>
          </div>
        </>
      ) : (
        <div className="confirm-buttons batch-plan-buttons">
          <button className="secondary" onClick={p.onCancel}>Cancel</button>
          <button className="confirm-go" disabled={!!p.block} onClick={p.onContinue}>Continue</button>
        </div>
      )}
      {p.block && <p className="muted small">Unavailable: {p.block}</p>}
    </div>
  );
}

function PlanView(p: {
  safe: SafeResult;
  flow: GuidedFlow;
  queue: CleanupQueue | null;
  tabId: number | null;
  block: string | null;
  onApplyLimit(limit: number | null): void;
  onContinue(): void;
  onLoadOlder(): void;
  onCancel(): void;
}) {
  const { safe, flow, queue } = p;
  const [showPosts, setShowPosts] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const [limitText, setLimitText] = useState(flow.limit !== null ? String(flow.limit) : '');
  const [limitError, setLimitError] = useState<string | null>(null);
  const s = scanSummary(safe);
  const eligible = remainingEligible(safe, flow);
  const open = queue ? queue.batches.filter((b) => !isFinalStatus(b.status)) : [];
  const sizes = open.map((b) => plannedItems(b).length);
  const planned = sizes.reduce((a, b) => a + b, 0);
  const excludedUncertain = queue ? queue.batches.flatMap((b) => b.items).filter((i) => i.status === 'EXCLUDED').length : 0;
  const left = Math.max(0, eligible - planned);
  const userLimited = flow.limit !== null && flow.limit < eligible;
  const capped = left > 0 && !userLimited;

  function applyLimit() {
    const t = limitText.trim();
    const n = Number.parseInt(t, 10);
    if (t !== '' && !(Number.isFinite(n) && n > 0 && String(n) === t)) {
      setLimitError('Enter a whole number above 0, or leave it empty for all eligible posts.');
      return;
    }
    setLimitError(null);
    p.onApplyLimit(t === '' ? null : n);
  }

  if (!queue || planned === 0) {
    return (
      <div className="guided-step">
        <StepHead n={3} title="Cleanup plan" />
        <p><strong>No eligible private posts to clean in the loaded posts.</strong></p>
        {s.excludedOnlyMe > 0 && <p className="small warn">{plural(s.excludedOnlyMe, 'Only me post needs', 'Only me posts need')} review and {s.excludedOnlyMe === 1 ? 'is' : 'are'} excluded.</p>}
        <div className="confirm-buttons batch-plan-buttons">
          <button className="secondary" onClick={p.onCancel}>Done</button>
          <button className="confirm-go" disabled={!!p.block} onClick={p.onLoadOlder}>Load older posts</button>
        </div>
      </div>
    );
  }

  const byId = new Map(safe.items.filter((it) => it.itemId).map((it) => [it.itemId!, it]));
  return (
    <div className="guided-step">
      <StepHead n={3} title="Cleanup plan" />
      <p className="big-line">Eligible private posts: <strong>{planned}</strong>{(userLimited || capped) && <span className="muted small"> of {eligible}</span>}</p>
      <div>
        <p>{plural(sizes.length, 'batch', 'batches')}:</p>
        <ul className="batch-sizes">
          {sizes.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
      </div>
      <p><strong>These posts will be moved to Facebook Trash.</strong> They will NOT be permanently deleted.</p>
      <p>
        Excluded / needs review: <strong className={s.excludedOnlyMe + excludedUncertain ? 'warn' : ''}>{s.excludedOnlyMe + excludedUncertain}</strong>
        {s.needsReview > 0 && (
          <button className="secondary small inline-button" onClick={() => setShowReview(!showReview)}>{showReview ? 'Hide' : 'Review exceptions'}</button>
        )}
      </p>
      {excludedUncertain > 0 && <p className="small warn">{plural(excludedUncertain, 'post', 'posts')} whose earlier Trash outcome was not verified {excludedUncertain === 1 ? 'is' : 'are'} left out.</p>}
      {showReview && <ReviewList safe={safe} tabId={p.tabId} />}
      {capped && (
        <div className="outcome warn-box">
          <p><strong>This run can clean the first {planned} posts.</strong></p>
          <p className="small">{plural(left, 'post', 'posts')} will remain for another cleanup run (at most {MAX_AUTORUN_POSTS} posts per run).</p>
        </div>
      )}
      {userLimited && <p className="small muted">Limited to the first {flow.limit} eligible posts. {plural(left, 'post', 'posts')} stay for a later run.</p>}
      <details className="guided-details">
        <summary className="small">Limit this run (optional, for testing)</summary>
        <label className="batch-toggle">
          <span className="small">Only the first</span>
          <input className="limit-input" type="number" min={1} inputMode="numeric" placeholder="all" value={limitText} onChange={(e) => setLimitText(e.target.value)} />
          <span className="small">eligible posts</span>
          <button className="secondary small" disabled={!!p.block} onClick={applyLimit}>Apply</button>
        </label>
        {limitError && <p className="error small">{limitError}</p>}
      </details>
      {showPosts && (
        <ol className="batch-review batch-scroll">
          {open.flatMap((b) => plannedItems(b)).map((i, k) => (
            <PostLine key={i.permalink} n={k + 1} post={{ id: i.itemId ?? '(unmapped)', item: i.itemId ? byId.get(i.itemId) ?? null : null }} withLink>
              <br />
              <PostMeta item={i.itemId ? byId.get(i.itemId) ?? null : null} />
            </PostLine>
          ))}
        </ol>
      )}
      <p className="muted small">Nothing on Facebook is selected yet.</p>
      <div className="confirm-buttons batch-plan-buttons">
        <button className="secondary" onClick={() => setShowPosts(!showPosts)}>{showPosts ? 'Hide posts' : 'Review posts'}</button>
        <button className="secondary" onClick={p.onCancel}>Cancel</button>
        <button className="confirm-go" disabled={!!p.block} onClick={p.onContinue}>{capped ? `Run first ${planned}` : 'Continue'}</button>
      </div>
      {p.block && <p className="muted small">Unavailable: {p.block}</p>}
    </div>
  );
}

function ApprovalView(p: { plan: RunPlan; block: string | null; starting: boolean; onCancel(): void; onApprove(): void }) {
  const a = p.plan.approval;
  const sizes = a.batches.map((b) => b.permalinks.length);
  return (
    <div className="confirm danger-box guided-step" role="alertdialog" aria-label={`Move ${a.posts} private posts to Trash?`}>
      <StepHead n={4} title="Final approval" />
      <p className="big-line"><strong>Move {plural(a.posts, 'private post', 'private posts')} to Trash?</strong></p>
      <table className="kv guided-kv">
        <tbody>
          <tr><th>Audience</th><td>ONLY_ME only</td></tr>
          <tr><th>Evidence</th><td>Strong only</td></tr>
          <tr><th>Batches</th><td>{batchShape(sizes)} <span className="muted small">(at most {MAX_BATCH_SIZE} each)</span></td></tr>
        </tbody>
      </table>
      {p.plan.capped && <p className="small warn">{plural(p.plan.leftPosts, 'post', 'posts')} in the plan stay for another run.</p>}
      <ul className="small guided-facts">
        <li>Posts needing review are excluded.</li>
        <li>Facebook may reload between batches. The extension will rescan and verify each batch.</li>
        <li>Each batch's Facebook Trash dialog is confirmed automatically after a {Math.round(CONFIRM_COUNTDOWN_MS / 1000)}-second countdown you can stop.</li>
        <li>The run will stop immediately on any unexpected state.</li>
        <li>Posts are moved to Facebook Trash, not permanently deleted.</li>
      </ul>
      <p className="small muted">Keep the Facebook tab visible: the run pauses before the next batch while it isn't.</p>
      {p.block && !p.starting && <p className="warn small">Cannot start: {p.block}</p>}
      <div className="confirm-buttons">
        <button className="secondary" autoFocus onClick={p.onCancel} disabled={p.starting}>Cancel</button>
        <button className="danger" disabled={p.starting || !!p.block} onClick={p.onApprove}>
          {p.starting ? 'Starting…' : `Move ${plural(a.posts, 'post', 'posts')} to Trash`}
        </button>
      </div>
    </div>
  );
}

/** The current V4 step in plain words (the exact state is in the technical details). */
function stepText(run: QueueRun, s: ActionState | null, countdown: number): ReactNode {
  const snap = s?.batch && s.batch.batchId === run.runBatchId ? s.batch : null;
  const pr = snap?.progress ?? null;
  const n = run.approved[run.currentBatchIndex]?.permalinks.length ?? 0;
  const prev = run.approved[run.currentBatchIndex - 1];
  switch (run.state) {
    case 'PREPARING':
      return 'Checking the page';
    case 'PREFLIGHTING':
      return 'Checking each post on the page (read-only)';
    case 'SELECTING':
      return pr && pr.total > 0 ? `Selecting ${pr.done} / ${pr.total}` : 'Selecting';
    case 'OPENING_DIALOG':
      return "Opening Facebook's Trash dialog";
    case 'COUNTDOWN':
      return <strong className="warn">Moving {plural(n, 'post', 'posts')} to Trash in {countdown}…</strong>;
    case 'CONFIRMING':
    case 'VERIFYING':
      return pr?.phase === 'VERIFYING' && pr.total > 0 ? `Verifying ${pr.done} / ${pr.total} moved to Trash` : 'Moving to Trash';
    case 'TAB_RELOADING':
      return 'Facebook reloaded the page. Waiting for the Activity Log…';
    case 'CONFIRM_RESULT_UNKNOWN':
    case 'POST_CONFIRM_VERIFY':
      return 'Facebook reloaded during the confirm. Verifying what happened (nothing is clicked again)…';
    case 'RESCANNING':
    case 'RECONCILING':
      return 'Rescanning and re-checking the remaining posts';
    case 'ADVANCING':
      return prev ? `Batch done · continuing…` : 'Continuing…';
    case 'ROLLING_BACK':
      return 'Stopping safely: cancelling and unselecting';
    default:
      return RUN_STATE_TEXT[run.state];
  }
}

function RunningView(p: { run: QueueRun; actionState: ActionState | null; log: QueueLogEntry[]; tabId: number | null; onStop(): void; onResume(): void }) {
  const { run } = p;
  const [details, setDetails] = useState(false);
  const countdown = useCountdown(run.state === 'COUNTDOWN' ? run.countdownEndsAt : null);
  const batch = Math.min(run.currentBatchIndex + 1, run.approved.length);
  async function showTab() {
    if (p.tabId === null) return;
    const tab = await chrome.tabs.update(p.tabId, { active: true });
    if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
  }
  const paused = run.state === 'PAUSED';
  return (
    <div className={`guided-step run-panel ${paused ? '' : 'running'}`} aria-live="polite">
      <h2 className="guided-title">{paused ? 'Cleanup paused' : 'Cleaning private posts…'}</h2>
      <p>Overall:</p>
      <p className="big-line"><strong>{run.removedCount} / {run.approvedPosts}</strong> moved to Trash</p>
      <progress value={run.removedCount} max={Math.max(1, run.approvedPosts)} />
      <p>Batch: <strong>{batch} / {run.approved.length}</strong></p>
      {paused ? (
        <>
          <p className="warn"><strong>{run.pauseReason ?? 'Paused.'}</strong></p>
          <p className="small">Nothing is selected. Resume rescans and re-checks the plan first, then continues.</p>
          <div className="confirm-buttons batch-plan-buttons">
            <button className="secondary" disabled={p.tabId === null} onClick={() => void showTab()}>Show Facebook tab</button>
            <button className="secondary" onClick={p.onStop}>Stop run</button>
            <button className="confirm-go" onClick={p.onResume}>Resume</button>
          </div>
        </>
      ) : (
        <>
          <p>Current step: {stepText(run, p.actionState, countdown)}</p>
          {run.confirm?.confirmResponseLost && run.confirm.postConfirmTargetsAbsent !== null && <PostConfirmSummary c={run.confirm} />}
          {run.stopRequestedAt ? (
            <p className="warn small"><strong>Stopping at the next safe point…</strong> {STOP_HINT[run.state] ?? ''}</p>
          ) : (
            <div className="confirm-buttons batch-plan-buttons">
              <button className="danger" onClick={p.onStop}>Stop run</button>
            </div>
          )}
          <p className="muted small">Keep the Facebook tab visible. The tester can be closed: the run continues in the background.</p>
        </>
      )}
      <div className="confirm-buttons batch-plan-buttons">
        <button className="secondary small" onClick={() => setDetails(!details)}>{details ? 'Hide technical details' : 'Show technical details'}</button>
      </div>
      {details && (
        <div className="run-inspect">
          <p className="small">State: <code>{run.state}</code>{STOP_HINT[run.state] ? <span className="muted"> · Stop now: {STOP_HINT[run.state]}</span> : null}</p>
          <RunDebug run={run} log={p.log} />
        </div>
      )}
    </div>
  );
}

function CompleteView(p: {
  run: QueueRun;
  queue: CleanupQueue | null;
  flow: GuidedFlow;
  remaining: number | null;
  block: string | null;
  log: QueueLogEntry[];
  onRescan(): void;
  onCleanRemaining(): void;
  onLoadOlder(): void;
  onDone(): void;
}) {
  const { run } = p;
  const o = runOutcome(run, p.queue);
  const [details, setDetails] = useState(false);
  const total = p.flow.runs.reduce((n, r) => n + r.removed, 0);
  return (
    <div className="guided-step run-panel ended-ok">
      <h2 className="guided-title ok">Cleanup finished</h2>
      <p className="big-line"><strong>{plural(o.removed, 'post', 'posts')} moved to Trash</strong></p>
      <table className="kv guided-kv">
        <tbody>
          <tr><th>Failed</th><td className={o.failed ? 'error' : ''}>{o.failed}</td></tr>
          <tr><th>Uncertain</th><td className={o.uncertain ? 'error' : ''}>{o.uncertain}</td></tr>
          <tr><th>Need review</th><td className={o.needsReview ? 'warn' : ''}>{o.needsReview}</td></tr>
        </tbody>
      </table>
      {p.flow.runs.length > 1 && <p className="small muted">This cleanup so far: {total} posts moved to Trash in {p.flow.runs.length} runs.</p>}
      {p.remaining === null ? (
        <p className="small">
          The remaining posts have not been counted since the run.{' '}
          <button className="secondary small inline-button" disabled={!!p.block} onClick={p.onRescan}>Rescan to count</button>
        </p>
      ) : p.remaining > 0 ? (
        <p><strong>{plural(p.remaining, 'eligible private post remains', 'eligible private posts remain')} loaded.</strong></p>
      ) : (
        <p className="muted">No eligible private posts remain in the loaded posts.</p>
      )}
      <p className="small muted">Moved posts are in Facebook's Trash, not permanently deleted.</p>
      <div className="confirm-buttons batch-plan-buttons">
        {p.remaining !== null && p.remaining > 0 && (
          <button className="confirm-go" disabled={!!p.block} onClick={p.onCleanRemaining} title="Rescans the page and builds a new plan. Nothing starts without your approval.">
            Clean remaining {p.remaining}
          </button>
        )}
        <button className="secondary" disabled={!!p.block} onClick={p.onLoadOlder}>Load older posts</button>
        <button className="secondary" onClick={p.onDone}>Done</button>
      </div>
      {p.block && <p className="muted small">Unavailable: {p.block}</p>}
      <div className="confirm-buttons batch-plan-buttons">
        <button className="secondary small" onClick={() => setDetails(!details)}>{details ? 'Hide technical details' : 'Show technical details'}</button>
      </div>
      {details && <RunDebug run={run} log={p.log} />}
    </div>
  );
}

function StoppedView(p: {
  run: QueueRun;
  queue: CleanupQueue | null;
  flow: GuidedFlow;
  actionState: ActionState | null;
  log: QueueLogEntry[];
  remaining: number | null;
  block: string | null;
  onReconcile(): void;
  onCleanRemaining(): void;
  onEnd(): void;
  onShowDeveloper(): void;
}) {
  const { run } = p;
  const [inspect, setInspect] = useState(false);
  const o = runOutcome(run, p.queue);
  const reason = run.stopReason ? STOP_REASON_TEXT[run.stopReason] : `The run ended ${run.state}.`;
  const snap = p.actionState?.batch ?? null;
  const stillActive = !!snap && isBatchActive(snap.state);
  const s = p.queue ? summarize(p.queue) : null;
  return (
    <div className="guided-step run-panel ended-bad">
      <h2 className={`guided-title ${run.uncertain ? 'error' : 'warn'}`}>{run.uncertain ? 'Cleanup stopped: please check Facebook' : 'Cleanup stopped safely'}</h2>
      <table className="kv guided-kv">
        <tbody>
          <tr><th>Removed before stop</th><td className="ok"><strong>{run.removedCount}</strong></td></tr>
          <tr><th>Remaining planned</th><td>{Math.max(0, run.approvedPosts - run.removedCount)}</td></tr>
          {o.uncertain > 0 && <tr><th>Uncertain</th><td className="error">{o.uncertain}</td></tr>}
          {o.failed > 0 && <tr><th>Not moved</th><td>{o.failed}</td></tr>}
        </tbody>
      </table>
      <p>Reason:</p>
      <p><strong>{reason}</strong> <code className="small">{run.stopReason ?? run.state}</code></p>
      {run.stopDetail && <p className="small break">{run.stopDetail}</p>}
      {run.uncertain && (
        <p className="error small">
          Facebook's state was not verified when the run stopped: a batch may still be selected, or Facebook's dialog open. Inspect the Facebook
          tab before anything else.
        </p>
      )}
      {stillActive && (
        <p className="error small">
          A cleanup batch is still {snap!.state} on Facebook. Open Developer mode and use the Cleanup batch panel to cancel and unselect it.
        </p>
      )}
      <p className="small"><strong>No action will be retried automatically.</strong></p>
      {p.flow.reconciledAt && s && (
        <div className="outcome ok-box">
          <p><strong>Rescanned and reconciled.</strong></p>
          <p className="small">
            Removed in this plan: {s.removed} · needing review: {s.needsReview}
            {p.remaining !== null ? ` · eligible private posts now loaded: ${p.remaining}` : ''}
          </p>
          {p.remaining !== null && p.remaining > 0 && (
            <div className="confirm-buttons batch-plan-buttons">
              <button className="confirm-go" disabled={!!p.block} onClick={p.onCleanRemaining} title="Rescans and builds a new plan. Posts whose outcome was not verified are left out. Nothing starts without your approval.">
                Clean remaining {p.remaining}
              </button>
            </div>
          )}
        </div>
      )}
      <div className="confirm-buttons batch-plan-buttons">
        <button className="secondary" onClick={() => setInspect(!inspect)}>{inspect ? 'Hide problem' : 'Inspect problem'}</button>
        <button className="confirm-go" disabled={!!p.block || !p.queue} onClick={p.onReconcile} title="A fresh scan, then every remaining post is matched again by permalink. Nothing is selected.">
          Rescan and reconcile
        </button>
        <button className="secondary" onClick={p.onEnd}>End cleanup</button>
      </div>
      {p.block && <p className="muted small">Unavailable: {p.block}</p>}
      {inspect && (
        <div className="run-inspect">
          <table className="kv guided-kv">
            <tbody>
              <tr><th>Stop code</th><td><code>{run.stopReason ?? '—'}</code></td></tr>
              <tr><th>Stopped while</th><td>{run.endedIn ?? '—'}</td></tr>
              <tr><th>Batch</th><td>{Math.min(run.currentBatchIndex + 1, run.approved.length)} / {run.approved.length}</td></tr>
              <tr><th>Facebook verified</th><td className={run.uncertain ? 'error' : 'ok'}>{run.uncertain ? 'no' : 'yes'}</td></tr>
              <tr><th>Batch on Facebook</th><td>{snap ? `${snap.state}${snap.batchId === run.runBatchId ? ' (this run)' : ''}` : '—'}</td></tr>
            </tbody>
          </table>
          {run.confirm?.confirmResponseLost && <PostConfirmSummary c={run.confirm} />}
          <RunDebug run={run} log={p.log} />
          <div className="confirm-buttons batch-plan-buttons">
            <button className="secondary small" onClick={p.onShowDeveloper}>Open Developer mode (queue, batch panel, logs)</button>
          </div>
        </div>
      )}
    </div>
  );
}
