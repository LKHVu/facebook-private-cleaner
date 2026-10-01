/**
 * facebookActions.ts
 *
 * V1A: selecting or unselecting ONE post's checkbox. Together with facebookTrashAction.ts (V1B,
 * moving that one selected post to Trash) and facebookBatchAction.ts (V2A / V2B, a batch of at
 * most MAX_BATCH_SIZE posts) this is the only code in the extension that changes anything on Facebook's page.
 * Everything else (facebookSelectors.ts, facebookControls.ts, facebookToolbar.ts, the scan in
 * scanner.ts) is read-only. clickCheckboxOnce() below is the one checkbox write all of them use.
 *
 * The checkbox action only ever clicks the exact checkbox element the current scan session
 * stored for that post. It never re-finds a post or a checkbox by text, never clicks menus, and
 * never trashes, archives, deletes or changes an audience.
 *
 * This module also owns the state the write modules share: the action log, the lock, the
 * busy flag, which posts this extension selected, retired scan sessions, a pending Trash, the
 * published state of a V2A batch and the published progress of a V3A auto-load run.
 *
 * Before every click, every safety condition is checked again against the live page. After the
 * click, the target, its neighbours, the master select-all checkbox and every other checkbox on
 * the page are compared with their state before the click. Anything unexpected locks all
 * further actions until the Facebook tab is reloaded.
 */

import type {
  ActionErrorCode,
  AutoLoadSnapshot,
  BatchSnapshot,
  BatchState,
  PendingTrashInfo,
  ActionLogEntry,
  ActionState,
  Audience,
  AudienceBasis,
  CheckboxAction,
  CheckboxActionFailure,
  CheckboxActionRequest,
  CheckboxActionResponse,
  CheckboxStateChange,
  CheckboxVerification,
  CheckState,
  Confidence,
} from '../shared/types';
import { SCANNER_PROTOCOL, isAutoLoadActive, isBatchActive } from '../shared/types';
import * as fbc from './facebookControls';

// ---------------------------------------------------------------------------
// What the scanner hands over
// ---------------------------------------------------------------------------

/** One mapped row of the current scan session, with what the scan decided about it. */
export interface ActionableItem {
  itemId: string;
  row: HTMLElement;
  /** The exact checkbox element control discovery chose for this row during the scan. */
  checkbox: Element | undefined;
  audience: Audience;
  audienceBasis: AudienceBasis;
  checkboxConfidence: Confidence | null;
  checkboxAmbiguous: boolean;
  /** controls.permalink.href at scan time; must be unchanged when acting (the row is still the same post). */
  permalink: string | null;
  /**
   * Every post URL linked from the row at scan time (normalised). Only read by the batch's
   * post-Trash verification, to tell "the row now shows a different post" from "the row still
   * shows another link of this post". Never used to find or act on a row.
   */
  postUrls: string[];
}

export interface ActionableSession {
  id: string;
  url: string;
  /** In document order, so a row's neighbours are the entries before and after it. */
  items: ActionableItem[];
  /** The master select-all checkbox, if the scan found one. Never clicked; only compared. */
  masterCheckbox: Element | null;
  masterNote: string;
}

export interface ActionDeps {
  /** Re-runs the scanner's audience classification on one row, now. Read-only. */
  classify(row: Element): { audience: Audience; basis: AudienceBasis };
}

// ---------------------------------------------------------------------------
// In-memory state (lives until the Facebook tab is reloaded; nothing is persisted)
// ---------------------------------------------------------------------------

const ACTIONS: readonly CheckboxAction[] = ['SELECT_CHECKBOX', 'UNSELECT_CHECKBOX'];
const MAX_LOG = 200;
/** How long to wait for the target checkbox to reach its new state after the click. */
const STATE_WAIT_MS = 1500;
const POLL_MS = 50;
/** Extra wait after the target changed, so side effects on other checkboxes have time to show. */
const SETTLE_MS = 300;
const RESCAN = 'Please scan again.';

