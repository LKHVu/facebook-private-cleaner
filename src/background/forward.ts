/**
 * Relaying a request to the scanner content script of one Facebook tab (injecting the scanner on
 * demand). Used by the message router (serviceWorker.ts) and by the V4 cleanup run (queueRunner.ts).
 * Refuses to touch any tab that isn't facebook.com.
 */

import type { ContentRequest, SimpleResponse } from '../shared/types';
import { SCANNER_NOT_RUNNING_ERROR } from '../shared/types';
import { isFacebookUrl } from '../content/facebookSelectors';

const SCANNER_FILE = 'content/scanner.js';

async function assertFacebookTab(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  if (!isFacebookUrl(tab.url)) throw new Error('The target tab is not facebook.com.');
}

async function scannerIsPresent(tabId: number): Promise<boolean> {
  try {
    const pong = await chrome.tabs.sendMessage<ContentRequest, SimpleResponse>(tabId, { type: 'FPC_PING' });
    return !!pong?.ok;
  } catch {
    return false; // "Receiving end does not exist" -> not injected yet
  }
}

/** Ping the scanner; inject it if it isn't there (first use, or after the extension was reloaded). */
async function ensureScanner(tabId: number): Promise<void> {
  if (await scannerIsPresent(tabId)) return;
  await chrome.scripting.executeScript({ target: { tabId }, files: [SCANNER_FILE] });
}

/**
 * `inject: false` for anything that needs an existing scan session (actions, action state):
 * a freshly injected scanner has no session, so injecting would only hide the real problem.
 */
export async function forward<R>(tabId: number, msg: ContentRequest, inject = true): Promise<R> {
  await assertFacebookTab(tabId);
  if (inject) await ensureScanner(tabId);
  else if (!(await scannerIsPresent(tabId))) {
    throw new Error(SCANNER_NOT_RUNNING_ERROR);
  }
  const res = await chrome.tabs.sendMessage<ContentRequest, R>(tabId, msg);
  if (res === undefined) throw new Error('The scanner did not respond. Reload the Facebook tab and try again.');
  return res;
}
