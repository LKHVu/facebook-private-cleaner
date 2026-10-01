import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ActionState, AutoLoadSnapshot, PopupRequest, RunBroadcast, ScanResponse, ScanResult, WorkerInfoResponse } from '../shared/types';
import { BUILD_ID } from '../shared/build';
import { AUDIENCES, MAX_BATCH_SIZE, SCANNER_PROTOCOL, isAutoLoadActive, isBatchActive } from '../shared/types';
import { ACTIVITY_LOG_YOUR_POSTS_URL, isActivityLogUrl, isFacebookUrl } from '../content/facebookSelectors';
import { AutoLoadPanel } from './AutoLoad';
import { BatchPanel, newPlan, togglePlanItem, type BatchPlan } from './BatchActions';
import { fetchActionState } from './CheckboxActions';
import { DebugPanel } from './DebugPanel';
import { ErrorBoundary, ErrorBox } from './ErrorBoundary';
import { runBatchLabel, runOwnsQueue } from './facebookQueueRun';
import { GuidedCleanup, useGuidedFlow } from './GuidedCleanup';
import { AUDIENCE_LABELS } from './labels';
import { normalizeResult, type SafeItem } from './normalize';
import { clearLastPopupError, readLastPopupError } from './popupErrors';
import { QueuePanel, queueLinkFor, useCleanupQueue } from './QueueActions';
import { ScanHealth } from './ScanHealth';
import { openTester } from './testerTarget';

interface ActiveTab {
  id: number;
  url: string | null;
}

type Status = { kind: 'idle' } | { kind: 'scanning' } | { kind: 'error'; message: string };

/**
 * The compact toolbar popup. Popups close as soon as they lose focus, so the full debug and
 * action UI lives in the persistent tester window (Tester.tsx); this only opens it, plus a quick scan.
 */
export function App() {
  const [tab, setTab] = useState<ActiveTab | null | undefined>(undefined);
  const [openError, setOpenError] = useState<string | null>(null);

  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => {
      setTab(t?.id !== undefined ? { id: t.id, url: t.url ?? null } : null);
    });
  }, []);

  const onFacebook = isFacebookUrl(tab?.url);
  const onActivityLog = isActivityLogUrl(tab?.url);

  function openActivityLog() {
    if (tab && onFacebook) chrome.tabs.update(tab.id, { url: ACTIVITY_LOG_YOUR_POSTS_URL });
    else chrome.tabs.create({ url: ACTIVITY_LOG_YOUR_POSTS_URL });
    window.close();
  }

  async function startTester() {
    if (!tab || !onActivityLog) return;
    setOpenError(null);
    try {
      await openTester(tab.id);
      window.close();
    } catch (e) {
      setOpenError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <main className="app">
      <Header />

      <section className="tab-status">
        {tab === undefined && <p className="muted">Checking active tab…</p>}
        {tab !== undefined && !onFacebook && (
          <>
            <p className="warn">The active tab is not facebook.com.</p>
            <button className="secondary" onClick={openActivityLog}>
              Open Activity Log → Your posts
            </button>
          </>
        )}
        {onFacebook && onActivityLog && <p className="ok">✓ Facebook Activity Log detected</p>}
        {onFacebook && !onActivityLog && (
          <>
            <p className="warn">Facebook detected, but this isn't the Activity Log. Scanning still works, but results are less reliable.</p>
            <button className="secondary" onClick={openActivityLog}>
              Go to Activity Log → Your posts
            </button>
          </>
        )}
      </section>

      <button className="primary" disabled={!onActivityLog} onClick={startTester}>
        Open persistent tester
      </button>
      <p className="muted small">
        {onActivityLog
          ? 'Opens a separate window that stays open and keeps working on this tab. Selecting and Trash are done there.'
          : 'Available on the Facebook Activity Log tab.'}
      </p>
      {openError && <p className="error">{openError}</p>}

      <Workbench tabId={onFacebook && tab ? tab.id : null} compact scanLabel="Scan quickly" />
    </main>
  );
}

