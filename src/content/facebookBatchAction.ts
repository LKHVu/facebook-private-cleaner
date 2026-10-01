/**
 * facebookBatchAction.ts
 *
 * V2A / V2B: a controlled cleanup batch. At most MAX_BATCH_SIZE (20) ONLY_ME posts, chosen by the
 * user from the current scan, moved to Facebook's Trash with ONE bulk Trash operation.
 * Together with facebookActions.ts (V1A) and facebookTrashAction.ts (V1B) the only code that
 * changes Facebook's page. It adds no new way of clicking: checkboxes go through
 * fba.clickCheckboxOnce, and the toolbar / dialog steps through V1B's exported primitives.
 *
 * The popup owns DRAFT and REVIEW (a plan: nothing on Facebook changes). From SELECTING on this
 * module owns the state, changes it only through transition() (BATCH_TRANSITIONS), and publishes
 * a snapshot to facebookActions.ts, which serves it in ActionState.batch. While a step runs, the
 * snapshot also carries its progress (BatchProgress), which the popup polls. Display only.
 *
 *   PREFLIGHT      read-only: every item's checks on the live page, per item. Creates no batch.
 *   SELECT         preflight every item (no click if any fails), then select the exact stored
 *                  checkboxes one at a time, verifying after each; roll back on any failure.
 *   UNSELECT       unselect every checkbox this batch selected, verify ("Cancel and unselect").
 *   OPEN_DIALOG    re-check everything, click the toolbar's HIGH Trash button once, discover
 *                  Facebook's dialog. Nothing else is clicked.
 *   CANCEL_DIALOG  click Facebook's HIGH Cancel; the posts stay selected (back to SELECTED).
 *   CONFIRM        re-check everything again, click Facebook's HIGH confirm once, verify each post.
 *
 * The invariant every write step asserts first (invariantViolations): a post that is not in the
 * batch is never selected, and every selected checkbox on the page is one this batch selected.
 * V2B adds, after every selection click: every target is still provably the same row, checkbox
 * and post (validateTarget), every mapped row that was on the page is still there, and Facebook's
 * master select-all is never fully checked (MASTER_FULLY_SELECTED, even if every loaded row is a
 * target). Any of these stops the selection and rolls it back; an unverified rollback locks.
 * Hard limits: no Select All, no global re-finding of targets, no text matching, no loop beyond
 * the supplied items, no scrolling, no retries, no permanent deletion. One active batch at a
 * time; while it is active, V1A, V1B and new scans are refused.
 */

import type {
  BatchErrorCode,
  BatchFailure,
  BatchItemCheck,
  BatchItemOutcome,
  BatchPreflight,
  BatchProgressPhase,
  BatchRequest,
  BatchRowIdentity,
  BatchResponse,
  BatchRollback,
  BatchSelectionVerification,
  BatchSnapshot,
  BatchState,
  BatchStep,
  BatchTrashVerification,
  CheckState,
  DialogDiscovery,
  PreflightCheckKey,
  ToolbarDiscovery,
} from '../shared/types';
import { MAX_BATCH_SIZE, SCANNER_PROTOCOL, canTransition, isBatchActive } from '../shared/types';
import * as fba from './facebookActions';
import * as fbc from './facebookControls';
import * as fbt from './facebookToolbar';
import * as fbta from './facebookTrashAction';

const STEPS: readonly BatchStep[] = ['PREFLIGHT', 'SELECT', 'UNSELECT', 'OPEN_DIALOG', 'CANCEL_DIALOG', 'CONFIRM'];
/** A batch may open Facebook's dialog, or confirm it, only this long after it was selected. */
const BATCH_TTL_MS = 10 * 60_000;
/** Facebook's dialog is only confirmable this long after it opened (same as V1B). */
const DIALOG_TTL_MS = fbta.PENDING_TTL_MS;
/** How long to wait for every target to leave the list after Facebook's confirm click: a base plus a little per post. */
const REMOVAL_WAIT_BASE_MS = 10_000;
const REMOVAL_WAIT_PER_ITEM_MS = 500;
/** Item ids named in one message or log line. */
const MAX_LISTED_IDS = 5;
const RESCAN = 'Please scan again.';
const MASTER_FULL = 'The master select-all checkbox is fully selected.';
const readState = fbc.readCheckState;

type Stop = { code: BatchErrorCode; error: string; needsRescan: boolean };

interface Batch {
  batchId: string;
  session: fba.ActionableSession;
  deps: fba.ActionDeps;
  url: string;
  createdAt: number;
  state: BatchState;
  /** The batch targets, in document order. Never changes after creation. */
  items: fba.ActionableItem[];
  /** Targets this batch selected (verified checked) and has not unselected since. */
  selected: Set<fba.ActionableItem>;
  history: { state: BatchState; at: string }[];
  preflight: BatchPreflight | null;
  progress: BatchSnapshot['progress'];
  selection: BatchSelectionVerification | null;
  toolbar: ToolbarDiscovery | null;
  dialogDiscovery: DialogDiscovery | null;
  kept: (fbta.KeptDialog & { openedAt: number }) | null;
  rollback: BatchRollback | null;
  verification: BatchTrashVerification | null;
  lastError: { code: string; error: string } | null;
}

let batch: Batch | null = null;
/** Set right before each click on Facebook's page, so an error afterwards knows the page may have changed. */
let clickedThisStep = false;

const markClicked = () => {
  clickedThisStep = true;
};

/** Toolbar / dialog buttons: the element's own native click(), exactly once. */
function clickOnce(el: HTMLElement): void {
  markClicked();
  el.click();
}