const log: ActionLogEntry[] = [];
/** Why further actions are refused, or null. Set by any unexpected post-action state; cleared only by a page reload. */
let lockReason: string | null = null;
let busy = false;
/** `${scanSessionId}:${itemId}` of rows this extension selected and has not unselected since. */
const selectedByExtension = new Set<string>();
/** Scan sessions a Trash attempt used up: the list changed, so every action on them is refused. */
const retiredSessions = new Set<string>();
/** Published by facebookTrashAction.ts while Facebook's Trash dialog waits for the second confirmation. */
let pendingTrash: PendingTrashInfo | null = null;
/** Published by facebookBatchAction.ts on every state change: the batch in progress, or the last one. */
let batchSnapshot: BatchSnapshot | null = null;
/** Published by autoLoad.ts while it runs, and kept after it ends: the running or last auto-load. */
let autoLoadSnapshot: AutoLoadSnapshot | null = null;

export function getActionState(): ActionState {
  return {
    locked: lockReason,
    log: [...log],
    retiredSessions: [...retiredSessions],
    pendingTrash,
    batch: batchSnapshot,
    autoLoad: autoLoadSnapshot,
    pageVisible: document.visibilityState === 'visible',
  };
}

export function publishBatch(snapshot: BatchSnapshot | null): void {
  batchSnapshot = snapshot;
}

export function publishAutoLoad(snapshot: AutoLoadSnapshot | null): void {
  autoLoadSnapshot = snapshot;
}

/** Why every action and scan is refused while older entries are loading, or null. */
export function autoLoadBlock(): string | null {
  return autoLoadSnapshot && isAutoLoadActive(autoLoadSnapshot.state)
    ? 'Facebook is currently loading older Activity Log entries. Wait for loading to finish (or stop it), then scan again.'
    : null;
}

/** The state of a batch that blocks every other action and new scans, or null. */
export function activeBatchState(): BatchState | null {
  return batchSnapshot && isBatchActive(batchSnapshot.state) ? batchSnapshot.state : null;
}

export function getPendingTrash(): PendingTrashInfo | null {
  return pendingTrash;
}

export function getLog(): ActionLogEntry[] {
  return [...log];
}

export function getLockReason(): string | null {
  return lockReason;
}

/** Refuses every further action until the Facebook tab is reloaded. The first reason is kept. */
export function lockActions(reason: string): void {
  lockReason ??= reason;
}

/** One action at a time, across the checkbox and Trash modules. */
export function tryAcquire(): boolean {
  if (busy) return false;
  busy = true;
  return true;
}

export function release(): void {
  busy = false;
}

export function retireSession(scanSessionId: string): void {
  retiredSessions.add(scanSessionId);
}

export function setPendingTrash(info: PendingTrashInfo | null): void {
  pendingTrash = info;
}

export function isSelectedByExtension(scanSessionId: string, itemId: string): boolean {
  return selectedByExtension.has(`${scanSessionId}:${itemId}`);
}

export function forgetSelection(scanSessionId: string, itemId: string): void {
  selectedByExtension.delete(`${scanSessionId}:${itemId}`);
}

/** What the log records about a request: ids and the action name only, never Facebook content. */
export interface LogIds {
  scanSessionId?: unknown;
  itemId?: unknown;
  action?: unknown;
}

export function record(req: LogIds, item: ActionableItem | null, result: string): void {
  log.push({
    timestamp: new Date().toISOString(),
    scanSessionId: typeof req.scanSessionId === 'string' ? req.scanSessionId : '(invalid)',
    itemId: typeof req.itemId === 'string' ? req.itemId : '(invalid)',
    action: typeof req.action === 'string' ? req.action : '(invalid)',
    classification: item?.audience ?? null,
    checkboxConfidence: item?.checkboxConfidence ?? null,
    result,
  });
  if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG);
}

/**
 * What a batch entry records: ids, counts and states only. No permalinks, no Facebook content.
 * Compact for large batches: the item ids are listed once (listIds, on BATCH_CREATED); other
 * batch-wide entries only give the count, per-item entries the one item.
 */
export interface BatchLogFields {
  action: string;
  batchId: string;
  scanSessionId: string;
  itemIds: string[];
  state: BatchState;
  result: string;
  /** Set for per-item entries (a failed select, a rollback failure); the batch-wide entries leave it out. */
  item?: ActionableItem | null;
  /** List every item id in this entry (once per batch). */
  listIds?: boolean;
}

export function recordBatch(f: BatchLogFields): void {
  log.push({
    timestamp: new Date().toISOString(),
    scanSessionId: f.scanSessionId,
    itemId: f.item ? f.item.itemId : f.listIds ? f.itemIds.join(',') : `(${f.itemIds.length} items)`,
    action: f.action,
    classification: f.item?.audience ?? null,
    checkboxConfidence: f.item?.checkboxConfidence ?? null,
    result: f.result,
    batchId: f.batchId,
    batchState: f.state,
    count: f.itemIds.length,
  });
  if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG);
}