export function Header() {
  return (
    <header>
      <h1>Facebook Private Cleaner</h1>
      <span className="badge" title={`Guided cleanup of Only me posts (load, scan, plan, one approval, verified batches of up to ${MAX_BATCH_SIZE} moved to Trash); Developer mode keeps every manual V0–V4 tool`}>V5 · guided cleanup · batch ≤ {MAX_BATCH_SIZE}</span>
    </header>
  );
}

/** V5: the tester's two faces. Simple: the guided cleanup only. Developer: every V0–V4 tool, unchanged. */
export type TesterMode = 'simple' | 'developer';

interface WorkbenchProps {
  /** The Facebook tab every request goes to, or null when there is none (all requests disabled). */
  tabId: number | null;
  /** Counts only: no debug panel, item list or actions. */
  compact?: boolean;
  scanLabel?: string;
  /** Tester only (ignored when compact). Defaults to Developer: everything below, as before V5. */
  mode?: TesterMode;
  /** The connected tab is on the Activity Log (the guided cleanup starts only there). */
  activityLog?: boolean;
  onModeChange?(mode: TesterMode): void;
}

/**
 * Scan button, counts and (unless compact) V3A Load more posts, the scan health, the V3B cleanup
 * queue, the V2A cleanup batch and the debug panel with the V1A / V1B actions.
 * V5 Simple mode shows the guided cleanup instead; it drives the same state (scan, queue, run).
 */
