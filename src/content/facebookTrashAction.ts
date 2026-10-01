/**
 * facebookTrashAction.ts
 *
 * V1B: move ONE post to Facebook's Trash through the Activity Log's own bulk toolbar. Together
 * with facebookActions.ts, the only code in the extension that changes Facebook's page.
 *
 * The flow is split into steps, each started by its own explicit confirmation in the popup:
 *
 *   OPEN_DIALOG  re-check everything, click the toolbar's HIGH-confidence Trash button once,
 *                then only DISCOVER Facebook's confirmation dialog. Nothing else is clicked.
 *                The dialog and its confirm / cancel buttons are kept as a pending Trash.
 *   CONFIRM      re-check everything again, click Facebook's HIGH-confidence confirm button
 *                once, then verify with the post's permalink that exactly this post left the list.
 *   CANCEL       click Facebook's HIGH-confidence Cancel / Close button (never the confirm
 *                button), or leave the dialog for the user to close when it isn't HIGH.
 *
 * Hard limits: one post per flow, only a post this extension selected itself, and only when it
 * is the only selected checkbox on the page. No loops, no select-all, no permanent deletion.
 * A scan used for a CONFIRM is retired: nothing more happens on it until a new scan.
 *
 * The toolbar gate, the dialog click-and-discover, the dialog re-check, Facebook's Cancel and the
 * permalink checks are exported: V2A's facebookBatchAction.ts reuses them for its one bulk Trash.
 */

import type {
  ActionLogEntry,
  DialogDiscovery,
  OtherRowsCheck,
  TrashErrorCode,
  TrashRequest,
  TrashResponse,
  TrashStep,
  TrashFailure,
  ToolbarDiscovery,
  TrashVerification,
} from '../shared/types';
import { SCANNER_PROTOCOL } from '../shared/types';
import * as fba from './facebookActions';
import * as fbc from './facebookControls';
import * as fbt from './facebookToolbar';

const STEPS: readonly TrashStep[] = ['OPEN_DIALOG', 'CONFIRM', 'CANCEL'];
const LOG_ACTION: Record<TrashStep, string> = {
  OPEN_DIALOG: 'TRASH_OPEN_DIALOG',
  CONFIRM: 'TRASH_CONFIRM',
  CANCEL: 'TRASH_CANCEL',
};
/** How long to wait for Facebook's dialog after the toolbar click. */
export const DIALOG_WAIT_MS = 5000;
const DIALOG_POLL_MS = 100;
/** The dialog must look the same again after this pause (no re-render mid-discovery). */
const DIALOG_SETTLE_MS = 300;
/** A pending Trash is only confirmable for this long; after that Facebook's dialog must be closed by hand. */
export const PENDING_TTL_MS = 2 * 60_000;
/** How long to wait for the post to leave the list after Facebook's confirm click. */
const REMOVAL_WAIT_MS = 10_000;
export const REMOVAL_POLL_MS = 150;
/** Extra wait after removal, so unexpected side effects have time to show. */
export const REMOVAL_SETTLE_MS = 700;
const CANCEL_WAIT_MS = 2000;
const MAX_MISSING_IDS = 10;

type Stop = Pick<TrashFailure, 'code' | 'error' | 'needsRescan'>;

interface Pending {
  pendingId: string;
  scanSessionId: string;
  itemId: string;
  createdAt: number;
  url: string;
  dialog: Element;
  confirm: HTMLElement;
  cancel: HTMLElement | null;
}
let pending: Pending | null = null;
/** Set right before each click on Facebook's page, so an error afterwards knows the page may have changed. */
let clickedThisStep = false;

/** The only way this module clicks anything: the element's own native click(), exactly once. */
function clickOnce(el: HTMLElement): void {
  clickedThisStep = true;
  el.click();
}

const sleep = fba.sleep;

function setPending(p: Pending | null): void {
  pending = p;
  fba.setPendingTrash(p && { scanSessionId: p.scanSessionId, itemId: p.itemId, pendingId: p.pendingId, since: new Date(p.createdAt).toISOString() });
}

