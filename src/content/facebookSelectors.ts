/**
 * facebookSelectors.ts
 *
 * ALL Facebook-specific knowledge lives in this file: URLs, label strings,
 * attribute names and the strategies used to split the page into items.
 * When Facebook changes its markup, this should be the only file to edit.
 *
 * Rules of thumb:
 *  - Never rely on Facebook's generated CSS class names (x1n2onr6 ...).
 *  - Prefer semantic hooks: role, aria-label, title, <svg><title>, alt,
 *    visible text, and structural relationships between elements.
 *
 * This module is read-only: it never clicks, types or mutates Facebook's DOM.
 */

import type { Audience, BulkActionKind, EvidenceSource, EvidenceStrength, ItemDate } from '../shared/types';

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

const FACEBOOK_HOST_RE = /(^|\.)facebook\.com$/i;

/** Activity Log -> "Your posts" category. `/me/` redirects to the signed-in profile. */
export const ACTIVITY_LOG_YOUR_POSTS_URL =
  'https://www.facebook.com/me/allactivity?activity_history=false&category_key=MANAGEPOSTSPHOTOSANDVIDEOS&manage_mode=false&should_load_landing_page=false';

export function isFacebookUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && FACEBOOK_HOST_RE.test(u.hostname);
  } catch {
    return false;
  }
}

export function isActivityLogUrl(url: string | null | undefined): boolean {
  if (!isFacebookUrl(url)) return false;
  return /\/allactivity(\/|$)/i.test(new URL(url!).pathname);
}

// ---------------------------------------------------------------------------
// Audience vocabulary
// ---------------------------------------------------------------------------

interface PhraseRule {
  /** null = recognised as an audience name, but deliberately not mapped (e.g. "Custom"). */
  audience: Audience | null;
  match: 'exact' | 'prefix';
  /** Lower-case, NFC-normalised. */
  phrases: string[];
}

/**
 * Audience names as Facebook displays them. Add your UI language here if the
 * scanner reports UNKNOWN for everything. Order matters: first match wins.
 */
export const AUDIENCE_PHRASES: PhraseRule[] = [
  {
    audience: 'ONLY_ME',
    match: 'exact',
    phrases: ['only me', 'chỉ mình tôi', 'solo yo', 'moi uniquement', 'nur ich'],
  },
  {
    audience: 'PUBLIC',
    match: 'exact',
    phrases: ['public', 'công khai', 'público', 'öffentlich'],
  },
  {
    audience: 'FRIENDS',
    match: 'exact',
    phrases: ['friends', 'your friends', 'bạn bè', 'amigos', 'amis', 'freunde'],
  },
  {
    // Friend-based variants. Mapped to FRIENDS; the raw label is kept in the debug evidence.
    audience: 'FRIENDS',
    match: 'prefix',
    phrases: [
      'friends except',
      'friends of friends',
      'specific friends',
      'close friends',
      'bạn bè ngoại trừ',
      'bạn của bạn bè',
      'bạn bè cụ thể',
      'amigos excepto',
      'amis sauf',
    ],
  },
  {
    audience: null,
    match: 'exact',
    phrases: ['custom', 'tùy chỉnh', 'personalizado', 'personnalisé', 'benutzerdefiniert'],
  },
];

/**
 * Patterns that wrap an audience name inside a longer label, e.g.
 * "Shared with Only me" or "Edit privacy. Sharing with Public.".
 * Capture group 1 must be the audience name.
 */
export const SHARED_WITH_PATTERNS: RegExp[] = [
  /(?:shared with|sharing with|visible to|audience|privacy)\s*:?\s*([^.;,|]+)/i,
  /(?:đã chia sẻ với|chia sẻ với|đối tượng)\s*:?\s*([^.;,|]+)/i,
  /(?:compartido con|partagé avec|geteilt mit)\s*:?\s*([^.;,|]+)/i,
];

/** A label that is *only* an audience name ("Only me") must be at most this long. */
const MAX_BARE_LABEL_LENGTH = 40;

/** Visible-text candidates longer than this are ignored (post bodies, etc.). */
const MAX_TEXT_CANDIDATE_LENGTH = 40;

export function normalizeLabel(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/[ ​‎‏]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s.:·•…]+$/u, '');
}

export interface LabelClassification {
  phrase: string;
  audience: Audience | null;
  recognized: boolean;
  rule: string;
}

