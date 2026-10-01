/**
 * V4 popup UI: "Run remaining batches". The approval screen, and the run panel that follows the
 * run the background worker drives (background/queueRunner.ts). Everything shown here is read
 * from session storage (the run, the queue) and from the Facebook tab's action state (the current
 * batch's progress), so a reopened tester shows the same run. The panel only asks the worker to
 * start, stop, resume or close a run; it never sends a Facebook step itself.
 */

import { useEffect, useState, type ReactNode } from 'react';
import type { ActionState, PopupRequest, SimpleResponse } from '../shared/types';
import { BUILD_ID } from '../shared/build';
import { isBatchActive } from '../shared/types';
import { ResultView, type Post } from './BatchActions';
import { batchNo, isFinalStatus, summarize, type CleanupQueue, type QueueLogEntry } from './facebookQueue';
import {
  CONFIRM_COUNTDOWN_MS,
  MAX_AUTORUN_POSTS,
  RUN_STATE_TEXT,
  elapsedMs,
  isRunEnded,
  runBatchLabel,
  type QueueRun,
  type RunConfirmRecord,
  type RunPlan,
  type RunReloadInfo,
  type RunState,
} from './facebookQueueRun';
import type { SafeResult } from './normalize';

/** Sends a run request to the background worker. Returns why it was refused, or null. */
export async function sendRunRequest(msg: Extract<PopupRequest, { type: `FPC_RUN_${string}` }>): Promise<string | null> {
  try {
    const res: SimpleResponse | undefined = await chrome.runtime.sendMessage(msg);
    if (!res) return 'No response from the background service worker.';
    return res.ok ? null : res.error;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** The label of the button that opens the approval screen. */
export function runButtonLabel(plan: RunPlan): string {
  return plan.capped ? `Run first ${plan.approval.posts} posts` : 'Run remaining batches';
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

const CONFIRM_SECONDS = Math.round(CONFIRM_COUNTDOWN_MS / 1000);

const STOP_CONDITIONS = [
  'a post is no longer ONLY_ME',
  'a checkbox/control is no longer HIGH',
  'Facebook re-renders in an unsafe way',
  'a batch is PARTIAL / INCONCLUSIVE / FAILED',
  'a scan becomes stale',
  'the URL changes',
  'an unexpected checkbox is selected',
  'the Trash dialog cannot be verified',
];

export function RunApproval(p: { plan: RunPlan; starting: boolean; block: string | null; onCancel(): void; onApprove(): void }) {
  const { plan } = p;
  const a = plan.approval;
  const k = a.batches.length;
  return (
    <div className="confirm danger-box" role="alertdialog" aria-label="Run remaining cleanup queue?">
      <p><strong>Run remaining cleanup queue?</strong></p>
      <table className="kv queue-summary">
        <tbody>
          <tr><th>Remaining posts</th><td><strong>{plan.remainingPosts}</strong></td></tr>
          <tr><th>Remaining batches</th><td><strong>{plan.remainingBatches}</strong></td></tr>
          {plan.capped && (
            <>
              <tr><th>This run</th><td className="warn"><strong>{a.posts} posts in {plural(k, 'batch')}</strong> (batches {a.batches.map((b) => b.index + 1).join(', ')})</td></tr>
              <tr><th>Left for later</th><td>{plan.leftPosts} posts in {plural(plan.leftBatches, 'batch')}</td></tr>
            </>
          )}
        </tbody>
      </table>
      {plan.capped && (
        <p className="small warn">
          One run covers at most {MAX_AUTORUN_POSTS} posts (whole batches). The other {plan.leftPosts} stay in the queue for the next run.
        </p>
      )}
      <p className="small">The extension will process one verified batch at a time.</p>
      <p className="small">It will stop immediately if:</p>
      <ul className="small">
        {STOP_CONDITIONS.map((c) => <li key={c}>{c}</li>)}
      </ul>
      <p className="small">
        Only the {a.posts} posts listed in this queue now can be affected. Posts a later scan discovers are never added. Before each
        batch's final Facebook confirm there is a {CONFIRM_SECONDS}-second countdown you can stop.
      </p>
      <p className="small"><strong>Posts will be moved to Facebook Trash, not permanently deleted.</strong></p>
      <p className="small muted">Keep the Facebook tab visible: the run pauses before the next batch while it isn't.</p>
      {p.block && <p className="warn small">Cannot start: {p.block}</p>}
      <div className="confirm-buttons">
        <button className="secondary" autoFocus onClick={p.onCancel} disabled={p.starting}>Cancel</button>
        <button className="danger" disabled={p.starting || !!p.block} onClick={p.onApprove}>
          {p.starting ? 'Starting…' : plan.capped ? `Run first ${a.posts} posts (${plural(k, 'batch')})` : `Run ${k} remaining ${k === 1 ? 'batch' : 'batches'}`}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The run panel
// ---------------------------------------------------------------------------

/** What Stop does in each state (V4 §10). */
export const STOP_HINT: Partial<Record<RunState, string>> = {
  PREPARING: 'Stops now. Nothing is selected.',
  PREFLIGHTING: 'Stops after this read-only check. Nothing is selected.',
  SELECTING: 'Finishes the current checkbox, then unselects the batch (verified) and stops.',
  OPENING_DIALOG: "Waits for Facebook's dialog, cancels it, unselects the batch and stops.",
  COUNTDOWN: "Does NOT click confirm: cancels Facebook's dialog, unselects the batch and stops.",
  CONFIRMING: "Facebook's confirm was already clicked: finishes the verification, then stops.",
  VERIFYING: 'Finishes the verification, then stops.',
  TAB_RELOADING: 'Stops now. The last batch was already verified; nothing is selected.',
  CONFIRM_RESULT_UNKNOWN: 'Finishes finding out what Facebook did (read-only, nothing is clicked), then stops.',
  POST_CONFIRM_VERIFY: 'Finishes finding out what Facebook did (read-only, nothing is clicked), then stops.',
  RESCANNING: 'Finishes this read-only scan, then stops.',
  RECONCILING: 'Finishes this read-only step, then stops.',
  ADVANCING: 'Stops now. The next batch does not start.',
};

interface PanelProps {
  run: QueueRun;
  queue: CleanupQueue | null;
  log: QueueLogEntry[];
  actionState: ActionState | null;
  safe: SafeResult | null;
  tabId: number | null;
  /** Why a queue action (rescan / reconcile) can't run now, or null. */
  quietBlock: string | null;
  /** The worker said no, or a request failed. */
  error: string | null;
  onStop(): void;
  onResume(): void;
  onEnd(): void;
  onRescanReconcile(): void;
  onRescanResume(): void;
  onRescan(): void;
  onLoadOlder(): void;
  /** Opens the approval screen for a new run of the queue's remaining batches. */
  onApproveNew(): void;
  /** Why a new run can't be approved now, or null. */
  approveBlock: string | null;
}

export function RunPanel(p: PanelProps) {
  const { run } = p;
  let body: ReactNode;
  if (run.state === 'COMPLETE') body = <CompleteView {...p} />;
  else if (isRunEnded(run)) body = <StoppedView {...p} />;
  else if (run.state === 'PAUSED') body = <PausedView {...p} />;
  else body = <RunningView {...p} />;
  return (
    <section className={`run-panel ${isRunEnded(run) ? (run.state === 'COMPLETE' ? 'ended-ok' : 'ended-bad') : 'running'}`} aria-live="polite">
      {body}
      {p.error && <p className="error small break">{p.error}</p>}
      <RunDebug run={run} log={p.log} />
    </section>
  );
}

function Overall({ run }: { run: QueueRun }) {
  return (
    <>
      <p>
        Overall: <strong>{run.removedCount} / {run.approvedPosts}</strong> removed
      </p>
      <progress value={run.removedCount} max={Math.max(1, run.approvedPosts)} />
    </>
  );
}

function RunningView(p: PanelProps) {
  const { run, actionState } = p;
  const a = run.approved[run.currentBatchIndex];
  const n = a?.permalinks.length ?? 0;
  const snap = actionState?.batch ?? null;
  const progress = snap && snap.batchId === run.runBatchId ? snap.progress : null;
  const countdown = useCountdown(run.state === 'COUNTDOWN' ? run.countdownEndsAt : null);
  const prev = run.approved[run.currentBatchIndex - 1];

  let step: ReactNode = RUN_STATE_TEXT[run.state];
  if (run.state === 'CONFIRMING' && progress?.phase === 'VERIFYING') step = RUN_STATE_TEXT.VERIFYING;
  const reload = run.reload ?? null;
  if (run.state === 'TAB_RELOADING') {
    step = <strong className="warn">Facebook reloaded after Batch {reload?.afterBatch ?? '?'}. Waiting for Activity Log…</strong>;
  } else if (run.state === 'RESCANNING' && reload?.reloadRecoveryResult === 'RESTORED') {
    step = (
      <>
        <strong className="ok">Activity Log restored.</strong> Rescanning…
      </>
    );
  }
  const lost = run.state === 'CONFIRM_RESULT_UNKNOWN' || run.state === 'POST_CONFIRM_VERIFY';
  if (lost) step = RUN_STATE_TEXT[run.state];
  if (run.state === 'COUNTDOWN') step = <strong className="warn">Moving {plural(n, 'post')} to Trash in {countdown}…</strong>;
  if (run.state === 'ADVANCING' && prev) {
    step = (
      <>
        <strong className="ok">Batch {prev.index + 1} SUCCESS</strong> · continuing to Batch {a ? a.index + 1 : '?'}…
      </>
    );
  }
  const showBar = progress && progress.total > 1 && ['SELECTING', 'CONFIRMING', 'VERIFYING', 'ROLLING_BACK'].includes(run.state);

  return (
    <>
      <h3>RUNNING CLEANUP QUEUE</h3>
      <table className="kv queue-summary">
        <tbody>
          <tr><th>Batch</th><td><strong>{Math.min(run.currentBatchIndex + 1, run.approved.length)} / {run.approved.length}</strong> {a && <span className="muted small">(queue Batch {a.index + 1})</span>}</td></tr>
          <tr><th>Posts in batch</th><td>{n}</td></tr>
        </tbody>
      </table>
      <Overall run={run} />
      {lost && (
        <div className="outcome error-box">
          <p><strong>Facebook reloaded during final confirmation.</strong></p>
          <p className="small">The old page closed before it could report the result. Verifying what actually happened… Confirm is not clicked again.</p>
        </div>
      )}
      <p>Current step: {step}</p>
      {run.confirm?.confirmResponseLost && run.confirm.postConfirmTargetsAbsent !== null && (
        <PostConfirmSummary c={run.confirm} />
      )}
      {showBar && (
        <>
          <progress value={progress!.done} max={progress!.total} />
          <p className="small"><strong>{progress!.done} / {progress!.total}</strong>{progress!.phase === 'VERIFYING' ? ' verified removed so far' : ''}</p>
        </>
      )}
      {run.stopRequestedAt ? (
        <p className="warn small"><strong>Stopping at the next safe point…</strong> {STOP_HINT[run.state] ?? ''}</p>
      ) : (
        <>
          <div className="confirm-buttons">
            <button className="danger" onClick={p.onStop}>Stop run</button>
          </div>
          {STOP_HINT[run.state] && <p className="muted small">Stop now: {STOP_HINT[run.state]}</p>}
        </>
      )}
      <p className="muted small">
        Runs in the background: switching tabs or windows does not stop it, and the tester can be closed and reopened. Keep the Facebook
        tab visible: the run pauses before the next batch while it isn't.
      </p>
    </>
  );
}

function PausedView(p: PanelProps) {
  const { run, tabId } = p;
  async function showTab() {
    if (tabId === null) return;
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
  }
  return (
    <>
      <h3>CLEANUP RUN PAUSED</h3>
      <p className="warn"><strong>{run.pauseReason ?? 'Paused.'}</strong></p>
      <p className="small">
        {runBatchLabel(run)} has not started: nothing is selected. Resume runs a fresh scan and reconciliation first, then continues with
        the approved plan.
      </p>
      <Overall run={run} />
      <div className="confirm-buttons">
        <button className="secondary" disabled={tabId === null} onClick={() => void showTab()}>Show Facebook tab</button>
        <button className="secondary" onClick={p.onStop}>Stop run</button>
        <button className="confirm-go" onClick={p.onResume}>Resume</button>
      </div>
    </>
  );
}

function CompleteView(p: PanelProps) {
  const { run, queue } = p;
  const batches = run.approved.map((a) => queue?.batches.find((b) => b.key === a.key) ?? null);
  const partial = batches.filter((b) => b?.status === 'PARTIAL').length;
  const failed = batches.filter((b) => b?.status === 'FAILED' || b?.status === 'INCONCLUSIVE').length;
  const needsReview = queue ? summarize(queue).needsReview : 0;
  return (
    <>
      <h3 className="ok">Cleanup complete</h3>
      <table className="kv queue-summary">
        <tbody>
          <tr><th>Batches completed</th><td className="ok">{run.completedBatchIds.length} / {run.approved.length}</td></tr>
          <tr><th>Posts moved to Trash</th><td className="ok">{run.removedCount}</td></tr>
          <tr><th>Partial</th><td>{partial}</td></tr>
          <tr><th>Failed</th><td>{failed}</td></tr>
          <tr><th>Needs review</th><td className={needsReview ? 'warn' : ''}>{needsReview}</td></tr>
          <tr><th>Duration</th><td>{Math.round(elapsedMs(run) / 1000)} s</td></tr>
        </tbody>
      </table>
      <p className="small muted">Nothing more is loaded or moved automatically.</p>
      <div className="confirm-buttons batch-plan-buttons">
        <button className="secondary" disabled={!!p.quietBlock} onClick={p.onRescan}>Rescan Facebook</button>
        <button className="secondary" onClick={p.onLoadOlder}>Load older posts</button>
        <button className="secondary" onClick={p.onEnd}>Close</button>
      </div>
      {p.quietBlock && <p className="muted small">Rescan unavailable: {p.quietBlock}</p>}
    </>
  );
}

function StoppedView(p: PanelProps) {
  const { run } = p;
  const [inspect, setInspect] = useState(false);
  const interrupted = run.stopReason === 'INTERRUPTED';
  const user = run.stopReason === 'USER_STOPPED';
  const doneKeys = new Set(run.completedBatchIds);
  const cur = run.approved[run.currentBatchIndex];
  // The queue was rescanned and reconciled after this run stopped (by "Rescan and reconcile").
  const q = p.queue;
  const reconciled = !!q && !!run.endedAt && q.mappedAt > run.endedAt && !q.staleReason;
  const nextOpen = q ? q.batches.find((b) => b.index >= q.currentIndex && !isFinalStatus(b.status)) ?? null : null;
  return (
    <>
      <h3 className={user ? 'warn' : 'error'}>{interrupted ? 'Previous cleanup run interrupted' : 'Cleanup run stopped'}</h3>
      <table className="kv queue-summary">
        <tbody>
          <tr><th>Batch</th><td>{runBatchLabel(run)}{cur ? <span className="muted small"> (queue Batch {cur.index + 1})</span> : null}</td></tr>
          <tr><th>Reason</th><td className={user ? 'warn' : 'error'}><strong>{run.stopReason ?? run.state}</strong></td></tr>
          <tr><th>Removed before stop</th><td>{run.removedCount}</td></tr>
          <tr><th>Stopped while</th><td>{run.endedIn ?? '—'}</td></tr>
        </tbody>
      </table>
      {run.stopDetail && <p className="small break">{run.stopDetail}</p>}
      {run.confirm?.confirmResponseLost && <PostConfirmSummary c={run.confirm} />}
      {run.stopReason === 'TAB_RELOADED' && (
        <p className="small">
          Facebook reloaded the page where the run could not safely continue. Rescan and reconcile to see where every post is now; continuing
          needs your approval again.
        </p>
      )}
      {interrupted && (
        <div className="small">
          <p>Last verified state:</p>
          <ul>
            {run.approved.map((a, i) =>
              doneKeys.has(a.key) ? (
                <li key={a.key} className="ok">Batch {a.index + 1} SUCCESS</li>
              ) : i === run.currentBatchIndex ? (
                <li key={a.key} className={run.uncertain ? 'error' : ''}>Batch {a.index + 1} {run.uncertain ? `interrupted while ${run.endedIn} (NOT verified)` : 'not started'}</li>
              ) : (
                <li key={a.key} className="muted">Batch {a.index + 1} not started</li>
              ),
            )}
          </ul>
        </div>
      )}
      {run.uncertain && (
        <p className="error small">
          Facebook's state was not verified when the run stopped. Inspect the Facebook tab and the Cleanup batch panel below before anything else
          (a batch may still be selected, or Facebook's dialog open). Then rescan and reconcile. Nothing resumes automatically.
        </p>
      )}
      <p className="small muted">
        Successfully completed batches stay SUCCESS, unstarted batches stay in the queue. Continuing needs a fresh scan, reconciliation and
        your approval again.
      </p>
      {reconciled && (
        <div className="outcome ok-box">
          <p><strong>Previous autorun remains stopped.</strong></p>
          <p className="small">
            Queue successfully reconciled.{' '}
            {nextOpen ? (
              <>Batch {batchNo(nextOpen)} is <strong>{nextOpen.status}</strong>.</>
            ) : (
              'No batch is left to run.'
            )}
          </p>
          <div className="confirm-buttons batch-plan-buttons">
            <button className="secondary" onClick={p.onEnd}>End stopped run</button>
            <button className="secondary" onClick={p.onEnd} title="Closes this stopped run; the queue's own Review batch / Skip / Pause controls are below.">
              Continue queue manually
            </button>
            <button className="confirm-go" disabled={!!p.approveBlock || !nextOpen} onClick={p.onApproveNew} title="Shows a new approval screen. The stopped run is not restarted.">
              Approve a new autorun
            </button>
          </div>
          {p.approveBlock && nextOpen && <p className="muted small">New autorun unavailable: {p.approveBlock}</p>}
        </div>
      )}
      <div className="confirm-buttons batch-plan-buttons">
        <button className="secondary" onClick={() => setInspect(!inspect)}>{inspect ? 'Hide problem' : 'Inspect problem'}</button>
        {interrupted && !run.uncertain ? (
          <button className="confirm-go" disabled={!!p.quietBlock} onClick={p.onRescanResume} title="Rescans and reconciles; the run then waits for your approval again.">
            Rescan and resume
          </button>
        ) : (
          <button className="confirm-go" disabled={!!p.quietBlock} onClick={p.onRescanReconcile}>Rescan and reconcile</button>
        )}
        <button className="secondary" onClick={p.onEnd}>End run</button>
      </div>
      {p.quietBlock && <p className="muted small">Rescan unavailable: {p.quietBlock}</p>}
      {inspect && <Inspect {...p} />}
    </>
  );
}

/** What stopped the run: the last V2B batch as the Facebook tab reports it, and the run's own log. */
function Inspect(p: PanelProps) {
  const { run, actionState, safe } = p;
  const snap = actionState?.batch ?? null;
  const mine = snap && snap.batchId === run.runBatchId ? snap : null;
  const byId = new Map((safe?.items ?? []).filter((it) => it.itemId).map((it) => [it.itemId!, it]));
  const posts: Post[] = mine ? mine.itemIds.map((id) => ({ id, item: mine.scanSessionId === safe?.scanSessionId ? byId.get(id) ?? null : null })) : [];
  return (
    <div className="run-inspect">
      <h4>The batch on Facebook</h4>
      {!mine ? (
        <p className="small muted">
          {run.runBatchId ? 'The Facebook tab no longer reports this run\'s batch (it was reloaded, or another batch ran since).' : 'No batch had started on Facebook when the run stopped.'}
        </p>
      ) : isBatchActive(mine.state) ? (
        <p className="small error">The batch is still {mine.state} on Facebook. Finish it in the Cleanup batch panel below (Cancel / Cancel and unselect).</p>
      ) : (
        <ResultView snap={mine} posts={posts} onBackToPlan={null} onClear={null} />
      )}
      {actionState?.locked && <p className="error small">Actions are locked in the Facebook tab: {actionState.locked}</p>}
      <h4>Run log</h4>
      <RunLog run={run} log={p.log} />
    </div>
  );
}

function RunLog({ run, log }: { run: QueueRun; log: QueueLogEntry[] }) {
  const rows = log.filter((e) => e.runId === run.runId).slice(-40).reverse();
  if (rows.length === 0) return <p className="small muted">No events.</p>;
  return (
    <div className="batch-scroll">
      <table className="grid">
        <thead><tr><th>Time</th><th>Event</th><th>Batch</th><th>Result</th></tr></thead>
        <tbody>
          {rows.map((e, i) => (
            <tr key={i}>
              <td>{new Date(e.timestamp).toLocaleTimeString()}</td>
              <td className="break">{e.event}</td>
              <td>{e.batch ?? '—'}</td>
              <td className="break small">{e.result}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Diagnostic: ids, states and counts. No Facebook content. Also the V5 guided cleanup's technical details. */
export function RunDebug({ run, log }: { run: QueueRun; log: QueueLogEntry[] }) {
  return (
    <details className="batch-debug">
      <summary className="small">Run debug</summary>
      <table className="kv queue-summary">
        <tbody>
          <tr><th>Run ID</th><td><code>{run.runId}</code></td></tr>
          <tr><th>Queue ID</th><td><code>{run.queueId}</code></td></tr>
          <tr><th>State</th><td>{run.state}{run.endedIn ? ` (in ${run.endedIn})` : ''}</td></tr>
          <tr><th>Approved</th><td>{run.approvedPosts} posts · batches {run.approved.map((a) => a.index + 1).join(', ')}</td></tr>
          <tr><th>Completed</th><td>{run.completedBatchIds.length}</td></tr>
          <tr><th>V2B batch</th><td><code>{run.runBatchId ? run.runBatchId.slice(0, 8) : '—'}</code></td></tr>
          <tr><th>Started</th><td>{new Date(run.startedAt).toLocaleTimeString()} · {Math.round(elapsedMs(run) / 1000)} s</td></tr>
          <tr><th>Tab</th><td>{run.tabId}</td></tr>
          <tr><th>Same-tab reloads</th><td>{run.reloads ?? 0}</td></tr>
          <tr><th>Builds</th><td className={run.workerBuild && run.workerBuild !== BUILD_ID ? 'warn' : ''}>worker {run.workerBuild ?? '—'} · tester {BUILD_ID}</td></tr>
        </tbody>
      </table>
      {run.reload && <ReloadDebug r={run.reload} />}
      {run.confirm && <ConfirmDebug c={run.confirm} />}
      <RunLog run={run} log={log} />
    </details>
  );
}

/** The verdict on a batch whose final-confirm answer was lost in a reload. Counts only. */
export function PostConfirmSummary({ c }: { c: RunConfirmRecord }) {
  const ok = c.postConfirmRecoveryResult === 'SUCCESS' || c.postConfirmRecoveryResult === 'V2B_SUCCESS';
  const pending = c.postConfirmTargetsAbsent === null;
  return (
    <div className={`outcome ${pending ? '' : ok ? 'ok-box' : 'error-box'}`}>
      <p>
        <strong>Post-confirm fresh verification</strong> <span className="muted small">Batch {c.batchNo}</span>
        {ok && <span className="ok small"> · SUCCESS: response lost, verified after reload</span>}
      </p>
      {pending ? (
        <p className="small muted">{c.postConfirmRecoveryResult ?? 'Not verified.'}</p>
      ) : (
        <table className="kv queue-summary">
          <tbody>
            <tr><th>Expected targets</th><td>{c.expected}</td></tr>
            <tr><th>Absent</th><td className={c.postConfirmTargetsAbsent === c.expected ? 'ok' : ''}>{c.postConfirmTargetsAbsent}</td></tr>
            <tr><th>Still present</th><td className={c.postConfirmTargetsPresent ? 'error' : ''}>{c.postConfirmTargetsPresent}</td></tr>
            <tr><th>Uncertain</th><td className={c.postConfirmTargetsUncertain ? 'error' : ''}>{c.postConfirmTargetsUncertain}</td></tr>
          </tbody>
        </table>
      )}
      {!ok && !pending && <p className="small">Nothing will be retried automatically.</p>}
    </div>
  );
}

/** The latest final-confirm record. Ids, times and counts only. */
function ConfirmDebug({ c }: { c: RunConfirmRecord }) {
  const t = (v: string | null) => (v ? new Date(v).toLocaleTimeString() : '—');
  const yn = (v: boolean) => (v ? 'yes' : 'no');
  return (
    <table className="kv queue-summary">
      <tbody>
        <tr><th>Confirm batch</th><td>Batch {c.batchNo} · <code>{c.batchId.slice(0, 8)}</code> · {c.expected} targets</td></tr>
        <tr><th>confirmRequestSentAt</th><td>{t(c.confirmRequestSentAt)}</td></tr>
        <tr><th>confirmResponseReceived</th><td>{yn(c.confirmResponseReceived)}</td></tr>
        <tr><th>confirmResponseLost</th><td className={c.confirmResponseLost ? 'warn' : ''}>{yn(c.confirmResponseLost)}</td></tr>
        <tr><th>reloadDuringConfirm</th><td>{yn(c.reloadDuringConfirm)}</td></tr>
        <tr><th>postConfirmRecoveryStarted</th><td>{t(c.postConfirmRecoveryStarted)}</td></tr>
        <tr><th>postConfirmFreshScanId</th><td><code>{c.postConfirmFreshScanId ? c.postConfirmFreshScanId.slice(0, 8) : '—'}</code></td></tr>
        <tr><th>postConfirmTargetsAbsent</th><td>{c.postConfirmTargetsAbsent ?? '—'}</td></tr>
        <tr><th>postConfirmTargetsPresent</th><td>{c.postConfirmTargetsPresent ?? '—'}</td></tr>
        <tr><th>postConfirmTargetsUncertain</th><td>{c.postConfirmTargetsUncertain ?? '—'}</td></tr>
        <tr><th>postConfirmRecoveryResult</th><td>{c.postConfirmRecoveryResult ?? '—'}</td></tr>
        <tr><th>outcomeRecorded</th><td>{yn(c.outcomeRecorded)}</td></tr>
      </tbody>
    </table>
  );
}

/** The latest same-tab reload of the Facebook tab during the run. URLs and states only. */
function ReloadDebug({ r }: { r: RunReloadInfo }) {
  const yn = (v: boolean | null) => (v === null ? '—' : v ? 'yes' : 'no');
  return (
    <table className="kv queue-summary">
      <tbody>
        <tr><th>sameTabReloadDetected</th><td>{yn(r.sameTabReloadDetected)} <span className="muted small">{new Date(r.detectedAt).toLocaleTimeString()}</span></td></tr>
        <tr><th>reloadDetectedAtState</th><td>{r.reloadDetectedAtState}</td></tr>
        <tr><th>batchAlreadyVerifiedSuccess</th><td>{yn(r.batchAlreadyVerifiedSuccess)}{r.afterBatch !== null ? ` (Batch ${r.afterBatch})` : ''}</td></tr>
        <tr><th>reloadRecoveryStarted</th><td>{r.reloadRecoveryStarted ? new Date(r.reloadRecoveryStarted).toLocaleTimeString() : '—'}</td></tr>
        <tr><th>reloadRecoveryResult</th><td className={r.reloadRecoveryResult?.startsWith('FAILED') ? 'error' : r.reloadRecoveryResult === 'RECONCILED' ? 'ok' : ''}>{r.reloadRecoveryResult ?? '—'}</td></tr>
        <tr><th>URL before</th><td className="break small">{r.urlBefore}</td></tr>
        <tr><th>URL after</th><td className="break small">{r.urlAfter ?? '—'}</td></tr>
      </tbody>
    </table>
  );
}

/** Whole seconds left until `endsAt` (ticks while it is set). */
export function useCountdown(endsAt: string | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!endsAt) return;
    const t = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(t);
  }, [endsAt]);
  return endsAt ? Math.max(0, Math.ceil((Date.parse(endsAt) - now) / 1000)) : 0;
}
