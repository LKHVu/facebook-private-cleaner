/**
 * facebookControls.ts
 *
 * V0.5 control discovery. Given one Activity Log row that the scanner has already mapped
 * to an exact DOM element, find the controls that belong to THAT row: its selection
 * checkbox, its "..." menu button, its "View" button, its audience indicator and its
 * permalink. Like facebookSelectors.ts, this file holds Facebook-specific knowledge and is
 * the place to edit when Facebook changes its markup.
 *
 * Rules:
 *  - Everything is searched for inside the mapped row element. Posts are never re-found by text.
 *  - No generated CSS class names. Structural and accessibility signals (role, aria-*,
 *    input semantics, href patterns) come first; words are used only as supporting evidence,
 *    or where Facebook offers nothing else (the "View" button).
 *  - When several candidates match equally well, report the ambiguity instead of choosing one.
 *
 * Strictly read-only: this module reads attributes, text and layout boxes. It never clicks,
 * focuses, opens menus or dispatches events.
 */

import type {
  CheckState,
  Confidence,
  ControlDiscovery,
  ControlKind,
  InteractiveElementInfo,
  PermalinkDiscovery,
  RowControls,
} from '../shared/types';
import { CONTROL_KINDS } from '../shared/types';
import {
  LABEL_ATTRIBUTES,
  LABEL_ATTRIBUTE_SELECTOR,
  PERMALINK_RE,
  ROW_MENU_LABEL_RE,
  SELECT_ALL_PHRASES,
  classifyLabel,
  collectTextCandidates,
  describeElement,
  isBulkSelectionRow,
  normalizeLabel,
  outermost,
} from './facebookSelectors';

// ---------------------------------------------------------------------------
// Vocabulary and selectors
// ---------------------------------------------------------------------------

/**
 * Accessible-name prefixes of the per-row "..." button (lower-case, NFC). Supporting evidence
 * only: the primary signal is aria-haspopup, which does not depend on the UI language.
 * ROW_MENU_LABEL_RE from facebookSelectors.ts is checked as well.
 */
export const MENU_LABEL_PREFIXES: string[] = [
  'action options',
  'actions for',
  'more options',
  'more actions',
  'options',
  'tùy chọn',
  'thêm tùy chọn',
  'lựa chọn khác', // live: "Lựa chọn khác cho <name> đã chia sẻ một bài viết."
  'xem thêm tùy chọn',
  'hành động',
  'thao tác',
  'opciones',
  'más opciones',
  'plus d’options',
  "plus d'options",
  'options d’action',
  "options d'action",
  'weitere optionen',
  'aktionen',
];

/** Whole accessible names of the per-row "View" button (lower-case, NFC). */
export const VIEW_PHRASES: string[] = [
  'view',
  'view post',
  'xem',
  'xem bài viết',
  'ver',
  'ver publicación',
  'voir',
  'voir la publication',
  'ansehen',
  'anzeigen',
];

export const CHECKBOX_SELECTOR = 'input[type="checkbox"], [role="checkbox"]';
const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="menuitem"]',
  '[role="combobox"]',
  '[aria-haspopup]',
].join(', ');
/** Facebook draws icons as <svg>, <img>, or <i> with a CSS background image. */
const ICON_SELECTOR = 'svg, img, i, [data-visualcompletion="css-img"]';
/** aria-haspopup values that mean "opens a menu". "listbox" etc. are reported but not trusted. */
const MENU_POPUP_VALUES = new Set(['menu', 'true']);
/**
 * aria-haspopup values that make an icon-only button a strong "..." candidate. Facebook's live
 * Activity Log "..." button uses "dialog". Only trusted together with no meaningful visible text.
 */
const STRONG_MENU_POPUP_VALUES = new Set(['menu', 'true', 'dialog']);

/** A "..." or "View" button has at most this much text of its own; larger clickable areas are not buttons. */
const MAX_BUTTON_TEXT = 40;
const MAX_NAME = 80;
const MAX_INTERACTIVE_REPORTED = 40;
const MAX_CANDIDATES_REPORTED = 6;

// ---------------------------------------------------------------------------
// Element helpers
// ---------------------------------------------------------------------------

function clip(s: string, n = MAX_NAME): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** The element's own text, ignoring icons and scripts, whitespace-collapsed. */
export function textOf(el: Element): string {
  const parts: string[] = [];
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.parentElement?.closest('svg, script, style')) continue;
    const t = n.textContent?.trim();
    if (t) parts.push(t);
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export interface AccessibleName {
  name: string;
  /** aria-labelledby, aria-label, label, text, title, svg-title, img-alt or none. */
  source: string;
}