export function Workbench({ tabId, compact = false, scanLabel = 'Scan posts', mode = 'developer', activityLog = true, onModeChange }: WorkbenchProps) {
  const simple = !compact && mode === 'simple';
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [result, setResult] = useState<ScanResult | null>(null);
  const [strategy, setStrategy] = useState<string>(''); // '' = auto
  const safe = useMemo(() => (result ? normalizeResult(result) : null), [result]);
  const scanSessionId = safe?.scanSessionId ?? null;

  // The content script's lock, log, pending Trash and batch. Not used by the compact popup.
  const [actionState, setActionState] = useState<ActionState | null>(null);
  const [actionStateError, setActionStateError] = useState<string | null>(null);
  // The batch panel polls this while a step runs: an older answer arriving late must not replace a newer one.
  const stateRequests = useRef(0);
  const stateApplied = useRef(0);
  const refreshActionState = useCallback(async () => {
    if (tabId === null || compact) return;
    const mine = ++stateRequests.current;
    try {
      const state = await fetchActionState(tabId);
      if (mine < stateApplied.current) return;
      stateApplied.current = mine;
      setActionState(state);
      setActionStateError(null);
    } catch (e) {
      if (mine < stateApplied.current) return;
      stateApplied.current = mine;
      setActionStateError(e instanceof Error ? e.message : String(e));
    }
  }, [tabId, compact]);
  useEffect(() => {
    refreshActionState();
  }, [refreshActionState, scanSessionId]);

  // V2A: the extension-side batch plan (memory only) and whether a batch request is in flight.
  const [plan, setPlan] = useState<BatchPlan | null>(null);
  const [batchBusy, setBatchBusy] = useState<string | null>(null);
  useEffect(() => {
    setPlan((p) => (p && p.scanSessionId === scanSessionId ? p : null)); // a plan belongs to one scan
  }, [scanSessionId]);
  // V3A: while older entries load (or the start request is in flight) nothing else may run.
  // An unreadable action state (e.g. the tab was reloaded, which ends loading) doesn't keep it blocked.
  const [loadStarting, setLoadStarting] = useState(false);
  const loading = loadStarting || (isAutoLoadActive(actionState?.autoLoad?.state) && !actionStateError);
  const loadBlock = loading ? 'Facebook is currently loading older Activity Log entries.' : null;

  // V3B: the cleanup queue (session storage). While one is open, Auto-load and hand-picked batches wait.
  const queueApi = useCleanupQueue({ enabled: !compact, tabId, batchSnap: actionState?.batch ?? null, onTabEvent: refreshActionState });
  // V4: while a cleanup run owns the queue, the background worker drives Facebook: nothing else may start here.
  const run = queueApi.run;
  const runActive = runOwnsQueue(run);
  const runBlock = runActive && run ? `a cleanup run is ${run.state === 'PAUSED' ? 'paused' : 'running'} (${runBatchLabel(run)}). Stop it first.` : null;

  const batchState = actionState?.batch?.state ?? null;
  // An unreadable action state (e.g. the tab was reloaded, which ends any batch) doesn't keep scanning blocked:
  // the content script refuses a scan itself while a batch is active.
  const batchBlock =
    loadBlock ??
    runBlock ??
    (batchBusy ? 'a cleanup batch step is running.' : null) ??
    (isBatchActive(batchState) && !actionStateError ? `a cleanup batch is ${batchState}. Finish or cancel it in the Cleanup batch panel first.` : null);

  const queueOpen = !!queueApi.queue && queueApi.queue.state !== 'COMPLETE' && queueApi.queue.state !== 'STOPPED';
  const queueBlock = queueOpen ? 'a cleanup queue exists. Use it, or discard it in the Cleanup queue panel first.' : null;
  const loadStartBlock =
    tabId === null ? 'no Facebook tab connected.' :
    !actionState ? (actionStateError ? `could not read the action state (${actionStateError}).` : 'checking the action state…') :
    actionState.locked ? `actions are locked: ${actionState.locked}` :
    actionState.pendingTrash ? 'a single-post Trash is waiting for confirmation. Confirm or cancel it first.' :
    status.kind === 'scanning' ? 'a scan is running.' :
    batchBlock ?? queueBlock;
  const planEditBlock =
    batchBlock ??
    (plan?.state === 'REVIEW' ? 'the batch is under review. Cancel the review to change it.' : null) ??
    (actionState?.locked ? 'actions are locked.' : null) ??
    queueBlock;

  // V4: while a run is active, follow the Facebook tab's progress (the current batch's step and counts).
  useEffect(() => {
    if (!runActive || run?.state === 'PAUSED') return;
    const t = window.setInterval(() => void refreshActionState(), 500);
    return () => window.clearInterval(t);
  }, [runActive, run?.state, refreshActionState]);
  useEffect(() => {
    if (run) void refreshActionState();
  }, [run?.runId, run?.state]);

  // V4: the service worker that runs cleanup runs must be this build (Chrome keeps an old one running until the extension is reloaded).
  const [workerBuild, setWorkerBuild] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (compact) return;
    const msg: PopupRequest = { type: 'FPC_WORKER_INFO' };
    chrome.runtime.sendMessage(msg).then(
      (r: WorkerInfoResponse | undefined) => setWorkerBuild(r && r.ok ? r.build : null),
      () => setWorkerBuild(null),
    );
  }, [compact, run?.runId, run?.state]);
  const buildMismatch = !compact && workerBuild !== undefined && workerBuild !== BUILD_ID;

  // V4: the run's fresh scans replace this window's scan (handed over by message; never stored).
  useEffect(() => {
    if (compact || tabId === null) return;
    const listener = (msg: RunBroadcast, sender: chrome.runtime.MessageSender) => {
      if (sender.id !== chrome.runtime.id || sender.tab || msg?.type !== 'FPC_RUN_SCAN' || msg.tabId !== tabId) return;
      setResult(msg.result);
      setStatus({ kind: 'idle' });
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [compact, tabId]);

  function toggleBatch(item: SafeItem) {
    if (!scanSessionId || !safe || planEditBlock) return;
    const next = togglePlanItem(plan ?? newPlan(scanSessionId), item, safe.items);
    if (typeof next !== 'string') setPlan(next.itemIds.length > 0 ? next : null);
  }

  /** A completely fresh scan. Returns it (the V3B queue reconciles with it), or null if it failed. */
  async function scan(): Promise<ScanResult | null> {
    if (tabId === null || batchBlock) return null;
    // Nothing is merged with an earlier scan: the new result (and its scanSessionId) replaces it.
    setStatus({ kind: 'scanning' });
    try {
      const req: PopupRequest = { type: 'FPC_SCAN_TAB', tabId, strategy: strategy || undefined };
      const res: ScanResponse | undefined = await chrome.runtime.sendMessage(req);
      if (!res) throw new Error('No response from the background service worker.');
      if (!res.ok) throw new Error(res.error);
      setResult(res.result);
      setStatus({ kind: 'idle' });
      return res.result;
    } catch (e) {
      setStatus({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      return null;
    }
  }

  // V5: the guided cleanup's own state (session storage). Shown in Simple mode; Developer mode only mentions it.
  const guided = useGuidedFlow();
  const guidedStep = guided.flow?.step ?? null;

  if (simple) {
    return (
      <>
        {buildMismatch && (
          <p className="error small break">
            The background service worker is {workerBuild ? `build ${workerBuild}` : 'an older build'}, but this tester is build {BUILD_ID}. Reload the
            extension at chrome://extensions, then refresh the Facebook tab and reopen the tester.
          </p>
        )}
        <ErrorBoundary label="Guided cleanup">
          <GuidedCleanup
            guided={guided}
            tabId={tabId}
            activityLog={activityLog}
            result={result}
            safe={safe}
            scanning={status.kind === 'scanning'}
            scanError={status.kind === 'error' ? status.message : null}
            scanBlock={batchBlock}
            scan={scan}
            actionState={actionState}
            actionStateError={actionStateError}
            refreshActionState={refreshActionState}
            queueApi={queueApi}
            strategy={strategy}
            buildMismatch={buildMismatch}
            onLoadStarted={() => {
              // The content script has discarded its scan session: drop ours, and the plan built on it.
              setResult(null);
              setPlan(null);
              setStatus({ kind: 'idle' });
            }}
            setLoadStarting={setLoadStarting}
            clearPlan={() => setPlan(null)}
            onShowDeveloper={() => onModeChange?.('developer')}
          />
        </ErrorBoundary>
        <LastPopupError />
      </>
    );
  }

  // V4: a run (active, or ended and not closed) puts the queue and its run panel right under the scan button.
  const runShown = !!run && !run.dismissed && !!queueApi.queue && run.queueId === queueApi.queue.queueId;
  const queuePanel = (
    <ErrorBoundary label="Cleanup queue">
      <QueuePanel
        api={queueApi}
        tabId={tabId}
        safe={safe}
        protocolOk={result?.protocol === SCANNER_PROTOCOL}
        actionState={actionState}
        actionStateError={actionStateError}
        busy={batchBusy}
        scanning={status.kind === 'scanning'}
        loadBlock={loadBlock}
        plan={plan}
        setPlan={setPlan}
        rescan={scan}
        strategy={strategy}
        onLoadOlder={() => document.querySelector('.autoload-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
      />
    </ErrorBoundary>
  );

  return (
    <>
      {!compact && guidedStep && (
        <p className="warn small">
          A guided cleanup is open ({guidedStep.replace(/_/g, ' ').toLowerCase()}).{' '}
          <button className="secondary small" onClick={() => onModeChange?.('simple')}>Back to Simple mode</button>
        </p>
      )}
      <button className={compact ? 'secondary' : 'primary'} disabled={tabId === null || status.kind === 'scanning' || !!batchBlock} onClick={scan}>
        {status.kind === 'scanning' ? 'Scanning…' : scanLabel}
      </button>
      {batchBlock && <p className="warn small">Scanning is disabled: {batchBlock}</p>}
      {buildMismatch && (
        <p className="error small break">
          The background service worker is {workerBuild ? `build ${workerBuild}` : 'an older build'}, but this tester is build {BUILD_ID}. Reload the
          extension at chrome://extensions, then refresh the Facebook tab and reopen the tester. A cleanup run will not start until they match.
        </p>
      )}

      {!compact && runShown && queuePanel}

      {!compact && (
        <ErrorBoundary label="Load more posts">
          <AutoLoadPanel
            tabId={tabId}
            actionState={actionState}
            actionStateError={actionStateError}
            refreshActionState={refreshActionState}
            strategy={strategy}
            scannedRows={result && result.protocol === SCANNER_PROTOCOL ? result.total : null}
            planSize={plan?.itemIds.length ?? 0}
            blocker={loadStartBlock}
            scanning={status.kind === 'scanning'}
            setStarting={setLoadStarting}
            onStarted={() => {
              // The content script has discarded its scan session: drop ours, and the plan built on it.
              setResult(null);
              setPlan(null);
              setStatus({ kind: 'idle' });
            }}
            onFinished={(snap: AutoLoadSnapshot, scanAfter: boolean) => {
              if (scanAfter && snap.state === 'COMPLETE') void scan();
            }}
          />
        </ErrorBoundary>
      )}
      {compact && <p className="muted small">A scan here replaces the tester's scan in that tab: scan again in the tester afterwards.</p>}

      {status.kind === 'error' && <p className="error">{status.message}</p>}

      {result && (
        <ErrorBoundary label="Scan summary">
          {result.protocol !== SCANNER_PROTOCOL && (
            <p className="error">
              This result came from an older copy of the scanner still running in the Facebook tab. Reload the
              extension at chrome://extensions, refresh the Facebook tab, then scan again.
            </p>
          )}
          <section className="summary">
            <div className="total">
              <span className="num">{result.total}</span>
              <span className="label">total scanned</span>
            </div>
            <div className="counts">
              {AUDIENCES.map((a) => (
                <div key={a} className={`count aud-${a}`}>
                  <span className="num">{result.counts[a]}</span>
                  <span className="label">{AUDIENCE_LABELS[a]}</span>
                </div>
              ))}
            </div>
            <p className="muted small">
              Only items currently loaded on the page are scanned.{compact ? ' Scroll down on Facebook to load more, then scan again.' : ' Use Load more posts to load older ones.'}
            </p>
          </section>
          {result.warnings.length > 0 && (
            <ul className="warnings">
              {result.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
        </ErrorBoundary>
      )}

      {!compact && safe && (
        <ErrorBoundary label="Scan health">
          <ScanHealth safe={safe} tabId={tabId} />
        </ErrorBoundary>
      )}

      {!compact && !runShown && queuePanel}

      {!compact && (
        <ErrorBoundary label="Cleanup batch">
          <BatchPanel
            tabId={tabId}
            safe={safe}
            protocolOk={result?.protocol === SCANNER_PROTOCOL}
            actionState={actionState}
            actionStateError={actionStateError}
            refreshActionState={refreshActionState}
            plan={plan}
            setPlan={setPlan}
            busy={batchBusy}
            setBusy={setBatchBusy}
            loadBlock={loadBlock}
            queueLink={queueLinkFor(queueApi, safe, setPlan)}
            manualBlock={queueBlock}
            runBlock={runBlock}
          />
        </ErrorBoundary>
      )}

      {!compact && (
        <ErrorBoundary label="Developer / debug">
          <DebugPanel
            result={result}
            safe={safe}
            tabId={tabId}
            strategy={strategy}
            onStrategyChange={setStrategy}
            actionState={actionState}
            actionStateError={actionStateError}
            refreshActionState={refreshActionState}
            batchBlock={batchBlock}
            plan={plan}
            onToggleBatch={toggleBatch}
            batchEditBlock={planEditBlock}
            queueLog={queueApi.log}
          />
        </ErrorBoundary>
      )}

      <LastPopupError />
    </>
  );
}

/** Diagnostic only (temporary): the latest error recorded by popupErrors.ts, from this or an earlier popup session. */
function LastPopupError() {
  const [error, setError] = useState(readLastPopupError);
  if (!error) return null;
  return (
    <details className="last-error">
      <summary className="small">Last popup error · {new Date(error.at).toLocaleString()}</summary>
      <ErrorBox
        title="Last popup error"
        error={error}
        dismissLabel="Clear"
        onDismiss={() => {
          clearLastPopupError();
          setError(null);
        }}
      />
    </details>
  );
}
