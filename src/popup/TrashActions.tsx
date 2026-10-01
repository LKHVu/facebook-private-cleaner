/**
 * V1B popup UI: move ONE selected ONLY_ME post to Facebook's Trash.
 *
 *   [Move this post to Trash] → our confirmation (with a live check of the toolbar's Trash button)
 *   → Continue: the content script clicks the toolbar's Trash button and only discovers Facebook's dialog
 *   → our second confirmation, showing what Facebook's dialog says
 *   → Confirm move to Trash: the content script clicks Facebook's confirm button, then verifies.
 *
 * The popup only asks. facebookTrashAction.ts re-checks every safety condition before each click.
 */

import { useEffect, useState } from 'react';
import type {
  BulkActionKind,
  DialogDiscovery,
  Failure,
  PopupRequest,
  ToolbarDiscovery,
  ToolbarResponse,
  TrashRequest,
  TrashResponse,
  TrashStep,
  TrashVerification,
} from '../shared/types';
import { BULK_ACTION_KINDS, SCANNER_PROTOCOL } from '../shared/types';
import type { ActionContext } from './CheckboxActions';
import type { SafeItem } from './normalize';
import { toolbarReady } from './safetyRules';

export const BULK_ACTION_LABELS: Record<BulkActionKind, string> = {
  archive: 'Archive',
  trash: 'Trash',
  changeAudience: 'Change audience',
};

export type TrashUi =
  | { kind: 'idle' }
  | { kind: 'confirming' }
  | { kind: 'working'; message: string }
  | { kind: 'facebook-dialog'; pendingId: string; dialog: DialogDiscovery }
  | { kind: 'cancelled'; clickedCancel: boolean; note: string }
  | { kind: 'completed'; outcome: 'SUCCESS' | 'INCONCLUSIVE'; verification: TrashVerification }
  | {
      kind: 'failed';
      step: TrashStep | null;
      code: string | null;
      message: string;
      /** Something was clicked on Facebook before it failed. */
      clicked: boolean;
      needsRescan: boolean;
      toolbar: ToolbarDiscovery | null;
      dialog: DialogDiscovery | null;
      verification: TrashVerification | null;
    };

export const IDLE_TRASH: TrashUi = { kind: 'idle' };

/** Read-only: runs toolbar discovery in the Facebook tab now. */
export async function fetchToolbar(tabId: number, scanSessionId: string): Promise<ToolbarDiscovery> {
  const msg: PopupRequest = { type: 'FPC_TOOLBAR_DISCOVER_TAB', tabId, scanSessionId };
  const res: ToolbarResponse | undefined = await chrome.runtime.sendMessage(msg);
  if (!res) throw new Error('No response from the background service worker.');
  if (!res.ok) throw new Error(res.error);
  return res.toolbar;
}

export { toolbarReady };

function mark(found: boolean, ambiguous: boolean): string {
  return found ? '✓' : ambiguous ? '?' : '✗';
}