/** Drops a pending Trash without clicking anything (e.g. a new scan started). Facebook's dialog, if still open, is left alone. */
export function discardPending(reason: string): void {
  if (!pending) return;
  fba.record({ scanSessionId: pending.scanSessionId, itemId: pending.itemId, action: 'TRASH_DISCARD' }, null, `DISCARDED:${reason}`);
  setPending(null);
}

function isExpired(p: Pending): boolean {
  return Date.now() - p.createdAt > PENDING_TTL_MS;
}

// ---------------------------------------------------------------------------
// Shared checks
// ---------------------------------------------------------------------------

interface Target {
  session: fba.ActionableSession;
  item: fba.ActionableItem & { permalink: string };
  checkbox: HTMLElement;
}

/**
 * Everything about the post itself that must hold before either click: validateTarget's
 * checks 1-9 (current scan, exact row, ONLY_ME from strong evidence re-classified now, same
 * HIGH checkbox, same permalink), then a permalink to verify with, selected by this extension,
 * still checked, and no other checkbox on the page selected.
 */
function checkTarget(session: fba.ActionableSession | null, req: TrashRequest, deps: fba.ActionDeps): Target | fba.Refusal<TrashErrorCode> {
  const t = fba.validateTarget(session, req.scanSessionId, req.itemId, deps);
  if (t.refused) return t;
  const s = session!;
  const { item, checkbox } = t;

  if (!item.permalink) {
    return fba.refuse('NO_PERMALINK', 'This row has no post link, so removing it could not be verified. Nothing was clicked.');
  }
  if (!fba.isSelectedByExtension(s.id, item.itemId)) {
    return fba.refuse('NOT_SELECTED_BY_EXTENSION', 'Only a post this extension selected itself in the current scan can be moved to Trash. Select it with "Select this post" first.');
  }
  const own = fbc.readCheckState(checkbox);
  if (own.state !== 'checked') return fba.refuse('NOT_SELECTED', `The post's checkbox is ${own.state} (${own.detail}), not selected. Nothing was clicked.`);

  // Exactly one post selected: every other mapped row reads unchecked, and nothing else on the page reads checked.
  for (const other of s.items) {
    if (other === item || !other.checkbox?.isConnected) continue;
    const st = fbc.readCheckState(other.checkbox);
    if (st.state !== 'unchecked') {
      return fba.refuse('OTHER_SELECTED', `Row ${other.itemId}'s checkbox is ${st.state}, not unchecked. Only one post may be selected. Nothing was clicked.`);
    }
  }
  const sel = fbt.readSelection(s.masterCheckbox);
  const others = sel.checked.filter((el) => !fba.overlaps(el, checkbox));
  if (others.length > 0) {
    return fba.refuse('OTHER_SELECTED', `${others.length} other checkbox(es) on the page are selected. Only one post may be selected. Nothing was clicked.`);
  }
  if (sel.mixed.length > 0) return fba.refuse('OTHER_SELECTED', `${sel.mixed.length} checkbox(es) on the page are partly selected. Nothing was clicked.`);
  if (sel.masterState === 'checked') return fba.refuse('OTHER_SELECTED', 'The master select-all checkbox is fully selected. Nothing was clicked.');
  if (!sel.checked.some((el) => fba.overlaps(el, checkbox))) {
    return fba.refuse('STATE_UNREADABLE', "The page-wide checkbox reading doesn't include this post's checkbox. Nothing was clicked.", true);
  }

  return { session: s, item: item as Target['item'], checkbox };
}

// ---------------------------------------------------------------------------
// Verification (read-only)
// ---------------------------------------------------------------------------

/** Is this (normalised) post URL linked from anywhere on the page now? */
export function permalinkOnPage(href: string): boolean {
  for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    if (a.href && fbc.normalizePostUrl(a.href) === href) return true;
  }
  return false;
}

/** Every (normalised) URL linked from the page now, read once. For checking many permalinks in one pass (V2B). */
export function linkedUrls(): Set<string> {
  const out = new Set<string>();
  for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href]')) if (a.href) out.add(fbc.normalizePostUrl(a.href));
  return out;
}