/** V3A: one auto-load entry. Row counts, attempts, duration and the stop reason only. */
export function recordAutoLoad(action: string, s: AutoLoadSnapshot, result: string): void {
  log.push({
    timestamp: new Date().toISOString(),
    scanSessionId: '(none)',
    itemId: `(${s.currentRows} rows)`,
    action,
    classification: null,
    checkboxConfidence: null,
    result,
    autoLoad: {
      runId: s.runId,
      rows: s.currentRows,
      addedRows: s.addedRows,
      attempts: s.attempts,
      elapsedMs: s.elapsedMs,
      stopReason: s.stopReason,
    },
  });
  if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG);
}

// ---------------------------------------------------------------------------
// Reading checkbox state (never changes anything)
// ---------------------------------------------------------------------------

type StateReading = fbc.StateReading;
const readState = fbc.readCheckState;

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitForState(el: Element, want: CheckState): Promise<void> {
  const deadline = performance.now() + STATE_WAIT_MS;
  while (readState(el).state !== want && performance.now() < deadline) await sleep(POLL_MS);
}

/**
 * The one checkbox write in the extension: the stored element's own native click(), exactly
 * once, then a wait for it to reach `want` (and a short settle for side effects to show).
 * Callers validate the element first and verify the page afterwards; this only clicks and waits.
 *
 * For a native <input type=checkbox> click() toggles it and fires click/input/change like a
 * user click; for a [role=checkbox] it fires the click event Facebook's handler listens for.
 */
export async function clickCheckboxOnce(checkbox: HTMLElement, want: CheckState, onClick?: () => void): Promise<StateReading> {
  onClick?.();
  checkbox.click();
  await waitForState(checkbox, want);
  await sleep(SETTLE_MS);
  return readState(checkbox);
}

export function isDisabled(el: Element): boolean {
  return (el instanceof HTMLInputElement && el.disabled) || el.closest('[aria-disabled="true"]') !== null;
}

export function overlaps(a: Element, b: Element): boolean {
  return a === b || a.contains(b) || b.contains(a);
}

// ---------------------------------------------------------------------------
// Safety checks
// ---------------------------------------------------------------------------

export interface Refusal<C extends string = ActionErrorCode> {
  refused: true;
  code: C;
  error: string;
  needsRescan: boolean;
}

/** The row-level checks passed: this is still the same ONLY_ME post with the same HIGH checkbox. */
export interface ValidatedTarget {
  refused: false;
  item: ActionableItem;
  checkbox: HTMLElement;
  index: number;
}

interface Validated extends ValidatedTarget {
  before: StateReading;
}

export function refuse<C extends string = ActionErrorCode>(code: C, error: string, needsRescan = false): Refusal<C> {
  return { refused: true, code, error, needsRescan };
}

/**
 * Checks 1-9, shared by every action on one post: the scan is current, and the row is still
 * the same ONLY_ME post (strong evidence, re-classified now) with the same HIGH-confidence
 * checkbox element strictly inside it. Checked in order; the first failure is returned.
 */