function listIds(ids: string[]): string {
  return ids.length <= MAX_LISTED_IDS ? ids.join(', ') : `${ids.slice(0, MAX_LISTED_IDS).join(', ')} and ${ids.length - MAX_LISTED_IDS} more`;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function snapshot(b: Batch): BatchSnapshot {
  return {
    batchId: b.batchId,
    scanSessionId: b.session.id,
    createdAt: new Date(b.createdAt).toISOString(),
    state: b.state,
    itemIds: b.items.map((it) => it.itemId),
    selectedByBatch: b.items.filter((it) => b.selected.has(it)).map((it) => it.itemId),
    history: [...b.history],
    preflight: b.preflight,
    progress: b.progress,
    selection: b.selection,
    toolbar: b.toolbar,
    dialog: b.dialogDiscovery,
    rollback: b.rollback,
    verification: b.verification,
    lastError: b.lastError,
  };
}

function publish(b: Batch): void {
  if (b === batch) fba.publishBatch(snapshot(b));
}

/** Display only: what the running step is doing. Published at once, so a polling popup sees it between clicks. */
function setProgress(b: Batch, phase: BatchProgressPhase, done: number, total: number, current: fba.ActionableItem | null = null): void {
  b.progress = { phase, done, total, currentItemId: current?.itemId ?? null, updatedAt: new Date().toISOString() };
  publish(b);
}

/** The only way the state changes. An unlisted change is a bug: it throws, and the entry point fails closed. */
function transition(b: Batch, to: BatchState): void {
  if (!canTransition(b.state, to)) throw new Error(`Invalid batch state change ${b.state} → ${to}.`);
  const from = b.state;
  b.state = to;
  b.history.push({ state: to, at: new Date().toISOString() });
  publish(b);
  logBatch(b, 'BATCH_STATE', `${from}→${to}`);
}

function logBatch(b: Batch, action: string, result: string, item?: fba.ActionableItem): void {
  fba.recordBatch({ action, batchId: b.batchId, scanSessionId: b.session.id, itemIds: b.items.map((it) => it.itemId), state: b.state, result, item });
}

// ---------------------------------------------------------------------------
// The non-target invariant
// ---------------------------------------------------------------------------

/**
 * A Facebook post not explicitly in the batch must never be selected. Holds when: no mapped row
 * outside the batch reads checked or mixed, every checked checkbox on the page is the stored
 * checkbox of one of `expected` (the targets that should be selected right now), nothing reads
 * mixed, the master select-all is not fully checked, and `expected` is part of the batch.
 * Returns every violation; empty means it holds. Read-only.
 */
function invariantViolations(b: Batch, expected: ReadonlySet<fba.ActionableItem>): string[] {
  const v: string[] = [];
  for (const it of expected) if (!b.items.includes(it)) v.push(`${it.itemId} is not in the batch.`);
  for (const it of b.session.items) {
    if (b.items.includes(it)) continue;
    const st = readState(it.checkbox).state;
    if (st === 'checked' || st === 'mixed') v.push(`Non-target row ${it.itemId} is ${st}.`);
  }
  const sel = fbt.readSelection(b.session.masterCheckbox);
  if (sel.masterState === 'checked') v.push(MASTER_FULL);
  const boxes = [...expected].map((it) => it.checkbox).filter((cb): cb is Element => !!cb);
  const stray = sel.checked.filter((el) => !boxes.some((cb) => fba.overlaps(cb, el)));
  if (stray.length > 0) v.push(`${stray.length} selected checkbox(es) on the page are not targets this batch selected.`);
  if (sel.mixed.length > 0) v.push(`${sel.mixed.length} checkbox(es) on the page are partly selected.`);
  return v;
}

/** V2B: Facebook's master select-all reads fully checked. Never allowed, even if every loaded row is a target. */
function masterFullySelected(b: Batch): boolean {
  return fbt.readSelection(b.session.masterCheckbox).masterState === 'checked';
}

// ---------------------------------------------------------------------------
// Preflight and re-validation (read-only)
// ---------------------------------------------------------------------------

/**
 * Which check group a refusal code belongs to. The groups are evaluated in PREFLIGHT_ORDER, so
 * the groups before the failing one passed and the ones after it were not evaluated.
 */
const PREFLIGHT_ORDER: readonly PreflightCheckKey[] = ['onlyMeStrong', 'checkboxHigh', 'identityUnchanged', 'currentlyUnchecked'];
/** The scan or the row itself is gone: nothing about the item could be evaluated. */
const ROW_GONE_CODES = new Set(['STALE_SESSION', 'NAVIGATED', 'ITEM_NOT_FOUND', 'ROW_DISCONNECTED']);
const CHECK_OF_CODE: Record<string, PreflightCheckKey> = {
  NOT_ONLY_ME: 'onlyMeStrong',
  WEAK_EVIDENCE: 'onlyMeStrong',
  CLASSIFICATION_CHANGED: 'onlyMeStrong',
  CHECKBOX_NOT_HIGH: 'checkboxHigh',
  CHECKBOX_MISSING: 'checkboxHigh',
  CHECKBOX_DISCONNECTED: 'checkboxHigh',
  CHECKBOX_OUTSIDE_ROW: 'checkboxHigh',
  ROWS_OVERLAP: 'checkboxHigh',
  SELECT_ALL_CONTROL: 'checkboxHigh',
  AMBIGUOUS: 'checkboxHigh',
  ROW_IDENTITY_CHANGED: 'identityUnchanged',
  NO_PERMALINK: 'identityUnchanged',
  PERMALINK_MISMATCH: 'identityUnchanged',
  DISABLED: 'currentlyUnchecked',
  ALREADY_IN_STATE: 'currentlyUnchecked',
  STATE_UNREADABLE: 'currentlyUnchecked',
};

/** Display only: which check groups passed, failed, or were not reached, given the first failing code (null = all passed). */
function checkGroups(code: string | null): BatchItemCheck['checks'] {
  const r: BatchItemCheck['checks'] = { onlyMeStrong: null, checkboxHigh: null, identityUnchanged: null, currentlyUnchecked: null };
  if (code !== null && ROW_GONE_CODES.has(code)) return { ...r, identityUnchanged: false };
  const failed = code === null ? null : CHECK_OF_CODE[code];
  if (code !== null && !failed) return r; // an unmapped code: nothing is claimed
  for (const k of PREFLIGHT_ORDER) {
    if (k === failed) {
      r[k] = false;
      break;
    }
    r[k] = true;
  }
  return r;
}

interface Preflighted {
  check: BatchItemCheck;
  target: fba.ValidatedTarget | null;
}

/**
 * Checks 1-15 for one item: validateTarget (current scan and URL, row connected, ONLY_ME from
 * strong evidence at scan time and now, HIGH unambiguous checkbox, the same stored element,
 * strictly inside its row and in no other, not select-all, discovery picks it again, same
 * permalink), then: a permalink exists and equals the one the popup reviewed, enabled, unchecked.
 */
function preflightItem(session: fba.ActionableSession | null, req: BatchRequest, k: number, deps: fba.ActionDeps): Preflighted {
  const itemId = req.itemIds[k];
  const no = (code: string, error: string): Preflighted => ({ check: { itemId, ok: false, code, error, checks: checkGroups(code) }, target: null });
  const t = fba.validateTarget(session, req.scanSessionId, itemId, deps);
  if (t.refused) return no(t.code, t.error);
  if (!t.item.permalink) return no('NO_PERMALINK', 'This row has no post link, so its removal could not be verified.');
  if (t.item.permalink !== req.permalinks[k]) return no('PERMALINK_MISMATCH', 'The post link reviewed in the popup is not the one this scan stored for the row.');
  if (fba.isDisabled(t.checkbox)) return no('DISABLED', 'The checkbox is disabled.');
  const st = readState(t.checkbox);
  if (st.state !== 'unchecked') {
    return no(st.state === 'checked' ? 'ALREADY_IN_STATE' : 'STATE_UNREADABLE', `The checkbox is ${st.state} (${st.detail}), not unchecked.`);
  }
  return { check: { itemId, ok: true, code: null, error: null, checks: checkGroups(null) }, target: t };
}

/** Nothing on the page may be selected before a batch starts, so "exactly the batch" can be verified. */
function pagePreflight(session: fba.ActionableSession): string | null {
  const sel = fbt.readSelection(session.masterCheckbox);
  if (sel.checked.length > 0) return `${sel.checked.length} checkbox(es) on the page are already selected. Unselect them first (or reload the Facebook tab).`;
  if (sel.mixed.length > 0) return `${sel.mixed.length} checkbox(es) on the page are partly selected.`;
  if (sel.masterState === 'checked' || sel.masterState === 'mixed') return `The master select-all checkbox is ${sel.masterState}.`;
  return null;
}

/**
 * Every item and the page, read-only. `targets` is set only when everything passed: then (and
 * only then) SELECT may start clicking. PREFLIGHT returns the same result without clicking.
 */
function runPreflight(session: fba.ActionableSession | null, req: BatchRequest, deps: fba.ActionDeps): { preflight: BatchPreflight; targets: fba.ValidatedTarget[] | null } {
  const pre = req.itemIds.map((_, k) => preflightItem(session, req, k, deps));
  const items = pre.map((p) => p.check);
  const pageProblems: string[] = [];
  const warnings: string[] = [];
  if (!session) pageProblems.push(`This scan is no longer current. ${RESCAN}`);
  else {
    const page = pagePreflight(session);
    if (page) pageProblems.push(page);
    const loaded = session.items.filter((it) => it.row.isConnected && it.checkbox?.isConnected);
    if (loaded.length > 0 && loaded.every((it) => req.itemIds.includes(it.itemId))) {
      warnings.push(
        'Every loaded post row is in this batch. Facebook may then mark its select-all checkbox fully checked, which stops the ' +
          'selection (MASTER_FULLY_SELECTED) and rolls it back. Leave at least one loaded post out of the batch.',
      );
    }
  }
  const boxes = pre.map((p) => p.target?.checkbox).filter((cb): cb is HTMLElement => !!cb);
  if (boxes.some((cb, i) => boxes.some((o, j) => i !== j && fba.overlaps(cb, o)))) pageProblems.push('Two batch items share a checkbox.');
  const failed = items.filter((c) => !c.ok).length;
  const ok = failed === 0 && pageProblems.length === 0 && items.length > 0;
  return {
    preflight: { batchId: req.batchId, checkedAt: new Date().toISOString(), items, ready: items.length - failed, failed, pageProblems, warnings, ok },
    targets: ok ? pre.map((p) => p.target!) : null,
  };
}

/**
 * Before OPEN_DIALOG and CONFIRM: every target is still the same ONLY_ME post (validateTarget),
 * selected by this batch and reading checked, and the invariant holds with every target selected.
 */
function revalidateSelected(b: Batch, session: fba.ActionableSession | null, deps: fba.ActionDeps): Stop | null {
  if (session !== b.session) return { code: 'STALE_SESSION', error: `The scan this batch belongs to is no longer current. ${RESCAN}`, needsRescan: true };
  if (masterFullySelected(b)) return { code: 'MASTER_FULLY_SELECTED', error: MASTER_FULL, needsRescan: false };
  for (const it of b.items) {
    const t = fba.validateTarget(session, b.session.id, it.itemId, deps);
    if (t.refused) return { code: t.code, error: `${it.itemId}: ${t.error}`, needsRescan: t.needsRescan };
    if (t.item !== it) return { code: 'ROW_IDENTITY_CHANGED', error: `${it.itemId} is no longer the same scanned row.`, needsRescan: true };
    if (!b.selected.has(it)) return { code: 'NOT_SELECTED_BY_EXTENSION', error: `${it.itemId} was not selected by this batch.`, needsRescan: false };
    const st = readState(t.checkbox);
    if (st.state !== 'checked') return { code: 'NOT_SELECTED', error: `${it.itemId}'s checkbox is ${st.state} (${st.detail}), not selected.`, needsRescan: false };
  }
  const inv = invariantViolations(b, new Set(b.items));
  if (inv.length > 0) return { code: 'INVARIANT_VIOLATION', error: inv.join(' '), needsRescan: false };
  return null;
}

// ---------------------------------------------------------------------------
// Selection verification (read-only)
// ---------------------------------------------------------------------------

interface Tracked {
  el: Element;
  before: CheckState;
}

/** Every checkbox on the page except the batch targets' and the master, with its state now. Only compared, never clicked. */
function trackOthers(b: Batch): Tracked[] {
  const exclude = [...b.items.map((it) => it.checkbox), b.session.masterCheckbox].filter((e): e is Element => !!e);
  return [...document.querySelectorAll(fbc.CHECKBOX_SELECTOR)]
    .filter((el) => !exclude.some((x) => fba.overlaps(x, el)))
    .map((el) => ({ el, before: readState(el).state }));
}

interface SelectionCheck {
  v: BatchSelectionVerification;
  /** Something other than the targets is wrong (a non-target selected, other checkboxes changed, URL): locks even after a complete rollback. */
  severe: boolean;
  masterFull: boolean;
}

/**
 * Each target must read checked exactly when it is in `expected`; every other checkbox on the
 * page must be unchanged; the invariant must hold; the URL must be the same. V2B, for Facebook
 * re-rendering: every target must still pass validateTarget with the same row and stored
 * checkbox, and every mapped row in `rowsAtStart` must still be on the page.
 */
function verifySelection(b: Batch, expected: ReadonlySet<fba.ActionableItem>, others: Tracked[], url: string, rowsAtStart: fba.ActionableItem[]): SelectionCheck {
  const targetProblems: string[] = [];
  const targets = b.items.map((it) => {
    const want: CheckState = expected.has(it) ? 'checked' : 'unchecked';
    const state = readState(it.checkbox).state;
    if (state !== want) targetProblems.push(`Target ${it.itemId} is ${state}, expected ${want}.`);
    return { itemId: it.itemId, state, ok: state === want };
  });

  // Re-rendering: never re-found by text; the stored row and checkbox must still prove themselves.
  const staleTargets: string[] = [];
  for (const it of b.items) {
    const t = fba.validateTarget(b.session, b.session.id, it.itemId, b.deps);
    const why = t.refused ? t.code : t.item !== it || t.checkbox !== it.checkbox ? 'ROW_IDENTITY_CHANGED' : null;
    if (why) {
      staleTargets.push(it.itemId);
      targetProblems.push(`Target ${it.itemId} can no longer be proven the same post (${why}).`);
    }
  }
  const rowsLeft = rowsAtStart.filter((it) => !it.row.isConnected).map((it) => it.itemId);
  if (rowsLeft.length > 0) targetProblems.push(`${rowsLeft.length} mapped row(s) left the page during the selection (${listIds(rowsLeft)}): Facebook re-rendered the list.`);

  const nonTargetRows = { compared: 0, selected: 0, missing: 0, selectedIds: [] as string[] };
  for (const it of b.session.items) {
    if (b.items.includes(it)) continue;
    nonTargetRows.compared++;
    const st = readState(it.checkbox).state;
    if (st === 'missing') nonTargetRows.missing++;
    else if (st === 'checked' || st === 'mixed') {
      nonTargetRows.selected++;
      nonTargetRows.selectedIds.push(it.itemId);
    }
  }
  let changed = 0;
  let disappeared = 0;
  for (const o of others) {
    const after = readState(o.el).state;
    if (after === 'missing' && o.before !== 'missing') disappeared++;
    else if (after !== o.before) changed++;
  }
  const sel = fbt.readSelection(b.session.masterCheckbox);
  const urlUnchanged = location.href === url;
  const masterFull = sel.masterState === 'checked';

  const inv = invariantViolations(b, expected);
  const pageProblems = inv.filter((p) => p !== MASTER_FULL);
  if (changed > 0) pageProblems.push(`${changed} other checkbox(es) on the page changed state.`);
  if (!urlUnchanged) pageProblems.push('The page URL changed.');

  return {
    v: {
      targets,
      targetsSelected: targets.filter((t) => t.state === 'checked').length,
      expected: expected.size,
      nonTargetRows,
      otherCheckboxes: { compared: others.length, changed, disappeared },
      rowsLeft: rowsLeft.slice(0, MAX_LISTED_IDS * 2),
      staleTargets,
      pageSelected: sel.checked.length,
      masterState: sel.masterState,
      urlUnchanged,
      unexpected: [...targetProblems, ...(masterFull ? [MASTER_FULL] : []), ...pageProblems],
    },
    severe: pageProblems.length > 0,
    masterFull,
  };
}

// ---------------------------------------------------------------------------
// Unselecting (rollback and "Cancel and unselect")
// ---------------------------------------------------------------------------

/** Why this target's stored checkbox may not be clicked to unselect it, or null. Lighter than validateTarget on purpose: it only undoes our own click. */
function unselectBlocker(b: Batch, it: fba.ActionableItem): string | null {
  if (!b.items.includes(it) || !b.selected.has(it)) return 'not a target this batch selected';
  if (location.href !== b.url) return 'the page URL changed';
  const { row, checkbox: cb } = it;
  if (!row.isConnected) return 'its row is no longer on the page';
  if (!cb || !cb.isConnected || !(cb instanceof HTMLElement)) return 'its stored checkbox is no longer on the page';
  if (cb === row || !row.contains(cb)) return 'its stored checkbox is no longer inside its row';
  if (b.session.items.some((o) => o !== it && o.row.isConnected && (o.row.contains(cb) || fba.overlaps(o.row, row)))) return 'its row overlaps another row';
  const master = b.session.masterCheckbox;
  if ((master && fba.overlaps(master, cb)) || fbc.isNamedSelectAll(cb)) return 'its stored checkbox looks like the master select-all';
  if (fba.isDisabled(cb)) return 'its checkbox is disabled';
  const st = readState(cb);
  if (st.state !== 'checked') return `its checkbox is ${st.state} (${st.detail}), not selected`;
  return null;
}

/**
 * Unselects, in reverse order, every target this batch selected: at most one click each. A
 * target whose stored checkbox already reads unchecked (e.g. unticked by hand) needs no click
 * and counts as done. Complete only when every click verified and nothing on the page is still
 * selected. Progress (UNSELECTING, done / total) is published after each target.
 */
async function unselectAll(b: Batch, action: string): Promise<BatchRollback> {
  const todo = [...b.items].reverse().filter((it) => b.selected.has(it));
  const selectedBeforeFailure = b.items.filter((it) => b.selected.has(it)).map((it) => it.itemId);
  const rolledBack: string[] = [];
  const rollbackFailures: { itemId: string; reason: string }[] = [];
  for (const it of todo) {
    setProgress(b, 'UNSELECTING', rolledBack.length, todo.length, it);
    if (it.checkbox?.isConnected && readState(it.checkbox).state === 'unchecked') {
      b.selected.delete(it);
      rolledBack.push(it.itemId);
      logBatch(b, action, 'SUCCESS:ALREADY_UNCHECKED', it);
      continue;
    }
    const why = unselectBlocker(b, it);
    if (why) {
      rollbackFailures.push({ itemId: it.itemId, reason: `${why}; not clicked` });
      logBatch(b, action, `REFUSED:${why}`, it);
      continue;
    }
    const after = await fba.clickCheckboxOnce(it.checkbox as HTMLElement, 'unchecked', markClicked);
    if (after.state === 'unchecked') {
      b.selected.delete(it);
      rolledBack.push(it.itemId);
    } else {
      rollbackFailures.push({ itemId: it.itemId, reason: `still ${after.state} (${after.detail}) after one click` });
      logBatch(b, action, `UNEXPECTED:${after.state}`, it);
    }
  }
  const sel = fbt.readSelection(b.session.masterCheckbox);
  if (sel.checked.length > 0 || sel.mixed.length > 0) {
    rollbackFailures.push({ itemId: '(page)', reason: `${sel.checked.length + sel.mixed.length} checkbox(es) on the page are still selected` });
  }
  if (sel.masterState === 'checked' || sel.masterState === 'mixed') rollbackFailures.push({ itemId: '(master)', reason: `the master checkbox is ${sel.masterState}` });
  const r: BatchRollback = { selectedBeforeFailure, rolledBack, rollbackFailures, complete: rollbackFailures.length === 0 };
  b.rollback = r;
  setProgress(b, 'UNSELECTING', rolledBack.length, todo.length);
  logBatch(b, action, `${r.complete ? 'SUCCESS' : 'UNEXPECTED'}:${rolledBack.length}/${todo.length} unselected${r.complete ? '' : `, ${rollbackFailures.length} failure(s)`}`);
  return r;
}

/** One line naming what a rollback could not do. */
function rollbackFailureText(rb: BatchRollback): string {
  return rb.rollbackFailures.map((f) => `${f.itemId} ${f.reason}`).join('; ');
}

// ---------------------------------------------------------------------------
// Post-Trash verification (read-only)
// ---------------------------------------------------------------------------

interface RowNow {
  identity: BatchRowIdentity;
  permalink: string | null;
  postUrls: number;
  postLike: boolean;
}

/**
 * What a target's original row element, still connected, represents now. Read-only: the row's
 * links and control discovery only, never its text. See BatchRowIdentity.
 */
function inspectRow(it: fba.ActionableItem): RowNow {
  const urls = fbc.postUrlsIn(it.row);
  const d = fbc.discoverRowControls(it.row, it.itemId).result;
  const has = (c: { found: boolean; ambiguousCandidates: number }) => c.found || c.ambiguousCandidates > 0;
  const postLike = has(d.checkbox) || has(d.audienceIndicator) || has(d.viewButton) || has(d.menuButton);
  const own = new Set([it.permalink!, ...it.postUrls]);
  const identity: BatchRowIdentity = urls.includes(it.permalink!)
    ? 'SAME_TARGET'
    : urls.some((u) => own.has(u))
      ? 'UNKNOWN' // another link the target row had at scan time is still there
      : urls.length > 0
        ? 'DIFFERENT_POST'
        : postLike
          ? 'UNKNOWN'
          : 'STALE_SHELL';
  return { identity, permalink: d.permalink.href, postUrls: urls.length, postLike };
}

/**
 * Each target's outcome. The post's normalised link is the identity: it decides whether the post
 * is still listed, whatever happened to the row element (Facebook re-renders and recycles rows):
 *   link on the page                                                        STILL_PRESENT
 *   link gone, and the original row is gone                                 REMOVED*
 *   link gone, the original row is still connected but shows a
 *     DIFFERENT_POST or is a STALE_SHELL (no link, no post controls)        REMOVED*
 *   anything else (e.g. the row still looks like a post but nothing in it
 *     proves which one)                                                     UNCERTAIN (never guessed)
 * *Only while the nearest non-target rows before and after it in scan order are still listed: if
 * they are gone too, Facebook may only have unloaded that part of the list (virtualization).
 */
function verifyTrash(b: Batch, dialog: Element | null, url: string, waitedMs: number): BatchTrashVerification {
  const linked = fbta.linkedUrls();
  const targets = new Set(b.items);
  const listed = (it: fba.ActionableItem) => it.row.isConnected || (!!it.permalink && linked.has(it.permalink));
  const all = b.session.items;
  const neighboursListed = (it: fba.ActionableItem): boolean | null => {
    const i = all.indexOf(it);
    const before = all.slice(0, i).reverse().find((o) => !targets.has(o));
    const after = all.slice(i + 1).find((o) => !targets.has(o));
    const ns = [before, after].filter((o): o is fba.ActionableItem => !!o);
    return ns.length === 0 ? null : ns.every(listed);
  };
  const items = b.items.map((it) => {
    const rowDisconnected = !it.row.isConnected;
    const permalinkAbsent = !linked.has(it.permalink!);
    const neighbours = neighboursListed(it);
    const now = rowDisconnected ? null : inspectRow(it);
    const shell = now?.identity === 'DIFFERENT_POST' || now?.identity === 'STALE_SHELL';
    const rowText = now
      ? `original row still connected but no longer represents the target (current row identity: ${now.identity === 'DIFFERENT_POST' ? 'different permalink' : 'none'})`
      : 'original row gone';
    let outcome: BatchItemOutcome;
    let reason: string;
    if (!permalinkAbsent) {
      outcome = 'STILL_PRESENT';
      reason = `target link is on the page${rowDisconnected ? ' (in a re-rendered row)' : ''}`;
    } else if (rowDisconnected || shell) {
      outcome = neighbours === false ? 'UNCERTAIN' : 'REMOVED';
      reason =
        neighbours === false
          ? `target link absent; ${rowText}; but a neighbouring row is gone too: Facebook may only have unloaded that part of the list`
          : `target link absent; ${rowText}`;
    } else {
      outcome = 'UNCERTAIN';
      reason =
        now?.identity === 'SAME_TARGET'
          ? 'the original row still links the target, yet the link was not found on the page'
          : now && now.postUrls > 0
            ? 'target permalink absent, but the original row still links another URL the target row had at scan time'
            : 'target link absent, but the original row still looks like a post row and nothing in it proves which post it shows now';
    }
    return {
      itemId: it.itemId,
      outcome,
      rowDisconnected,
      permalinkAbsent,
      neighboursListed: neighbours,
      rowIdentity: now?.identity ?? null,
      currentRowPermalink: now?.permalink ?? null,
      currentRowPostUrls: now?.postUrls ?? null,
      currentRowPostLike: now?.postLike ?? null,
      reason,
    };
  });
  return {
    items,
    removed: items.filter((i) => i.outcome === 'REMOVED').length,
    stillPresent: items.filter((i) => i.outcome === 'STILL_PRESENT').length,
    uncertain: items.filter((i) => i.outcome === 'UNCERTAIN').length,
    otherRows: fbta.checkOtherRows(b.session, targets, linked),
    selectedCount: fbta.selectedCount(b.session.masterCheckbox),
    urlUnchanged: location.href === url,
    dialogClosed: fbta.dialogClosed(dialog),
    waitedMs: Math.round(waitedMs),
    notes: [],
  };
}

/**
 * SUCCESS: every target verified REMOVED, every other mapped row (or its re-rendered copy) is
 * still there, nothing is selected, the URL is the same and the dialog closed. PARTIAL: some but
 * not all targets verified removed. FAILED: every target is clearly still listed. INCONCLUSIVE:
 * anything else. `lock`: a clear contradiction.
 */
function judge(b: Batch, v: BatchTrashVerification): { outcome: 'SUCCESS' | 'PARTIAL' | 'INCONCLUSIVE' | 'FAILED'; lock: string | null } {
  const n = b.items.length;
  let lock: string | null = null;
  if (!v.urlUnchanged) {
    v.notes.push('The page URL changed.');
    lock = 'the page URL changed after confirming the batch Trash.';
  }
  const still = v.items.filter((i) => i.outcome === 'STILL_PRESENT');
  if (still.length > 0) v.notes.push(`${still.length} post(s) are still listed (their link is on the page): ${listIds(still.map((i) => i.itemId))}.`);
  for (const i of v.items) if (i.outcome === 'UNCERTAIN') v.notes.push(`${i.itemId}: ${i.reason}.`);
  if (!v.dialogClosed) v.notes.push("Facebook's dialog is still open.");
  if (v.otherRows.missing > 0) {
    v.notes.push(
      `${v.otherRows.missing} other previously scanned row(s) are no longer on the page (${v.otherRows.missingIds.join(', ')}). ` +
        "Facebook may have unloaded them while re-rendering, or removed them. Check Facebook's Trash.",
    );
  }
  if (v.selectedCount > 0) {
    v.notes.push(`${v.selectedCount} checkbox(es) are still selected.`);
    if (v.removed > 0) lock ??= `posts left the list after the batch Trash, but ${v.selectedCount} checkbox(es) are still selected.`;
  }

  if (!v.urlUnchanged) return { outcome: 'INCONCLUSIVE', lock };
  if (v.removed === n) return { outcome: v.notes.length === 0 ? 'SUCCESS' : 'INCONCLUSIVE', lock };
  if (v.removed > 0) return { outcome: 'PARTIAL', lock };
  if (v.stillPresent === n) return { outcome: 'FAILED', lock };
  return { outcome: 'INCONCLUSIVE', lock };
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

interface FailExtra {
  preflight?: BatchPreflight | null;
}

function failure(req: Partial<BatchRequest>, step: BatchStep | null, r: Stop, extra: FailExtra = {}): BatchFailure {
  const b = batch && batch.batchId === req.batchId ? batch : null;
  const result = `${clickedThisStep ? 'UNEXPECTED' : 'REFUSED'}:${r.code}`;
  if (b) {
    b.lastError = { code: r.code, error: r.error };
    publish(b);
    logBatch(b, `BATCH_${step ?? '(invalid)'}`, result);
  } else {
    fba.recordBatch({
      action: `BATCH_${step ?? '(invalid)'}`,
      batchId: typeof req.batchId === 'string' ? req.batchId : '(invalid)',
      scanSessionId: typeof req.scanSessionId === 'string' ? req.scanSessionId : '(invalid)',
      itemIds: Array.isArray(req.itemIds) ? req.itemIds.filter((x): x is string => typeof x === 'string') : [],
      state: 'REVIEW',
      result,
    });
  }
  return {
    ok: false,
    step,
    code: r.code,
    error: r.error,
    needsRescan: r.needsRescan,
    locked: fba.getLockReason() !== null,
    clicked: clickedThisStep,
    preflight: extra.preflight ?? null,
    batch: b ? snapshot(b) : null,
    log: fba.getLog(),
  };
}

function success(b: Batch, step: BatchStep, note: string | null = null): BatchResponse {
  b.lastError = null;
  publish(b);
  return { ok: true, step, batch: snapshot(b), preflight: null, note, log: fba.getLog() };
}

/** Clicks happened and the page is not as expected: lock, and end the batch as FAILED. */
function failAfterClick(b: Batch, req: BatchRequest, step: BatchStep, code: BatchErrorCode, error: string, lock: string): BatchFailure {
  fba.lockActions(lock);
  if (canTransition(b.state, 'FAILED')) transition(b, 'FAILED');
  return failure(req, step, { code, error, needsRescan: true });
}

// ---------------------------------------------------------------------------
// PREFLIGHT: read-only, creates no batch
// ---------------------------------------------------------------------------

function preflightOnly(session: fba.ActionableSession | null, req: BatchRequest, deps: fba.ActionDeps): BatchResponse {
  const step: BatchStep = 'PREFLIGHT';
  if (batch && isBatchActive(batch.state)) {
    return failure(req, step, { code: 'BATCH_ACTIVE', error: `Another batch is ${batch.state}. Finish or cancel it first.`, needsRescan: false });
  }
  if (fba.getPendingTrash()) {
    return failure(req, step, { code: 'TRASH_PENDING', error: 'A single-post Trash is waiting for confirmation. Confirm or cancel it first.', needsRescan: false });
  }
  if (req.permalinks.length !== req.itemIds.length) {
    return failure(req, step, { code: 'BATCH_MALFORMED', error: 'Every item needs the permalink the popup reviewed.', needsRescan: false });
  }
  const { preflight } = runPreflight(session, req, deps);
  const failedIds = preflight.items.filter((c) => !c.ok).map((c) => c.itemId);
  fba.recordBatch({
    action: 'BATCH_PREFLIGHT',
    batchId: req.batchId,
    scanSessionId: req.scanSessionId,
    itemIds: req.itemIds,
    state: 'REVIEW',
    result: `READ_ONLY:${preflight.ready}/${req.itemIds.length} ready${failedIds.length ? `, failed ${listIds(failedIds)}` : ''}${preflight.pageProblems.length ? ', page state' : ''}`,
  });
  return { ok: true, step, batch: null, preflight, note: null, log: fba.getLog() };
}

// ---------------------------------------------------------------------------
// SELECT: preflight every item, then select them one at a time
// ---------------------------------------------------------------------------

async function selectBatch(session: fba.ActionableSession | null, req: BatchRequest, deps: fba.ActionDeps): Promise<BatchResponse> {
  const step: BatchStep = 'SELECT';
  if (batch && isBatchActive(batch.state)) {
    return failure(req, step, { code: 'BATCH_ACTIVE', error: `Another batch is ${batch.state}. Finish or cancel it first.`, needsRescan: false });
  }
  if (batch && batch.batchId === req.batchId) {
    return failure(req, step, { code: 'BATCH_WRONG_STATE', error: `This batch already ran (${batch.state}). Start a new batch. Nothing was clicked.`, needsRescan: false });
  }
  if (fba.getPendingTrash()) {
    return failure(req, step, { code: 'TRASH_PENDING', error: 'A single-post Trash is waiting for confirmation. Confirm or cancel it first.', needsRescan: false });
  }
  if (req.permalinks.length !== req.itemIds.length) {
    return failure(req, step, { code: 'BATCH_MALFORMED', error: 'Every item needs the permalink the popup reviewed.', needsRescan: false });
  }
  const ids = { batchId: req.batchId, scanSessionId: req.scanSessionId, itemIds: req.itemIds, state: 'REVIEW' as BatchState };
  fba.recordBatch({ ...ids, action: 'BATCH_CREATED', result: 'SUCCESS', listIds: true });

  // 1. Preflight, all items, before anything is clicked. Even one failure: no click at all.
  const { preflight, targets } = runPreflight(session, req, deps);
  if (!preflight.ok || !targets || !session) {
    const failedIds = preflight.items.filter((c) => !c.ok).map((c) => c.itemId);
    fba.recordBatch({ ...ids, action: 'BATCH_PREFLIGHT_FAILED', result: `REFUSED:${failedIds.length} of ${req.itemIds.length} item(s)${failedIds.length ? ` (${listIds(failedIds)})` : ''}${preflight.pageProblems.length ? ', page state' : ''}` });
    const why = [failedIds.length > 0 ? `${failedIds.length} of ${req.itemIds.length} item(s) failed the preflight (${listIds(failedIds)}).` : null, ...preflight.pageProblems].filter(Boolean);
    return failure(req, step, { code: 'BATCH_PREFLIGHT_FAILED', error: `${why.join(' ')} No checkbox was selected.`, needsRescan: failedIds.length > 0 }, { preflight });
  }
  fba.recordBatch({ ...ids, action: 'BATCH_PREFLIGHT_OK', result: `SUCCESS:${preflight.ready}/${req.itemIds.length} ready` });

  const items = targets.map((t) => t.item).sort((a, c) => session.items.indexOf(a) - session.items.indexOf(c));
  const b: Batch = {
    batchId: req.batchId,
    session,
    deps,
    url: session.url,
    createdAt: Date.now(),
    state: 'REVIEW',
    items,
    selected: new Set(),
    history: [{ state: 'REVIEW', at: new Date().toISOString() }],
    preflight,
    progress: null,
    selection: null,
    toolbar: null,
    dialogDiscovery: null,
    kept: null,
    rollback: null,
    verification: null,
    lastError: null,
  };
  batch = b;
  transition(b, 'SELECTING');
  const n = b.items.length;

  // 2. One checkbox at a time: re-check, click once, verify everything (and that nothing re-rendered).
  const others = trackOthers(b);
  const url = location.href;
  const rowsAtStart = b.session.items.filter((it) => it.row.isConnected);
  const expected = new Set<fba.ActionableItem>();
  for (const it of b.items) {
    setProgress(b, 'SELECTING', expected.size, n, it);
    const t = fba.validateTarget(session, b.session.id, it.itemId, deps);
    let why: string | null = t.refused ? `${it.itemId}: ${t.code}: ${t.error}` : t.item !== it || t.checkbox !== it.checkbox ? `${it.itemId} is no longer the same scanned row.` : null;
    if (!why && readState(it.checkbox).state !== 'unchecked') why = `${it.itemId}'s checkbox is no longer unchecked.`;
    const inv = why ? [] : invariantViolations(b, expected);
    if (inv.length > 0) why = `Invariant: ${inv.join(' ')}`;
    if (why || t.refused) {
      logBatch(b, 'BATCH_SELECT_ITEM', 'REFUSED:STOPPED_BEFORE_CLICK', it);
      const masterFull = masterFullySelected(b);
      return failSelection(b, req, `Stopped before selecting ${it.itemId}: ${why}`, inv.some((p) => p !== MASTER_FULL), masterFull);
    }

    const after = await fba.clickCheckboxOnce(t.checkbox, 'checked', markClicked);
    if (after.state === 'checked') b.selected.add(it);
    const want = new Set([...expected, it]);
    const { v, severe, masterFull } = verifySelection(b, want, others, url, rowsAtStart);
    b.selection = v;
    if (after.state !== 'checked' || v.unexpected.length > 0) {
      logBatch(b, 'BATCH_SELECT_ITEM', `UNEXPECTED:${masterFull ? 'MASTER_FULLY_SELECTED' : after.state}`, it);
      return failSelection(b, req, `After selecting ${it.itemId} (${expected.size + 1} of ${n}): ${v.unexpected.join(' ') || `its checkbox is ${after.state} (${after.detail}).`}`, severe, masterFull);
    }
    expected.add(it);
  }
  setProgress(b, 'SELECTING', n, n);

  // 3. All N selected: the whole page, once more.
  const final = verifySelection(b, new Set(b.items), others, url, rowsAtStart);
  b.selection = final.v;
  if (final.v.unexpected.length > 0) return failSelection(b, req, `After selecting all ${n}: ${final.v.unexpected.join(' ')}`, final.severe, final.masterFull);

  // 4. Read-only: what the bulk toolbar shows now (OPEN_DIALOG checks it again before clicking).
  b.toolbar = fbt.discoverBulkToolbar(b.session.items.map((it) => it.row).filter((r) => r.isConnected), b.session.masterCheckbox).discovery;
  logBatch(b, 'BATCH_SELECTION_VERIFIED', `SUCCESS:${n}/${n} selected`);
  transition(b, 'SELECTED');
  setProgress(b, 'SELECTED', n, n);
  return success(b, step);
}

/**
 * Stops the selection: rolls back what this batch selected, locks if that is incomplete (or
 * `severe`), ends as FAILED. MASTER_FULLY_SELECTED when Facebook's select-all read fully checked.
 */
async function failSelection(b: Batch, req: BatchRequest, why: string, severe: boolean, masterFull: boolean): Promise<BatchFailure> {
  const rb = await unselectAll(b, 'BATCH_ROLLBACK');
  if (!rb.complete) fba.lockActions(`a batch selection failed and its rollback is incomplete: ${rollbackFailureText(rb)}.`);
  else if (severe) fba.lockActions(`unexpected page state during a batch selection: ${why}`);
  transition(b, 'FAILED');
  return failure(req, 'SELECT', {
    code: masterFull ? 'MASTER_FULLY_SELECTED' : 'BATCH_SELECTION_FAILED',
    error: `${why} ${rb.complete ? `Rolled back: ${rb.rolledBack.length ? `${rb.rolledBack.length} post(s) unselected` : 'nothing was selected'}.` : 'Rollback incomplete: all actions are locked until the Facebook tab is reloaded.'}`,
    needsRescan: true,
  });
}

// ---------------------------------------------------------------------------
// The other steps
// ---------------------------------------------------------------------------

/** The batch this request refers to, in one of `states`, or why not. */
function requireBatch(req: BatchRequest, step: BatchStep, states: BatchState[]): Batch | BatchFailure {
  const b = batch;
  const sameIds = b && b.items.length === req.itemIds.length && b.items.every((it) => req.itemIds.includes(it.itemId));
  if (!b || b.batchId !== req.batchId || b.session.id !== req.scanSessionId || !sameIds) {
    return failure(req, step, { code: 'BATCH_NOT_FOUND', error: 'No batch with these ids exists in the Facebook tab (the tab was reloaded, or it was replaced). Nothing was clicked.', needsRescan: true });
  }
  if (!states.includes(b.state)) {
    return failure(req, step, { code: 'BATCH_WRONG_STATE', error: `The batch is ${b.state}, not ${states.join(' / ')}. Nothing was clicked.`, needsRescan: false });
  }
  return b;
}

function expired(b: Batch): Stop | null {
  if (Date.now() - b.createdAt <= BATCH_TTL_MS) return null;
  return { code: 'BATCH_EXPIRED', error: `The batch was selected more than ${BATCH_TTL_MS / 60_000} minutes ago. Nothing was clicked. Cancel and unselect it, then scan again.`, needsRescan: false };
}

async function unselectBatch(req: BatchRequest): Promise<BatchResponse> {
  const b = requireBatch(req, 'UNSELECT', ['SELECTED']);
  if ('ok' in b) return b;
  if (b.kept && !fbta.dialogClosed(b.kept.dialog)) {
    return failure(req, 'UNSELECT', { code: 'PAGE_STATE_UNEXPECTED', error: "Facebook's dialog is still open. Close it first. Nothing was clicked.", needsRescan: false });
  }
  const rb = await unselectAll(b, 'BATCH_UNSELECT');
  if (!rb.complete) {
    return failAfterClick(
      b,
      req,
      'UNSELECT',
      'BATCH_UNSELECT_FAILED',
      `Could not unselect every post: ${rollbackFailureText(rb)}. All actions are locked: check the selection on Facebook and reload the tab.`,
      'unselecting a batch did not return every checkbox to unchecked.',
    );
  }
  transition(b, 'CANCELLED');
  return success(b, 'UNSELECT', `Unselected ${rb.rolledBack.length} post(s); nothing on the page is selected.`);
}

async function openBatchDialog(session: fba.ActionableSession | null, req: BatchRequest, deps: fba.ActionDeps): Promise<BatchResponse> {
  const step: BatchStep = 'OPEN_DIALOG';
  const b = requireBatch(req, step, ['SELECTED']);
  if ('ok' in b) return b;
  const n = b.items.length;

  // V2B: Facebook's select-all fully checked while the batch waited: stop and roll back, nothing else.
  if (session === b.session && masterFullySelected(b)) {
    const rb = await unselectAll(b, 'BATCH_ROLLBACK');
    if (!rb.complete) fba.lockActions(`the master select-all became fully checked and the rollback is incomplete: ${rollbackFailureText(rb)}.`);
    transition(b, 'FAILED');
    return failure(req, step, {
      code: 'MASTER_FULLY_SELECTED',
      error: `${MASTER_FULL} The Trash button was not clicked. ${rb.complete ? `Rolled back: ${rb.rolledBack.length} post(s) unselected.` : 'Rollback incomplete: all actions are locked until the Facebook tab is reloaded.'}`,
      needsRescan: true,
    });
  }
  const stop = expired(b) ?? revalidateSelected(b, session, deps);
  if (stop) return failure(req, step, stop);

  // The toolbar's Trash button: HIGH, enabled, unique, outside every row, and exactly N selected.
  const high = fbta.findHighTrash(b.session, n, 'SELECTED_COUNT_MISMATCH');
  b.toolbar = high.toolbar;
  if ('stop' in high) return failure(req, step, high.stop);
  const inv = invariantViolations(b, new Set(b.items));
  if (inv.length > 0) return failure(req, step, { code: 'INVARIANT_VIOLATION', error: `${inv.join(' ')} Nothing was clicked.`, needsRescan: false });

  setProgress(b, 'OPENING_DIALOG', 0, 1);
  const opened = await fbta.clickTrashAndDiscoverDialog(high.trash, clickOnce);
  logBatch(b, 'BATCH_TRASH_OPENED', 'SUCCESS:CLICKED');
  const { found } = opened;
  b.dialogDiscovery = found.discovery;
  const manual = "Nothing else was clicked. Close Facebook's dialog yourself (Cancel), then reload the Facebook tab.";
  if (location.href !== opened.url) {
    return failAfterClick(b, req, step, 'UNEXPECTED_AFTER_TRASH', `The page URL changed after clicking Trash. ${manual}`, 'the page URL changed after clicking the toolbar Trash button (batch).');
  }
  if (!found.dialog) {
    const linked = fbta.linkedUrls();
    const gone = b.items.filter((it) => !it.row.isConnected && !linked.has(it.permalink!)).length;
    return failAfterClick(
      b,
      req,
      step,
      'DIALOG_NOT_FOUND',
      `No confirmation dialog appeared within ${fbta.DIALOG_WAIT_MS / 1000} s. ${found.discovery.reason} ` +
        (gone > 0 ? `${gone} of the posts have left the list anyway: check Facebook's Trash. ` : '') +
        'Nothing else was clicked. Reload the Facebook tab and check it by hand.',
      'clicked the toolbar Trash button (batch) but no confirmation dialog appeared.',
    );
  }
  const buttons = fbta.highDialogButtons(found);
  if ('why' in buttons) {
    return failAfterClick(b, req, step, 'DIALOG_NOT_HIGH', `${buttons.why} ${manual}`, "Facebook's confirmation dialog (batch) could not be identified with HIGH confidence.");
  }
  b.kept = { dialog: found.dialog, ...buttons, openedAt: Date.now() };
  transition(b, 'DIALOG_OPEN');
  setProgress(b, 'AWAITING_FINAL_CONFIRMATION', 1, 1);
  logBatch(b, 'BATCH_DIALOG_HIGH', 'SUCCESS');
  return success(b, step);
}

async function cancelBatchDialog(req: BatchRequest): Promise<BatchResponse> {
  const step: BatchStep = 'CANCEL_DIALOG';
  const b = requireBatch(req, step, ['DIALOG_OPEN']);
  if ('ok' in b) return b;
  const kept = b.kept!;
  const url = location.href;
  const c = await fbta.cancelFacebookDialog(kept, clickOnce);
  if (c.again) b.dialogDiscovery = c.again.discovery;
  logBatch(b, 'BATCH_DIALOG_CANCEL', c.alreadyClosed ? 'SUCCESS:ALREADY_CLOSED' : c.clicked ? (c.closed ? 'SUCCESS:CANCELLED' : 'SUCCESS:STILL_OPEN') : 'SUCCESS:NO_CLICK');

  // Cancelling must leave every target exactly where it was.
  const left = b.items.filter((it) => !it.row.isConnected);
  if (location.href !== url || left.length > 0) {
    fba.retireSession(b.session.id);
    return failAfterClick(
      b,
      req,
      step,
      'UNEXPECTED_AFTER_TRASH',
      `${location.href !== url ? 'The page URL changed' : `${listIds(left.map((it) => it.itemId))} left the page`} while Facebook's dialog was being cancelled. Check Facebook's Trash and reload the tab.`,
      'unexpected state after cancelling the batch Trash dialog.',
    );
  }
  if (!c.closed) {
    return success(
      b,
      step,
      c.clicked
        ? "Clicked Facebook's Cancel, but the dialog is still open. Close it yourself, then press Cancel here again."
        : "Facebook's Cancel button could not be identified with HIGH confidence, so nothing was clicked. Close Facebook's dialog yourself, then press Cancel here again.",
    );
  }
  b.kept = null;
  b.dialogDiscovery = null;
  transition(b, 'SELECTED');
  setProgress(b, 'SELECTED', b.items.length, b.items.length);
  return success(b, step, c.alreadyClosed ? "Facebook's dialog was already closed. The posts are still selected." : "Clicked Facebook's Cancel. The dialog closed; the posts are still selected and were not moved.");
}

async function confirmBatch(session: fba.ActionableSession | null, req: BatchRequest, deps: fba.ActionDeps): Promise<BatchResponse> {
  const step: BatchStep = 'CONFIRM';
  const b = requireBatch(req, step, ['DIALOG_OPEN']);
  if ('ok' in b) return b;
  const kept = b.kept!;
  const n = b.items.length;
  const refuse = (r: Stop) =>
    failure(req, step, {
      ...r,
      error: `${r.error} Nothing was clicked. Press Cancel to close Facebook's dialog${r.code === 'MASTER_FULLY_SELECTED' ? ', then "Cancel and unselect"' : ''}.`,
    });

  // Final safety check: all of it again, immediately before the click.
  if (Date.now() - kept.openedAt > DIALOG_TTL_MS) {
    return refuse({ code: 'PENDING_EXPIRED', error: `Facebook's dialog has been open for more than ${DIALOG_TTL_MS / 60_000} minutes.`, needsRescan: false });
  }
  const old = expired(b);
  if (old) return refuse(old);
  if (location.href !== b.url) return refuse({ code: 'NAVIGATED', error: 'The page has navigated since the scan.', needsRescan: true });
  const re = fbta.recheckDialog(kept);
  b.dialogDiscovery = re.again.discovery;
  if (!re.ok) return refuse({ code: 'DIALOG_CHANGED', error: re.why, needsRescan: false });
  const stop = revalidateSelected(b, session, deps);
  if (stop) return refuse(stop);
  const count = fbta.selectedCount(b.session.masterCheckbox);
  if (count !== n) {
    return refuse({ code: 'SELECTED_COUNT_MISMATCH', error: `${count} checkbox(es) are selected on the page, not exactly ${n}.`, needsRescan: false });
  }

  // The list changes after this click whatever happens: retire the scan first, so nothing else runs on it.
  fba.retireSession(b.session.id);
  transition(b, 'CONFIRMING');
  logBatch(b, 'BATCH_CONFIRM', 'SUCCESS:CLICKING');
  const url = location.href;
  const started = performance.now();
  clickOnce(kept.confirm);
  transition(b, 'VERIFYING');
  setProgress(b, 'VERIFYING', 0, n);

  // Wait for every target to leave the list (or the URL to change), then settle and verify once more.
  const waitMs = REMOVAL_WAIT_BASE_MS + n * REMOVAL_WAIT_PER_ITEM_MS;
  const elapsed = () => performance.now() - started;
  while (elapsed() < waitMs) {
    const v = verifyTrash(b, kept.dialog, url, elapsed());
    setProgress(b, 'VERIFYING', v.removed, n);
    if (!v.urlUnchanged || (v.dialogClosed && v.removed === n)) break;
    await fba.sleep(fbta.REMOVAL_POLL_MS);
  }
  await fba.sleep(fbta.REMOVAL_SETTLE_MS);
  const v = verifyTrash(b, kept.dialog, url, elapsed());
  const j = judge(b, v);
  b.verification = v;
  b.kept = null;
  for (const it of b.items) if (!it.row.isConnected) b.selected.delete(it);
  if (j.lock) fba.lockActions(j.lock);
  setProgress(b, 'VERIFYING', v.removed, n);
  logBatch(b, `BATCH_VERIFY_${j.outcome}`, `${j.outcome === 'SUCCESS' ? 'SUCCESS' : 'UNEXPECTED'}:${v.removed}/${n} removed, ${v.stillPresent} still present, ${v.uncertain} uncertain`);
  transition(b, j.outcome);
  return success(b, step, j.outcome === 'SUCCESS' ? null : `A full rescan is required. Nothing will be retried automatically.${j.lock ? ' All actions are locked until the Facebook tab is reloaded.' : ''}`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

export async function performBatchStep(session: fba.ActionableSession | null, req: BatchRequest, deps: fba.ActionDeps): Promise<BatchResponse> {
  clickedThisStep = false;
  const step = STEPS.includes(req?.step) ? req.step : null;
  const stop = (code: BatchErrorCode, error: string, needsRescan = false) => failure(req ?? {}, step, { code, error, needsRescan });

  if (req?.protocol !== SCANNER_PROTOCOL) {
    return stop('PROTOCOL_MISMATCH', 'The popup and the scanner in this tab come from different builds. Reload the Facebook tab, then scan again.', true);
  }
  if (!step || typeof req.scanSessionId !== 'string' || typeof req.batchId !== 'string' || !isStringArray(req.itemIds) || !isStringArray(req.permalinks)) {
    return stop('BATCH_MALFORMED', 'Malformed batch request.');
  }
  // The hard limit, enforced here whatever the popup sent. Never truncated.
  if (req.itemIds.length > MAX_BATCH_SIZE) return stop('BATCH_TOO_LARGE', `A batch holds at most ${MAX_BATCH_SIZE} posts; this request has ${req.itemIds.length}. Nothing was clicked.`);
  if (req.itemIds.length === 0) return stop('BATCH_EMPTY', 'The batch is empty.');
  if (new Set(req.itemIds).size !== req.itemIds.length) return stop('BATCH_MALFORMED', 'The batch lists the same item twice.');
  // PREFLIGHT only reads the page; every other step clicks and needs the popup's confirmation.
  if (step !== 'PREFLIGHT' && req.confirmed !== true) return stop('NOT_CONFIRMED', 'This step was not confirmed in the popup. Nothing was clicked.');
  const lock = fba.getLockReason();
  if (lock) return stop('LOCKED', `Actions are locked: ${lock} Reload the Facebook tab to reset.`);
  const loading = fba.autoLoadBlock();
  if (loading) return stop('AUTOLOAD_ACTIVE', loading, true);
  if (!fba.tryAcquire()) return stop('BUSY', 'Another action is still running.');

  try {
    switch (step) {
      case 'PREFLIGHT':
        return preflightOnly(session, req, deps);
      case 'SELECT':
        return await selectBatch(session, req, deps);
      case 'UNSELECT':
        return await unselectBatch(req);
      case 'OPEN_DIALOG':
        return await openBatchDialog(session, req, deps);
      case 'CANCEL_DIALOG':
        return await cancelBatchDialog(req);
      case 'CONFIRM':
        return await confirmBatch(session, req, deps);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // After a click we can no longer vouch for the page state.
    if (clickedThisStep) {
      fba.lockActions(`the batch step ${step} threw after clicking: ${message}`);
      if (batch && batch.batchId === req.batchId && canTransition(batch.state, 'FAILED')) transition(batch, 'FAILED');
    }
    return stop('INTERNAL_ERROR', `${clickedThisStep ? 'Error after a click: ' : ''}${message}`, true);
  } finally {
    fba.release();
  }
}