/** Bulk toolbar ✓ Archive ✓ Trash ✓ Change audience, with confidence and selection count. */
export function ToolbarChecklist({ toolbar, expected = 1 }: { toolbar: ToolbarDiscovery; expected?: number }) {
  return (
    <table className="kv">
      <tbody>
        <tr>
          <th>Bulk toolbar</th>
          <td className={toolbar.confidence === 'HIGH' ? 'ok' : 'warn'}>
            {mark(toolbar.found, false)} {toolbar.found ? toolbar.confidence : 'not found'}
          </td>
        </tr>
        {BULK_ACTION_KINDS.map((k) => {
          const a = toolbar.actions[k];
          return (
            <tr key={k}>
              <th>{BULK_ACTION_LABELS[k]}</th>
              <td className={a.confidence === 'HIGH' ? 'ok' : a.found ? 'warn' : 'muted'}>
                {mark(a.found, a.ambiguousCandidates > 0)} {a.found ? a.confidence : a.ambiguousCandidates > 0 ? `ambiguous (${a.ambiguousCandidates})` : 'missing'}
              </td>
            </tr>
          );
        })}
        <tr>
          <th>Selected</th>
          <td className={toolbar.selectedCount === expected ? '' : 'warn'}>
            {toolbar.selectedCount} checkbox(es) · master {toolbar.masterState}
            {toolbar.unreadableCount > 0 ? ` · ${toolbar.unreadableCount} unreadable` : ''}
          </td>
        </tr>
      </tbody>
    </table>
  );
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

interface PanelProps {
  item: SafeItem;
  ctx: ActionContext;
  /** This popup selected the post in the current scan. */
  selected: boolean;
  ui: TrashUi;
  setUi(ui: TrashUi): void;
  /** The post was moved (or may have been): it no longer counts as selected. */
  onFinished(): void;
  refreshActionState(): void;
}

/** Rendered inside the V1A action panel of an ONLY_ME item. */
export function TrashPanel({ item, ctx, selected, ui, setUi, onFinished, refreshActionState }: PanelProps) {
  const { tabId, scanSessionId } = ctx;
  const otherPending = ctx.pendingTrash && ctx.pendingTrash.itemId !== item.itemId;
  const restartable = ui.kind === 'idle' || ui.kind === 'cancelled' || (ui.kind === 'failed' && !ui.clicked);
  const blocker =
    ctx.locked ? 'actions are locked.' :
    ctx.unavailable ? ctx.unavailable :
    !item.permalink ? 'this row has no post link, so removal could not be verified.' :
    otherPending ? 'another post has a Trash waiting for confirmation.' :
    null;

  async function send(step: TrashStep, pendingId: string | null, working: string): Promise<TrashResponse | null> {
    if (tabId === null || !scanSessionId || !item.itemId) return null;
    setUi({ kind: 'working', message: working });
    try {
      const request: TrashRequest = { protocol: SCANNER_PROTOCOL, scanSessionId, itemId: item.itemId, step, pendingId, confirmed: true };
      const msg: PopupRequest = { type: 'FPC_TRASH_TAB', tabId, request };
      const res: TrashResponse | Failure | undefined = await chrome.runtime.sendMessage(msg);
      if (!res) throw new Error('No response from the background service worker.');
      if (!res.ok && !('code' in res)) throw new Error(res.error);
      return res;
    } catch (e) {
      // No answer from the Facebook tab: the step may or may not have clicked something, so assume it did.
      setUi({
        kind: 'failed',
        step,
        code: null,
        message: `Could not tell what happened on Facebook: ${e instanceof Error ? e.message : String(e)}`,
        clicked: step !== 'CANCEL',
        needsRescan: true,
        toolbar: null,
        dialog: null,
        verification: null,
      });
      return null;
    } finally {
      refreshActionState();
    }
  }

  function showFailure(res: TrashResponse) {
    if (res.ok) return;
    setUi({
      kind: 'failed',
      step: res.step,
      code: res.code,
      message: res.error,
      clicked: res.clicked,
      needsRescan: res.needsRescan,
      toolbar: res.toolbar,
      dialog: res.dialog,
      verification: res.verification,
    });
    if (res.step === 'CONFIRM' && res.clicked) onFinished();
  }

  async function openDialog() {
    const res = await send('OPEN_DIALOG', null, "Checking everything again, clicking Facebook's Trash button once, then looking for Facebook's confirmation dialog…");
    if (!res) return;
    if (res.ok && res.step === 'OPEN_DIALOG') setUi({ kind: 'facebook-dialog', pendingId: res.pendingId, dialog: res.dialog });
    else showFailure(res);
  }

  async function confirm(pendingId: string) {
    const res = await send('CONFIRM', pendingId, "Checking everything again, clicking Facebook's confirmation once, then verifying…");
    if (!res) return;
    if (res.ok && res.step === 'CONFIRM') {
      setUi({ kind: 'completed', outcome: res.outcome, verification: res.verification });
      onFinished();
    } else showFailure(res);
  }

  async function cancel(pendingId: string) {
    const res = await send('CANCEL', pendingId, "Cancelling Facebook's dialog…");
    if (!res) return;
    if (res.ok && res.step === 'CANCEL') setUi({ kind: 'cancelled', clickedCancel: res.clickedCancel, note: res.note });
    else showFailure(res);
  }

  return (
    <>
      {selected && restartable && !blocker && (
        <button className="danger" onClick={() => setUi({ kind: 'confirming' })}>
          Move this post to Trash
        </button>
      )}
      {selected && restartable && blocker && !ctx.locked && <p className="muted small">Trash unavailable: {blocker}</p>}

      {ui.kind === 'confirming' && (
        <TrashConfirm item={item} ctx={ctx} onCancel={() => setUi(IDLE_TRASH)} onContinue={openDialog} />
      )}

      {ui.kind === 'working' && <p className="muted small">{ui.message}</p>}

      {ui.kind === 'facebook-dialog' && (
        <div className="confirm danger-box" role="alertdialog" aria-label="Facebook is asking for confirmation">
          <p><strong>Facebook is asking for confirmation.</strong></p>
          <DialogView dialog={ui.dialog} />
          <p className="small">
            Only after you press Confirm will the extension click Facebook's "{ui.dialog.buttons.find((b) => b.role === 'confirm')?.name ?? 'confirm'}"
            button, once.
          </p>
          <div className="confirm-buttons">
            <button className="secondary" autoFocus onClick={() => cancel(ui.pendingId)}>
              Cancel
            </button>
            <button className="danger" onClick={() => confirm(ui.pendingId)}>
              Confirm move to Trash
            </button>
          </div>
        </div>
      )}

      {ui.kind === 'cancelled' && (
        <div className="outcome ok-box">
          <p className="small">{ui.note}</p>
        </div>
      )}

      {ui.kind === 'completed' && <CompletedView outcome={ui.outcome} v={ui.verification} />}

      {ui.kind === 'failed' && <FailedView ui={ui} />}
    </>
  );
}

type ToolbarCheck = { kind: 'loading' } | { kind: 'ok'; toolbar: ToolbarDiscovery } | { kind: 'error'; message: string };

/** Our first confirmation, before anything on Facebook is clicked. Includes a live, read-only toolbar check. */
function TrashConfirm({ item, ctx, onCancel, onContinue }: { item: SafeItem; ctx: ActionContext; onCancel(): void; onContinue(): void }) {
  const [check, setCheck] = useState<ToolbarCheck>({ kind: 'loading' });
  const { tabId, scanSessionId } = ctx;

  function recheck() {
    if (tabId === null || !scanSessionId) return;
    setCheck({ kind: 'loading' });
    fetchToolbar(tabId, scanSessionId).then(
      (toolbar) => setCheck({ kind: 'ok', toolbar }),
      (e: unknown) => setCheck({ kind: 'error', message: e instanceof Error ? e.message : String(e) }),
    );
  }
  useEffect(recheck, [tabId, scanSessionId]);

  const notReady = check.kind === 'ok' ? toolbarReady(check.toolbar) : check.kind === 'error' ? check.message : 'checking…';

  return (
    <div className="confirm danger-box" role="alertdialog" aria-label="Confirm moving this post to Trash">
      <p><strong>Move this one Facebook post to Trash?</strong></p>
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
          <tr>
            <th>Permalink</th>
            <td className="break">{item.permalink ? <a href={item.permalink} target="_blank" rel="noreferrer">{item.permalink}</a> : <span className="error">none</span>}</td>
          </tr>
        </tbody>
      </table>
      <p className="small"><strong>Only this one selected post will be affected.</strong></p>
      <p className="small muted">
        Continue clicks Facebook's Trash button once and then stops at Facebook's confirmation dialog. You will be asked
        again before that dialog is confirmed.
      </p>

      <h4>Facebook toolbar (checked now)</h4>
      {check.kind === 'loading' && <p className="muted small">Checking the toolbar…</p>}
      {check.kind === 'error' && <p className="error small">{check.message}</p>}
      {check.kind === 'ok' && <ToolbarChecklist toolbar={check.toolbar} />}
      {check.kind !== 'loading' && notReady && <p className="warn small">Cannot continue: {notReady}.</p>}

      <div className="confirm-buttons">
        <button className="secondary small" onClick={recheck} disabled={check.kind === 'loading'}>
          Re-check
        </button>
        <button className="secondary" autoFocus onClick={onCancel}>
          Cancel
        </button>
        <button className="danger" disabled={notReady !== null} onClick={onContinue}>
          Continue
        </button>
      </div>
    </div>
  );
}

/** What was discovered in Facebook's confirmation dialog. */
export function DialogView({ dialog }: { dialog: DialogDiscovery }) {
  return (
    <>
      <table className="kv">
        <tbody>
          <tr><th>Dialog</th><td>{dialog.found ? <><code>{dialog.role}</code> {dialog.name ? `"${dialog.name}"` : <span className="muted">(no name)</span>}</> : <span className="error">not found</span>}</td></tr>
          {dialog.text && <tr><th>Text</th><td className="break">{dialog.text}</td></tr>}
          <tr><th>About Trash</th><td className={dialog.mentionsTrash ? 'ok' : 'warn'}>{dialog.mentionsTrash ? 'yes' : 'no'}</td></tr>
          <tr>
            <th>Confirm</th>
            <td className={dialog.confirm.confidence === 'HIGH' ? 'ok' : 'error'}>
              {dialog.confirm.found ? dialog.confirm.confidence : dialog.confirm.ambiguousCandidates > 0 ? 'ambiguous' : 'missing'}
              <br /><span className="muted small break">{dialog.confirm.reason}</span>
            </td>
          </tr>
          <tr>
            <th>Cancel</th>
            <td className={dialog.cancel.confidence === 'HIGH' ? '' : 'warn'}>
              {dialog.cancel.found ? dialog.cancel.confidence : dialog.cancel.ambiguousCandidates > 0 ? 'ambiguous' : 'missing'}
              <br /><span className="muted small break">{dialog.cancel.reason}</span>
            </td>
          </tr>
        </tbody>
      </table>
      <details>
        <summary className="small muted">Buttons in the dialog ({dialog.buttons.length}) · appeared after {dialog.waitedMs} ms</summary>
        <table className="grid">
          <thead><tr><th>Role</th><th>Name</th><th>Signals</th></tr></thead>
          <tbody>
            {dialog.buttons.map((b, i) => (
              <tr key={i} className={b.role === 'confirm' ? 'used' : ''}>
                <td>{b.role}</td>
                <td className="break">{b.name || <span className="muted">(none)</span>}<br /><span className="muted">{b.nameSource} · <code>{b.element}</code></span></td>
                <td className="break muted">{b.signals.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small break">{dialog.reason}</p>
      </details>
    </>
  );
}

function yesNo(v: boolean, good: boolean) {
  return <td className={v === good ? 'ok' : 'error'}>{v ? 'yes' : 'no'}</td>;
}

export function TrashVerificationTable({ v }: { v: TrashVerification }) {
  const o = v.otherRows;
  return (
    <table className="kv">
      <tbody>
        <tr><th>Target row disconnected</th>{yesNo(v.targetRowDisconnected, true)}</tr>
        <tr><th>Target permalink absent</th>{yesNo(v.targetPermalinkAbsent, true)}</tr>
        <tr>
          <th>Other mapped rows retained</th>
          <td className={o.missing === 0 ? 'ok' : 'error'}>
            {o.missing === 0 ? 'yes' : 'NO'} ({o.connected} unchanged, {o.rerendered} re-rendered, {o.missing} missing of {o.total})
          </td>
        </tr>
        <tr><th>Selected count</th><td className={v.selectedCount === 0 ? 'ok' : 'error'}>{v.selectedCount}</td></tr>
        <tr><th>URL unchanged</th>{yesNo(v.urlUnchanged, true)}</tr>
        <tr><th>Facebook dialog closed</th>{yesNo(v.dialogClosed, true)}</tr>
        <tr><th>Waited</th><td>{v.waitedMs} ms</td></tr>
      </tbody>
    </table>
  );
}

function CompletedView({ outcome, v }: { outcome: 'SUCCESS' | 'INCONCLUSIVE'; v: TrashVerification }) {
  const ok = outcome === 'SUCCESS';
  return (
    <div className={`outcome ${ok ? 'ok-box' : 'error-box'}`}>
      <p className={ok ? 'ok' : ''}>
        <strong>{ok ? 'Moved to Trash (verified)' : 'INCONCLUSIVE: could not verify the result'}</strong>
      </p>
      {v.notes.length > 0 && (
        <ul className="small">
          {v.notes.map((n, i) => <li key={i} className="break">{n}</li>)}
        </ul>
      )}
      <TrashVerificationTable v={v} />
      <p className="small">
        {ok
          ? 'This scan is now used up. Scan again before doing anything else.'
          : "No further actions will be performed on this scan. Check Facebook's Trash and the Activity Log yourself, then scan again."}
      </p>
    </div>
  );
}

function FailedView({ ui }: { ui: Extract<TrashUi, { kind: 'failed' }> }) {
  return (
    <div className="outcome error-box">
      <p>
        <strong>{ui.clicked ? 'Warning: stopped after a click on Facebook' : 'Trash refused (nothing was clicked)'}</strong>
        {ui.code && <code className="small"> {ui.code}</code>}
      </p>
      <p className="small break">{ui.message}</p>
      {ui.clicked && <p className="small">No further actions will be performed. Check Facebook yourself and reload the tab.</p>}
      {!ui.clicked && ui.needsRescan && <p className="small">Scan again before retrying.</p>}
      {ui.toolbar && <ToolbarChecklist toolbar={ui.toolbar} />}
      {ui.dialog && <DialogView dialog={ui.dialog} />}
      {ui.verification && <TrashVerificationTable v={ui.verification} />}
    </div>
  );
}
