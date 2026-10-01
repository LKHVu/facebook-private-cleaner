/**
 * Content script, injected on demand by the background service worker.
 *
 * The scan is read-only: it inspects the currently loaded DOM and reports what it finds.
 * Its only own change to the page is a temporary overlay box (and a scroll) when the popup
 * asks to highlight an item or one of its controls for debugging.
 *
 * V3A auto-load (autoLoad.ts) only scrolls the page to load older entries. Starting it discards
 * the current scan session; while it runs, scans and every action are refused.
 *
 * The writes to Facebook's page live entirely in facebookActions.ts (V1A: select one post's
 * checkbox), facebookTrashAction.ts (V1B: move that one post to Trash) and facebookBatchAction.ts
 * (V2A / V2B: a batch of at most MAX_BATCH_SIZE posts). This file only routes those requests there, together
 * with the scan session they need; it never clicks anything itself. While a batch is active it
 * refuses to scan, because a new scan would replace the session the batch is working on.
 *
 * All Facebook-specific selectors/strings come from facebookSelectors.ts, facebookControls.ts
 * and facebookToolbar.ts.
 */

import type {
  ActionStateResponse,
  Audience,
  BulkActionKind,
  AudienceBasis,
  AudienceCounts,
  AudienceEvidence,
  ContentRequest,
  ControlKind,
  HighlightResponse,
  LabelSeen,
  RejectedCandidate,
  ScanResult,
  ScannedItem,
  StrategyAttempt,
  ToolbarResponse,
} from '../shared/types';
import { BULK_ACTION_KINDS, CONTROL_KINDS, MAX_BATCH_SIZE, SCANNER_PROTOCOL } from '../shared/types';
import * as al from './autoLoad';
import * as fba from './facebookActions';
import * as fbb from './facebookBatchAction';
import * as fbc from './facebookControls';
import * as fb from './facebookSelectors';
import * as fbt from './facebookToolbar';
import * as fbta from './facebookTrashAction';

const MAX_LABELS_PER_ITEM = 40;
const MAX_INVENTORY = 150;
const MAX_VALUE_LENGTH = 120;
const MAX_VISIBLE_LABELS_PER_ITEM = 30;
const HIGHLIGHT_MS = 3000;
/** Row outline, and a distinct colour per control so they're easy to tell apart. */
interface OutlineColor {
  css: string;
  /** Reported back to the popup ("Outlined checkbox in blue"). */
  name: string;
}
const ROW_OUTLINE_COLOR: OutlineColor = { css: '#e11d48', name: 'red' };
const CONTROL_OUTLINE_COLORS: Record<ControlKind, OutlineColor> = {
  checkbox: { css: '#2563eb', name: 'blue' },
  menuButton: { css: '#f59e0b', name: 'orange' },
  viewButton: { css: '#16a34a', name: 'green' },
  audienceIndicator: { css: '#9333ea', name: 'purple' },
};
const TOOLBAR_OUTLINE_COLORS: Record<BulkActionKind, OutlineColor> = {
  archive: { css: '#0891b2', name: 'teal' },
  trash: { css: '#dc2626', name: 'red' },
  changeAudience: { css: '#9333ea', name: 'purple' },
};
const TOOLBAR_ACTION_NAMES: Record<BulkActionKind, string> = {
  archive: 'Archive button',
  trash: 'Trash button',
  changeAudience: 'Change audience button',
};
const CONTROL_NAMES: Record<ControlKind, string> = {
  checkbox: 'checkbox',
  menuButton: 'more/options button',
  viewButton: 'View button',
  audienceIndicator: 'audience indicator',
};
const STALE_SCAN = 'Scan is stale. Please scan again.';

/**
 * The exact elements the latest scan was built from (each row, and the controls discovered
 * inside it), so the popup can ask us to highlight one, or V1A to select one's checkbox,
 * without re-finding it. Only the latest scan is kept: a newer scan, an in-page navigation,
 * or a reload (which drops this script entirely) makes older scanSessionIds stale.
 */
