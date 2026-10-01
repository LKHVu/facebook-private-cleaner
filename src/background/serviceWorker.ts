/**
 * Background service worker.
 *
 * Receives requests from the popup, makes sure the scanner content script is
 * present in the target tab (injecting it on demand), and relays the request.
 * Refuses to touch any tab that isn't facebook.com.
 *
 * V4: also runs the cleanup run (queueRunner.ts), which must not depend on the tester window.
 */

import type {
  ActionStateResponse,
  AutoLoadResponse,
  BatchResponse,
  CheckboxActionResponse,
  HighlightResponse,
  PopupRequest,
  ScanResponse,
  SimpleResponse,
  ToolbarResponse,
  TrashResponse,
  WorkerInfoResponse,
} from '../shared/types';
import { BUILD_ID } from '../shared/build';
import { forward } from './forward';
import { handleRunRequest, initQueueRunner, isRunRequest } from './queueRunner';

// Synchronously at the top level: recovers an interrupted run and registers its tab listeners.
initQueueRunner();

chrome.runtime.onMessage.addListener((msg: PopupRequest, sender, sendResponse) => {
  // Only accept requests from this extension's own pages (the popup, or the tester window, which
  // has a sender.tab because it runs in a window of its own). Content scripts send from facebook.com.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return;

  let work: Promise<ScanResponse | HighlightResponse | CheckboxActionResponse | ActionStateResponse | ToolbarResponse | TrashResponse | BatchResponse | AutoLoadResponse | SimpleResponse | WorkerInfoResponse>;
  switch (msg?.type) {
    case 'FPC_SCAN_TAB':
      work = forward<ScanResponse>(msg.tabId, { type: 'FPC_SCAN', strategy: msg.strategy });
      break;
    case 'FPC_HIGHLIGHT_ITEM':
      work = forward<HighlightResponse>(msg.tabId, {
        type: 'FPC_HIGHLIGHT',
        scanSessionId: msg.scanSessionId,
        itemId: msg.itemId,
        control: msg.control,
      });
      break;
    case 'FPC_CHECKBOX_ACTION_TAB':
      work = forward<CheckboxActionResponse>(msg.tabId, { type: 'FPC_CHECKBOX_ACTION', request: msg.request }, false);
      break;
    case 'FPC_ACTION_STATE_TAB':
      work = forward<ActionStateResponse>(msg.tabId, { type: 'FPC_ACTION_STATE' }, false);
      break;
    case 'FPC_TOOLBAR_DISCOVER_TAB':
      work = forward<ToolbarResponse>(msg.tabId, { type: 'FPC_TOOLBAR_DISCOVER', scanSessionId: msg.scanSessionId }, false);
      break;
    case 'FPC_TOOLBAR_HIGHLIGHT_TAB':
      work = forward<HighlightResponse>(msg.tabId, { type: 'FPC_TOOLBAR_HIGHLIGHT', scanSessionId: msg.scanSessionId, action: msg.action }, false);
      break;
    case 'FPC_TRASH_TAB':
      work = forward<TrashResponse>(msg.tabId, { type: 'FPC_TRASH', request: msg.request }, false);
      break;
    case 'FPC_BATCH_TAB':
      work = forward<BatchResponse>(msg.tabId, { type: 'FPC_BATCH', request: msg.request }, false);
      break;
    case 'FPC_BATCH_HIGHLIGHT_TAB':
      work = forward<HighlightResponse>(msg.tabId, { type: 'FPC_BATCH_HIGHLIGHT', scanSessionId: msg.scanSessionId, itemIds: msg.itemIds }, false);
      break;
    case 'FPC_AUTOLOAD_START_TAB':
      // Needs no scan session, so the scanner may be injected for it (like a scan).
      work = forward<AutoLoadResponse>(msg.tabId, { type: 'FPC_AUTOLOAD_START', request: msg.request });
      break;
    case 'FPC_AUTOLOAD_STOP_TAB':
      work = forward<AutoLoadResponse>(msg.tabId, { type: 'FPC_AUTOLOAD_STOP', runId: msg.runId }, false);
      break;
    case 'FPC_WORKER_INFO':
      work = Promise.resolve({ ok: true, build: BUILD_ID } satisfies WorkerInfoResponse);
      break;
    case 'FPC_RUN_START':
    case 'FPC_RUN_STOP':
    case 'FPC_RUN_RESUME':
    case 'FPC_RUN_END':
      if (!isRunRequest(msg)) return;
      work = handleRunRequest(msg);
      break;
    default:
      return;
  }

  work.then(sendResponse, (e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  return true; // keep the message channel open for the async response
});