function lookupPhrase(phrase: string): { audience: Audience | null; rule: string } | null {
  for (const r of AUDIENCE_PHRASES) {
    for (const p of r.phrases) {
      if (r.match === 'exact' ? phrase === p : phrase.startsWith(p)) {
        return { audience: r.audience, rule: `${r.match} match "${p}"` };
      }
    }
  }
  return null;
}

/**
 * Decide whether a label/text names an audience.
 * Returns null if the string has nothing to do with audiences.
 */
export function classifyLabel(raw: string): LabelClassification | null {
  const norm = normalizeLabel(raw);
  if (!norm) return null;

  // 1. Whole label is an audience name: "Only me".
  if (norm.length <= MAX_BARE_LABEL_LENGTH) {
    const hit = lookupPhrase(norm);
    if (hit) return { phrase: norm, audience: hit.audience, recognized: true, rule: `whole label, ${hit.rule}` };
  }

  // 2. Audience name wrapped in a sentence: "Shared with Only me".
  for (const re of SHARED_WITH_PATTERNS) {
    const m = norm.match(re);
    if (!m) continue;
    const phrase = normalizeLabel(m[1]);
    const hit = lookupPhrase(phrase);
    if (hit) {
      return { phrase, audience: hit.audience, recognized: true, rule: `/${re.source}/ captured "${phrase}", ${hit.rule}` };
    }
    // Looks like an audience label but the name isn't in the dictionary – keep as a near miss.
    return { phrase, audience: null, recognized: false, rule: `/${re.source}/ captured "${phrase}" – not in AUDIENCE_PHRASES` };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Scan root
// ---------------------------------------------------------------------------

export function getScanRoot(doc: Document): { root: Element; description: string } {
  const main = doc.querySelector('[role="main"]');
  if (main) return { root: main, description: '[role="main"]' };
  return { root: doc.body, description: 'document.body (no [role="main"] found)' };
}

// ---------------------------------------------------------------------------
// Item (post/activity row) detection
// ---------------------------------------------------------------------------

/** aria-labels of the per-row "..." menu button. Matched case-insensitively at the start. */
export const ROW_MENU_LABEL_RE =
  /^(action options|actions for this post|more options|options for|tùy chọn hành động|hành động với bài viết này|xem thêm tùy chọn|opciones de acción|options d’action|options d'action)/i;

export interface ItemStrategy {
  id: string;
  description: string;
  /** Auto mode only uses fallback strategies when every primary strategy found nothing. */
  fallback?: boolean;
  find(root: Element): Element[];
  /**
   * Optional second pass over what find() returned: a reason string rejects the candidate
   * as a page control rather than an activity item; null keeps it.
   */
  rejectNonItem?(candidate: Element): string | null;
  /**
   * V3A: one cheap marker element per row, in document order, WITHOUT climbing to the row or
   * rejecting anything, so it can be counted repeatedly while older rows load. May be off from
   * find() by a constant (e.g. the master checkbox): auto-load only uses how much it grows.
   * Defaults to find(), for strategies whose find() is already cheap.
   */
  markers?(root: Element): Element[];
}

/** Keep only elements that are not nested inside another element of the list. */
export function outermost<T extends Element>(els: T[]): T[] {
  const set = new Set<Element>(els);
  return els.filter((el) => {
    for (let p = el.parentElement; p; p = p.parentElement) if (set.has(p)) return false;
    return true;
  });
}

function hasText(el: Element): boolean {
  return (el.textContent ?? '').trim().length > 0;
}

/**
 * Given one "anchor" element per row (e.g. the row's "..." button), climb from
 * each anchor to the highest ancestor that still contains only that one anchor.
 * That ancestor is the row. Works without knowing any class names.
 */
function climbToRows(anchors: Element[], root: Element): Element[] {
  const containsOnlyOne = (el: Element) => {
    let n = 0;
    for (const a of anchors) if (el.contains(a) && ++n > 1) return false;
    return n === 1;
  };
  const rows = new Set<Element>();
  for (const a of anchors) {
    let el = a;
    while (el.parentElement && el.parentElement !== root && root.contains(el.parentElement) && containsOnlyOne(el.parentElement)) {
      el = el.parentElement;
    }
    rows.add(el);
  }
  return [...rows];
}

export function hasStrongAudienceLabel(el: Element): boolean {
  for (const { attr } of LABEL_ATTRIBUTES) {
    const v = el.getAttribute(attr);
    if (v && classifyLabel(v)?.recognized) return true;
  }
  if (el.localName === 'title' && el.closest('svg')) {
    return !!classifyLabel(el.textContent ?? '')?.recognized;
  }
  return false;
}

/**
 * Label of the master "select all" checkbox above the Activity Log list in manage mode.
 * Lower-case, NFC-normalised, whole-string match. Add your UI language here.
 */
export const SELECT_ALL_PHRASES: string[] = ['all', 'select all', 'tất cả', 'chọn tất cả'];

// ---------------------------------------------------------------------------
// Bulk toolbar and Trash dialog vocabulary (V1B). Every UI-language string V1B
// matches lives here. Lower-case, NFC-normalised, compared with normalizeLabel().
// ---------------------------------------------------------------------------

/** Whole accessible names of the bulk actions shown next to the master checkbox. */
export const BULK_ACTION_LABELS: Record<BulkActionKind, string[]> = {
  archive: ['archive', 'lưu trữ'],
  trash: ['trash', 'move to trash', 'move to bin', 'bỏ đi', 'chuyển vào thùng rác'],
  changeAudience: ['change audience', 'edit audience', 'thay đổi đối tượng', 'chỉnh sửa đối tượng'],
};

/** Every bulk-action name, for recognising the toolbar row. Same format as SELECT_ALL_PHRASES. */
export const BULK_ACTION_PHRASES: string[] = Object.values(BULK_ACTION_LABELS).flat();

/** Whole accessible names of the button in Facebook's dialog that confirms moving to Trash. */
export const TRASH_CONFIRM_PHRASES: string[] = [
  'move',
  'move to trash',
  'move to bin',
  'trash',
  'chuyển',
  'di chuyển',
  'chuyển vào thùng rác',
  'bỏ đi',
];

/** Whole accessible names of a dialog button that cancels without doing anything. */
export const DIALOG_CANCEL_PHRASES: string[] = ['cancel', 'hủy', 'huỷ', 'not now', 'để sau'];

/** Whole accessible names of a dialog's close (X) button. Used only when there is no Cancel button. */
export const DIALOG_CLOSE_PHRASES: string[] = ['close', 'đóng'];

/** A dialog whose name, headings or text contain one of these is about Trash. Substring match. */
export const TRASH_DIALOG_CONTEXT_PHRASES: string[] = ['trash', 'recycle bin', 'thùng rác', 'bỏ đi'];

/**
 * Words that mean permanent deletion. A button named with one of these is never a Trash
 * confirmation, and a dialog whose name or heading contains one is refused. Substring match.
 * (Not checked against the dialog's body text, which may explain that Trash empties itself after 30 days.)
 */
export const PERMANENT_DELETE_WORDS: string[] = ['delete', 'permanent', 'xóa', 'xoá', 'vĩnh viễn'];

/** How many of the select-all / bulk-action signals a row needs before it counts as the toolbar. */
const MIN_BULK_SIGNALS = 2;

/**
 * Is this checkbox "row" really the bulk-selection toolbar ("Tất cả" + "Lưu trữ" / "Bỏ đi" /
 * "Thay đổi đối tượng") rather than one activity item?
 *
 * Returns a human-readable reason if so, otherwise null. Conservative on purpose:
 *  - A row that shows anything belonging to one post (an audience icon/label or a post
 *    permalink) is always kept, whatever else it contains.
 *  - Otherwise the row must show at least MIN_BULK_SIGNALS of: a select-all label and
 *    distinct bulk-action names, each as a whole short text or accessibility label.
 */
export function isBulkSelectionRow(row: Element): string | null {
  const labelled = [row, ...row.querySelectorAll(`${LABEL_ATTRIBUTE_SELECTOR}, svg title`)];
  if (labelled.some(hasStrongAudienceLabel) || getItemPermalink(row)) return null;

  const phrases = new Set<string>();
  for (const c of [...collectLabelCandidates(row), ...collectTextCandidates(row)]) phrases.add(normalizeLabel(c.value));

  const selectAll = SELECT_ALL_PHRASES.filter((p) => phrases.has(p));
  const bulkActions = BULK_ACTION_PHRASES.filter((p) => phrases.has(p));
  if (selectAll.length + bulkActions.length < MIN_BULK_SIGNALS) return null;

  const quote = (ps: string[]) => (ps.length ? ps.map((p) => `"${p}"`).join(', ') : 'none');
  return `Bulk-selection toolbar, not a post: select-all ${quote(selectAll)}; bulk actions ${quote(bulkActions)}; no audience label or post permalink.`;
}

export const ITEM_STRATEGIES: ItemStrategy[] = [
  {
    id: 'role-article',
    description: 'Outermost [role="article"] elements (how Facebook marks feed posts)',
    find: (root) => outermost([...root.querySelectorAll('[role="article"]')]).filter(hasText),
  },
  {
    id: 'role-listitem',
    description: 'Outermost [role="listitem"] elements',
    find: (root) => outermost([...root.querySelectorAll('[role="listitem"]')]).filter(hasText),
  },
  {
    id: 'row-menu-button',
    description: 'One row per "..." menu button (aria-label matches ROW_MENU_LABEL_RE), climbed to its row',
    find: (root) => climbToRows(rowMenuAnchors(root), root),
    markers: rowMenuAnchors,
  },
  {
    id: 'audience-icon',
    description:
      'One row per audience label/icon, climbed to its row. Misses rows without an icon and splits rows with several icons',
    fallback: true,
    find: (root) => climbToRows(audienceIconAnchors(root), root),
    markers: audienceIconAnchors,
  },
  {
    id: 'checkbox',
    description: 'One row per checkbox (Activity Log in "manage" mode), climbed to its row',
    // The master "select all" checkbox stays in the anchor list so no post row climbs up into
    // the toolbar; the toolbar's own row is then dropped by isBulkSelectionRow.
    find: (root) => climbToRows(checkboxAnchors(root), root),
    rejectNonItem: isBulkSelectionRow,
    markers: checkboxAnchors,
  },
];

function rowMenuAnchors(root: Element): Element[] {
  return [...root.querySelectorAll('[aria-label]')].filter((el) => ROW_MENU_LABEL_RE.test(el.getAttribute('aria-label') ?? ''));
}

function audienceIconAnchors(root: Element): Element[] {
  return outermost([...root.querySelectorAll(`${LABEL_ATTRIBUTE_SELECTOR}, svg title`)].filter(hasStrongAudienceLabel));
}

function checkboxAnchors(root: Element): Element[] {
  return [...root.querySelectorAll('[role="checkbox"], input[type="checkbox"]')];
}

/** V3A: the cheap per-row markers of one strategy (see ItemStrategy.markers). */
export function rowMarkers(strategyId: string, root: Element): Element[] {
  const s = ITEM_STRATEGIES.find((x) => x.id === strategyId);
  if (!s) return [];
  return s.markers ? s.markers(root) : s.find(root);
}

export function sortInDocumentOrder(els: Element[]): Element[] {
  return [...els].sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Evidence collection inside one item
// ---------------------------------------------------------------------------

export const LABEL_ATTRIBUTES: { attr: string; source: EvidenceSource }[] = [
  { attr: 'aria-label', source: 'aria-label' },
  { attr: 'title', source: 'title-attr' },
  { attr: 'data-tooltip-content', source: 'tooltip-attr' },
  { attr: 'alt', source: 'img-alt' },
];

export const LABEL_ATTRIBUTE_SELECTOR = LABEL_ATTRIBUTES.map((a) => `[${a.attr}]`).join(', ');

export interface RawCandidate {
  source: EvidenceSource;
  strength: EvidenceStrength;
  value: string;
  element: Element;
}

/** Accessibility labels and tooltips inside the item (strong evidence). */
export function collectLabelCandidates(item: Element): RawCandidate[] {
  const out: RawCandidate[] = [];
  const doc = item.ownerDocument;

  const els = item.matches(LABEL_ATTRIBUTE_SELECTOR) ? [item] : [];
  els.push(...item.querySelectorAll(LABEL_ATTRIBUTE_SELECTOR));
  for (const el of els) {
    for (const { attr, source } of LABEL_ATTRIBUTES) {
      const v = el.getAttribute(attr)?.trim();
      if (v) out.push({ source, strength: 'strong', value: v, element: el });
    }
  }

  for (const el of item.querySelectorAll('[aria-labelledby]')) {
    const text = (el.getAttribute('aria-labelledby') ?? '')
      .split(/\s+/)
      .map((id) => (id ? doc.getElementById(id)?.textContent?.trim() : ''))
      .filter(Boolean)
      .join(' ');
    if (text) out.push({ source: 'aria-labelledby', strength: 'strong', value: text, element: el });
  }

  for (const t of item.querySelectorAll('svg title')) {
    const v = t.textContent?.trim();
    if (v) out.push({ source: 'svg-title', strength: 'strong', value: v, element: t.closest('svg') ?? t });
  }

  return out;
}

/** Short visible text fragments inside the item (weak evidence). */
export function collectTextCandidates(item: Element): RawCandidate[] {
  const out: RawCandidate[] = [];
  const walker = item.ownerDocument.createTreeWalker(item, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = n.parentElement;
    if (!parent || parent.closest('svg, script, style')) continue;
    const v = n.textContent?.trim();
    if (v && v.length <= MAX_TEXT_CANDIDATE_LENGTH) {
      out.push({ source: 'visible-text', strength: 'weak', value: v, element: parent });
    }
  }
  return out;
}

/** Collect raw label strings from the whole root for the debug inventory. */
export function collectLabelInventory(root: Element): string[] {
  const values: string[] = [];
  for (const el of root.querySelectorAll(LABEL_ATTRIBUTE_SELECTOR)) {
    for (const { attr } of LABEL_ATTRIBUTES) {
      const v = el.getAttribute(attr)?.trim();
      if (v) values.push(v);
    }
  }
  for (const t of root.querySelectorAll('svg title')) {
    const v = t.textContent?.trim();
    if (v) values.push(v);
  }
  return values;
}

// ---------------------------------------------------------------------------
// Item metadata
// ---------------------------------------------------------------------------

export const PERMALINK_RE = /\/(posts|permalink|videos|photos?|reel|story\.php)\b|[?&](story_fbid|fbid)=/i;

export function getItemPermalink(item: Element): string | null {
  for (const a of item.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    if (PERMALINK_RE.test(a.href)) return a.href;
  }
  return null;
}

export function getItemPreview(item: Element, maxLength = 200): string {
  const text = ((item as HTMLElement).innerText ?? item.textContent ?? '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

// ---------------------------------------------------------------------------
// Item date (best effort, display only: never used to identify a post)
// ---------------------------------------------------------------------------

/** A time of day as the Activity Log shows it next to each row: "10:32", "9.05", "3:41 PM". */
const TIME_OF_DAY_RE = /^\d{1,2}[:.]\d{2}(\s?[ap]\.?m\.?)?$/i;
/** Day headings without digits. Lower-case, NFC. Anything with a digit also counts as a day heading. */
export const DAY_HEADING_WORDS: string[] = ['today', 'yesterday', 'hôm nay', 'hôm qua', 'hoy', 'ayer', "aujourd'hui", 'hier', 'heute', 'gestern'];
const MAX_DAY_HEADING_LENGTH = 60;

function isDayHeadingText(text: string): boolean {
  const norm = normalizeLabel(text);
  return !!norm && norm.length <= MAX_DAY_HEADING_LENGTH && (/\d/.test(norm) || DAY_HEADING_WORDS.includes(norm));
}

/**
 * The Activity Log groups rows under day headings ("27 tháng 9, 2026", "Hôm nay"). Returns those
 * headings under root, in document order, skipping any heading inside one of the item rows.
 */
export function findDayHeadings(root: Element, items: Element[]): Element[] {
  return [...root.querySelectorAll('[role="heading"], h1, h2, h3, h4, h5, h6')].filter(
    (h) => !items.some((it) => it.contains(h)) && isDayHeadingText(h.textContent ?? ''),
  );
}

export function getItemDate(item: Element, dayHeadings: Element[]): ItemDate | null {
  const time = item.querySelector('time[datetime]');
  if (time) return { text: time.getAttribute('datetime')!.trim(), source: 'time[datetime]' };
  const utime = Number(item.querySelector('abbr[data-utime]')?.getAttribute('data-utime'));
  if (utime > 0) return { text: new Date(utime * 1000).toLocaleString(), source: 'abbr[data-utime]' };

  let heading: string | null = null;
  for (const h of dayHeadings) {
    if (h.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING) heading = (h.textContent ?? '').replace(/\s+/g, ' ').trim();
    else break;
  }
  const timeText = collectTextCandidates(item).find((c) => TIME_OF_DAY_RE.test(c.value))?.value ?? null;
  if (heading && timeText) return { text: `${heading} · ${timeText}`, source: 'nearest day heading + time text in row' };
  if (heading) return { text: heading, source: 'nearest day heading above the row' };
  if (timeText) return { text: timeText, source: 'time text in row (no day heading found)' };
  return null;
}

/** e.g. `div[role=article]` or `span[aria-label="Shared with Only me"]` */
export function describeElement(el: Element): string {
  let s = el.localName;
  const role = el.getAttribute('role');
  if (role) s += `[role=${role}]`;
  const label = el.getAttribute('aria-label');
  if (label) s += `[aria-label="${label.length > 40 ? `${label.slice(0, 40)}…` : label}"]`;
  return s;
}
