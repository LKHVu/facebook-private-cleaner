/**
 * V1A popup UI: select / unselect ONE ONLY_ME post's checkbox, and the in-memory action log.
 * Once the post is selected, V1B's TrashPanel (TrashActions.tsx) offers moving it to Trash.
 *
 * The popup only asks. Every safety condition is checked again by facebookActions.ts in the
 * Facebook tab before anything is clicked; the checks here only decide what to offer.
 */

import type {
  ActionLogEntry,
  ActionState,
  ActionStateResponse,
  CheckboxAction,
  CheckboxActionRequest,
  CheckboxActionResponse,
  CheckboxStateChange,
  CheckboxVerification,
  Failure,
  PendingTrashInfo,
  PopupRequest,
} from '../shared/types';
import { SCANNER_PROTOCOL } from '../shared/types';
import type { QueueLogEntry } from './facebookQueue';
import type { SafeItem } from './normalize';
import { IDLE_TRASH, TrashPanel, type TrashUi } from './TrashActions';

type Outcome =
  | { kind: 'success'; action: CheckboxAction; verification: CheckboxVerification }
  | {
      kind: 'error';
      action: CheckboxAction;
      message: string;
      code: string | null;
      needsRescan: boolean;
      verification: CheckboxVerification | null;
    };

/** Per-item UI state. DebugPanel keeps it, so it survives collapsing the item. */
export interface ItemActionState {
  phase: 'idle' | 'confirming' | 'busy';
  /** This popup selected the post in the current scan and hasn't unselected it since. */
  selected: boolean;
  last: Outcome | null;
  /** V1B Trash flow for this post. */
  trash: TrashUi;
}

export const IDLE_ACTION: ItemActionState = { phase: 'idle', selected: false, last: null, trash: IDLE_TRASH };

export interface ActionContext {
  tabId: number | null;
  scanSessionId: string | null;
  /** The scan came from a scanner built with this popup's SCANNER_PROTOCOL. */
  protocolOk: boolean;
  /** Why the content script locked actions, or null. */
  locked: string | null;
  /** Set while the lock state is unknown (loading or unreadable), or the scan is used up: nothing is offered. */
  unavailable: string | null;
  /** A Trash waiting for its second confirmation, in any row. */
  pendingTrash: PendingTrashInfo | null;
}

