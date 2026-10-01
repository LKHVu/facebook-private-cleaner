/**
 * facebookToolbar.ts
 *
 * V1B discovery, strictly read-only: the Activity Log's bulk-selection toolbar and its actions
 * ("Lưu trữ" / Archive, "Bỏ đi" / Trash, "Thay đổi đối tượng" / Change audience), how many
 * checkboxes on the page are selected, and the confirmation dialog Facebook opens after Trash.
 * Like facebookControls.ts, it reads attributes, text and layout boxes only. It never clicks,
 * focuses or dispatches events. facebookTrashAction.ts decides what, if anything, to click.
 *
 * Rules (the same as facebookControls.ts):
 *  - No generated CSS class names: roles, accessible names, aria-* and containment only.
 *  - Bulk actions are searched for only inside the toolbar, which is found by climbing from the
 *    master select-all checkbox and never contains a mapped post row.
 *  - When several candidates match equally well, report the ambiguity and pick none.
 *
 * Every UI-language string comes from the V1B vocabulary block in facebookSelectors.ts.
 */

import type {
  BulkActionKind,
  CheckState,
  Confidence,
  ControlDiscovery,
  DialogButtonInfo,
  DialogButtonRole,
  DialogDiscovery,
  ToolbarDiscovery,
} from '../shared/types';
import { BULK_ACTION_KINDS } from '../shared/types';
import * as fbc from './facebookControls';
import {
  BULK_ACTION_LABELS,
  DIALOG_CANCEL_PHRASES,
  DIALOG_CLOSE_PHRASES,
  PERMANENT_DELETE_WORDS,
  TRASH_CONFIRM_PHRASES,
  TRASH_DIALOG_CONTEXT_PHRASES,
  describeElement,
  normalizeLabel,
  outermost,
} from './facebookSelectors';

const BUTTON_SELECTOR = 'button, [role="button"]';
const DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"], dialog[open]';
const HEADING_SELECTOR = '[role="heading"], h1, h2, h3, h4, h5, h6';
/** How far up from the master checkbox the toolbar may be. */
const MAX_TOOLBAR_LEVELS = 8;
/** Distinct bulk actions a container needs before it counts as the toolbar. */
const MIN_TOOLBAR_ACTION_KINDS = 2;
const MAX_DIALOG_TEXT = 300;
const MAX_DIALOG_BUTTONS = 20;
/** V2B diagnostic: toolbar text fragments with a number in them ("N selected"), kept short and few. */
const MAX_COUNT_TEXT = 40;
const MAX_COUNT_TEXTS = 3;

const ACTION_NAMES: Record<BulkActionKind, string> = {
  archive: 'Archive',
  trash: 'Trash',
  changeAudience: 'Change audience',
};
/** One name per action, for reasons shown in the debug panel. */
const ACTION_EXAMPLES = BULK_ACTION_KINDS.map((k) => BULK_ACTION_LABELS[k][0]);

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function quoteAll(ps: string[]): string {
  return ps.map((p) => `"${p}"`).join(' / ');
}

/** Disabled natively, or aria-disabled on the element or any ancestor up to (not including) stop. */
function isDisabledWithin(el: Element, stop: Element | null): boolean {
  if ((el instanceof HTMLButtonElement || el instanceof HTMLInputElement) && el.disabled) return true;
  for (let e: Element | null = el; e && e !== stop; e = e.parentElement) {
    if (e.getAttribute('aria-disabled') === 'true') return true;
  }
  return false;
}

function overlapsAny(el: Element, rows: Element[]): boolean {
  return rows.some((r) => r === el || r.contains(el) || el.contains(r));
}

// ---------------------------------------------------------------------------
// Selection on the page
// ---------------------------------------------------------------------------

export interface SelectionReading {
  /** Rendered checkboxes (outermost control each) reading "checked", master excluded. */
  checked: Element[];
  /** Same, reading "mixed". */
  mixed: Element[];
  /** Same, whose state can't be read. */
  unknown: Element[];
  masterState: CheckState | 'not found';
}

