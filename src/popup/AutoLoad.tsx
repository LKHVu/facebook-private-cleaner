/**
 * V3A popup UI: Load more posts. Asks the content script to load older Activity Log entries by
 * scrolling (autoLoad.ts), shows its published progress, and hands the finished run back to the
 * Workbench, which runs a completely fresh scan.
 *
 *   Load next 50                    about LOAD_NEXT_ROWS more rows, then stop
 *   Auto-load until no more posts   until Facebook adds no rows (or a safety limit)
 *
 * Starting discards the current scan and batch plan (the Workbench does that once the content
 * script accepted the request). While loading, scans and every action are disabled. The content
 * script refuses them too.
 */

import { useEffect, useRef, useState } from 'react';
import type { ActionState, AutoLoadMode, AutoLoadRequest, AutoLoadResponse, AutoLoadSnapshot, Failure, PopupRequest } from '../shared/types';
import {
  AUTOLOAD_MAX_MS,
  AUTOLOAD_MAX_NO_GROWTH,
  LOAD_NEXT_ROWS,
  MAX_AUTO_LOADED_ROWS,
  SCANNER_PROTOCOL,
  isAutoLoadActive,
} from '../shared/types';

/** How often the loading progress is read from the Facebook tab while a run is active. */
const PROGRESS_POLL_MS = 500;

interface Props {
  tabId: number | null;
  actionState: ActionState | null;
  actionStateError: string | null;
  refreshActionState(): Promise<void>;
  /** The item strategy chosen in the debug panel ('' = auto), so rows are counted like the next scan counts them. */
  strategy: string;
  /** Rows in the current scan, or null without one. */
  scannedRows: number | null;
  /** Posts in the batch plan that starting would discard. */
  planSize: number;
  /** Why loading can't start now, or null. */
  blocker: string | null;
  /** The fresh scan after loading is running. */
  scanning: boolean;
  /** The start request is in flight: the Workbench disables everything meanwhile. */
  setStarting(starting: boolean): void;
  /** The content script accepted the run and discarded its scan session: drop the scan and the plan. */
  onStarted(): void;
  /** A run this panel started (or adopted) ended. The Workbench scans if asked to. */
  onFinished(snap: AutoLoadSnapshot, scanAfter: boolean): void;
}

type UiError = { code: string | null; message: string };