/** A simplified accessible-name computation: good enough to tell Facebook's controls apart. */
export function accessibleName(el: Element): AccessibleName {
  const ids = el.getAttribute('aria-labelledby')?.trim();
  if (ids) {
    const t = ids
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (t) return { name: clip(t), source: 'aria-labelledby' };
  }
  const aria = el.getAttribute('aria-label')?.trim();
  if (aria) return { name: clip(aria), source: 'aria-label' };
  if (el instanceof HTMLInputElement && el.labels && el.labels.length > 0) {
    const t = [...el.labels].map(textOf).join(' ').trim();
    if (t) return { name: clip(t), source: 'label' };
  }
  const text = textOf(el);
  if (text) return { name: clip(text), source: 'text' };
  const title = el.getAttribute('title')?.trim();
  if (title) return { name: clip(title), source: 'title' };
  const svgTitle = el.querySelector('svg title')?.textContent?.trim();
  if (svgTitle) return { name: clip(svgTitle), source: 'svg-title' };
  const alt = el.querySelector('img[alt]')?.getAttribute('alt')?.trim();
  if (alt) return { name: clip(alt), source: 'img-alt' };
  return { name: '', source: 'none' };
}

/** false for display:none (and anything else without a layout box). Opacity-0 inputs still count. */
export function isRendered(el: Element): boolean {
  return el.getClientRects().length > 0;
}

function popupValue(el: Element): string | null {
  const v = el.getAttribute('aria-haspopup')?.trim().toLowerCase();
  return v && v !== 'false' ? v : null;
}

function isButtonLike(el: Element): boolean {
  return el.localName === 'button' || el.getAttribute('role') === 'button' || popupValue(el) !== null;
}

function isLinkLike(el: Element): boolean {
  return (el.localName === 'a' && el.hasAttribute('href')) || el.getAttribute('role') === 'link';
}

function isIconOnly(el: Element): boolean {
  return textOf(el) === '' && el.querySelector(ICON_SELECTOR) !== null;
}

export function isCheckboxLike(el: Element): boolean {
  return el.matches(CHECKBOX_SELECTOR) || el.querySelector(CHECKBOX_SELECTOR) !== null;
}

/** Path + query of a link, for display. */
function shortHref(el: Element): string | null {
  if (!(el instanceof HTMLAnchorElement) || !el.href) return null;
  try {
    const u = new URL(el.href);
    return clip(`${u.pathname}${u.search}`, 70);
  } catch {
    return clip(el.href, 70);
  }
}

function isPostHref(el: Element): boolean {
  return el instanceof HTMLAnchorElement && !!el.href && PERMALINK_RE.test(el.href);
}