export function validateTarget(
  session: ActionableSession | null,
  scanSessionId: string,
  itemId: string,
  deps: ActionDeps,
): ValidatedTarget | Refusal {
  // 1. The scan session is still current.
  if (!session || session.id !== scanSessionId) {
    return refuse('STALE_SESSION', `This scan is no longer current (a newer scan ran, or the page was reloaded). ${RESCAN}`, true);
  }
  if (retiredSessions.has(session.id)) {
    return refuse('STALE_SESSION', `This scan was used for a Trash action, so the list has changed. ${RESCAN}`, true);
  }
  if (location.href !== session.url) return refuse('NAVIGATED', `The page has navigated since the scan. ${RESCAN}`, true);

  // 2. The mapped row still exists and is connected.
  const index = session.items.findIndex((it) => it.itemId === itemId);
  if (index < 0) return refuse('ITEM_NOT_FOUND', `Item ${itemId} is not part of this scan. ${RESCAN}`, true);
  const item = session.items[index];
  const { row } = item;
  if (!row.isConnected) return refuse('ROW_DISCONNECTED', `That row is no longer on the page (Facebook re-rendered it). ${RESCAN}`, true);

  // 3. Classification is exactly ONLY_ME.
  if (item.audience !== 'ONLY_ME') return refuse('NOT_ONLY_ME', `This item was classified ${item.audience}, not ONLY_ME. Nothing was clicked.`);

  // 4. ...decided by strong evidence, at scan time and again now on the live row.
  if (item.audienceBasis !== 'strong') {
    return refuse('WEAK_EVIDENCE', `ONLY_ME was decided from ${item.audienceBasis} evidence, not an accessibility label. Nothing was clicked.`);
  }
  const now = deps.classify(row);
  if (now.audience !== 'ONLY_ME' || now.basis !== 'strong') {
    return refuse('CLASSIFICATION_CHANGED', `The row now classifies as ${now.audience} (${now.basis} evidence). ${RESCAN}`, true);
  }

  // 5. Checkbox discovery was HIGH confidence and unambiguous.
  if (item.checkboxConfidence !== 'HIGH' || item.checkboxAmbiguous) {
    return refuse('CHECKBOX_NOT_HIGH', `Checkbox discovery for this row was ${item.checkboxAmbiguous ? 'ambiguous' : item.checkboxConfidence ?? 'not found'}, not HIGH.`);
  }

  // 6. The exact stored checkbox element still exists.
  const cb = item.checkbox;
  if (!cb) return refuse('CHECKBOX_MISSING', 'The scan stored no checkbox element for this row.');
  if (!cb.isConnected) return refuse('CHECKBOX_DISCONNECTED', `The stored checkbox is no longer on the page (Facebook re-rendered it). ${RESCAN}`, true);
  if (!(cb instanceof HTMLElement)) return refuse('CHECKBOX_MISSING', 'The stored checkbox is not an HTML element, so it has no native click.');

  // 7. Strictly inside this exact row, and in no other mapped row.
  if (cb === row || !row.contains(cb)) return refuse('CHECKBOX_OUTSIDE_ROW', `The stored checkbox is no longer inside its row. ${RESCAN}`, true);
  for (const other of session.items) {
    if (other === item || !other.row.isConnected) continue;
    if (other.row.contains(cb) || overlaps(other.row, row)) {
      return refuse('ROWS_OVERLAP', `Row ${item.itemId} overlaps row ${other.itemId}, so the checkbox might not belong to one post only. ${RESCAN}`, true);
    }
  }

  // 8. Not Facebook's master "Tất cả" / select-all checkbox.
  const master = session.masterCheckbox;
  if (master && overlaps(master, cb)) return refuse('SELECT_ALL_CONTROL', 'The stored checkbox is (or contains) the master select-all checkbox.');
  if (fbc.isNamedSelectAll(cb)) return refuse('SELECT_ALL_CONTROL', 'The stored checkbox is named like the master select-all ("Tất cả").');

  // 9. No ambiguity: discovery run again on the same row must pick the same element, HIGH,
  //    and the row must still link to the same post.
  const again = fbc.discoverRowControls(row, item.itemId);
  const d = again.result.checkbox;
  if (!d.found || d.ambiguousCandidates > 0) return refuse('AMBIGUOUS', `Checkbox discovery on the live row now fails: ${d.reason} ${RESCAN}`, true);
  if (again.elements.checkbox !== cb) return refuse('AMBIGUOUS', `Checkbox discovery on the live row now picks a different element. ${RESCAN}`, true);
  if (d.confidence !== 'HIGH') return refuse('CHECKBOX_NOT_HIGH', `Checkbox discovery on the live row is now ${d.confidence}, not HIGH. ${RESCAN}`, true);
  if (again.result.permalink.href !== item.permalink) {
    return refuse('ROW_IDENTITY_CHANGED', `The row's post link changed since the scan, so it may now show a different post. ${RESCAN}`, true);
  }

  return { refused: false, item, checkbox: cb, index };
}

/**
 * Every condition that must hold, now, before the checkbox click: validateTarget, then the
 * checks specific to selecting / unselecting. The first failure is returned and nothing is clicked.
 */
