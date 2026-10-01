/**
 * The persistent tester window and the one Facebook tab it operates on.
 *
 * Both live in chrome.storage.session (cleared when the browser or the extension restarts):
 * only a tab id and a window id, never any Facebook content. The popup writes the target tab
 * when it opens the tester; the tester writes its own window id when it loads, so the popup
 * can focus it instead of opening a duplicate.
 */

import { isActivityLogUrl, isFacebookUrl } from '../content/facebookSelectors';

const TARGET_KEY = 'fpc:testerTargetTabId';
const WINDOW_KEY = 'fpc:testerWindowId';

export const TESTER_PATH = 'popup/tester.html';
const TESTER_WIDTH = 700;
const TESTER_HEIGHT = 850;

export async function readTargetTabId(): Promise<number | null> {
  const got = await chrome.storage.session.get(TARGET_KEY);
  const id = got[TARGET_KEY];
  return typeof id === 'number' ? id : null;
}

export async function writeTargetTabId(tabId: number): Promise<void> {
  await chrome.storage.session.set({ [TARGET_KEY]: tabId });
}

/** Calls `onChange` whenever the target tab id is changed (by the popup or the Reconnect button). */
export function watchTargetTabId(onChange: (tabId: number | null) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'session' || !(TARGET_KEY in changes)) return;
    const id = changes[TARGET_KEY].newValue;
    onChange(typeof id === 'number' ? id : null);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/** Called by the tester page itself on load. */
export async function registerTesterWindow(): Promise<void> {
  const w = await chrome.windows.getCurrent();
  if (w.id !== undefined) await chrome.storage.session.set({ [WINDOW_KEY]: w.id });
}

/** The tester window opened earlier, if it still exists. Window ids aren't reused within a browser session. */
async function existingTesterWindow(): Promise<number | null> {
  const got = await chrome.storage.session.get(WINDOW_KEY);
  const id = got[WINDOW_KEY];
  if (typeof id !== 'number') return null;
  try {
    const w = await chrome.windows.get(id);
    return w.type === 'popup' ? id : null;
  } catch {
    return null; // closed
  }
}

/**
 * Point the tester at `tabId`, then focus the existing tester window or open a new one.
 * The target is written first: an already-open tester picks it up through storage.onChanged.
 */
export async function openTester(tabId: number): Promise<void> {
  await writeTargetTabId(tabId);
  const existing = await existingTesterWindow();
  if (existing !== null) {
    await chrome.windows.update(existing, { focused: true, drawAttention: true });
    return;
  }
  await chrome.windows.create({
    url: chrome.runtime.getURL(TESTER_PATH),
    type: 'popup',
    width: TESTER_WIDTH,
    height: TESTER_HEIGHT,
    focused: true,
  });
}

export type TargetTab =
  | { kind: 'loading' }
  | { kind: 'none' }
  | { kind: 'connected'; tabId: number; url: string; activityLog: boolean }
  /** Closed, or navigated away from facebook.com. */
  | { kind: 'disconnected'; tabId: number; reason: string };

/**
 * The target tab's live state. Without the "tabs" permission, tab.url is only visible for
 * hosts the extension has access to, so a missing url means it is no longer on facebook.com.
 */
export async function inspectTargetTab(tabId: number | null): Promise<TargetTab> {
  if (tabId === null) return { kind: 'none' };
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { kind: 'disconnected', tabId, reason: 'the tab was closed.' };
  }
  if (!isFacebookUrl(tab.url)) return { kind: 'disconnected', tabId, reason: 'the tab navigated away from facebook.com.' };
  return { kind: 'connected', tabId, url: tab.url!, activityLog: isActivityLogUrl(tab.url) };
}

/**
 * The active tab of the browser window the user was last in (the tester window itself is a
 * popup window, so it is skipped). Used by "Reconnect to current Facebook tab".
 */
export async function findCurrentActivityLogTab(): Promise<{ ok: true; tabId: number } | { ok: false; error: string }> {
  let win: chrome.windows.Window;
  try {
    win = await chrome.windows.getLastFocused({ populate: true, windowTypes: ['normal'] });
  } catch {
    return { ok: false, error: 'No browser window found.' };
  }
  const tab = win.tabs?.find((t) => t.active);
  if (!tab || tab.id === undefined) return { ok: false, error: 'No active tab in the last browser window.' };
  if (!isFacebookUrl(tab.url)) return { ok: false, error: 'The active tab in the last browser window is not facebook.com.' };
  if (!isActivityLogUrl(tab.url)) return { ok: false, error: 'The active tab is facebook.com, but not the Activity Log.' };
  return { ok: true, tabId: tab.id };
}

/** "www.facebook.com/me/allactivity" style, for display. */
export function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}${u.search ? '?…' : ''}`;
  } catch {
    return url;
  }
}