/** Every distinct (normalised) post URL linked from inside `scope`, uncapped. Read-only; used by batch verification. */
export function postUrlsIn(scope: Element): string[] {
  return [...new Set([...scope.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(isPostHref).map((a) => normalizePostUrl(a.href)))];
}

/** Drops Facebook's tracking parameters (__cft__, __tn__ …) and the hash, so equal posts compare equal. */
export function normalizePostUrl(href: string): string {
  try {
    const u = new URL(href);
    for (const key of [...u.searchParams.keys()]) if (key.startsWith('__')) u.searchParams.delete(key);
    u.hash = '';
    return u.toString();
  } catch {
    return href;
  }
}

/** Every signal control discovery can read off an element; shown in the debug panel. */
export function elementSignals(el: Element): string[] {
  const s: string[] = [];
  const popup = popupValue(el);
  if (popup) s.push(`aria-haspopup=${popup}`);
  for (const attr of ['aria-expanded', 'aria-checked', 'aria-pressed', 'aria-disabled']) {
    const v = el.getAttribute(attr);
    if (v !== null) s.push(`${attr}=${v}`);
  }
  if (el instanceof HTMLInputElement) {
    s.push(`input[type=${el.type}]`);
    if (el.type === 'checkbox') s.push(`checked=${el.checked}`); // reads the property; nothing is toggled
    if (el.disabled) s.push('disabled');
  }
  if (isIconOnly(el)) s.push('icon-only');
  const href = shortHref(el);
  if (href) s.push(`href=${href}${isPostHref(el) ? ' (post URL)' : ''}`);
  if (!isRendered(el)) s.push('not rendered');
  if (el.closest('[aria-hidden="true"]')) s.push('inside aria-hidden');
  return s;
}

// ---------------------------------------------------------------------------
// Checkbox state (read-only; used by V1A/V1B verification and the toolbar's selection count)
// ---------------------------------------------------------------------------

export interface StateReading {
  state: CheckState;
  /** e.g. "aria-checked=false, native input unchecked". */
  detail: string;
}

function ariaState(el: Element): CheckState | null {
  switch (el.getAttribute('aria-checked')) {
    case 'true': return 'checked';
    case 'false': return 'unchecked';
    case 'mixed': return 'mixed';
    default: return null;
  }
}

/**
 * A native input reports .checked / .indeterminate; a [role=checkbox] reports aria-checked.
 * When an element has both (a role=checkbox wrapping one native input), they must agree.
 */
export function readCheckState(el: Element | null | undefined): StateReading {
  if (!el || !el.isConnected) return { state: 'missing', detail: 'not connected to the page' };
  const aria = ariaState(el);
  const inputs = el instanceof HTMLInputElement ? [el] : [...el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  if (inputs.length > 1) return { state: 'unknown', detail: `${inputs.length} native checkbox inputs inside one control` };
  const input = inputs[0];
  const native: CheckState | null = input ? (input.indeterminate ? 'mixed' : input.checked ? 'checked' : 'unchecked') : null;
  const parts = [aria ? `aria-checked=${el.getAttribute('aria-checked')}` : null, native ? `native input ${native}` : null].filter(Boolean);
  const detail = parts.join(', ') || 'no aria-checked and no native input';
  if (aria && native && aria !== native) return { state: 'unknown', detail: `states disagree: ${detail}` };
  return { state: aria ?? native ?? 'unknown', detail };
}

// ---------------------------------------------------------------------------
// Result builders
// ---------------------------------------------------------------------------

export interface Candidate {
  el: Element;
  name: AccessibleName;
  signals: string[];
}

export function toCandidate(el: Element, extra: string[] = []): Candidate {
  return { el, name: accessibleName(el), signals: [...extra, ...elementSignals(el)] };
}

export function describeCandidate(c: Candidate): string {
  const name = c.name.name ? ` name="${c.name.name}" (${c.name.source})` : ' (no accessible name)';
  const signals = c.signals.length ? ` [${c.signals.join(', ')}]` : '';
  return `${describeElement(c.el)}${name}${signals}`;
}

export interface ControlPick {
  discovery: ControlDiscovery;
  element: Element | null;
}

export function missing(reason: string, candidates: Candidate[] = [], signals: string[] = []): ControlPick {
  return {
    element: null,
    discovery: {
      found: false,
      confidence: null,
      reason,
      controlId: null,
      element: null,
      signals,
      candidates: candidates.length,
      ambiguousCandidates: 0,
      candidateDescriptions: candidates.slice(0, MAX_CANDIDATES_REPORTED).map(describeCandidate),
    },
  };
}

export function ambiguous(reason: string, candidates: Candidate[], signals: string[] = []): ControlPick {
  const p = missing(`Ambiguous: ${reason} None was chosen.`, candidates, signals);
  p.discovery.ambiguousCandidates = candidates.length;
  return p;
}

export function chosen(
  itemId: string,
  kind: string,
  c: Candidate,
  confidence: Confidence,
  reason: string,
  candidates: Candidate[],
): ControlPick {
  const name = c.name.name ? [`name "${c.name.name}" from ${c.name.source}`] : ['no accessible name'];
  return {
    element: c.el,
    discovery: {
      found: true,
      confidence,
      reason,
      controlId: `${itemId}:${kind}`,
      element: describeElement(c.el),
      signals: [...name, ...c.signals],
      candidates: candidates.length,
      ambiguousCandidates: 0,
      candidateDescriptions: candidates.slice(0, MAX_CANDIDATES_REPORTED).map(describeCandidate),
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Selection checkbox
// ---------------------------------------------------------------------------

function discoverCheckbox(row: Element, itemId: string): ControlPick {
  const bulk = isBulkSelectionRow(row);
  if (bulk) return missing(`Refusing: this row looks like the bulk-selection toolbar. ${bulk}`);

  // Explicit containment check: only elements strictly inside the mapped row.
  const inside = [...row.querySelectorAll(CHECKBOX_SELECTOR)].filter((el) => el !== row && row.contains(el));
  const rendered = inside.filter(isRendered);
  const hidden = inside.length - rendered.length;
  const hiddenNote = hidden > 0 ? ` (${hidden} not-rendered checkbox element(s) ignored)` : '';

  // A native input nested in a [role=checkbox] (or the reverse) is one control: keep the outer element.
  const candidates = outermost(rendered).map((el) => {
    const extra: string[] = [];
    if (el.localName !== 'input' && el.querySelector('input[type="checkbox"]')) extra.push('wraps a native checkbox input');
    return toCandidate(el, extra);
  });

  // The master "Tất cả" checkbox must never be returned. If this row contains it (rendered or
  // not), the row itself is suspect, so no checkbox is returned at all.
  const selectAll = inside.map((el) => accessibleName(el).name).find((n) => SELECT_ALL_PHRASES.includes(normalizeLabel(n)));
  if (selectAll !== undefined) {
    return missing(
      `Refusing: this row contains a checkbox named like the master select-all ("${selectAll}"), so the row may span the toolbar.`,
      candidates,
    );
  }

  if (candidates.length === 0) {
    return missing(`No rendered input[type=checkbox] or [role=checkbox] inside this row${hiddenNote}. Is the Activity Log in manage mode?`);
  }
  if (candidates.length > 1) {
    return ambiguous(`${candidates.length} separate checkboxes inside this row${hiddenNote}.`, candidates);
  }

  const c = candidates[0];
  const isNative = c.el instanceof HTMLInputElement;
  const hasState = isNative || c.el.hasAttribute('aria-checked');
  return chosen(
    itemId,
    'checkbox',
    c,
    hasState ? 'HIGH' : 'MEDIUM',
    `The only rendered checkbox inside the mapped row (${isNative ? 'native input[type=checkbox]' : 'role=checkbox'}` +
      `${hasState ? ' with checked state' : ', but no aria-checked'}); contained in the row and not named like select-all${hiddenNote}.`,
    candidates,
  );
}

// ---------------------------------------------------------------------------
// 2. Audience indicator
// ---------------------------------------------------------------------------

/** The strongest audience label on el itself (attribute, aria-labelledby or <svg><title>), or null. */
function ownAudienceLabel(el: Element): { source: string; value: string; audience: string } | null {
  const tryValue = (source: string, raw: string | null | undefined) => {
    const v = raw?.trim();
    if (!v) return null;
    const cls = classifyLabel(v);
    return cls?.recognized ? { source, value: clip(v), audience: cls.audience ?? `unmapped "${cls.phrase}"` } : null;
  };
  if (el.localName === 'title') return tryValue('svg-title', el.textContent);
  for (const { attr } of LABEL_ATTRIBUTES) {
    const hit = tryValue(attr, el.getAttribute(attr));
    if (hit) return hit;
  }
  const ids = el.getAttribute('aria-labelledby');
  if (ids) {
    const text = ids
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? '')
      .join(' ');
    return tryValue('aria-labelledby', text);
  }
  return null;
}

function audienceSignals(row: Element, el: Element, label: { source: string; value: string; audience: string }): string[] {
  const s = [`${label.source}="${label.value}" → ${label.audience}`];
  const interactive = el.closest(INTERACTIVE_SELECTOR) ?? el.querySelector(INTERACTIVE_SELECTOR);
  if (interactive && interactive !== row && row.contains(interactive)) {
    s.push(`interactive: ${describeElement(interactive)} (probably opens the audience selector; never clicked)`);
  }
  return s;
}

function discoverAudience(row: Element, itemId: string): ControlPick {
  const targets = new Map<Element, { source: string; value: string; audience: string }>();
  for (const el of row.querySelectorAll(`${LABEL_ATTRIBUTE_SELECTOR}, [aria-labelledby], svg title`)) {
    const label = ownAudienceLabel(el);
    if (!label) continue;
    // Highlight the icon itself, not its <title>.
    const target = el.localName === 'title' ? (el.closest('svg') ?? el) : el;
    if (target !== row && row.contains(target) && !targets.has(target)) targets.set(target, label);
  }

  // An icon labelled twice (span[aria-label] > svg > title) is one indicator: keep the outermost.
  const strong = outermost([...targets.keys()]).map((el) => toCandidate(el, audienceSignals(row, el, targets.get(el)!)));
  if (strong.length === 1) {
    return chosen(itemId, 'audienceIndicator', strong[0], 'HIGH', 'The only element in this row whose accessibility label / tooltip names an audience.', strong);
  }
  if (strong.length > 1) {
    const rendered = strong.filter((c) => isRendered(c.el));
    if (rendered.length === 1) {
      return chosen(
        itemId,
        'audienceIndicator',
        rendered[0],
        'MEDIUM',
        `${strong.length} elements are labelled with an audience, but only this one is rendered.`,
        strong,
      );
    }
    return ambiguous(`${strong.length} separate elements in this row are labelled with an audience.`, strong);
  }

  // Weak fallback: a short visible text equal to an audience name.
  const weakEls = outermost([
    ...new Set(
      collectTextCandidates(row)
        .filter((t) => classifyLabel(t.value)?.recognized)
        .map((t) => t.element),
    ),
  ]);
  const weak = weakEls.map((el) => toCandidate(el, [`visible text "${clip(textOf(el), 40)}"`]));
  if (weak.length === 1) {
    return chosen(itemId, 'audienceIndicator', weak[0], 'LOW', 'No labelled audience icon; only a short visible text naming an audience.', weak);
  }
  if (weak.length > 1) return ambiguous(`No labelled audience icon, and ${weak.length} visible texts name an audience.`, weak);
  return missing('No element in this row is labelled with, or shows, an audience name.');
}

// ---------------------------------------------------------------------------
// 3. "View" button
// ---------------------------------------------------------------------------

function discoverView(row: Element, itemId: string): ControlPick {
  const named = [...row.querySelectorAll(INTERACTIVE_SELECTOR)].filter(
    (el) =>
      el !== row &&
      (isButtonLike(el) || isLinkLike(el)) &&
      !isCheckboxLike(el) &&
      isRendered(el) &&
      VIEW_PHRASES.includes(normalizeLabel(accessibleName(el).name)),
  );
  // <a role=link><div role=button>Xem</div></a> is one control.
  const candidates = outermost(named).map((el) => toCandidate(el));

  if (candidates.length === 0) {
    const postLinks = [...row.querySelectorAll('a[href]')].filter(isPostHref).length;
    return missing(
      `No rendered button/link in this row is named ${VIEW_PHRASES.slice(0, 4).map((p) => `"${p}"`).join(' / ')}…` +
        (postLinks ? ` (${postLinks} link(s) to post URLs exist; see Permalink).` : '.'),
    );
  }
  if (candidates.length > 1) return ambiguous(`${candidates.length} buttons/links in this row are named like "View".`, candidates);

  const c = candidates[0];
  if (isPostHref(c.el)) {
    return chosen(itemId, 'viewButton', c, 'HIGH', 'The only control named like "View", and it links to a post URL.', candidates);
  }
  return chosen(
    itemId,
    'viewButton',
    c,
    'MEDIUM',
    `The only control named like "View" (matched by its ${c.name.source === 'text' ? 'visible text' : c.name.source}; Facebook gives it no structural marker).`,
    candidates,
  );
}

// ---------------------------------------------------------------------------
// 4. "..." / more-options menu button
// ---------------------------------------------------------------------------

/** The menu-like beginning of an accessible name (as normalised), or null. */
function menuLabelPrefix(name: string): string | null {
  const norm = normalizeLabel(name);
  if (!norm) return null;
  return ROW_MENU_LABEL_RE.exec(norm)?.[0] ?? MENU_LABEL_PREFIXES.find((p) => norm.startsWith(p)) ?? null;
}

function isMenuLabelled(name: string): boolean {
  return menuLabelPrefix(name) !== null;
}

/** No letters or digits of its own: icon-only, empty, or just a "…" / "⋯" glyph. */
function hasNoMeaningfulText(el: Element): boolean {
  return !/[\p{L}\p{N}]/u.test(textOf(el));
}

/** e.g. 'unique rendered icon-only button with role=button and aria-haspopup="dialog"; aria-label begins "Lựa chọn khác…"' */
function strongMenuReason(c: Candidate): string {
  const kind = c.el.localName === 'button' ? '<button>' : c.el.getAttribute('role') === 'button' ? 'role=button' : describeElement(c.el);
  const look = isIconOnly(c.el) ? 'icon-only' : 'text-less';
  let reason = `Unique rendered ${look} button with ${kind} and aria-haspopup="${popupValue(c.el)}"`;
  const prefix = menuLabelPrefix(c.name.name);
  if (prefix) {
    const shown = c.name.name.trim().slice(0, prefix.length);
    reason += `; ${c.name.source} begins "${normalizeLabel(shown) === prefix ? shown : prefix}…"`;
  }
  return `${reason}.`;
}

function discoverMenu(row: Element, itemId: string, exclude: (Element | null)[]): ControlPick {
  const others = exclude.filter((e): e is Element => e !== null);
  const buttons = [...row.querySelectorAll(INTERACTIVE_SELECTOR)].filter((el) => el !== row && isButtonLike(el));

  // Button-like elements that could be the "..." button: not (wrapping) a checkbox, not the
  // audience selector, not the View button, and not a big clickable area with lots of text.
  const pool: Candidate[] = [];
  let excluded = 0;
  for (const el of buttons) {
    const name = accessibleName(el);
    const skip =
      !isRendered(el) ||
      isCheckboxLike(el) ||
      others.some((o) => o === el || el.contains(o) || o.contains(el)) ||
      !!classifyLabel(name.name)?.recognized ||
      textOf(el).length > MAX_BUTTON_TEXT;
    if (skip) excluded++;
    else pool.push({ el, name, signals: elementSignals(el) });
  }

  const withPopup = pool.filter((c) => MENU_POPUP_VALUES.has(popupValue(c.el) ?? ''));
  const strong = pool.filter((c) => STRONG_MENU_POPUP_VALUES.has(popupValue(c.el) ?? '') && hasNoMeaningfulText(c.el));
  const labelled = pool.filter((c) => isMenuLabelled(c.name.name));
  const iconOnly = pool.filter((c) => isIconOnly(c.el));
  const summary = [
    `${buttons.length} button-like element(s) in row, ${excluded} excluded (not rendered / checkbox / audience / View / long text)`,
    `${strong.length} text-less with aria-haspopup=menu|true|dialog (strong)`,
    `${withPopup.length} with aria-haspopup=menu|true`,
    `${labelled.length} with a menu-like accessible name`,
    `${iconOnly.length} icon-only`,
  ];
  const rowNote = (p: ControlPick) => withRowSignals(p, summary);
  const pick = (c: Candidate, confidence: Confidence, reason: string, tier: Candidate[]) =>
    rowNote(chosen(itemId, 'menuButton', c, confidence, reason, tier));

  // Tier 0: an icon-only / text-less button that opens a menu or dialog. Language-independent.
  // Exactly one such button survives the exclusions, or the row is ambiguous.
  const strongMenus = outermostCandidates(strong);
  if (strongMenus.length === 1) return pick(strongMenus[0], 'HIGH', strongMenuReason(strongMenus[0]), strongMenus);
  if (strongMenus.length > 1) {
    return rowNote(ambiguous(`${strongMenus.length} text-less buttons in this row have aria-haspopup=menu|true|dialog.`, strongMenus));
  }

  // Tier 1: opens a menu (aria-haspopup=menu|true) but has visible text. "dialog" is not trusted here.
  const popupMenus = outermostCandidates(withPopup);
  if (popupMenus.length === 1) {
    const c = popupMenus[0];
    const how = isMenuLabelled(c.name.name) ? 'named like a menu' : isIconOnly(c.el) ? 'icon-only' : null;
    return pick(
      c,
      how ? 'HIGH' : 'MEDIUM',
      `The only button in this row with aria-haspopup=${popupValue(c.el)}` +
        (how ? `, and it is ${how}.` : ', but it is neither icon-only nor named like a menu.'),
      popupMenus,
    );
  }
  if (popupMenus.length > 1) {
    const named = popupMenus.filter((c) => isMenuLabelled(c.name.name));
    if (named.length === 1) {
      return pick(named[0], 'HIGH', `${popupMenus.length} buttons in this row open a popup; only this one is named like a menu.`, popupMenus);
    }
    const icons = popupMenus.filter((c) => isIconOnly(c.el));
    if (named.length === 0 && icons.length === 1) {
      return pick(icons[0], 'MEDIUM', `${popupMenus.length} buttons in this row open a popup; only this one is icon-only.`, popupMenus);
    }
    return rowNote(ambiguous(`${popupMenus.length} buttons in this row have aria-haspopup=menu|true.`, popupMenus));
  }

  // Tier 2: no usable aria-haspopup in the row; fall back to the accessible name.
  const named = outermostCandidates(labelled);
  if (named.length === 1) {
    return pick(
      named[0],
      'MEDIUM',
      'No button in this row has a usable aria-haspopup; this is the only one with a menu-like accessible name.',
      named,
    );
  }
  if (named.length > 1) return rowNote(ambiguous(`${named.length} buttons in this row have a menu-like accessible name.`, named));

  // Tier 3: structure only.
  const icons = outermostCandidates(iconOnly);
  if (icons.length === 1) {
    return pick(icons[0], 'LOW', 'No aria-haspopup and no menu-like name in this row; this is the only remaining icon-only button.', icons);
  }
  if (icons.length > 1) return rowNote(ambiguous(`No aria-haspopup or menu-like name, and ${icons.length} icon-only buttons.`, icons));

  return rowNote(missing('No button in this row looks like a "..." menu button.', pool));
}

export function outermostCandidates(cs: Candidate[]): Candidate[] {
  return outermost(cs.map((c) => c.el)).map((el) => cs.find((c) => c.el === el)!);
}

function withRowSignals(p: ControlPick, rowSignals: string[]): ControlPick {
  p.discovery.signals = [...p.discovery.signals, ...rowSignals.map((s) => `row: ${s}`)];
  return p;
}

// ---------------------------------------------------------------------------
// 5. Permalink
// ---------------------------------------------------------------------------

/** URL shapes that are the post itself, rather than a photo/video that may be media inside it. */
const POST_ITSELF_RE = /\/(posts|permalink)\b|\/story\.php|[?&]story_fbid=/i;

function discoverPermalink(row: Element, view: Element | null): PermalinkDiscovery {
  const hrefs = [
    ...new Set([...row.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(isPostHref).map((a) => normalizePostUrl(a.href))),
  ];
  const result = (found: boolean, confidence: Confidence | null, href: string | null, reason: string, ambiguousCandidates = 0) => ({
    found,
    confidence,
    href,
    reason,
    ambiguousCandidates,
    candidateHrefs: hrefs.slice(0, MAX_CANDIDATES_REPORTED),
  });

  if (view instanceof HTMLAnchorElement && isPostHref(view)) {
    const others = hrefs.length - 1;
    return result(
      true,
      'HIGH',
      normalizePostUrl(view.href),
      `href of this row's View button${others > 0 ? `; ${others} other post URL(s) in the row ignored` : ''}.`,
    );
  }
  if (hrefs.length === 1) {
    const itself = POST_ITSELF_RE.test(hrefs[0]);
    return result(
      true,
      itself ? 'HIGH' : 'MEDIUM',
      hrefs[0],
      itself
        ? 'The only post URL linked from this row.'
        : 'The only post URL linked from this row, but it is a photo/video/reel URL and may be media inside the post.',
    );
  }
  if (hrefs.length > 1) {
    return result(false, null, null, `Ambiguous: ${hrefs.length} distinct post URLs in this row. None was chosen.`, hrefs.length);
  }
  return result(false, null, null, 'No link in this row matches a known post URL pattern (PERMALINK_RE).');
}

// ---------------------------------------------------------------------------
// Master "Tất cả" / select-all checkbox (outside every row)
// ---------------------------------------------------------------------------

/** Is this checkbox itself named like the master select-all ("Tất cả", "Select all")? */
export function isNamedSelectAll(el: Element): boolean {
  return SELECT_ALL_PHRASES.includes(normalizeLabel(accessibleName(el).name));
}

/** How far up from a checkbox to look for a nearby "Tất cả" text when the checkbox has no name. */
const MASTER_TEXT_MAX_LEVELS = 4;

function hasSelectAllTextNearby(el: Element, rows: Element[]): boolean {
  let box: Element | null = el.parentElement;
  for (let i = 0; box && i < MASTER_TEXT_MAX_LEVELS; i++, box = box.parentElement) {
    if (rows.some((r) => box!.contains(r))) return false; // grown past the toolbar into the list
    if (collectTextCandidates(box).some((t) => SELECT_ALL_PHRASES.includes(normalizeLabel(t.value)))) return true;
  }
  return false;
}

export interface MasterCheckboxDiscovery {
  element: Element | null;
  confidence: Confidence | null;
  note: string;
}

/**
 * Finds the master select-all checkbox, so V1A can verify it did NOT become selected.
 * Read-only, and used only for that verification: it is never clicked. Only rendered
 * checkboxes outside (and not around) every mapped row are considered.
 */
export function discoverMasterCheckbox(scope: Element, rows: Element[]): MasterCheckboxDiscovery {
  const outside = outermost(
    [...scope.querySelectorAll(CHECKBOX_SELECTOR)].filter(
      (el) => isRendered(el) && !rows.some((r) => r === el || r.contains(el) || el.contains(r)),
    ),
  );
  const named = outside.filter(isNamedSelectAll);
  if (named.length === 1) {
    return { element: named[0], confidence: 'HIGH', note: `Named like select-all: ${describeCandidate(toCandidate(named[0]))}.` };
  }
  if (named.length > 1) return { element: null, confidence: null, note: `Ambiguous: ${named.length} checkboxes are named like select-all.` };
  const near = outside.filter((el) => hasSelectAllTextNearby(el, rows));
  if (near.length === 1) {
    return {
      element: near[0],
      confidence: 'MEDIUM',
      note: `No checkbox is named like select-all; this one sits next to a select-all text: ${describeCandidate(toCandidate(near[0]))}.`,
    };
  }
  if (near.length > 1) return { element: null, confidence: null, note: `Ambiguous: ${near.length} checkboxes sit next to a select-all text.` };
  return {
    element: null,
    confidence: null,
    note: `Not found: none of the ${outside.length} rendered checkbox(es) outside the post rows is named like, or next to, "${SELECT_ALL_PHRASES.join('" / "')}".`,
  };
}

// ---------------------------------------------------------------------------
// Row entry points
// ---------------------------------------------------------------------------

/** The serialisable result plus the exact elements, which stay in the content script's scan session. */
export interface DiscoveredRowControls {
  result: RowControls;
  elements: Partial<Record<ControlKind, Element>>;
}

export function discoverRowControls(row: Element, itemId: string): DiscoveredRowControls {
  const checkbox = discoverCheckbox(row, itemId);
  const audienceIndicator = discoverAudience(row, itemId);
  const viewButton = discoverView(row, itemId);
  // The checkbox is not passed here: buttons that are or wrap a checkbox are already excluded,
  // and a checkbox drawn over a large area must not hide the "..." button inside it.
  const menuButton = discoverMenu(row, itemId, [audienceIndicator.element, viewButton.element]);
  const picks: Record<ControlKind, ControlPick> = { checkbox, menuButton, viewButton, audienceIndicator };

  const elements: Partial<Record<ControlKind, Element>> = {};
  for (const kind of CONTROL_KINDS) {
    const el = picks[kind].element;
    if (el) elements[kind] = el;
  }

  const all = [...row.querySelectorAll(INTERACTIVE_SELECTOR)];
  const interactive: InteractiveElementInfo[] = all.slice(0, MAX_INTERACTIVE_REPORTED).map((el) => {
    const name = accessibleName(el);
    return {
      element: describeElement(el),
      name: name.name,
      nameSource: name.source,
      signals: elementSignals(el),
      assignedTo: CONTROL_KINDS.find((k) => elements[k] === el) ?? null,
    };
  });

  return {
    elements,
    result: {
      checkbox: checkbox.discovery,
      menuButton: menuButton.discovery,
      viewButton: viewButton.discovery,
      audienceIndicator: audienceIndicator.discovery,
      permalink: discoverPermalink(row, viewButton.element),
      interactive,
      interactiveTotal: all.length,
    },
  };
}

/** Used when discovery throws for a row: every control is reported missing, with the error. */
export function failedRowControls(reason: string): DiscoveredRowControls {
  const d = () => missing(reason).discovery;
  return {
    elements: {},
    result: {
      checkbox: d(),
      menuButton: d(),
      viewButton: d(),
      audienceIndicator: d(),
      permalink: { found: false, confidence: null, href: null, reason, ambiguousCandidates: 0, candidateHrefs: [] },
      interactive: [],
      interactiveTotal: 0,
    },
  };
}

/**
 * A control must belong to exactly one row. If the same element was discovered for two rows
 * (only possible if rows overlap), un-assign it from all of them. Returns how many were released.
 */
export function releaseSharedControls(rows: { itemId: string; found: DiscoveredRowControls }[]): number {
  const owners = new Map<Element, { itemId: string; kind: ControlKind; found: DiscoveredRowControls }[]>();
  for (const { itemId, found } of rows) {
    for (const kind of CONTROL_KINDS) {
      const el = found.elements[kind];
      if (!el) continue;
      const list = owners.get(el) ?? [];
      list.push({ itemId, kind, found });
      owners.set(el, list);
    }
  }

  let released = 0;
  for (const list of owners.values()) {
    if (list.length < 2) continue;
    for (const owner of list) {
      const others = list.filter((o) => o !== owner).map((o) => `${o.itemId} (${o.kind})`);
      owner.found.result[owner.kind] = missing(
        `Refusing: the same element was also discovered as ${others.join(', ')}. A control must belong to exactly one row.`,
      ).discovery;
      delete owner.found.elements[owner.kind];
      for (const info of owner.found.result.interactive) if (info.assignedTo === owner.kind) info.assignedTo = null;
      released++;
    }
  }
  return released;
}