function validate(session: ActionableSession | null, req: CheckboxActionRequest, deps: ActionDeps): Validated | Refusal {
  const t = validateTarget(session, req.scanSessionId, req.itemId, deps);
  if (t.refused) return t;
  const { item, checkbox: cb, index } = t;
  const master = session!.masterCheckbox;

  // 10. Explicit confirmation (checked on entry) and, for unselect, only a row this extension selected.
  if (req.action === 'UNSELECT_CHECKBOX' && !isSelectedByExtension(session!.id, item.itemId)) {
    return refuse('NOT_SELECTED_BY_EXTENSION', 'Only a post this extension selected in the current scan can be unselected here.');
  }

  // The checkbox must be usable and in the state this action starts from.
  if (isDisabled(cb)) return refuse('DISABLED', 'The checkbox is disabled.');
  const before = readState(cb);
  if (before.state === 'unknown' || before.state === 'mixed') {
    return refuse('STATE_UNREADABLE', `Cannot tell whether the checkbox is selected (${before.detail}), so the result could not be verified.`);
  }
  const from: CheckState = req.action === 'SELECT_CHECKBOX' ? 'unchecked' : 'checked';
  if (before.state !== from) return refuse('ALREADY_IN_STATE', `The checkbox is already ${before.state}. Nothing was clicked.`);
  if (master && readState(master).state === 'checked') {
    return refuse('PAGE_STATE_UNEXPECTED', 'The master select-all checkbox is already fully selected. Clear the selection on Facebook first.');
  }

  return { refused: false, item, checkbox: cb, index, before };
}

// ---------------------------------------------------------------------------
// Post-action verification
// ---------------------------------------------------------------------------

interface Tracked {
  el: Element;
  before: CheckState;
}

function track(el: Element | null | undefined): Tracked | null {
  return el ? { el, before: readState(el).state } : null;
}

