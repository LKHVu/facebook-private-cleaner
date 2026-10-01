/**
 * The pure eligibility / readiness rules the popup's screens use, in a module without React, so
 * the background service worker (V4 cleanup run) applies exactly the same rules. The content
 * script checks all of this (and more) again before every click.
 *
 * Moved unchanged from BatchActions.tsx (batchIneligibility), ScanHealth.tsx (reviewReasons) and
 * TrashActions.tsx (toolbarReady), which re-export them.
 */

import type { ControlKind, ToolbarDiscovery } from '../shared/types';
import type { SafeItem } from './normalize';

/** Why an item can't be in a batch, or null. The content script checks all of this (and more) again. */
export function batchIneligibility(item: SafeItem): string | null {
  if (item.audience !== 'ONLY_ME') return `classified ${item.audience}, not ONLY_ME`;
  if (!item.itemId) return 'no item id';
  if (item.problems.length > 0) return "this item's data has an unexpected shape";
  if (item.audienceBasis !== 'strong') return `ONLY_ME from ${item.audienceBasis} evidence, not an accessibility label`;
  if (!item.controls) return 'no control data in this scan';
  const cb = item.controls.checkbox;
  if (cb.ambiguousCandidates > 0) return 'checkbox discovery is ambiguous';
  if (!cb.found) return 'no checkbox discovered';
  if (cb.confidence !== 'HIGH') return `checkbox is ${cb.confidence ?? '?'} confidence, not HIGH`;
  if (!item.controls.permalink.found || !item.controls.permalink.href) return 'no permalink, so removal could not be verified';
  return null;
}

const CONTROL_NAMES: Record<ControlKind, string> = {
  checkbox: 'checkbox',
  menuButton: 'menu',
  viewButton: 'View button',
  audienceIndicator: 'audience indicator',
};

/** Why this item needs a review, or [] when it doesn't. */
export function reviewReasons(it: SafeItem): string[] {
  const why: string[] = [];
  if (it.audience === 'UNKNOWN') why.push('audience UNKNOWN');
  else if (it.audienceBasis !== 'strong') why.push(`audience from ${it.audienceBasis} evidence only`);
  if (it.problems.length > 0) why.push('unexpected data shape');
  const c = it.controls;
  if (!c) {
    why.push('no control data');
    return why;
  }
  for (const kind of ['checkbox', 'menuButton'] as const) {
    const d = c[kind];
    if (d.ambiguousCandidates > 0) why.push(`${CONTROL_NAMES[kind]} ambiguous (${d.ambiguousCandidates})`);
    else if (!d.found) why.push(`no ${CONTROL_NAMES[kind]}`);
    else if (d.confidence !== 'HIGH') why.push(`${CONTROL_NAMES[kind]} ${d.confidence ?? '?'}`);
  }
  for (const kind of ['viewButton', 'audienceIndicator'] as const) {
    if (c[kind].ambiguousCandidates > 0) why.push(`${CONTROL_NAMES[kind]} ambiguous`);
  }
  if (c.permalink.ambiguousCandidates > 0) why.push('permalink ambiguous');
  else if (!c.permalink.found || !c.permalink.href) why.push('permalink missing');
  return why;
}

/** The toolbar's Trash button may be clicked: toolbar HIGH, Trash HIGH, exactly `expected` posts selected (1 for V1B). */
export function toolbarReady(t: ToolbarDiscovery, expected = 1): string | null {
  if (!t.found) return `no bulk toolbar found (${t.reason})`;
  if (t.confidence !== 'HIGH') return `the bulk toolbar is only ${t.confidence}`;
  const trash = t.actions.trash;
  if (!trash.found) return `the Trash button is ${trash.ambiguousCandidates > 0 ? 'ambiguous' : 'not found'}`;
  if (trash.confidence !== 'HIGH') return `the Trash button is only ${trash.confidence}`;
  if (t.selectedCount !== expected) return `${t.selectedCount} checkboxes are selected, not exactly ${expected}`;
  return null;
}
