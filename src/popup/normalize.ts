/**
 * Scan results cross chrome.runtime messaging and may come from a scanner injected by an
 * older build, so the debug panel checks their shape here instead of trusting the types.
 * Missing values get safe defaults, and every unexpected shape is recorded in `problems`
 * so the UI can show it, never silently hidden.
 */

import type { Audience, AudienceBasis, Confidence, ControlKind, ItemDate } from '../shared/types';
import { AUDIENCES, CONTROL_KINDS, SCANNER_PROTOCOL } from '../shared/types';

export const NONE = '(none)';

export interface SafeEvidence {
  source: string;
  strength: string;
  rawValue: string;
  matched: string | null;
  recognized: boolean;
  rule: string;
  element: string;
  used: boolean;
}

export interface SafeLabel {
  /** An EvidenceSource, or "unknown" for the older plain-string format. */
  source: string;
  value: string;
}

export interface SafeControl {
  found: boolean;
  confidence: Confidence | null;
  reason: string;
  controlId: string | null;
  element: string | null;
  signals: string[];
  candidates: number | null;
  ambiguousCandidates: number;
  candidateDescriptions: string[];
}

export interface SafePermalink {
  found: boolean;
  confidence: Confidence | null;
  href: string | null;
  reason: string;
  ambiguousCandidates: number;
  candidateHrefs: string[];
}

export interface SafeInteractive {
  element: string;
  name: string;
  nameSource: string;
  signals: string[];
  assignedTo: ControlKind | null;
}

export interface SafeRowControls extends Record<ControlKind, SafeControl> {
  permalink: SafePermalink;
  interactive: SafeInteractive[];
  interactiveTotal: number | null;
}

export interface SafeItem {
  /** Position in result.items: unique even when itemId is missing. */
  position: number;
  index: number | null;
  itemId: string | null;
  audience: Audience;
  reason: string;
  /** 'none' when missing or malformed, which never qualifies for an action. */
  audienceBasis: AudienceBasis;
  date: ItemDate | null;
  preview: string;
  permalink: string | null;
  container: string;
  evidence: SafeEvidence[];
  labelsSeen: SafeLabel[];
  visibleLabels: string[];
  /** null when the scanner didn't report controls (older build). */
  controls: SafeRowControls | null;
  problems: string[];
}