function compare(t: Tracked, allowed: CheckState[], expected: string): CheckboxStateChange {
  const after = readState(t.el).state;
  return { before: t.before, after, ok: allowed.includes(after), expected };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function failure(
  req: LogIds,
  item: ActionableItem | null,
  r: Pick<Refusal, 'code' | 'error' | 'needsRescan'>,
  verification: CheckboxVerification | null = null,
  afterClick = verification !== null,
): CheckboxActionFailure {
  record(req, item, `${afterClick ? 'UNEXPECTED' : 'REFUSED'}:${r.code}`);
  return {
    ok: false,
    success: false,
    code: r.code,
    error: r.error,
    needsRescan: r.needsRescan,
    locked: lockReason !== null,
    verification,
    log: [...log],
  };
}

/**
 * Selects (or unselects) the checkbox of one ONLY_ME row, after re-checking every safety
 * condition. The only function in the extension that clicks anything on Facebook.
 */
export async function performCheckboxAction(
  session: ActionableSession | null,
  req: CheckboxActionRequest,
  deps: ActionDeps,
): Promise<CheckboxActionResponse> {
  if (req?.protocol !== SCANNER_PROTOCOL) {
    return failure(req ?? {}, null, {
      code: 'PROTOCOL_MISMATCH',
      error: 'The popup and the scanner in this tab come from different builds. Reload the Facebook tab, then scan again.',
      needsRescan: true,
    });
  }
  if (!ACTIONS.includes(req.action) || typeof req.scanSessionId !== 'string' || typeof req.itemId !== 'string') {
    return failure(req, null, { code: 'UNKNOWN_ACTION', error: 'Malformed action request.', needsRescan: false });
  }
  if (req.confirmed !== true) {
    return failure(req, null, { code: 'NOT_CONFIRMED', error: 'The action was not confirmed in the popup. Nothing was clicked.', needsRescan: false });
  }
  if (lockReason) {
    return failure(req, null, { code: 'LOCKED', error: `Actions are locked: ${lockReason} Reload the Facebook tab to reset.`, needsRescan: false });
  }
  if (pendingTrash) {
    return failure(req, null, {
      code: 'TRASH_PENDING',
      error: "A Trash action is waiting for confirmation. Confirm or cancel it in the popup first (or close Facebook's dialog and scan again).",
      needsRescan: false,
    });
  }
  const batchState = activeBatchState();
  if (batchState) {
    return failure(req, null, {
      code: 'BATCH_ACTIVE',
      error: `A cleanup batch is in progress (${batchState}). Finish or cancel it in the Cleanup batch panel first.`,
      needsRescan: false,
    });
  }
  const loading = autoLoadBlock();
  if (loading) return failure(req, null, { code: 'AUTOLOAD_ACTIVE', error: loading, needsRescan: true });
  if (!tryAcquire()) return failure(req, null, { code: 'BUSY', error: 'Another action is still running.', needsRescan: false });

  let clicked = false;
  let item: ActionableItem | null = null;
  try {
    const v = validate(session, req, deps);
    if (v.refused) return failure(req, session?.items.find((it) => it.itemId === req.itemId) ?? null, v);
    item = v.item;
    const s = session!;
    const selecting = req.action === 'SELECT_CHECKBOX';
    const want: CheckState = selecting ? 'checked' : 'unchecked';

    // Snapshot before the click. The page-wide list is only compared, never used to find the target.
    const prev = track(s.items[v.index - 1]?.checkbox);
    const next = track(s.items[v.index + 1]?.checkbox);
    const master = track(s.masterCheckbox);
    const exclude = [v.checkbox, prev?.el, next?.el, master?.el].filter((e): e is Element => !!e);
    const others = [...document.querySelectorAll(fbc.CHECKBOX_SELECTOR)]
      .filter((el) => !exclude.some((x) => overlaps(x, el)))
      .map((el) => ({ el, before: readState(el).state }));
    const urlBefore = location.href;

    // The interaction: the element's own native click(), exactly once.
    await clickCheckboxOnce(v.checkbox, want, () => (clicked = true));

    const unchanged = (t: Tracked) => compare(t, [t.before], 'unchanged');
    const target = compare({ el: v.checkbox, before: v.before.state }, [want], want);
    const previousRow = prev && unchanged(prev);
    const nextRow = next && unchanged(next);
    const masterChange =
      master &&
      (selecting
        ? compare(master, [...new Set<CheckState>([master.before, 'mixed'])], 'unchanged or indeterminate')
        : compare(master, [...new Set<CheckState>([master.before, 'mixed', 'unchecked'])], 'unchanged, indeterminate or unchecked'));
    let changed = 0;
    let disappeared = 0;
    for (const o of others) {
      const after = readState(o.el).state;
      if (after === 'missing' && o.before !== 'missing') disappeared++;
      else if (after !== o.before) changed++;
    }
    const urlUnchanged = location.href === urlBefore;

    const unexpected: string[] = [];
    if (!target.ok) unexpected.push(`Target checkbox is ${target.after} (${readState(v.checkbox).detail}), expected ${want}.`);
    if (previousRow && !previousRow.ok) unexpected.push(`Previous row's checkbox changed: ${previousRow.before} → ${previousRow.after}.`);
    if (nextRow && !nextRow.ok) unexpected.push(`Next row's checkbox changed: ${nextRow.before} → ${nextRow.after}.`);
    if (masterChange && !masterChange.ok) unexpected.push(`Master select-all checkbox changed: ${masterChange.before} → ${masterChange.after}.`);
    if (changed > 0) unexpected.push(`${changed} other checkbox(es) on the page changed state.`);
    if (!urlUnchanged) unexpected.push('The page URL changed after the click.');

    const verification: CheckboxVerification = {
      target,
      previousRow,
      nextRow,
      master: masterChange,
      masterNote: master ? s.masterNote : `${s.masterNote} It was checked indirectly, with every other checkbox on the page.`,
      otherCheckboxes: { compared: others.length, changed, disappeared },
      urlUnchanged,
      unexpected,
    };

    if (unexpected.length > 0) {
      lockReason = `unexpected state after ${req.action} on ${req.itemId}: ${unexpected.join(' ')}`;
      return failure(req, item, { code: 'VERIFICATION_FAILED', error: `Unexpected state after the click. ${unexpected.join(' ')}`, needsRescan: true }, verification);
    }

    const key = `${s.id}:${item.itemId}`;
    if (selecting) selectedByExtension.add(key);
    else selectedByExtension.delete(key);
    record(req, item, 'SUCCESS');
    return { ok: true, success: true, action: req.action, itemId: item.itemId, checked: target.after === 'checked', verification, log: [...log] };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // After a click we can no longer vouch for the page state.
    if (clicked) lockReason = `the action threw after clicking: ${message}`;
    return failure(req, item, { code: 'INTERNAL_ERROR', error: `${clicked ? 'Error after the click: ' : ''}${message}`, needsRescan: true }, null, clicked);
  } finally {
    release();
  }
}