interface SessionItem extends fba.ActionableItem {
  controls: Partial<Record<ControlKind, Element>>;
}
interface ScanSession extends fba.ActionableSession {
  items: SessionItem[];
  byId: Map<string, SessionItem>;
}
let session: ScanSession | null = null;

function truncate(s: string, n = MAX_VALUE_LENGTH): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function gatherEvidence(item: Element): { evidence: AudienceEvidence[]; labelsSeen: LabelSeen[]; visibleLabels: string[] } {
  const evidence: AudienceEvidence[] = [];
  const labelsSeen = new Map<string, LabelSeen>();
  const visibleLabels = new Set<string>();

  const consider = (c: fb.RawCandidate) => {
    const cls = fb.classifyLabel(c.value);
    if (!cls) return;
    evidence.push({
      source: c.source,
      strength: c.strength,
      rawValue: truncate(c.value),
      phrase: cls.phrase,
      matched: cls.audience,
      recognized: cls.recognized,
      rule: cls.rule,
      element: fb.describeElement(c.element),
      used: false,
    });
  };

  for (const c of fb.collectLabelCandidates(item)) {
    const value = truncate(c.value);
    if (labelsSeen.size < MAX_LABELS_PER_ITEM) labelsSeen.set(`${c.source}:${value}`, { source: c.source, value });
    consider(c);
  }
  for (const c of fb.collectTextCandidates(item)) {
    if (visibleLabels.size < MAX_VISIBLE_LABELS_PER_ITEM) visibleLabels.add(truncate(c.value));
    consider(c);
  }

  return { evidence, labelsSeen: [...labelsSeen.values()], visibleLabels: [...visibleLabels] };
}

/**
 * Decision rules, deliberately conservative (a later milestone will act on ONLY_ME):
 *  1. Use strong evidence (labels) if any matched; otherwise fall back to weak (text).
 *  2. If every piece of evidence in that tier agrees, that's the audience.
 *  3. If they disagree, the item is UNKNOWN.
 */
function decide(evidence: AudienceEvidence[]): { audience: Audience; basis: AudienceBasis; reason: string } {
  const matched = evidence.filter((e) => e.matched !== null);

  if (matched.length === 0) {
    const basis = 'none';
    const unmapped = evidence.find((e) => e.matched === null && e.recognized);
    if (unmapped) return { audience: 'UNKNOWN', basis, reason: `Audience "${unmapped.phrase}" is recognised but not mapped to ONLY_ME/FRIENDS/PUBLIC.` };
    const nearMiss = evidence.find((e) => !e.recognized);
    if (nearMiss) return { audience: 'UNKNOWN', basis, reason: `Found an audience-like label ("${nearMiss.rawValue}") but "${nearMiss.phrase}" is not in AUDIENCE_PHRASES.` };
    return { audience: 'UNKNOWN', basis, reason: 'No audience label, tooltip or text found inside this item.' };
  }

  const strong = matched.filter((e) => e.strength === 'strong');
  const tier = strong.length > 0 ? strong : matched;
  const basis = strong.length > 0 ? 'strong' : 'weak';
  const tierName = strong.length > 0 ? 'strong (label)' : 'weak (visible text only)';
  const distinct = [...new Set(tier.map((e) => e.matched as Audience))];

  if (distinct.length === 1) {
    tier.forEach((e) => (e.used = true));
    const first = tier[0];
    return {
      audience: distinct[0],
      basis,
      reason: `${tier.length} ${tierName} indicator(s) agree on ${distinct[0]}; e.g. ${first.source} "${first.rawValue}".`,
    };
  }

  return {
    audience: 'UNKNOWN',
    basis,
    reason: `Conflicting ${tierName} indicators: ${distinct.join(' vs ')}. Treated as UNKNOWN to be safe.`,
  };
}

