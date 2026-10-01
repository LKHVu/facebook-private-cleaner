/**
 * facebookScroll.ts
 *
 * V3A: where the Activity Log scrolls, and moving that scroll position. Everything auto-load
 * needs to know about how Facebook lays the list out lives here.
 *
 * The only change it makes to the page is the scroll position, through the normal browser
 * scrolling APIs (scrollTo / scrollIntoView). No wheel, pointer or key events are fabricated,
 * nothing is clicked or focused, and no generated CSS class names are used.
 */

import * as fb from './facebookSelectors';

/** The element whose scroll position moves the Activity Log list. */
export interface ScrollTarget {
  /** document.scrollingElement for page scrolling, otherwise the nested scroll container. */
  el: Element;
  isDocument: boolean;
  description: string;
}

export interface ScrollReading {
  top: number;
  height: number;
  client: number;
}

/** A scroll container must have at least this much more content than it shows. */
const MIN_OVERFLOW_PX = 2;

function documentTarget(): ScrollTarget {
  return { el: document.scrollingElement ?? document.documentElement, isDocument: true, description: 'document' };
}

function scrollsVertically(el: Element): boolean {
  const s = getComputedStyle(el);
  return /(auto|scroll|overlay)/.test(s.overflowY) && el.scrollHeight - el.clientHeight >= MIN_OVERFLOW_PX;
}

/**
 * The scroll container of the Activity Log: the nearest ancestor of the last loaded row that
 * actually scrolls vertically. Facebook usually scrolls the whole document; if a nested element
 * scrolls instead, that element is used. With no row (or no scrolling ancestor) it is the document.
 */
export function findScrollContainer(lastRowMarker: Element | null): ScrollTarget {
  const top = document.scrollingElement ?? document.documentElement;
  for (let el = lastRowMarker?.parentElement ?? null; el && el !== top && el !== document.body; el = el.parentElement) {
    if (scrollsVertically(el)) return { el, isDocument: false, description: fb.describeElement(el) };
  }
  return documentTarget();
}

export function readScroll(t: ScrollTarget): ScrollReading {
  return { top: Math.round(t.el.scrollTop), height: Math.round(t.el.scrollHeight), client: Math.round(t.el.clientHeight) };
}

function scrollTo(t: ScrollTarget, top: number): void {
  if (t.isDocument) window.scrollTo({ top, behavior: 'instant' });
  else t.el.scrollTo({ top, behavior: 'instant' });
}

/**
 * Scrolls the list to its bottom, where Facebook loads older entries. If the container can't
 * scroll (nothing to scroll, or it isn't the real scroller), the last row marker is scrolled
 * into view instead, which moves whichever ancestors do scroll.
 */
export function scrollToBottom(t: ScrollTarget, lastRowMarker: Element | null): { method: string; before: ScrollReading; after: ScrollReading } {
  const before = readScroll(t);
  let method = `${t.description} to its bottom`;
  if (before.height - before.client >= MIN_OVERFLOW_PX) scrollTo(t, before.height);
  else if (lastRowMarker?.isConnected) {
    lastRowMarker.scrollIntoView({ block: 'end', behavior: 'instant' });
    method = 'last row into view';
  }
  return { method, before, after: readScroll(t) };
}

/**
 * Moves up by about half a screen. Used before scrolling to the bottom again after an attempt
 * that loaded nothing: Facebook's loader may only react when the bottom of the list comes back into view.
 */
export function nudgeUp(t: ScrollTarget): void {
  const r = readScroll(t);
  const client = t.isDocument ? window.innerHeight : r.client;
  scrollTo(t, Math.max(0, r.top - Math.min(600, Math.round(client / 2))));
}

/** Is this page Facebook's main list region ([role=main]) present? The scan root when it is. */
export function hasMainRegion(): boolean {
  return document.querySelector('[role="main"]') !== null;
}

/**
 * Is this still the Activity Log page auto-load started on (and, if it had one then, with its
 * main list region)? null when it is, otherwise why not.
 */
export function activityLogProblem(startUrl: string, hadMain: boolean): { navigated: boolean; why: string } | null {
  if (location.href !== startUrl) return { navigated: true, why: 'The Facebook page navigated while loading.' };
  if (!fb.isActivityLogUrl(location.href)) return { navigated: false, why: 'This is no longer the Activity Log.' };
  if (hadMain && !hasMainRegion()) return { navigated: false, why: "The Activity Log's main region is no longer on the page." };
  return null;
}