/** Is el the master select-all checkbox (the scan's, or one named like it)? */
function isMaster(el: Element, master: Element | null): boolean {
  return (master !== null && (master === el || master.contains(el) || el.contains(master))) || fbc.isNamedSelectAll(el);
}

/** Every rendered checkbox on the page and its state. Read-only. */
export function readSelection(master: Element | null): SelectionReading {
  const all = outermost([...document.querySelectorAll(fbc.CHECKBOX_SELECTOR)].filter(fbc.isRendered));
  const out: SelectionReading = {
    checked: [],
    mixed: [],
    unknown: [],
    masterState: master?.isConnected ? fbc.readCheckState(master).state : 'not found',
  };
  for (const el of all) {
    if (isMaster(el, master)) {
      if (out.masterState === 'not found') out.masterState = fbc.readCheckState(el).state;
      continue;
    }
    const s = fbc.readCheckState(el).state;
    if (s === 'checked') out.checked.push(el);
    else if (s === 'mixed') out.mixed.push(el);
    else if (s === 'unknown') out.unknown.push(el);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bulk toolbar
// ---------------------------------------------------------------------------

/**
 * V2B, diagnostic only: short rendered text fragments inside the toolbar that contain a number,
 * which is where Facebook may show its own "N selected" text. Never used for a safety decision.
 */
function readCountTexts(toolbar: Element): { countTexts: string[]; visibleCount: number | null } {
  const countTexts: string[] = [];
  const walker = document.createTreeWalker(toolbar, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n && countTexts.length < MAX_COUNT_TEXTS; n = walker.nextNode()) {
    const text = (n.textContent ?? '').replace(/\s+/g, ' ').trim();
    const parent = n.parentElement;
    if (!text || text.length > MAX_COUNT_TEXT || !/\d/.test(text) || !parent || !fbc.isRendered(parent)) continue;
    if (!countTexts.includes(text)) countTexts.push(text);
  }
  const numbers = countTexts.length === 1 ? countTexts[0].match(/\d+/g) ?? [] : [];
  return { countTexts, visibleCount: numbers.length === 1 ? Number(numbers[0]) : null };
}

function actionKindOf(name: string): BulkActionKind | null {
  const n = normalizeLabel(name);
  return BULK_ACTION_KINDS.find((k) => BULK_ACTION_LABELS[k].includes(n)) ?? null;
}

interface ActionCandidate extends fbc.Candidate {
  kind: BulkActionKind;
}

/** Rendered buttons inside scope whose whole accessible name is a bulk action. A button nested in another is one control. */
function actionButtonsIn(scope: Element | Document): ActionCandidate[] {
  const named = [...scope.querySelectorAll(BUTTON_SELECTOR)].filter(
    (el) => el !== scope && fbc.isRendered(el) && actionKindOf(fbc.accessibleName(el).name) !== null,
  );
  return outermost(named).map((el) => {
    const c = fbc.toCandidate(el);
    return { ...c, kind: actionKindOf(c.name.name)! };
  });
}

interface ToolbarContainer {
  el: Element;
  anchor: string;
  anchoredOnMaster: boolean;
  levels: number;
}

/**
 * Climbs from the anchor to the smallest ancestor that contains buttons for at least
 * MIN_TOOLBAR_ACTION_KINDS distinct bulk actions. Stops before an ancestor that contains (or
 * sits inside) a mapped post row, or contains page navigation / the main region.
 */
function climbToToolbar(anchor: Element, rows: Element[]): { el: Element; levels: number } | null {
  let levels = 0;
  for (let el = anchor.parentElement; el && el !== document.body && levels < MAX_TOOLBAR_LEVELS; el = el.parentElement) {
    levels++;
    if (overlapsAny(el, rows)) return null;
    if (el.matches('[role="main"], [role="navigation"]') || el.querySelector('[role="main"], [role="navigation"]')) return null;
    const kinds = new Set(actionButtonsIn(el).map((c) => c.kind));
    if (kinds.size >= MIN_TOOLBAR_ACTION_KINDS) return { el, levels };
  }
  return null;
}

function findToolbarContainers(rows: Element[], master: Element | null): ToolbarContainer[] {
  const out: ToolbarContainer[] = [];
  const add = (anchor: Element, anchoredOnMaster: boolean) => {
    const hit = climbToToolbar(anchor, rows);
    if (hit && !out.some((c) => c.el === hit.el)) {
      out.push({ el: hit.el, anchor: describeElement(anchor), anchoredOnMaster, levels: hit.levels });
    }
  };
  if (master?.isConnected && !overlapsAny(master, rows)) {
    add(master, true);
    return out;
  }
  // No master checkbox from the scan: try every rendered Trash-named button outside the rows.
  // A toolbar found this way is at most MEDIUM, so it can never be acted on.
  for (const c of actionButtonsIn(document)) {
    if (c.kind === 'trash' && !overlapsAny(c.el, rows)) add(c.el, false);
  }
  return out;
}

function emptyActions(reason: string): Record<BulkActionKind, ControlDiscovery> {
  return Object.fromEntries(BULK_ACTION_KINDS.map((k) => [k, fbc.missing(reason).discovery])) as Record<BulkActionKind, ControlDiscovery>;
}

function discoverAction(
  kind: BulkActionKind,
  toolbar: Element,
  toolbarConfidence: Confidence,
  inToolbar: ActionCandidate[],
  onPage: ActionCandidate[],
): fbc.ControlPick {
  const mine = inToolbar.filter((c) => c.kind === kind);
  const phrases = quoteAll(BULK_ACTION_LABELS[kind]);
  if (mine.length === 0) return fbc.missing(`No rendered button in the toolbar is named ${phrases}.`);
  if (mine.length > 1) return fbc.ambiguous(`${mine.length} buttons in the toolbar are named like ${ACTION_NAMES[kind]}.`, mine);

  const c = mine[0];
  const elsewhere = onPage.filter((o) => o.kind === kind && !toolbar.contains(o.el));
  const downgrades: string[] = [];
  if (toolbarConfidence !== 'HIGH') downgrades.push(`the toolbar itself is only ${toolbarConfidence}`);
  if (isDisabledWithin(c.el, toolbar.parentElement)) downgrades.push('it is disabled (is exactly one post selected?)');
  if (c.el.closest('[aria-hidden="true"]')) downgrades.push('it is inside aria-hidden');
  if (fbc.isCheckboxLike(c.el)) downgrades.push('it is or wraps a checkbox');
  if (elsewhere.length > 0) downgrades.push(`${elsewhere.length} other button(s) outside the toolbar have the same name`);
  if (!['aria-label', 'aria-labelledby', 'text'].includes(c.name.source)) downgrades.push(`its name comes only from ${c.name.source}`);

  const role = c.el.localName === 'button' ? '<button>' : 'role=button';
  const base = `The only rendered ${role} inside the bulk toolbar whose whole accessible name (${c.name.source}) is "${c.name.name}".`;
  if (downgrades.length === 0) {
    return fbc.chosen('toolbar', kind, c, 'HIGH', `${base} Enabled, unique on the page, outside every post row.`, mine);
  }
  return fbc.chosen('toolbar', kind, c, 'MEDIUM', `${base} Not HIGH because ${downgrades.join('; ')}.`, mine);
}

/** The toolbar discovery plus the exact elements, which stay in the content script. */
export interface ToolbarFound {
  discovery: ToolbarDiscovery;
  toolbar: Element | null;
  elements: Partial<Record<BulkActionKind, Element>>;
}

/**
 * Finds the bulk-selection toolbar and its actions. `rows` are the mapped post rows of the
 * current scan (connected ones), `master` the scan's master select-all checkbox, if any.
 */
export function discoverBulkToolbar(rows: Element[], master: Element | null): ToolbarFound {
  const selection = readSelection(master);
  const base = {
    selectedCount: selection.checked.length,
    masterState: selection.masterState,
    unreadableCount: selection.unknown.length,
  };
  const none = (reason: string, signals: string[] = []): ToolbarFound => ({
    toolbar: null,
    elements: {},
    discovery: {
      found: false,
      confidence: null,
      reason,
      element: null,
      signals,
      actions: emptyActions('No bulk toolbar was found.'),
      ...base,
      countTexts: [],
      visibleCount: null,
    },
  });

  const containers = findToolbarContainers(rows, master);
  if (containers.length === 0) {
    return none(
      master
        ? `No ancestor of the master checkbox (up to ${MAX_TOOLBAR_LEVELS} levels, and not containing a post row) holds buttons for ${MIN_TOOLBAR_ACTION_KINDS}+ of: ${quoteAll(ACTION_EXAMPLES)}.`
        : 'The scan found no master select-all checkbox, and no Trash-named button outside the post rows sits in a toolbar.',
    );
  }
  if (containers.length > 1) {
    return none(`Ambiguous: ${containers.length} separate containers look like the bulk toolbar. None was chosen.`, containers.map((c) => describeElement(c.el)));
  }

  const t = containers[0];
  const boxes = outermost([...t.el.querySelectorAll(fbc.CHECKBOX_SELECTOR)].filter(fbc.isRendered));
  const onlyMaster = boxes.length === 1 && isMaster(boxes[0], master);
  const confidence: Confidence = t.anchoredOnMaster && onlyMaster ? 'HIGH' : 'MEDIUM';
  const inToolbar = actionButtonsIn(t.el);
  const signals = [
    `anchor: ${t.anchor}${t.anchoredOnMaster ? ' (master select-all checkbox)' : ' (Trash-named button; no master checkbox)'}`,
    `${t.levels} level(s) up from the anchor`,
    `bulk actions inside: ${inToolbar.map((c) => `"${c.name.name}"`).join(', ') || 'none'}`,
    `${boxes.length} rendered checkbox(es) inside${onlyMaster ? ' (only the master)' : ''}`,
    'contains no mapped post row',
  ];
  const reason =
    confidence === 'HIGH'
      ? `The smallest ancestor of the master select-all checkbox with ${MIN_TOOLBAR_ACTION_KINDS}+ bulk-action buttons; its only checkbox is the master and it contains no post row.`
      : `Looks like the bulk toolbar, but ${t.anchoredOnMaster ? `it holds ${boxes.length} checkboxes, not just the master` : 'it was not found from the master select-all checkbox'}.`;

  const onPage = actionButtonsIn(document);
  const elements: Partial<Record<BulkActionKind, Element>> = {};
  const actions = {} as Record<BulkActionKind, ControlDiscovery>;
  for (const kind of BULK_ACTION_KINDS) {
    const pick = discoverAction(kind, t.el, confidence, inToolbar, onPage);
    actions[kind] = pick.discovery;
    if (pick.element) elements[kind] = pick.element;
  }

  return {
    toolbar: t.el,
    elements,
    discovery: { found: true, confidence, reason, element: describeElement(t.el), signals, actions, ...base, ...readCountTexts(t.el) },
  };
}

// ---------------------------------------------------------------------------
// Facebook's Trash confirmation dialog
// ---------------------------------------------------------------------------

/** Every dialog element on the page now. Taken just before the toolbar click, so the new dialog can be told apart. */
export function snapshotDialogs(): Set<Element> {
  return new Set(document.querySelectorAll(DIALOG_SELECTOR));
}

function containsAny(haystack: string, needles: string[]): string | null {
  return needles.find((n) => haystack.includes(n)) ?? null;
}

function dialogButtonRole(name: string): { role: DialogButtonRole; note: string | null } {
  const n = normalizeLabel(name);
  const permanent = containsAny(n, PERMANENT_DELETE_WORDS);
  if (permanent) return { role: 'other', note: `permanent-delete wording "${permanent}": never a Trash confirmation` };
  if (TRASH_CONFIRM_PHRASES.includes(n)) return { role: 'confirm', note: null };
  if (DIALOG_CANCEL_PHRASES.includes(n)) return { role: 'cancel', note: null };
  if (DIALOG_CLOSE_PHRASES.includes(n)) return { role: 'close', note: null };
  return { role: 'other', note: null };
}

/** The dialog's own name: aria-labelledby / aria-label, else its first heading. */
function dialogName(d: Element): string | null {
  const n = fbc.accessibleName(d);
  if (n.source === 'aria-labelledby' || n.source === 'aria-label') return n.name;
  const h = d.querySelector(HEADING_SELECTOR);
  const text = h ? fbc.textOf(h) : '';
  return text ? clip(text, 120) : null;
}

/** The dialog discovery plus the exact elements, which stay in the content script. */
export interface DialogFound {
  discovery: DialogDiscovery;
  dialog: Element | null;
  confirm: Element | null;
  cancel: Element | null;
}

function noDialog(reason: string, newDialogs: number, waitedMs: number): DialogFound {
  const none = fbc.missing('No dialog.').discovery;
  return {
    dialog: null,
    confirm: null,
    cancel: null,
    discovery: { found: false, reason, role: null, name: null, text: '', mentionsTrash: false, newDialogs, buttons: [], confirm: none, cancel: none, waitedMs },
  };
}

/**
 * Finds the Trash confirmation dialog and, inside it, the confirm and cancel buttons.
 *  - `before`: dialogs present before the toolbar click; only dialogs that appeared since count.
 *  - `only`: re-check this exact dialog instead (the second confirmation step).
 * The confirm button is HIGH only when: it is the one button in a newly opened dialog whose
 * whole name is a Trash-confirm phrase, it is enabled, the dialog mentions Trash and not
 * permanent deletion in its name/heading, and the dialog also has a Cancel or Close button.
 */
export function discoverTrashDialog(before: Set<Element>, waitedMs: number, only?: Element): DialogFound {
  let fresh: Element[];
  if (only) {
    fresh = only.isConnected && fbc.isRendered(only) ? [only] : [];
    if (fresh.length === 0) return noDialog('The dialog found earlier is no longer on the page.', 0, waitedMs);
  } else {
    const all = [...document.querySelectorAll(DIALOG_SELECTOR)].filter(
      (d) => !before.has(d) && fbc.isRendered(d) && d.querySelector(BUTTON_SELECTOR) !== null,
    );
    // Facebook may nest role=dialog layers; the innermost one holding the buttons is the dialog.
    fresh = all.filter((d) => !all.some((o) => o !== d && d.contains(o)));
    if (fresh.length === 0) {
      const open = [...document.querySelectorAll(DIALOG_SELECTOR)].filter(fbc.isRendered).length;
      return noDialog(`No new dialog with buttons appeared (${open} rendered dialog(s) on the page, all present before the click).`, 0, waitedMs);
    }
  }

  let chosenDialogs = fresh;
  if (fresh.length > 1) {
    chosenDialogs = fresh.filter((d) => [...d.querySelectorAll(BUTTON_SELECTOR)].some((b) => dialogButtonRole(fbc.accessibleName(b).name).role === 'confirm'));
    if (chosenDialogs.length !== 1) {
      return noDialog(`Ambiguous: ${fresh.length} new dialogs appeared and ${chosenDialogs.length} of them have a Trash-confirm button. None was chosen.`, fresh.length, waitedMs);
    }
  }
  const d = chosenDialogs[0];

  const name = dialogName(d);
  const headings = [...d.querySelectorAll(HEADING_SELECTOR)].map((h) => fbc.textOf(h)).filter(Boolean);
  const text = clip(((d as HTMLElement).innerText ?? d.textContent ?? '').replace(/\s+/g, ' ').trim(), MAX_DIALOG_TEXT);
  const title = normalizeLabel([name ?? '', ...headings].join(' '));
  const context = containsAny(normalizeLabel(`${title} ${text}`), TRASH_DIALOG_CONTEXT_PHRASES);
  const permanentTitle = containsAny(title, PERMANENT_DELETE_WORDS);

  const buttonEls = outermost([...d.querySelectorAll(BUTTON_SELECTOR)].filter((b) => b !== d && fbc.isRendered(b)));
  const classified = buttonEls.map((el) => {
    const { role, note } = dialogButtonRole(fbc.accessibleName(el).name);
    const c = fbc.toCandidate(el, note ? [note] : []);
    if (isDisabledWithin(el, d)) c.signals.push('disabled');
    return { c, role };
  });
  const buttons: DialogButtonInfo[] = classified.slice(0, MAX_DIALOG_BUTTONS).map(({ c, role }) => ({
    element: describeElement(c.el),
    name: c.name.name,
    nameSource: c.name.source,
    signals: c.signals,
    role,
  }));
  const of = (role: DialogButtonRole) => classified.filter((x) => x.role === role).map((x) => x.c);

  // Cancel: a unique Cancel button, else a unique Close (X) button.
  const cancels = of('cancel');
  const closes = of('close');
  const pickCancel = (c: fbc.Candidate, tier: fbc.Candidate[], reason: string) =>
    isDisabledWithin(c.el, d)
      ? fbc.chosen('dialog', 'cancel', c, 'MEDIUM', `${reason} But it is disabled.`, tier)
      : fbc.chosen('dialog', 'cancel', c, 'HIGH', reason, tier);
  let cancel: fbc.ControlPick;
  if (cancels.length === 1) cancel = pickCancel(cancels[0], cancels, `The only button named ${quoteAll(DIALOG_CANCEL_PHRASES)}.`);
  else if (cancels.length > 1) cancel = fbc.ambiguous(`${cancels.length} buttons are named like Cancel.`, cancels);
  else if (closes.length === 1) cancel = pickCancel(closes[0], closes, `No Cancel button; the only button named ${quoteAll(DIALOG_CLOSE_PHRASES)}.`);
  else if (closes.length > 1) cancel = fbc.ambiguous(`No Cancel button, and ${closes.length} buttons are named like Close.`, closes);
  else cancel = fbc.missing(`No button named ${quoteAll([...DIALOG_CANCEL_PHRASES, ...DIALOG_CLOSE_PHRASES])}.`);

  // Confirm: exactly one, then every condition for HIGH.
  const confirms = of('confirm');
  let confirm: fbc.ControlPick;
  if (confirms.length === 0) confirm = fbc.missing(`No button in the dialog is named ${quoteAll(TRASH_CONFIRM_PHRASES)}.`);
  else if (confirms.length > 1) confirm = fbc.ambiguous(`${confirms.length} buttons in the dialog are named like a Trash confirmation.`, confirms);
  else {
    const c = confirms[0];
    const downgrades: string[] = [];
    if (isDisabledWithin(c.el, d)) downgrades.push('it is disabled');
    if (c.el.closest('[aria-hidden="true"]')) downgrades.push('it is inside aria-hidden');
    if (!context) downgrades.push(`the dialog never mentions ${quoteAll(TRASH_DIALOG_CONTEXT_PHRASES)}`);
    if (permanentTitle) downgrades.push(`the dialog's title mentions "${permanentTitle}" (permanent deletion)`);
    if (!cancel.element) downgrades.push('the dialog has no identifiable Cancel/Close button');
    const base = `The only button in the ${only ? '' : 'newly opened '}dialog whose whole name is a Trash confirmation ("${c.name.name}", ${c.name.source})`;
    confirm =
      downgrades.length === 0
        ? fbc.chosen('dialog', 'confirm', c, 'HIGH', `${base}; enabled; the dialog mentions "${context}" and has a Cancel/Close button.`, confirms)
        : fbc.chosen('dialog', 'confirm', c, 'MEDIUM', `${base}, but not HIGH because ${downgrades.join('; ')}.`, confirms);
  }

  return {
    dialog: d,
    confirm: confirm.element,
    cancel: cancel.element,
    discovery: {
      found: true,
      reason: only ? 'The same dialog as before, checked again.' : `${fresh.length} new dialog(s) appeared after the click; this one was chosen.`,
      role: d.getAttribute('role') ?? d.localName,
      name,
      text,
      mentionsTrash: context !== null,
      newDialogs: fresh.length,
      buttons,
      confirm: confirm.discovery,
      cancel: cancel.discovery,
      waitedMs,
    },
  };
}