/** The same classification the scan does, for one row. facebookActions.ts re-checks a row with it just before acting. */
function classifyRow(row: Element): { audience: Audience; basis: AudienceBasis } {
  const { audience, basis } = decide(gatherEvidence(row).evidence);
  return { audience, basis };
}

function itemIdFor(index: number): string {
  return `item-${index}`;
}

function classifyItem(item: Element, index: number, dayHeadings: Element[]): Omit<ScannedItem, 'controls'> {
  const { evidence, labelsSeen, visibleLabels } = gatherEvidence(item);
  const { audience, basis, reason } = decide(evidence);
  return {
    index,
    itemId: itemIdFor(index),
    audience,
    reason,
    audienceBasis: basis,
    date: fb.getItemDate(item, dayHeadings),
    preview: fb.getItemPreview(item),
    permalink: fb.getItemPermalink(item),
    container: fb.describeElement(item),
    evidence,
    labelsSeen,
    visibleLabels,
  };
}

/**
 * Control discovery for every row. Runs after, and independently of, classification: a
 * failure here is reported in the row's controls and never changes its audience.
 */
function discoverControls(containers: Element[], warnings: string[]): fbc.DiscoveredRowControls[] {
  let failures = 0;
  const found = containers.map((row, i) => {
    try {
      return fbc.discoverRowControls(row, itemIdFor(i));
    } catch (e) {
      failures++;
      return fbc.failedRowControls(`Control discovery threw: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  if (failures > 0) warnings.push(`Control discovery failed for ${failures} row(s); see each item's controls.`);
  const released = fbc.releaseSharedControls(found.map((f, i) => ({ itemId: itemIdFor(i), found: f })));
  if (released > 0) warnings.push(`${released} control(s) were found in more than one row and were un-assigned.`);
  return found;
}

function buildInventory(root: Element): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const v of fb.collectLabelInventory(root)) {
    const key = truncate(v, 80);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, MAX_INVENTORY);
}

/**
 * Splits the page into rows: every strategy runs, then the forced one, or in auto mode the primary
 * strategy with the most rows, is used. Read-only. The scan and V3A's row counting share it.
 */
function pickRows(
  root: Element,
  warnings: string[],
  forcedStrategy?: string,
): { strategy: string | null; strategyWasForced: boolean; attempts: StrategyAttempt[]; containers: Element[] } {
  const attempts: StrategyAttempt[] = [];
  const found = new Map<string, Element[]>();
  for (const s of fb.ITEM_STRATEGIES) {
    let candidates: Element[] = [];
    try {
      candidates = s.find(root);
    } catch (e) {
      warnings.push(`Strategy ${s.id} threw: ${String(e)}`);
    }
    const rejected: RejectedCandidate[] = [];
    const els = candidates.filter((el) => {
      const reason = s.rejectNonItem?.(el) ?? null;
      if (reason) rejected.push({ reason, preview: fb.getItemPreview(el, 80), container: fb.describeElement(el) });
      return !reason;
    });
    found.set(s.id, els);
    attempts.push({ id: s.id, description: s.description, candidates: candidates.length, rejected, count: els.length });
  }

  // Auto mode: the primary strategy that finds the most items wins (ties -> earlier in
  // ITEM_STRATEGIES). Fallback strategies are only considered if no primary one found anything.
  let strategy: string | null = null;
  const strategyWasForced = !!forcedStrategy && found.has(forcedStrategy);
  if (strategyWasForced) {
    strategy = forcedStrategy!;
  } else {
    if (forcedStrategy) warnings.push(`Unknown strategy "${forcedStrategy}", using auto.`);
    for (const useFallbacks of [false, true]) {
      let best = 0;
      for (const s of fb.ITEM_STRATEGIES) {
        const count = found.get(s.id)!.length;
        if (!!s.fallback === useFallbacks && count > best) (best = count), (strategy = s.id);
      }
      if (strategy) break;
    }
  }
  if (strategy && fb.ITEM_STRATEGIES.find((s) => s.id === strategy)?.fallback) {
    warnings.push(`Using fallback strategy "${strategy}": rows without an audience icon are not counted.`);
  }

  const containers = strategy ? fb.sortInDocumentOrder(found.get(strategy)!) : [];
  return { strategy, strategyWasForced, attempts, containers };
}

function runScan(forcedStrategy?: string): ScanResult {
  const started = performance.now();
  const warnings: string[] = [];
  const url = location.href;
  const pageKind = fb.isActivityLogUrl(url) ? 'ACTIVITY_LOG' : 'OTHER_FACEBOOK';
  if (pageKind !== 'ACTIVITY_LOG') {
    warnings.push('This is not the Activity Log. Results may include other people\'s posts or miss yours.');
  }

  const { root, description: rootDescription } = fb.getScanRoot(document);
  const { strategy, strategyWasForced, attempts, containers } = pickRows(root, warnings, forcedStrategy);
  if (containers.length === 0) {
    warnings.push('No items found. Make sure posts are visible on the page (scroll a bit) and try again.');
  }

  const dayHeadings = fb.findDayHeadings(root, containers);
  const classified = containers.map((el, i) => classifyItem(el, i, dayHeadings));
  const controls = discoverControls(containers, warnings);
  const items: ScannedItem[] = classified.map((it, i) => ({ ...it, controls: controls[i].result }));
  // Only used to verify that selecting one post never selects everything; never clicked.
  const master = fbc.discoverMasterCheckbox(document.body, containers);

  clearHighlight(); // the previous session's highlight may still be showing
  // A Trash waiting for confirmation belongs to the old scan. Facebook's dialog, if open, is left alone.
  fbta.discardPending('a new scan started');
  const sessionItems: SessionItem[] = items.map((it, i) => ({
    itemId: it.itemId,
    row: containers[i] as HTMLElement,
    controls: controls[i].elements,
    checkbox: controls[i].elements.checkbox,
    audience: it.audience,
    audienceBasis: it.audienceBasis,
    checkboxConfidence: it.controls.checkbox.confidence,
    checkboxAmbiguous: it.controls.checkbox.ambiguousCandidates > 0,
    permalink: it.controls.permalink.href,
    postUrls: fbc.postUrlsIn(containers[i]),
  }));
  session = {
    id: crypto.randomUUID(),
    url,
    items: sessionItems,
    byId: new Map(sessionItems.map((it) => [it.itemId, it])),
    masterCheckbox: master.element,
    masterNote: `Master select-all checkbox: ${master.note}`,
  };
  const counts: AudienceCounts = { ONLY_ME: 0, FRIENDS: 0, PUBLIC: 0, UNKNOWN: 0 };
  for (const it of items) counts[it.audience]++;

  return {
    protocol: SCANNER_PROTOCOL,
    scanSessionId: session.id,
    url,
    pageKind,
    scannedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
    root: rootDescription,
    strategy,
    strategyWasForced,
    attempts,
    total: items.length,
    counts,
    items,
    labelInventory: buildInventory(root),
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Highlight (debug only): a temporary overlay box drawn above the page, nothing else
// ---------------------------------------------------------------------------

/**
 * The highlight is our own fixed-position <div> on top of everything, sized from the target's
 * bounding box. Unlike a CSS outline on the target it can't be clipped by an overflow:hidden
 * ancestor or clip-path, covered by a sibling layer, or hidden by the target's opacity, and it
 * never touches Facebook's elements: nothing is styled, focused or clicked.
 */
interface ActiveHighlight {
  overlays: HTMLDivElement[];
  timer: number;
  frame: number;
}
let active: ActiveHighlight | null = null;

/** A box smaller than this in either direction is treated as not drawn (e.g. a clipped 1×1 input). */
const MIN_VISUAL_PX = 4;
/** An ancestor larger than this is a layout container, not the drawn control. */
const MAX_CONTROL_BOX_PX = 96;

function clearHighlight(): void {
  if (!active) return;
  clearTimeout(active.timer);
  cancelAnimationFrame(active.frame);
  for (const o of active.overlays) o.remove();
  active = null;
}

function isInViewport(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.top < window.innerHeight;
}

function sizeOf(r: DOMRect): string {
  return `${Math.round(r.width)}x${Math.round(r.height)}`;
}

function hasUsefulSize(r: DOMRect): boolean {
  return r.width >= MIN_VISUAL_PX && r.height >= MIN_VISUAL_PX;
}

/**
 * The element whose box stands for the control on screen. Only used for its rectangle.
 * Normally the exact scanned element; if that has no usable box, the nearest rendered,
 * control-sized ancestor inside the row; failing that, the row itself.
 */
function visualBox(el: Element, row: Element): { box: Element; how: string } {
  if (hasUsefulSize(el.getBoundingClientRect())) return { box: el, how: 'the stored element itself' };
  let levels = 0;
  for (let e = el.parentElement; e && e !== row && row.contains(e); e = e.parentElement) {
    levels++;
    if (e.getClientRects().length === 0) continue; // display:none or display:contents
    const r = e.getBoundingClientRect();
    if (!hasUsefulSize(r)) continue;
    if (r.width > MAX_CONTROL_BOX_PX || r.height > MAX_CONTROL_BOX_PX) break; // ancestors only get bigger from here
    const where = levels === 1 ? 'parent' : `ancestor ${levels} levels up,`;
    return { box: e, how: `${where} ${fb.describeElement(e)}` };
  }
  return { box: row, how: `whole row: no ancestor up to ${MAX_CONTROL_BOX_PX}px has a usable box` };
}

/** Read-only notes on what could hide an outline drawn on el itself; shown in the debug panel. */
function paintNotes(el: Element, row: Element): string {
  const notes: string[] = [];
  const cs = getComputedStyle(el);
  if (Number(cs.opacity) < 1) notes.push(`opacity ${cs.opacity}`);
  if (cs.visibility !== 'visible') notes.push(`visibility ${cs.visibility}`);
  if (cs.clipPath && cs.clipPath !== 'none') notes.push(`clip-path ${cs.clipPath}`);
  for (let a = el.parentElement; a && a !== row && row.contains(a); a = a.parentElement) {
    const s = getComputedStyle(a);
    if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
    notes.push(`nearest overflow-clipping ancestor is ${a.localName} ${sizeOf(a.getBoundingClientRect())}`);
    break;
  }
  const r = el.getBoundingClientRect();
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  if (top && top !== el && !el.contains(top)) notes.push(`covered at its centre by ${top.localName}`);
  return notes.length ? notes.join('; ') : 'nothing unusual found';
}

interface OverlaySpec {
  box: Element;
  color: OutlineColor;
  isRow: boolean;
}

function drawOverlay(box: Element, color: OutlineColor, isRow: boolean): void {
  drawOverlays([{ box, color, isRow }]);
}

/** One overlay box per spec, all following their elements until the shared timer ends. */
function drawOverlays(specs: OverlaySpec[]): void {
  const placed = specs.map(({ box, color, isRow }) => {
    const overlay = document.createElement('div');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.dataset.fpcHighlight = '';
    const border = isRow ? 4 : 3;
    // Rows: drawn on the row's edge. Controls are small, so their box goes just outside them.
    const pad = isRow ? 0 : border + 2;
    const fixed: [string, string][] = [
      ['position', 'fixed'],
      ['box-sizing', 'border-box'],
      ['margin', '0'],
      ['padding', '0'],
      ['border', `${border}px solid ${color.css}`],
      ['border-radius', isRow ? '0' : '4px'],
      ['background', 'transparent'],
      ['pointer-events', 'none'],
      ['z-index', '2147483647'],
    ];
    for (const [k, v] of fixed) overlay.style.setProperty(k, v, 'important');
    // Outside <body>, so it is never part of Facebook's React tree.
    document.documentElement.appendChild(overlay);
    return { overlay, box, pad };
  });

  // Follow the boxes every frame: the scroll into view (and any later scroll) moves them.
  const mine = placed.map((p) => p.overlay);
  const place = () => {
    if (!active || active.overlays !== mine) return;
    if (placed.some((p) => !p.box.isConnected)) return clearHighlight();
    for (const { overlay, box, pad } of placed) {
      const r = box.getBoundingClientRect();
      overlay.style.setProperty('left', `${r.left - pad}px`, 'important');
      overlay.style.setProperty('top', `${r.top - pad}px`, 'important');
      overlay.style.setProperty('width', `${r.width + 2 * pad}px`, 'important');
      overlay.style.setProperty('height', `${r.height + 2 * pad}px`, 'important');
    }
    active.frame = requestAnimationFrame(place);
  };
  active = { overlays: mine, timer: window.setTimeout(clearHighlight, HIGHLIGHT_MS), frame: 0 };
  place();
}

function highlight(scanSessionId: string, itemId: string, control?: ControlKind): HighlightResponse {
  if (!session || session.id !== scanSessionId) return { ok: false, error: STALE_SCAN };
  if (location.href !== session.url) return { ok: false, error: `The page has navigated since the scan. ${STALE_SCAN}` };
  const entry = session.byId.get(itemId);
  if (!entry) return { ok: false, error: STALE_SCAN };
  const { row } = entry;
  if (!row.isConnected) {
    return { ok: false, error: `That row is no longer on the page (Facebook re-rendered it). ${STALE_SCAN}` };
  }

  let box: Element = row;
  let outlined = 'row';
  let color = ROW_OUTLINE_COLOR;
  const details: string[] = [];
  if (control !== undefined) {
    if (!CONTROL_KINDS.includes(control)) return { ok: false, error: `Unknown control "${String(control)}".` };
    const el = entry.controls[control];
    const name = CONTROL_NAMES[control];
    if (!el) return { ok: false, error: `No ${name} was discovered in this row during the scan.` };
    // The exact element from the scan, and it must still sit inside the exact row from the scan.
    if (!el.isConnected || el === row || !row.contains(el)) {
      return { ok: false, error: `That ${name} is no longer in its row (Facebook re-rendered it). ${STALE_SCAN}` };
    }
    const v = visualBox(el, row);
    box = v.box;
    outlined =
      box === row ? `whole row, because the ${name} and its containers have no usable box` :
      box !== el ? `${name}'s nearest control-sized container, because the control itself has no usable box` :
      name;
    color = CONTROL_OUTLINE_COLORS[control];
    details.push(
      `Stored element: ${fb.describeElement(el)}`,
      `Stored element rect: ${sizeOf(el.getBoundingClientRect())}`,
      `Stored element paint: ${paintNotes(el, row)}`,
      `Visual highlight element: ${v.how}`,
    );
  }

  // One highlight at a time; a repeat click restarts the timer.
  clearHighlight();
  // Scrolling only moves the viewport; nothing on the page is clicked or changed.
  if (!isInViewport(box)) box.scrollIntoView({ block: 'center', behavior: 'smooth' });
  details.push(`Visual rect: ${sizeOf(box.getBoundingClientRect())}`);
  drawOverlay(box, color, box === row);
  return { ok: true, outlined: `${outlined} in ${color.name}`, details };
}

// ---------------------------------------------------------------------------
// V1B bulk toolbar (discovery and highlight only; read-only)
// ---------------------------------------------------------------------------

function currentSession(scanSessionId: string): ScanSession | string {
  if (!session || session.id !== scanSessionId) return STALE_SCAN;
  if (location.href !== session.url) return `The page has navigated since the scan. ${STALE_SCAN}`;
  return session;
}

/** Runs toolbar discovery now, against the current scan's connected rows and master checkbox. */
function discoverToolbar(s: ScanSession): fbt.ToolbarFound {
  return fbt.discoverBulkToolbar(
    s.items.map((it) => it.row).filter((r) => r.isConnected),
    s.masterCheckbox,
  );
}

function toolbarDiscovery(scanSessionId: string): ToolbarResponse {
  const s = currentSession(scanSessionId);
  if (typeof s === 'string') return { ok: false, error: s };
  return { ok: true, toolbar: discoverToolbar(s).discovery };
}

/** Outlines what toolbar discovery picks right now for one bulk action (the element V1B would click for Trash). */
function highlightToolbar(scanSessionId: string, action: BulkActionKind): HighlightResponse {
  const s = currentSession(scanSessionId);
  if (typeof s === 'string') return { ok: false, error: s };
  if (!BULK_ACTION_KINDS.includes(action)) return { ok: false, error: `Unknown toolbar action "${String(action)}".` };
  const found = discoverToolbar(s);
  const name = TOOLBAR_ACTION_NAMES[action];
  const el = found.elements[action];
  const d = found.discovery.actions[action];
  if (!found.toolbar) return { ok: false, error: `No bulk toolbar: ${found.discovery.reason}` };
  if (!el) return { ok: false, error: `No ${name} identified: ${d.reason}` };

  const v = visualBox(el, found.toolbar);
  const color = TOOLBAR_OUTLINE_COLORS[action];
  const details = [
    `Discovery: ${d.confidence ?? '?'}: ${d.reason}`,
    `Stored element: ${fb.describeElement(el)}`,
    `Stored element rect: ${sizeOf(el.getBoundingClientRect())}`,
    `Visual highlight element: ${v.how}`,
  ];
  clearHighlight();
  if (!isInViewport(v.box)) v.box.scrollIntoView({ block: 'center', behavior: 'smooth' });
  details.push(`Visual rect: ${sizeOf(v.box.getBoundingClientRect())}`);
  drawOverlay(v.box, color, v.box === found.toolbar);
  return { ok: true, outlined: `${v.box === found.toolbar ? `whole toolbar (the ${name} has no usable box)` : name} in ${color.name}`, details };
}

// ---------------------------------------------------------------------------
// V2A: outline the stored checkbox of each batch item at once (read-only)
// ---------------------------------------------------------------------------

function highlightBatch(scanSessionId: string, itemIds: unknown): HighlightResponse {
  const s = currentSession(scanSessionId);
  if (typeof s === 'string') return { ok: false, error: s };
  if (!Array.isArray(itemIds) || itemIds.length === 0 || !itemIds.every((id) => typeof id === 'string')) return { ok: false, error: 'No batch items given.' };
  if (itemIds.length > MAX_BATCH_SIZE) return { ok: false, error: `At most ${MAX_BATCH_SIZE} items can be highlighted at once.` };

  const specs: OverlaySpec[] = [];
  const details: string[] = [];
  for (const id of itemIds as string[]) {
    const entry = s.byId.get(id);
    const el = entry?.controls.checkbox;
    if (!entry || !entry.row.isConnected) {
      details.push(`${id}: row no longer on the page`);
      continue;
    }
    // The exact element from the scan, and it must still sit inside the exact row from the scan.
    if (!el || !el.isConnected || el === entry.row || !entry.row.contains(el)) {
      details.push(`${id}: no stored checkbox inside its row`);
      continue;
    }
    const v = visualBox(el, entry.row);
    specs.push({ box: v.box, color: CONTROL_OUTLINE_COLORS.checkbox, isRow: v.box === entry.row });
    details.push(`${id}: ${v.how}, ${sizeOf(v.box.getBoundingClientRect())}`);
  }
  if (specs.length === 0) return { ok: false, error: `None of the batch checkboxes could be outlined. ${details.join('; ')}` };

  clearHighlight();
  // One scroll, to the first target only, and only if it is off screen.
  if (!isInViewport(specs[0].box)) specs[0].box.scrollIntoView({ block: 'center', behavior: 'smooth' });
  drawOverlays(specs);
  return { ok: true, outlined: `${specs.length} of ${itemIds.length} batch checkbox(es) in ${CONTROL_OUTLINE_COLORS.checkbox.name}`, details };
}

// ---------------------------------------------------------------------------
// V3A: auto-load (only scrolls; see autoLoad.ts)
// ---------------------------------------------------------------------------

const autoLoadDeps: al.AutoLoadDeps = {
  countRows(strategy) {
    const { strategy: used, containers } = pickRows(fb.getScanRoot(document).root, [], strategy);
    return { strategy: used, rows: containers.length };
  },
  discardSession() {
    clearHighlight();
    fbta.discardPending('auto-load started'); // refused earlier if one was pending; kept as a safety net
    session = null; // every request naming the old scanSessionId is now STALE_SESSION
  },
};

chrome.runtime.onMessage.addListener((msg: ContentRequest, _sender, sendResponse) => {
  switch (msg?.type) {
    case 'FPC_CHECKBOX_ACTION':
      clearHighlight(); // our own debug overlay must not be on the page while acting
      fba
        .performCheckboxAction(session, msg.request, { classify: classifyRow })
        .then(sendResponse, (e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
      return true; // async response
    case 'FPC_TRASH':
      clearHighlight(); // our own debug overlay must not be on the page while acting
      fbta
        .performTrashStep(session, msg.request, { classify: classifyRow })
        .then(sendResponse, (e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
      return true; // async response
    case 'FPC_BATCH':
      clearHighlight(); // our own debug overlay must not be on the page while acting
      fbb
        .performBatchStep(session, msg.request, { classify: classifyRow })
        .then(sendResponse, (e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
      return true; // async response
    case 'FPC_BATCH_HIGHLIGHT':
      sendResponse(highlightBatch(msg.scanSessionId, msg.itemIds));
      break;
    case 'FPC_TOOLBAR_DISCOVER':
      try {
        sendResponse(toolbarDiscovery(msg.scanSessionId));
      } catch (e) {
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
      break;
    case 'FPC_TOOLBAR_HIGHLIGHT':
      sendResponse(highlightToolbar(msg.scanSessionId, msg.action));
      break;
    case 'FPC_ACTION_STATE':
      sendResponse({ ok: true, state: fba.getActionState() } satisfies ActionStateResponse);
      break;
    case 'FPC_PING':
      sendResponse({ ok: true });
      break;
    case 'FPC_AUTOLOAD_START':
      sendResponse(al.startAutoLoad(msg.request, autoLoadDeps));
      break;
    case 'FPC_AUTOLOAD_STOP':
      sendResponse(al.stopAutoLoad(msg.runId));
      break;
    case 'FPC_SCAN': {
      // Loading and scanning are separate phases: no scan while the list is still being loaded.
      const loading = fba.autoLoadBlock();
      if (loading) {
        sendResponse({ ok: false, error: loading });
        break;
      }
      // A new scan would replace the session an active batch works on (and could hide its selection).
      const batchState = fba.activeBatchState();
      if (batchState) {
        sendResponse({ ok: false, error: `A cleanup batch is in progress (${batchState}). Finish or cancel it before scanning again (or reload the Facebook tab).` });
        break;
      }
      try {
        sendResponse({ ok: true, result: runScan(msg.strategy) });
      } catch (e) {
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
      break;
    }
    case 'FPC_HIGHLIGHT':
      sendResponse(highlight(msg.scanSessionId, msg.itemId, msg.control));
      break;
  }
});