/** Why an ONLY_ME item can't be offered for selection, or null when it can. */
function selectBlocker(item: SafeItem, ctx: ActionContext): string | null {
  if (ctx.unavailable) return ctx.unavailable;
  if (!ctx.protocolOk) return 'this scan came from a different scanner build. Reload the Facebook tab and scan again.';
  if (ctx.tabId === null) return 'no Facebook tab connected.';
  if (!ctx.scanSessionId || !item.itemId) return 'this scan has no session or item id. Scan again.';
  if (item.problems.length > 0) return 'this item\'s data has an unexpected shape (see above).';
  if (item.audienceBasis !== 'strong') return `ONLY_ME was decided from ${item.audienceBasis} evidence, not an accessibility label.`;
  if (!item.controls) return 'this scan has no control data. Scan again.';
  const cb = item.controls.checkbox;
  if (cb.ambiguousCandidates > 0) return 'checkbox discovery is ambiguous in this row.';
  if (!cb.found) return 'no checkbox was discovered in this row.';
  if (cb.confidence !== 'HIGH') return `checkbox discovery is ${cb.confidence ?? '?'} confidence, not HIGH.`;
  return null;
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

interface PanelProps {
  item: SafeItem;
  ctx: ActionContext;
  state: ItemActionState;
  update(fn: (s: ItemActionState) => ItemActionState): void;
  /** Re-reads the lock and log from the content script. */
  refreshActionState(): void;
}

/** Rendered only for ONLY_ME items; nothing at all for PUBLIC / FRIENDS / UNKNOWN. */
export function ItemActionPanel({ item, ctx, state, update, refreshActionState }: PanelProps) {
  if (item.audience !== 'ONLY_ME') return null;
  const blocker = selectBlocker(item, ctx);
  const { phase, selected, last } = state;

  async function run(action: CheckboxAction) {
    const { tabId, scanSessionId } = ctx;
    if (tabId === null || !scanSessionId || !item.itemId) return;
    update((s) => ({ ...s, phase: 'busy' }));
    let outcome: Outcome;
    let nowSelected = selected;
    try {
      const request: CheckboxActionRequest = { protocol: SCANNER_PROTOCOL, scanSessionId, itemId: item.itemId, action, confirmed: true };
      const msg: PopupRequest = { type: 'FPC_CHECKBOX_ACTION_TAB', tabId, request };
      const res: CheckboxActionResponse | Failure | undefined = await chrome.runtime.sendMessage(msg);
      if (!res) throw new Error('No response from the background service worker.');
      if (res.ok) {
        outcome = { kind: 'success', action, verification: res.verification };
        nowSelected = action === 'SELECT_CHECKBOX';
      } else {
        const detailed = 'code' in res;
        outcome = {
          kind: 'error',
          action,
          message: res.error,
          code: detailed ? res.code : null,
          needsRescan: detailed ? res.needsRescan : true,
          verification: detailed ? res.verification : null,
        };
      }
    } catch (e) {
      outcome = { kind: 'error', action, message: e instanceof Error ? e.message : String(e), code: null, needsRescan: true, verification: null };
    }
    update((s) => ({ ...s, phase: 'idle', selected: nowSelected, last: outcome }));
    refreshActionState();
  }

  // While a Trash is under way (or finished), the V1A buttons stay out of the way.
  const trashIdle = state.trash.kind === 'idle' || state.trash.kind === 'cancelled' || (state.trash.kind === 'failed' && !state.trash.clicked);

  return (
    <div className="action-panel">
      <h4>Action (V1A select · V1B trash)</h4>
      {ctx.locked && (
        <p className="error small">
          Actions are locked: {ctx.locked} Reload the Facebook tab, check the selection there by hand, then scan again.
        </p>
      )}
      {!ctx.locked && blocker && !selected && trashIdle && <p className="muted small">Select unavailable: {blocker}</p>}

      {!ctx.locked && !blocker && !selected && phase === 'idle' && trashIdle && (
        <button className="secondary" onClick={() => update((s) => ({ ...s, phase: 'confirming', last: null }))}>
          Select this post
        </button>
      )}

      {phase === 'confirming' && (
        <div className="confirm" role="alertdialog" aria-label="Confirm selecting this post">
          <p><strong>Select this one Facebook post?</strong></p>
          <table className="kv">
            <tbody>
              <tr><th>Privacy</th><td><code className="aud-ONLY_ME">ONLY_ME</code></td></tr>
              <tr>
                <th>Date</th>
                <td>
                  {item.date ? item.date.text : <span className="muted">not detected</span>}
                  {item.date && <span className="muted small"> ({item.date.source})</span>}
                </td>
              </tr>
              <tr><th>Preview</th><td className="break">{clip(item.preview, 160) || <span className="muted">(no text)</span>}</td></tr>
            </tbody>
          </table>
          <p className="small">
            This will only select its checkbox.
            <br />
            Nothing will be deleted or moved.
          </p>
          <div className="confirm-buttons">
            <button className="secondary" autoFocus onClick={() => update((s) => ({ ...s, phase: 'idle' }))}>
              Cancel
            </button>
            <button className="confirm-go" onClick={() => run('SELECT_CHECKBOX')}>
              Select post
            </button>
          </div>
        </div>
      )}

      {phase === 'busy' && <p className="muted small">Working… (checking, clicking once, then verifying)</p>}

      {last && trashIdle && <OutcomeView outcome={last} />}

      {selected && phase === 'idle' && trashIdle && !ctx.locked && !ctx.unavailable && (
        <button className="secondary" onClick={() => run('UNSELECT_CHECKBOX')}>
          Unselect this post
        </button>
      )}

      {phase === 'idle' && (
        <TrashPanel
          item={item}
          ctx={ctx}
          selected={selected}
          ui={state.trash}
          setUi={(trash) => update((s) => ({ ...s, trash }))}
          onFinished={() => update((s) => ({ ...s, selected: false }))}
          refreshActionState={refreshActionState}
        />
      )}
    </div>
  );
}

function stateText(c: CheckboxStateChange): string {
  return c.before === c.after ? `${c.after} (unchanged)` : `${c.before} → ${c.after}`;
}

function neighboursText(v: CheckboxVerification): string {
  const parts = [
    v.previousRow ? `previous ${stateText(v.previousRow)}` : null,
    v.nextRow ? `next ${stateText(v.nextRow)}` : null,
  ].filter(Boolean);
  if (parts.length === 0) return 'none to compare';
  const allOk = (v.previousRow?.ok ?? true) && (v.nextRow?.ok ?? true);
  return `${allOk ? 'unchanged' : 'CHANGED'} (${parts.join('; ')})`;
}

function masterText(v: CheckboxVerification): string {
  const m = v.master;
  if (!m) return 'not found';
  if (!m.ok) return `UNEXPECTED: ${m.before} → ${m.after}`;
  if (m.before === m.after) return `unchanged (${m.after})`;
  if (m.after === 'mixed') return `indeterminate (${m.before} → mixed)`;
  return `${m.before} → ${m.after}`;
}

function VerificationTable({ v }: { v: CheckboxVerification }) {
  const o = v.otherCheckboxes;
  return (
    <>
      <table className="kv">
        <tbody>
          <tr>
            <th>Target checkbox</th>
            <td className={v.target.ok ? 'ok' : 'error'}>{v.target.after}{v.target.before !== v.target.after ? ` (was ${v.target.before})` : ''}</td>
          </tr>
          <tr>
            <th>Neighboring rows</th>
            <td className={(v.previousRow?.ok ?? true) && (v.nextRow?.ok ?? true) ? '' : 'error'}>{neighboursText(v)}</td>
          </tr>
          <tr>
            <th>Master checkbox</th>
            <td className={v.master && !v.master.ok ? 'error' : ''}>{masterText(v)}</td>
          </tr>
          <tr>
            <th>Other checkboxes</th>
            <td className={o.changed > 0 ? 'error' : ''}>
              {o.compared} compared, {o.changed} changed{o.disappeared > 0 ? `, ${o.disappeared} left the page` : ''}
            </td>
          </tr>
          <tr>
            <th>Page URL</th>
            <td className={v.urlUnchanged ? '' : 'error'}>{v.urlUnchanged ? 'unchanged' : 'CHANGED'}</td>
          </tr>
        </tbody>
      </table>
      <p className="muted small break">{v.masterNote}</p>
    </>
  );
}

function OutcomeView({ outcome }: { outcome: Outcome }) {
  const verb = outcome.action === 'SELECT_CHECKBOX' ? 'Selected' : 'Unselected';
  if (outcome.kind === 'success') {
    return (
      <div className="outcome ok-box">
        <p className="ok"><strong>{verb} successfully</strong></p>
        <VerificationTable v={outcome.verification} />
      </div>
    );
  }
  const unexpected = outcome.verification !== null;
  return (
    <div className="outcome error-box">
      <p>
        <strong>{unexpected ? 'Warning: unexpected state after the click' : `${verb === 'Selected' ? 'Select' : 'Unselect'} refused`}</strong>
        {outcome.code && <code className="small"> {outcome.code}</code>}
      </p>
      <p className="small break">{outcome.message}</p>
      {unexpected && (
        <p className="small">
          No further actions will be performed. Check the checkboxes on Facebook yourself and reload the tab.
        </p>
      )}
      {!unexpected && outcome.needsRescan && <p className="small">Scan again before retrying.</p>}
      {outcome.verification && <VerificationTable v={outcome.verification} />}
    </div>
  );
}

/** Fetches the content script's lock and action log. */
export async function fetchActionState(tabId: number): Promise<ActionState> {
  const msg: PopupRequest = { type: 'FPC_ACTION_STATE_TAB', tabId };
  const res: ActionStateResponse | undefined = await chrome.runtime.sendMessage(msg);
  if (!res) throw new Error('No response from the background service worker.');
  if (!res.ok) throw new Error(res.error);
  return res.state;
}

function resultClass(result: string): string {
  return result.startsWith('SUCCESS') || result.startsWith('READY') || result === 'COMPLETE' ? 'ok' : result.startsWith('UNEXPECTED') || /^(FAILED|PARTIAL|INCONCLUSIVE)/.test(result) ? 'error' : 'warn';
}

/**
 * Diagnostic only: every action attempt since the Facebook tab was loaded, plus the V3B queue-level
 * events (kept in session storage), newest first. No Facebook content.
 */
export function ActionLog({ log, locked, queueLog = [] }: { log: ActionLogEntry[]; locked: string | null; queueLog?: QueueLogEntry[] }) {
  type Row = { kind: 'action'; e: ActionLogEntry } | { kind: 'queue'; e: QueueLogEntry };
  const rows: Row[] = [...log.map((e): Row => ({ kind: 'action', e })), ...queueLog.map((e): Row => ({ kind: 'queue', e }))];
  // Stable: entries with the same timestamp keep their order.
  const ordered = rows.map((r, i) => ({ r, i })).sort((a, b) => a.r.e.timestamp.localeCompare(b.r.e.timestamp) || a.i - b.i).map((x) => x.r);
  return (
    <details className="action-log">
      <summary>Action log ({rows.length}){locked ? ' · LOCKED' : ''}</summary>
      <p className="muted small">Actions: in memory in the Facebook tab only, cleared when the tab reloads. Queue events: session storage.</p>
      {locked && <p className="error small">Locked: {locked}</p>}
      {rows.length === 0 ? (
        <p className="muted small">No actions yet.</p>
      ) : (
        <table className="grid">
          <thead>
            <tr><th>Time</th><th>Item</th><th>Action</th><th>Class.</th><th>Checkbox</th><th>Result</th></tr>
          </thead>
          <tbody>
            {[...ordered].reverse().map((row, i) => row.kind === 'queue' ? (
              <tr key={i} title={`queue ${row.e.queueId}`}>
                <td>{new Date(row.e.timestamp).toLocaleTimeString()}</td>
                <td className="break">
                  queue {row.e.queueId.slice(0, 8)}{row.e.batch !== null ? ` · batch ${row.e.batch}` : ''}
                  {row.e.scanSessionId && <><br /><span className="muted">{row.e.scanSessionId.slice(0, 8)}</span></>}
                </td>
                <td className="break">{row.e.event}</td>
                <td colSpan={2} className="break muted">{Object.entries(row.e.counts).map(([k, v]) => `${k} ${v}`).join(', ') || '—'}</td>
                <td className={`break ${resultClass(row.e.result)}`}>{row.e.result}</td>
              </tr>
            ) : (
              <ActionRow key={i} e={row.e} />
            ))}
          </tbody>
        </table>
      )}
    </details>
  );
}

function ActionRow({ e }: { e: ActionLogEntry }) {
  return (
    <tr title={`scan ${e.scanSessionId}`}>
      <td>{new Date(e.timestamp).toLocaleTimeString()}</td>
      <td className="break">
        {e.itemId}
        <br />
        <span className="muted">{e.scanSessionId.slice(0, 8)}</span>
        {e.batchId && <><br /><span className="muted">batch {e.batchId.slice(0, 8)} · {e.count ?? '?'}</span></>}
      </td>
      <td className="break">{e.action}{e.batchState && <><br /><span className="muted">{e.batchState}</span></>}</td>
      <td>{e.classification ?? '—'}</td>
      <td>{e.checkboxConfidence ?? '—'}</td>
      <td className={`break ${resultClass(e.result)}`}>{e.result}</td>
    </tr>
  );
}