function secondsText(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))} s`;
}

export function AutoLoadPanel(p: Props) {
  const { tabId, actionState, actionStateError, refreshActionState } = p;
  const snap = actionState?.autoLoad ?? null;
  const active = !!snap && isAutoLoadActive(snap.state);
  const [scanAfter, setScanAfter] = useState(true);
  const [starting, setStartingLocal] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  /** The run whose end this panel reports (and scans after). */
  const [myRunId, setMyRunId] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const handled = useRef<string | null>(null);

  // A run already going (e.g. the tester was reopened while loading) is adopted, so its end is shown and scanned.
  useEffect(() => {
    if (snap && active && snap.runId !== myRunId) setMyRunId(snap.runId);
  }, [snap?.runId, active]);

  // While loading, read the progress regularly.
  useEffect(() => {
    if (!active && !starting) return;
    const t = window.setInterval(() => void refreshActionState(), PROGRESS_POLL_MS);
    return () => window.clearInterval(t);
  }, [active, starting, refreshActionState]);

  // A run of ours ended: hand it over once.
  useEffect(() => {
    if (!snap || active || snap.state === 'IDLE' || snap.runId !== myRunId || handled.current === snap.runId) return;
    handled.current = snap.runId;
    p.onFinished(snap, scanAfter);
  }, [snap?.runId, snap?.state, myRunId]);

  function setStarting(v: boolean) {
    setStartingLocal(v);
    p.setStarting(v);
  }

  async function start(mode: AutoLoadMode) {
    if (tabId === null || p.blocker || active || starting) return;
    setError(null);
    setStarting(true);
    try {
      const request: AutoLoadRequest = { protocol: SCANNER_PROTOCOL, mode, strategy: p.strategy || undefined };
      const msg: PopupRequest = { type: 'FPC_AUTOLOAD_START_TAB', tabId, request };
      const res: AutoLoadResponse | Failure | undefined = await chrome.runtime.sendMessage(msg);
      if (!res) throw new Error('No response from the background service worker.');
      if (!res.ok) {
        setError({ code: 'code' in res ? res.code : null, message: res.error });
        return;
      }
      setMyRunId(res.autoLoad.runId);
      setDismissed(null);
      p.onStarted();
    } catch (e) {
      setError({ code: null, message: e instanceof Error ? e.message : String(e) });
    } finally {
      await refreshActionState();
      setStarting(false);
    }
  }

  async function stop() {
    if (tabId === null || !snap) return;
    try {
      const msg: PopupRequest = { type: 'FPC_AUTOLOAD_STOP_TAB', tabId, runId: snap.runId };
      const res: AutoLoadResponse | Failure | undefined = await chrome.runtime.sendMessage(msg);
      if (res && !res.ok) setError({ code: 'code' in res ? res.code : null, message: res.error });
    } catch (e) {
      setError({ code: null, message: e instanceof Error ? e.message : String(e) });
    } finally {
      await refreshActionState();
    }
  }

  const finished = snap && !active && snap.state !== 'IDLE' && snap.runId !== dismissed ? snap : null;
  const lost = active && (tabId === null || actionStateError !== null);

  return (
    <section className="autoload-panel">
      <h3>Load more posts</h3>

      {active && snap ? (
        <RunningView snap={snap} onStop={stop} />
      ) : (
        <>
          <p>
            Currently loaded:{' '}
            {p.scannedRows !== null ? <strong>{p.scannedRows} rows</strong> : finished ? <strong>{finished.currentRows} rows</strong> : <span className="muted">unknown (no scan yet)</span>}
          </p>
          <div className="confirm-buttons batch-plan-buttons">
            <button className="secondary" disabled={!!p.blocker || starting} onClick={() => start('NEXT_N')}>
              Load next {LOAD_NEXT_ROWS}
            </button>
            <button className="secondary" disabled={!!p.blocker || starting} onClick={() => start('UNTIL_END')}>
              Auto-load until no more posts
            </button>
          </div>
          <label className="batch-toggle">
            <input type="checkbox" checked={scanAfter} onChange={(e) => setScanAfter(e.target.checked)} />
            <span className="small">Scan automatically when loading stops</span>
          </label>
          <p className="muted small">
            Only scrolls the Facebook page: nothing is selected, clicked or moved. Stops by itself after {AUTOLOAD_MAX_NO_GROWTH} attempts
            without new rows, at {MAX_AUTO_LOADED_ROWS} loaded rows, or after {AUTOLOAD_MAX_MS / 60_000} minutes.
          </p>
          {(p.scannedRows !== null || p.planSize > 0) && !p.blocker && (
            <p className="warn small">
              Starting discards the current scan{p.planSize > 0 ? ` and the batch plan (${p.planSize} post${p.planSize === 1 ? '' : 's'})` : ''}. A fresh scan is needed
              afterwards.
            </p>
          )}
          {starting && <p className="muted small">Checking the page and counting the loaded rows…</p>}
          {p.blocker && !starting && <p className="muted small">Loading unavailable: {p.blocker}</p>}
        </>
      )}

      {lost && (
        <p className="error small">
          {tabId === null
            ? 'The Facebook tab is disconnected. If it was closed or reloaded, loading has stopped.'
            : `Could not read the loading progress (${actionStateError}). If the Facebook tab was reloaded or navigated, loading has stopped: scan again.`}
        </p>
      )}

      {error && (
        <div className="outcome error-box">
          <p>
            <strong>Loading refused (nothing was scrolled)</strong>
            {error.code && <code className="small"> {error.code}</code>}
          </p>
          <p className="small break">{error.message}</p>
        </div>
      )}

      {finished && !active && (
        <FinishedView
          snap={finished}
          scanning={p.scanning}
          scanAfter={scanAfter && finished.runId === myRunId}
          onDismiss={() => setDismissed(finished.runId)}
        />
      )}
    </section>
  );
}

function RunningView({ snap, onStop }: { snap: AutoLoadSnapshot; onStop(): void }) {
  const stopping = snap.state === 'STOPPING';
  const elapsed = Date.now() - new Date(snap.startedAt).getTime();
  return (
    <div className="progress-box" role="status" aria-live="polite">
      <p>
        <strong>{stopping ? 'Stopping after this attempt…' : 'Loading older posts…'}</strong>{' '}
        <span className="muted small">{snap.mode === 'NEXT_N' ? `load next ${LOAD_NEXT_ROWS}` : snap.mode === 'UP_TO' ? `up to ${snap.targetRows} rows` : 'until no more posts'}</span>
      </p>
      {snap.targetRows !== null && (
        <progress value={Math.max(0, snap.currentRows - snap.startingRows)} max={Math.max(1, snap.targetRows - snap.startingRows)} />
      )}
      <table className="kv autoload">
        <tbody>
          <tr><th>Starting rows</th><td>{snap.startingRows}</td></tr>
          <tr><th>Current rows</th><td><strong>{snap.currentRows}</strong>{snap.targetRows !== null && <span className="muted"> / target {snap.targetRows}</span>}</td></tr>
          <tr><th>New rows</th><td className={snap.addedRows > 0 ? 'ok' : ''}>{snap.addedRows >= 0 ? '+' : ''}{snap.addedRows}</td></tr>
          <tr><th>Scroll attempts</th><td>{snap.attempts}</td></tr>
          <tr><th>Last growth</th><td>{snap.lastGrowth === null ? '—' : snap.lastGrowth > 0 ? `+${snap.lastGrowth}` : 'none'}</td></tr>
          <tr>
            <th>No growth in a row</th>
            <td className={snap.consecutiveNoGrowth > 0 ? 'warn' : ''}>{snap.consecutiveNoGrowth} / {AUTOLOAD_MAX_NO_GROWTH}</td>
          </tr>
          <tr><th>Elapsed</th><td>{secondsText(elapsed)} <span className="muted">(limit {AUTOLOAD_MAX_MS / 60_000} min)</span></td></tr>
          <tr><th>Safety cap</th><td>{snap.maxRows} rows</td></tr>
          <tr>
            <th>Scrolling</th>
            <td className="break">{snap.container} · position {snap.scrollTop.toLocaleString()} / {snap.scrollHeight.toLocaleString()} px</td>
          </tr>
        </tbody>
      </table>
      {snap.pageHidden && (
        <p className="warn small">
          The Facebook tab is hidden. Facebook may not load older posts until it is visible again, so these attempts don't count
          as "no more posts". Show the Facebook tab to continue.
        </p>
      )}
      <p className="muted small">Scanning and every action are disabled: Facebook is currently loading older Activity Log entries.</p>
      <div className="confirm-buttons">
        <button className="secondary" disabled={stopping} onClick={onStop}>
          {stopping ? 'Stopping…' : 'Stop loading'}
        </button>
      </div>
    </div>
  );
}

function FinishedView({ snap, scanning, scanAfter, onDismiss }: { snap: AutoLoadSnapshot; scanning: boolean; scanAfter: boolean; onDismiss(): void }) {
  const failed = snap.state === 'FAILED';
  const byUser = snap.stopReason === 'USER_STOPPED';
  return (
    <div className={`outcome ${failed ? 'error-box' : 'ok-box'}`}>
      <p className={failed ? '' : 'ok'}>
        <strong>{failed ? 'Loading failed' : byUser ? 'Loading stopped by user.' : 'Loading finished'}</strong>
        {snap.stopReason && <code className="small"> {snap.stopReason}</code>}
      </p>
      <p>
        <strong>{snap.currentRows} rows</strong> {byUser ? 'are currently loaded' : 'loaded'} ·{' '}
        <span className={snap.addedRows > 0 ? 'ok' : ''}>{snap.addedRows >= 0 ? '+' : ''}{snap.addedRows} since start</span>
      </p>
      <p className="small">
        {snap.attempts} scroll attempt{snap.attempts === 1 ? '' : 's'} in {secondsText(snap.elapsedMs)}.
      </p>
      {snap.stopMessage && !byUser && <p className="small break">Reason: {snap.stopMessage}</p>}
      {failed ? (
        <p className="small">No scan was run automatically. Check the Facebook tab, then scan again (or reload the tab).</p>
      ) : scanning ? (
        <p className="small"><strong>Running fresh scan…</strong></p>
      ) : scanAfter ? (
        <p className="small muted">A fresh scan ran after loading: see the results below.</p>
      ) : (
        <p className="small">Scan again to see (and act on) the loaded posts.</p>
      )}
      {snap.notes.length > 0 && (
        <details>
          <summary className="small muted">Loading notes ({snap.notes.length})</summary>
          <ul className="small">
            {snap.notes.map((n, i) => <li key={i} className="break">{n}</li>)}
          </ul>
        </details>
      )}
      <div className="confirm-buttons">
        <button className="secondary small" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