/**
 * How every mapped row NOT in `targets` is found now: same element, a re-rendered copy (same link), or missing.
 * `linked` (from linkedUrls()) avoids re-reading every link on the page for each row.
 */
export function checkOtherRows(session: fba.ActionableSession, targets: ReadonlySet<fba.ActionableItem>, linked?: ReadonlySet<string>): OtherRowsCheck {
  const r: OtherRowsCheck = { total: 0, connected: 0, rerendered: 0, missing: 0, missingIds: [] };
  const onPage = (href: string) => (linked ? linked.has(href) : permalinkOnPage(href));
  for (const it of session.items) {
    if (targets.has(it)) continue;
    r.total++;
    if (it.row.isConnected) r.connected++;
    else if (it.permalink && onPage(it.permalink)) r.rerendered++;
    else {
      r.missing++;
      if (r.missingIds.length < MAX_MISSING_IDS) r.missingIds.push(it.itemId);
    }
  }
  return r;
}

/** Checked checkboxes on the page, the master counted when it is fully checked. */
export function selectedCount(master: Element | null): number {
  const sel = fbt.readSelection(master);
  return sel.checked.length + (sel.masterState === 'checked' ? 1 : 0);
}

export function dialogClosed(dialog: Element | null): boolean {
  return !dialog || !dialog.isConnected || !fbc.isRendered(dialog);
}

function verify(t: Target, dialog: Element | null, urlBefore: string, waitedMs: number): TrashVerification {
  return {
    targetRowDisconnected: !t.item.row.isConnected,
    targetPermalinkAbsent: !permalinkOnPage(t.item.permalink),
    otherRows: checkOtherRows(t.session, new Set([t.item])),
    selectedCount: selectedCount(t.session.masterCheckbox),
    urlUnchanged: location.href === urlBefore,
    dialogClosed: dialogClosed(dialog),
    waitedMs: Math.round(waitedMs),
    notes: [],
  };
}

type Judgement = { outcome: 'SUCCESS' | 'INCONCLUSIVE' } | { outcome: 'UNEXPECTED'; why: string };

/**
 * SUCCESS only when the exact row is gone, the post's link is nowhere on the page, every
 * other mapped row (or its re-rendered copy) is still there, nothing is selected, the URL is
 * the same and Facebook's dialog closed. Clear contradictions lock; anything else is INCONCLUSIVE.
 */
