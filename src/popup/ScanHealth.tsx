/**
 * V3A: aggregate diagnostics for a scan, and the few items that need a human look, so a scan of
 * 100+ loaded posts doesn't have to be inspected row by row. Display only: it never changes an
 * item's classification or what may be acted on (the action modules check everything again).
 */

import { AUDIENCES } from '../shared/types';
import { HighlightButton } from './HighlightButton';
import { AUDIENCE_LABELS } from './labels';
import type { SafeControl, SafeResult } from './normalize';
import { reviewReasons } from './safetyRules';

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function isHigh(d: SafeControl | undefined): boolean {
  return !!d && d.found && d.confidence === 'HIGH' && d.ambiguousCandidates === 0;
}

export { reviewReasons };

/** The items of a scan that need a human look, with why and a highlight button. Also used by the V5 guided cleanup. */
export function ReviewList({ safe, tabId }: { safe: SafeResult; tabId: number | null }) {
  const review = safe.items.map((it) => ({ it, why: reviewReasons(it) })).filter((x) => x.why.length > 0);
  if (review.length === 0) return null;
  return (
    <ol className="review-list batch-scroll">
      {review.map(({ it, why }) => (
        <li key={it.position} className="review-item">
          <span className="small">
            <span className="muted">#{it.index ?? it.position}</span> <span className={`pill aud-${it.audience}`}>{AUDIENCE_LABELS[it.audience]}</span>{' '}
            <code>{it.itemId ?? '(no id)'}</code> {it.date?.text ?? <span className="muted">date not detected</span>}
          </span>
          <span className="small warn">{why.join(' · ')}</span>
          <span className="small muted break">{clip(it.preview, 90) || '(no text)'}</span>
          <HighlightButton
            request={tabId !== null && safe.scanSessionId && it.itemId ? { type: 'FPC_HIGHLIGHT_ITEM', tabId, scanSessionId: safe.scanSessionId, itemId: it.itemId } : null}
            label="Highlight on page"
          />
        </li>
      ))}
    </ol>
  );
}

export function ScanHealth({ safe, tabId }: { safe: SafeResult; tabId: number | null }) {
  const items = safe.items;
  const n = items.length;
  if (n === 0) return null;
  const counts = Object.fromEntries(AUDIENCES.map((a) => [a, items.filter((it) => it.audience === a).length]));
  const strong = items.filter((it) => it.audienceBasis === 'strong' && it.audience !== 'UNKNOWN').length;
  const checkboxHigh = items.filter((it) => isHigh(it.controls?.checkbox)).length;
  const menuHigh = items.filter((it) => isHigh(it.controls?.menuButton)).length;
  const permalinks = items.filter((it) => !!it.controls?.permalink.found && !!it.controls.permalink.href).length;
  const review = items.map((it) => ({ it, why: reviewReasons(it) })).filter((x) => x.why.length > 0);
  const cls = (v: number) => (v === n ? 'ok' : 'warn');

  return (
    <section className="scan-health">
      <h3>Scan health</h3>
      <table className="kv health">
        <tbody>
          <tr><th>Rows loaded</th><td><strong>{n}</strong></td></tr>
          {AUDIENCES.map((a) => (
            <tr key={a}><th className={`aud-${a}`}>{a}</th><td>{counts[a]}</td></tr>
          ))}
          <tr><th>Strong evidence</th><td className={cls(strong)}>{strong}</td></tr>
          <tr><th>Weak / unknown</th><td className={n - strong === 0 ? '' : 'warn'}>{n - strong}</td></tr>
          <tr><th>Checkbox HIGH</th><td className={cls(checkboxHigh)}>{checkboxHigh} / {n}</td></tr>
          <tr><th>Menu HIGH</th><td className={cls(menuHigh)}>{menuHigh} / {n}</td></tr>
          <tr><th>Permalink</th><td className={cls(permalinks)}>{permalinks} / {n}</td></tr>
        </tbody>
      </table>

      <p>
        <strong className={review.length === 0 ? 'ok' : 'warn'}>Items needing review: {review.length}</strong>
        {review.length === 0 && <span className="muted small"> every row has a known audience from strong evidence, HIGH controls and a permalink.</span>}
      </p>
      {review.length > 0 && <ReviewList safe={safe} tabId={tabId} />}
    </section>
  );
}