export interface SafeResult {
  scanSessionId: string | null;
  url: string;
  pageKind: string;
  root: string;
  strategy: string | null;
  strategyWasForced: boolean;
  durationMs: number | null;
  scannedAt: string;
  attempts: {
    id: string;
    description: string;
    candidates: number | null;
    rejected: { reason: string; preview: string; container: string }[];
    count: number | null;
  }[];
  items: SafeItem[];
  labelInventory: { value: string; count: number | null }[];
  /** Result-level shape problems (per-item ones live on each item). */
  problems: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function describe(v: unknown): string {
  if (v === undefined) return 'missing';
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return typeof v === 'string' ? `string "${v.slice(0, 40)}"` : `a ${typeof v}`;
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** Reads fields off an untrusted value, recording each unexpected shape in `problems`. */
function reader(raw: unknown, where: string, problems: string[]) {
  const obj: Record<string, unknown> = isRecord(raw) ? raw : {};
  if (!isRecord(raw)) problems.push(`${where}: expected an object, got ${describe(raw)}`);
  const bad = (key: string, expected: string) =>
    problems.push(`${where}.${key}: expected ${expected}, got ${describe(obj[key])}`);

  return {
    string(key: string): string {
      const v = obj[key];
      if (typeof v === 'string') return v;
      bad(key, 'a string');
      return v === undefined || v === null ? NONE : stringify(v);
    },
    /** A string, or null where null is a legitimate value. */
    nullableString(key: string): string | null {
      const v = obj[key];
      if (typeof v === 'string' || v === null) return v;
      bad(key, 'a string or null');
      return v === undefined ? null : stringify(v);
    },
    number(key: string): number | null {
      const v = obj[key];
      if (typeof v === 'number') return v;
      bad(key, 'a number');
      return null;
    },
    boolean(key: string): boolean {
      const v = obj[key];
      if (typeof v === 'boolean') return v;
      bad(key, 'a boolean');
      return false;
    },
    array(key: string): unknown[] {
      const v = obj[key];
      if (Array.isArray(v)) return v;
      bad(key, 'an array');
      return [];
    },
    raw(key: string): unknown {
      return obj[key];
    },
  };
}

function normalizeEvidence(raw: unknown, where: string, problems: string[]): SafeEvidence {
  const r = reader(raw, where, problems);
  return {
    source: r.string('source'),
    strength: r.string('strength'),
    rawValue: r.string('rawValue'),
    matched: r.nullableString('matched'),
    recognized: r.boolean('recognized'),
    rule: r.string('rule'),
    element: r.string('element'),
    used: r.boolean('used'),
  };
}

const CONFIDENCES: readonly Confidence[] = ['HIGH', 'MEDIUM', 'LOW'];
const AUDIENCE_BASES: readonly AudienceBasis[] = ['strong', 'weak', 'none'];

function confidenceOf(r: ReturnType<typeof reader>, where: string, problems: string[]): Confidence | null {
  const v = r.raw('confidence');
  if (v === null || CONFIDENCES.includes(v as Confidence)) return v as Confidence | null;
  problems.push(`${where}.confidence: expected HIGH/MEDIUM/LOW or null, got ${describe(v)}`);
  return null;
}

function stringArray(r: ReturnType<typeof reader>, key: string, where: string, problems: string[]): string[] {
  return r.array(key).map((v, i) => {
    if (typeof v === 'string') return v;
    problems.push(`${where}.${key}[${i}]: expected a string, got ${describe(v)}`);
    return stringify(v);
  });
}

function normalizeControl(raw: unknown, where: string, problems: string[]): SafeControl {
  const r = reader(raw, where, problems);
  return {
    found: r.boolean('found'),
    confidence: confidenceOf(r, where, problems),
    reason: r.string('reason'),
    controlId: r.nullableString('controlId'),
    element: r.nullableString('element'),
    signals: stringArray(r, 'signals', where, problems),
    candidates: r.number('candidates'),
    ambiguousCandidates: r.number('ambiguousCandidates') ?? 0,
    candidateDescriptions: stringArray(r, 'candidateDescriptions', where, problems),
  };
}

function normalizeControls(raw: unknown, where: string, problems: string[]): SafeRowControls | null {
  if (raw === undefined) {
    problems.push(`${where}: missing (scanner build without control discovery)`);
    return null;
  }
  const r = reader(raw, where, problems);
  const pw = `${where}.permalink`;
  const pr = reader(r.raw('permalink'), pw, problems);
  const controls = Object.fromEntries(
    CONTROL_KINDS.map((k) => [k, normalizeControl(r.raw(k), `${where}.${k}`, problems)]),
  ) as Record<ControlKind, SafeControl>;
  return {
    ...controls,
    permalink: {
      found: pr.boolean('found'),
      confidence: confidenceOf(pr, pw, problems),
      href: pr.nullableString('href'),
      reason: pr.string('reason'),
      ambiguousCandidates: pr.number('ambiguousCandidates') ?? 0,
      candidateHrefs: stringArray(pr, 'candidateHrefs', pw, problems),
    },
    interactive: r.array('interactive').map((x, i) => {
      const w = `${where}.interactive[${i}]`;
      const xr = reader(x, w, problems);
      const assigned = xr.raw('assignedTo');
      return {
        element: xr.string('element'),
        name: xr.string('name'),
        nameSource: xr.string('nameSource'),
        signals: stringArray(xr, 'signals', w, problems),
        assignedTo: CONTROL_KINDS.includes(assigned as ControlKind) ? (assigned as ControlKind) : null,
      };
    }),
    interactiveTotal: r.number('interactiveTotal'),
  };
}

function normalizeItem(raw: unknown, position: number): SafeItem {
  const problems: string[] = [];
  const where = `items[${position}]`;
  const r = reader(raw, where, problems);

  const rawAudience = r.raw('audience');
  let audience: Audience = 'UNKNOWN';
  if (AUDIENCES.includes(rawAudience as Audience)) audience = rawAudience as Audience;
  else problems.push(`${where}.audience: expected one of ${AUDIENCES.join('/')}, got ${describe(rawAudience)} (shown as UNKNOWN)`);

  let itemId: string | null = null;
  const rawItemId = r.raw('itemId');
  if (typeof rawItemId === 'string' && rawItemId) itemId = rawItemId;
  else problems.push(`${where}.itemId: expected a string, got ${describe(rawItemId)} (highlight unavailable)`);

  let plainStringLabels = 0;
  const labelsSeen = r.array('labelsSeen').map((l, i): SafeLabel => {
    if (typeof l === 'string') {
      plainStringLabels++;
      return { source: 'unknown', value: l };
    }
    const lr = reader(l, `${where}.labelsSeen[${i}]`, problems);
    return { source: lr.string('source'), value: lr.string('value') };
  });
  if (plainStringLabels > 0) {
    problems.push(`${where}.labelsSeen: ${plainStringLabels} plain string(s) (older scanner format), so their source is unknown`);
  }

  const visibleLabels = r.array('visibleLabels').map((v, i) => {
    if (typeof v === 'string') return v;
    problems.push(`${where}.visibleLabels[${i}]: expected a string, got ${describe(v)}`);
    return stringify(v);
  });

  const rawBasis = r.raw('audienceBasis');
  let audienceBasis: AudienceBasis = 'none';
  if (AUDIENCE_BASES.includes(rawBasis as AudienceBasis)) audienceBasis = rawBasis as AudienceBasis;
  else problems.push(`${where}.audienceBasis: expected strong/weak/none, got ${describe(rawBasis)} (treated as none)`);

  let date: ItemDate | null = null;
  const rawDate = r.raw('date');
  if (rawDate !== null) {
    const dr = reader(rawDate, `${where}.date`, problems);
    date = { text: dr.string('text'), source: dr.string('source') };
  }

  return {
    position,
    index: r.number('index'),
    itemId,
    audience,
    reason: r.string('reason'),
    audienceBasis,
    date,
    preview: r.string('preview'),
    permalink: r.nullableString('permalink'),
    container: r.string('container'),
    evidence: r.array('evidence').map((e, i) => normalizeEvidence(e, `${where}.evidence[${i}]`, problems)),
    labelsSeen,
    visibleLabels,
    controls: normalizeControls(r.raw('controls'), `${where}.controls`, problems),
    problems,
  };
}

export function normalizeResult(raw: unknown): SafeResult {
  const problems: string[] = [];
  const r = reader(raw, 'result', problems);

  const protocol = r.raw('protocol');
  if (protocol !== SCANNER_PROTOCOL) {
    problems.push(
      `This scan came from a different scanner build (protocol ${describe(protocol)}, this popup expects ${SCANNER_PROTOCOL}). ` +
        'Reload the extension at chrome://extensions, refresh the Facebook tab, then scan again.',
    );
  }

  const rawSession = r.raw('scanSessionId');
  const scanSessionId = typeof rawSession === 'string' && rawSession ? rawSession : null;
  if (!scanSessionId) problems.push(`result.scanSessionId: expected a string, got ${describe(rawSession)} (highlight unavailable)`);

  return {
    scanSessionId,
    url: r.string('url'),
    pageKind: r.string('pageKind'),
    root: r.string('root'),
    strategy: r.nullableString('strategy'),
    strategyWasForced: r.boolean('strategyWasForced'),
    durationMs: r.number('durationMs'),
    scannedAt: r.string('scannedAt'),
    attempts: r.array('attempts').map((a, i) => {
      const where = `result.attempts[${i}]`;
      const ar = reader(a, where, problems);
      return {
        id: ar.string('id'),
        description: ar.string('description'),
        candidates: ar.number('candidates'),
        rejected: ar.array('rejected').map((x, j) => {
          const xr = reader(x, `${where}.rejected[${j}]`, problems);
          return { reason: xr.string('reason'), preview: xr.string('preview'), container: xr.string('container') };
        }),
        count: ar.number('count'),
      };
    }),
    items: r.array('items').map(normalizeItem),
    labelInventory: r.array('labelInventory').map((l, i) => {
      const lr = reader(l, `result.labelInventory[${i}]`, problems);
      return { value: lr.string('value'), count: lr.number('count') };
    }),
    problems,
  };
}