function judge(v: TrashVerification): Judgement {
  if (!v.urlUnchanged) return { outcome: 'UNEXPECTED', why: 'The page URL changed.' };
  const removed = v.targetRowDisconnected && v.targetPermalinkAbsent;
  if (removed && v.selectedCount > 0) {
    return { outcome: 'UNEXPECTED', why: `The post left the list, but ${v.selectedCount} checkbox(es) are still selected.` };
  }
  if (!v.dialogClosed) v.notes.push("Facebook's dialog is still open.");
  if (!v.targetRowDisconnected && !v.targetPermalinkAbsent) v.notes.push('The post is still in the list (its row and its link are both on the page).');
  if (v.targetRowDisconnected && !v.targetPermalinkAbsent) {
    v.notes.push("The row element is gone, but the post's link is still on the page: Facebook re-rendered the list and the post may still be listed.");
  }
  if (!v.targetRowDisconnected && v.targetPermalinkAbsent) v.notes.push("The row element is still on the page, but the post's link is gone.");
  if (v.otherRows.missing > 0) {
    v.notes.push(
      `${v.otherRows.missing} other previously scanned row(s) are no longer on the page (${v.otherRows.missingIds.join(', ')}). ` +
        'Facebook may have unloaded them while re-rendering, or removed them. Check Facebook\'s Trash.',
    );
  }
  if (!removed && v.selectedCount > 0) v.notes.push(`${v.selectedCount} checkbox(es) are still selected.`);
  return { outcome: v.notes.length === 0 ? 'SUCCESS' : 'INCONCLUSIVE' };
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

interface Extra {
  clicked?: boolean;
  toolbar?: ToolbarDiscovery | null;
  dialog?: DialogDiscovery | null;
  verification?: TrashVerification | null;
}

function failure(req: Partial<TrashRequest>, step: TrashStep | null, item: fba.ActionableItem | null, r: Stop, extra: Extra = {}): TrashFailure {
  const clicked = extra.clicked ?? false;
  fba.record(logIds(req, step), item, `${clicked ? 'UNEXPECTED' : 'REFUSED'}:${r.code}`);
  return {
    ok: false,
    step,
    code: r.code,
    error: r.error,
    needsRescan: r.needsRescan,
    locked: fba.getLockReason() !== null,
    clicked,
    toolbar: extra.toolbar ?? null,
    dialog: extra.dialog ?? null,
    verification: extra.verification ?? null,
    log: fba.getLog(),
  };
}

function logIds(req: Partial<TrashRequest>, step: TrashStep | null): fba.LogIds {
  return { scanSessionId: req.scanSessionId, itemId: req.itemId, action: step ? LOG_ACTION[step] : 'TRASH_(invalid)' };
}

function log(req: TrashRequest, item: fba.ActionableItem | null, result: string): ActionLogEntry[] {
  fba.record(logIds(req, req.step), item, result);
  return fba.getLog();
}

// ---------------------------------------------------------------------------
// Shared primitives (V1B and V2A): toolbar gate, Trash click + dialog discovery, re-check, Cancel
// ---------------------------------------------------------------------------

export interface HighTrash {
  toolbar: ToolbarDiscovery;
  trash: HTMLElement;
}

export interface TrashGateStop {
  stop: { code: 'TOOLBAR_NOT_HIGH' | 'OTHER_SELECTED' | 'SELECTED_COUNT_MISMATCH'; error: string; needsRescan: boolean };
  toolbar: ToolbarDiscovery;
}

/**
 * The toolbar's Trash button may be clicked only when: the toolbar is HIGH, its Trash button is
 * HIGH (enabled, unique on the page), an HTML element strictly inside the toolbar and outside
 * every mapped row, and exactly `expectedSelected` checkboxes are selected. Read-only.
 */
export function findHighTrash(
  session: fba.ActionableSession,
  expectedSelected: number,
  countMismatchCode: 'OTHER_SELECTED' | 'SELECTED_COUNT_MISMATCH',
): HighTrash | TrashGateStop {
  const rows = session.items.map((it) => it.row).filter((r) => r.isConnected);
  const tb = fbt.discoverBulkToolbar(rows, session.masterCheckbox);
  const d = tb.discovery.actions.trash;
  const trash = tb.elements.trash;
  const notHigh = (why: string): TrashGateStop => ({
    stop: { code: 'TOOLBAR_NOT_HIGH', error: `${why} Nothing was clicked.`, needsRescan: false },
    toolbar: tb.discovery,
  });
  if (!tb.toolbar || tb.discovery.confidence !== 'HIGH') {
    return notHigh(`The bulk toolbar is ${tb.discovery.found ? tb.discovery.confidence : 'not found'}: ${tb.discovery.reason}`);
  }
  if (!trash || !d.found || d.confidence !== 'HIGH') return notHigh(`The toolbar's Trash button is ${d.found ? d.confidence : 'not identified'}: ${d.reason}`);
  if (!(trash instanceof HTMLElement) || !tb.toolbar.contains(trash) || rows.some((r) => fba.overlaps(r, trash))) {
    return notHigh('The Trash button is not an HTML element strictly inside the toolbar and outside every post row.');
  }
  if (tb.discovery.selectedCount !== expectedSelected) {
    return {
      stop: {
        code: countMismatchCode,
        error: `${tb.discovery.selectedCount} checkbox(es) are selected on the page, not exactly ${expectedSelected}. Nothing was clicked.`,
        needsRescan: false,
      },
      toolbar: tb.discovery,
    };
  }
  return { toolbar: tb.discovery, trash };
}

export interface OpenedDialog {
  found: fbt.DialogFound;
  url: string;
  waitedMs: number;
}

/**
 * Clicks the (already validated) toolbar Trash button once through `click`, then only looks:
 * waits for a new dialog whose confirm button is HIGH and makes sure it stays the same.
 */
export async function clickTrashAndDiscoverDialog(trash: HTMLElement, click: (el: HTMLElement) => void): Promise<OpenedDialog> {
  const before = fbt.snapshotDialogs();
  const url = location.href;
  const started = performance.now();
  click(trash);

  const elapsed = () => performance.now() - started;
  let found = fbt.discoverTrashDialog(before, 0);
  while (found.discovery.confirm.confidence !== 'HIGH' && elapsed() < DIALOG_WAIT_MS && location.href === url) {
    await sleep(DIALOG_POLL_MS);
    found = fbt.discoverTrashDialog(before, elapsed());
  }
  if (found.discovery.confirm.confidence === 'HIGH') {
    await sleep(DIALOG_SETTLE_MS);
    const again = fbt.discoverTrashDialog(before, elapsed());
    if (again.dialog !== found.dialog || again.confirm !== found.confirm || again.discovery.confirm.confidence !== 'HIGH') {
      again.discovery.reason = `The dialog changed while it was being checked. ${again.discovery.reason}`;
      again.discovery.confirm = { ...again.discovery.confirm, confidence: again.discovery.confirm.found ? 'MEDIUM' : null };
      found = { ...again, confirm: null };
    } else {
      found = again;
    }
  }
  return { found, url, waitedMs: elapsed() };
}

/** The dialog's HIGH confirm button and (only if HIGH) its Cancel button, or why not. */
export function highDialogButtons(found: fbt.DialogFound): { confirm: HTMLElement; cancel: HTMLElement | null } | { why: string } {
  const c = found.discovery.confirm;
  if (!found.dialog) return { why: found.discovery.reason };
  if (!found.confirm || c.confidence !== 'HIGH' || !(found.confirm instanceof HTMLElement)) {
    return { why: `Facebook's confirmation button is ${c.found ? c.confidence : c.ambiguousCandidates > 0 ? 'ambiguous' : 'not found'}: ${c.reason}` };
  }
  const cancel = found.cancel instanceof HTMLElement && found.discovery.cancel.confidence === 'HIGH' ? found.cancel : null;
  return { confirm: found.confirm, cancel };
}

/** The dialog elements kept between opening Facebook's dialog and confirming / cancelling it. */
export interface KeptDialog {
  dialog: Element;
  confirm: HTMLElement;
  cancel: HTMLElement | null;
}

/** Facebook's dialog is still the same element, and discovery on it still picks the same HIGH confirm button. */
export function recheckDialog(k: KeptDialog): { ok: true; again: fbt.DialogFound } | { ok: false; why: string; again: fbt.DialogFound } {
  const again = fbt.discoverTrashDialog(new Set(), 0, k.dialog);
  if (!again.dialog || again.confirm !== k.confirm || again.discovery.confirm.confidence !== 'HIGH' || !k.dialog.contains(k.confirm)) {
    const why = !again.dialog ? "Facebook's dialog has closed." : `Facebook's confirm button changed: ${again.discovery.confirm.reason}`;
    return { ok: false, why, again };
  }
  return { ok: true, again };
}

export interface CancelResult {
  /** Facebook's Cancel / Close button was clicked. */
  clicked: boolean;
  /** The dialog is closed now. */
  closed: boolean;
  alreadyClosed: boolean;
  again: fbt.DialogFound | null;
}

/**
 * Clicks Facebook's Cancel / Close button through `click`, only when it is still the same HIGH
 * button found when the dialog opened (and never the confirm button), then waits for the dialog to close.
 */
export async function cancelFacebookDialog(k: KeptDialog, click: (el: HTMLElement) => void): Promise<CancelResult> {
  if (dialogClosed(k.dialog)) return { clicked: false, closed: true, alreadyClosed: true, again: null };
  const again = fbt.discoverTrashDialog(new Set(), 0, k.dialog);
  const cancel = k.cancel;
  const sameCancel =
    cancel !== null &&
    again.cancel === cancel &&
    again.discovery.cancel.confidence === 'HIGH' &&
    cancel !== k.confirm &&
    !cancel.contains(k.confirm) &&
    k.dialog.contains(cancel);
  if (!sameCancel) return { clicked: false, closed: false, alreadyClosed: false, again };

  const started = performance.now();
  click(cancel);
  while (performance.now() - started < CANCEL_WAIT_MS && !dialogClosed(k.dialog)) await sleep(DIALOG_POLL_MS);
  return { clicked: true, closed: dialogClosed(k.dialog), alreadyClosed: false, again };
}

// ---------------------------------------------------------------------------
// Step 1: click the toolbar's Trash button, then discover Facebook's dialog
// ---------------------------------------------------------------------------

async function openDialog(session: fba.ActionableSession | null, req: TrashRequest, deps: fba.ActionDeps): Promise<TrashResponse> {
  const fail = (item: fba.ActionableItem | null, r: Stop, extra?: Extra) => failure(req, 'OPEN_DIALOG', item, r, extra);

  if (pending && !isExpired(pending)) {
    return fail(null, { code: 'TRASH_PENDING', error: 'Another Trash is already waiting for confirmation. Confirm or cancel it first.', needsRescan: false });
  }
  if (pending) discardPending('expired');

  const t = checkTarget(session, req, deps);
  if ('refused' in t) return fail(session?.items.find((it) => it.itemId === req.itemId) ?? null, t);

  // The toolbar's Trash button: HIGH confidence, inside the toolbar, outside every post row, exactly 1 selected.
  const high = findHighTrash(t.session, 1, 'OTHER_SELECTED');
  if ('stop' in high) return fail(t.item, high.stop as Stop, { toolbar: high.toolbar });
  const tb = high.toolbar;

  // The click: the Trash button's own native click(), exactly once. Then only look.
  const opened = await clickTrashAndDiscoverDialog(high.trash, clickOnce);
  const { found, url } = opened;

  const clickedExtra = { clicked: true, toolbar: tb, dialog: found.discovery };
  const manual = "Nothing else was clicked. Close Facebook's dialog yourself (Cancel), then reload the Facebook tab.";
  if (location.href !== url) {
    fba.lockActions('the page URL changed after clicking the toolbar Trash button.');
    return fail(t.item, { code: 'UNEXPECTED_AFTER_TRASH', error: `The page URL changed after clicking Trash. ${manual}`, needsRescan: true }, clickedExtra);
  }
  if (!found.dialog) {
    fba.lockActions("clicked the toolbar Trash button but no confirmation dialog appeared.");
    const v = verify(t, null, url, opened.waitedMs);
    const gone = v.targetRowDisconnected && v.targetPermalinkAbsent;
    return fail(
      t.item,
      {
        code: 'DIALOG_NOT_FOUND',
        error:
          `No confirmation dialog appeared within ${DIALOG_WAIT_MS / 1000} s. ${found.discovery.reason} ` +
          (gone ? 'The post has left the list anyway: Facebook may have moved it without asking. Check Facebook\'s Trash. ' : '') +
          'Nothing else was clicked. Reload the Facebook tab and check it by hand.',
        needsRescan: true,
      },
      { ...clickedExtra, verification: v },
    );
  }
  const buttons = highDialogButtons(found);
  if ('why' in buttons) {
    fba.lockActions("Facebook's confirmation dialog could not be identified with HIGH confidence.");
    return fail(t.item, { code: 'DIALOG_NOT_HIGH', error: `${buttons.why} ${manual}`, needsRescan: true }, clickedExtra);
  }

  const pendingId = crypto.randomUUID();
  setPending({ pendingId, scanSessionId: t.session.id, itemId: t.item.itemId, createdAt: Date.now(), url, dialog: found.dialog, ...buttons });
  return { ok: true, step: 'OPEN_DIALOG', pendingId, toolbar: tb, dialog: found.discovery, log: log(req, t.item, 'SUCCESS:DIALOG_OPEN') };
}

// ---------------------------------------------------------------------------
// Step 2: click Facebook's confirm button, then verify
// ---------------------------------------------------------------------------

/** The pending Trash this request refers to, or why not. Expired or mismatched ones are dropped. */
function takePending(req: TrashRequest): Pending | Stop {
  const p = pending;
  if (!p || req.pendingId !== p.pendingId || req.scanSessionId !== p.scanSessionId || req.itemId !== p.itemId) {
    return { code: 'NO_PENDING', error: 'No Trash is waiting for this post (it was cancelled, expired or replaced). Nothing was clicked.', needsRescan: true };
  }
  if (isExpired(p)) {
    discardPending('expired');
    return {
      code: 'PENDING_EXPIRED',
      error: `The confirmation waited more than ${PENDING_TTL_MS / 60_000} minutes. Nothing was clicked. Close Facebook's dialog yourself, then scan again.`,
      needsRescan: true,
    };
  }
  return p;
}

async function confirmTrash(session: fba.ActionableSession | null, req: TrashRequest, deps: fba.ActionDeps): Promise<TrashResponse> {
  const fail = (item: fba.ActionableItem | null, r: Stop, extra?: Extra) => failure(req, 'CONFIRM', item, r, extra);
  const p = takePending(req);
  if ('code' in p) return fail(null, p);
  const drop = (r: Stop, extra?: Extra) => (discardPending(r.code), fail(null, { ...r, error: `${r.error} Close Facebook's dialog yourself, then scan again.` }, extra));

  if (location.href !== p.url) return drop({ code: 'NAVIGATED', error: 'The page has navigated since the dialog opened. Nothing was clicked.', needsRescan: true });

  // Facebook's dialog: still the same element, and discovery on it still picks the same HIGH confirm button.
  const re = recheckDialog(p);
  const again = re.again;
  if (!re.ok) return drop({ code: 'DIALOG_CHANGED', error: `${re.why} Nothing was clicked.`, needsRescan: true }, { dialog: again.discovery });

  // The post: every check from step 1 again.
  const t = checkTarget(session, req, deps);
  if ('refused' in t) return drop(t, { dialog: again.discovery });

  // The list changes after this click whatever happens: retire the scan first, so nothing else runs on it.
  fba.retireSession(t.session.id);
  fba.forgetSelection(t.session.id, t.item.itemId);
  setPending(null);
  const url = location.href;
  const started = performance.now();
  clickOnce(p.confirm);

  // Wait for the post to leave the list (or the URL to change), then settle and verify once more.
  let v = verify(t, p.dialog, url, 0);
  while (performance.now() - started < REMOVAL_WAIT_MS) {
    v = verify(t, p.dialog, url, performance.now() - started);
    if (!v.urlUnchanged || (v.dialogClosed && v.targetRowDisconnected && v.targetPermalinkAbsent)) break;
    await sleep(REMOVAL_POLL_MS);
  }
  await sleep(REMOVAL_SETTLE_MS);
  v = verify(t, p.dialog, url, performance.now() - started);

  const j = judge(v);
  if (j.outcome === 'UNEXPECTED') {
    fba.lockActions(`unexpected state after confirming Trash on ${t.item.itemId}: ${j.why}`);
    return fail(t.item, { code: 'UNEXPECTED_AFTER_TRASH', error: `Unexpected state after confirming Trash. ${j.why}`, needsRescan: true }, { clicked: true, dialog: again.discovery, verification: v });
  }
  return { ok: true, step: 'CONFIRM', outcome: j.outcome, verification: v, log: log(req, t.item, j.outcome) };
}

// ---------------------------------------------------------------------------
// Cancel: Facebook's own Cancel / Close button, only when it is HIGH
// ---------------------------------------------------------------------------

async function cancelTrash(session: fba.ActionableSession | null, req: TrashRequest): Promise<TrashResponse> {
  const p = pending;
  const item = session?.items.find((it) => it.itemId === req.itemId) ?? null;
  const done = (clickedCancel: boolean, note: string, result: string): TrashResponse => ({
    ok: true,
    step: 'CANCEL',
    clickedCancel,
    note,
    log: log(req, item, result),
  });
  if (!p || req.pendingId !== p.pendingId || req.scanSessionId !== p.scanSessionId || req.itemId !== p.itemId) {
    return done(false, 'No Trash was waiting for this post. Nothing was clicked.', 'SUCCESS:NOTHING_PENDING');
  }
  setPending(null);

  const url = location.href;
  const c = await cancelFacebookDialog(p, clickOnce);
  if (c.alreadyClosed) return done(false, "Facebook's dialog is already closed. Nothing was clicked.", 'SUCCESS:DIALOG_ALREADY_CLOSED');
  if (!c.clicked) {
    return done(false, "Facebook's Cancel button could not be identified with HIGH confidence, so nothing was clicked. Close Facebook's dialog yourself.", 'SUCCESS:NO_CLICK');
  }

  // Cancelling must leave the post exactly where it was.
  const row = item?.row;
  if (location.href !== url || (row && !row.isConnected)) {
    fba.lockActions('unexpected state after cancelling the Trash dialog.');
    return failure(req, 'CANCEL', item, {
      code: 'UNEXPECTED_AFTER_TRASH',
      error: `After clicking Cancel, ${location.href !== url ? 'the page URL changed' : 'the post\'s row left the page'}. Check Facebook's Trash and reload the tab.`,
      needsRescan: true,
    }, { clicked: true, dialog: c.again?.discovery ?? null });
  }
  const closed = c.closed;
  return done(
    true,
    closed
      ? "Clicked Facebook's Cancel. The dialog closed; the post is still selected and was not moved."
      : "Clicked Facebook's Cancel, but the dialog is still open. Close it yourself.",
    closed ? 'SUCCESS:CANCELLED' : 'SUCCESS:CANCEL_DIALOG_STILL_OPEN',
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function performTrashStep(session: fba.ActionableSession | null, req: TrashRequest, deps: fba.ActionDeps): Promise<TrashResponse> {
  const step = STEPS.includes(req?.step) ? req.step : null;
  const stop = (code: TrashErrorCode, error: string, needsRescan = false) => failure(req ?? {}, step, null, { code, error, needsRescan });

  if (req?.protocol !== SCANNER_PROTOCOL) {
    return stop('PROTOCOL_MISMATCH', 'The popup and the scanner in this tab come from different builds. Reload the Facebook tab, then scan again.', true);
  }
  if (!step || typeof req.scanSessionId !== 'string' || typeof req.itemId !== 'string') return stop('UNKNOWN_ACTION', 'Malformed Trash request.');
  if (step !== 'OPEN_DIALOG' && typeof req.pendingId !== 'string') return stop('UNKNOWN_ACTION', 'Malformed Trash request: no pendingId.');
  if (req.confirmed !== true) return stop('NOT_CONFIRMED', 'This step was not confirmed in the popup. Nothing was clicked.');
  const lock = fba.getLockReason();
  if (lock) return stop('LOCKED', `Actions are locked: ${lock} Reload the Facebook tab to reset.`);
  const batchState = fba.activeBatchState();
  if (batchState) return stop('BATCH_ACTIVE', `A cleanup batch is in progress (${batchState}). Finish or cancel it in the Cleanup batch panel first.`);
  const loading = fba.autoLoadBlock();
  if (loading) return stop('AUTOLOAD_ACTIVE', loading, true);
  if (!fba.tryAcquire()) return stop('BUSY', 'Another action is still running.');

  clickedThisStep = false;
  try {
    switch (step) {
      case 'OPEN_DIALOG':
        return await openDialog(session, req, deps);
      case 'CONFIRM':
        return await confirmTrash(session, req, deps);
      case 'CANCEL':
        return await cancelTrash(session, req);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // After a click we can no longer vouch for the page state.
    if (clickedThisStep) fba.lockActions(`the Trash step ${step} threw after clicking: ${message}`);
    setPending(null);
    return failure(req, step, null, { code: 'INTERNAL_ERROR', error: `${clickedThisStep ? 'Error after the click: ' : ''}${message}`, needsRescan: true }, { clicked: clickedThisStep });
  } finally {
    fba.release();
  }
}
