/**
 * The persistent tester: the full scan / debug / V1A / V1B UI in its own extension window,
 * which, unlike the popup, stays open when focus moves to Facebook or another app.
 *
 * Every request goes to ONE Facebook tab: the one the tester was opened from (or later
 * reconnected to by hand). It never follows the active tab and never picks another Facebook
 * tab by itself. If that tab closes or leaves facebook.com, all requests are disabled.
 *
 * V5: two modes. Simple (the default) shows only the guided cleanup; Developer shows every V0–V4
 * tool exactly as before. The choice is a per-browser convenience (localStorage); both modes share
 * the same scan, queue and run, so switching never changes or restarts anything.
 */

import { useEffect, useRef, useState } from 'react';
import { Header, Workbench, type TesterMode } from './App';
import {
  findCurrentActivityLogTab,
  inspectTargetTab,
  readTargetTabId,
  registerTesterWindow,
  shortUrl,
  watchTargetTabId,
  writeTargetTabId,
  type TargetTab,
} from './testerTarget';

const MODE_KEY = 'fpc:testerMode';

function readMode(): TesterMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'developer' ? 'developer' : 'simple';
  } catch {
    return 'simple';
  }
}

export function Tester() {
  const [mode, setModeState] = useState<TesterMode>(readMode);
  function setMode(m: TesterMode) {
    setModeState(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* the mode is only a convenience */
    }
  }
  /** undefined while it is read from storage. */
  const [targetId, setTargetId] = useState<number | null | undefined>(undefined);
  const [target, setTarget] = useState<TargetTab>({ kind: 'loading' });
  const [reconnectError, setReconnectError] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    registerTesterWindow().catch(() => {}); // only used to avoid duplicate windows
    readTargetTabId().then(setTargetId, () => setTargetId(null));
    return watchTargetTabId((id) => {
      setTargetId(id);
      setReconnectError(null);
    });
  }, []);

  // Keep the target tab's state live: closed, navigated away, or still on Facebook.
  useEffect(() => {
    if (targetId === undefined) return;
    const refresh = () => {
      const mine = ++seq.current;
      inspectTargetTab(targetId).then((t) => {
        if (mine === seq.current) setTarget(t); // ignore answers that arrive out of order
      });
    };
    refresh();
    if (targetId === null) return;

    const onUpdated = (id: number) => {
      if (id === targetId) refresh();
    };
    const onRemoved = onUpdated;
    // A replaced tab is a different tab now: it is reported as closed, never followed.
    const onReplaced = (_added: number, removed: number) => onUpdated(removed);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.onReplaced.addListener(onReplaced);
    window.addEventListener('focus', refresh);
    return () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      chrome.tabs.onReplaced.removeListener(onReplaced);
      window.removeEventListener('focus', refresh);
    };
  }, [targetId]);

  async function reconnect() {
    const found = await findCurrentActivityLogTab();
    if (!found.ok) {
      setReconnectError(found.error);
      return;
    }
    setReconnectError(null);
    await writeTargetTabId(found.tabId);
    setTargetId(found.tabId); // storage.onChanged does not fire when the id is unchanged
  }

  // Only a tab confirmed to be the current target counts, never a stale answer about the previous one.
  const connectedTabId = target.kind === 'connected' && target.tabId === targetId ? target.tabId : null;
  const connectedActivityLog = connectedTabId !== null && target.kind === 'connected' && target.activityLog;

  return (
    <main className="app">
      <Header />
      <ModeSwitch mode={mode} onChange={setMode} />
      <ConnectionBar target={targetId === undefined ? { kind: 'loading' } : target} onReconnect={reconnect} error={reconnectError} />
      {targetId !== undefined && (
        // A different target tab starts from a clean slate: scans and selections belong to one tab.
        <Workbench key={targetId ?? 'none'} tabId={connectedTabId} activityLog={connectedActivityLog} mode={mode} onModeChange={setMode} />
      )}
    </main>
  );
}

function ModeSwitch({ mode, onChange }: { mode: TesterMode; onChange(m: TesterMode): void }) {
  return (
    <div className="mode-switch" role="radiogroup" aria-label="Tester mode">
      {(['simple', 'developer'] as const).map((m) => (
        <button key={m} role="radio" aria-checked={mode === m} className={`chip ${mode === m ? 'active' : ''}`} onClick={() => onChange(m)}>
          {m === 'simple' ? 'Simple' : 'Developer'}
        </button>
      ))}
      <span className="muted small">{mode === 'simple' ? 'Guided cleanup' : 'Every manual tool, scan health, queue, batch and run debug'}</span>
    </div>
  );
}

function ConnectionBar({ target, onReconnect, error }: { target: TargetTab; onReconnect(): void; error: string | null }) {
  async function showTab() {
    if (target.kind !== 'connected') return;
    const tab = await chrome.tabs.update(target.tabId, { active: true });
    if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
  }

  return (
    <section className={`connection ${target.kind}`}>
      {target.kind === 'loading' && <p className="muted">Checking the connected tab…</p>}
      {target.kind === 'none' && <p className="warn"><strong>No Facebook tab connected.</strong></p>}
      {target.kind === 'connected' && (
        <>
          <p className="ok"><strong>Connected Facebook tab</strong> <span className="muted small">(tab {target.tabId})</span></p>
          <p className="break small">{shortUrl(target.url)}</p>
          {!target.activityLog && <p className="warn small">This tab is no longer on the Activity Log. Results are less reliable.</p>}
        </>
      )}
      {target.kind === 'disconnected' && (
        <>
          <p className="error"><strong>Facebook tab disconnected.</strong></p>
          <p className="small">Tab {target.tabId}: {target.reason} Nothing will be sent until you reconnect.</p>
        </>
      )}
      <div className="connection-buttons">
        <button className="secondary small" onClick={onReconnect} title="Uses the active tab of the browser window you were last in">
          Reconnect to current Facebook tab
        </button>
        {target.kind === 'connected' && (
          <button className="secondary small" onClick={showTab}>
            Show Facebook tab
          </button>
        )}
      </div>
      {error && <p className="error small">{error}</p>}
    </section>
  );
}
