import { useEffect, useState, type ReactNode } from 'react';
import type { ActionState, Audience, ControlKind, PopupRequest, ScanResult, ToolbarDiscovery } from '../shared/types';
import { AUDIENCES, BULK_ACTION_KINDS, SCANNER_PROTOCOL } from '../shared/types';
import { ITEM_STRATEGIES } from '../content/facebookSelectors';
import { BatchToggle, type BatchPlan } from './BatchActions';
import { ActionLog, IDLE_ACTION, ItemActionPanel, type ActionContext, type ItemActionState } from './CheckboxActions';
import { ErrorBoundary } from './ErrorBoundary';
import { HighlightButton } from './HighlightButton';
import { AUDIENCE_LABELS } from './labels';
import { NONE, type SafeControl, type SafeItem, type SafePermalink, type SafeResult, type SafeRowControls } from './normalize';
import type { QueueLogEntry } from './facebookQueue';
import { BULK_ACTION_LABELS, ToolbarChecklist, fetchToolbar } from './TrashActions';

interface Props {
  result: ScanResult | null;
  /** normalizeResult(result), computed once by the Workbench. */
  safe: SafeResult | null;
  tabId: number | null;
  strategy: string;
  onStrategyChange(s: string): void;
  /** The content script's lock, log, pending Trash and batch; null while unknown. */
  actionState: ActionState | null;
  actionStateError: string | null;
  refreshActionState(): void;
  /** Why single-post actions are unavailable because of a cleanup batch, or null. */
  batchBlock: string | null;
  /** V2A: the extension-side batch plan, and adding / removing one item from it. */
  plan: BatchPlan | null;
  onToggleBatch(item: SafeItem): void;
  /** Why the plan can't be edited now, or null. */
  batchEditBlock: string | null;
  /** V3B: queue-level events (session storage), shown in the action log. */
  queueLog?: QueueLogEntry[];
}

export function DebugPanel(props: Props) {
  const { result, safe, tabId, strategy, onStrategyChange, actionState, actionStateError, refreshActionState, batchBlock, plan, onToggleBatch, batchEditBlock } = props;
  const [filter, setFilter] = useState<Audience | 'ALL'>('ALL');
  const [copied, setCopied] = useState(false);

  const items = safe?.items.filter((it) => filter === 'ALL' || it.audience === filter) ?? [];

  // V1A action state: per-item UI state for the current scan.
  const scanSessionId = safe?.scanSessionId ?? null;
  const [itemActions, setItemActions] = useState<Record<string, ItemActionState>>({});

  useEffect(() => {
    setItemActions({}); // a new scan: nothing selected through it yet
  }, [scanSessionId]);

  const retired = !!scanSessionId && !!actionState?.retiredSessions.includes(scanSessionId);
  const actionContext: ActionContext = {
    tabId,
    scanSessionId,
    protocolOk: result?.protocol === SCANNER_PROTOCOL,
    locked: actionState?.locked ?? null,
    // Until the lock state is known, nothing is offered. A scan used for a Trash offers nothing either.
    unavailable:
      !actionState ? (actionStateError ? `could not read the action state (${actionStateError}).` : 'checking the action state…') :
      retired ? 'this scan was used for a Trash action, so the list has changed. Scan again.' :
      batchBlock,
    pendingTrash: actionState?.pendingTrash ?? null,
  };
  const updateItemAction = (itemId: string) => (fn: (s: ItemActionState) => ItemActionState) =>
    setItemActions((all) => ({ ...all, [itemId]: fn(all[itemId] ?? IDLE_ACTION) }));

  async function copyJson() {
    if (!result) return;
    await navigator.clipboard.writeText(JSON.stringify(result, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <details className="debug" open>
      <summary>Developer / debug</summary>

      <label className="row">
        <span>Item strategy</span>
        <select value={strategy} onChange={(e) => onStrategyChange(e.target.value)}>
          <option value="">Auto (most items)</option>
          {ITEM_STRATEGIES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.id}
            </option>
          ))}
        </select>
      </label>
      <p className="muted small">Changing the strategy takes effect on the next scan.</p>

      {!safe && <p className="muted">Run a scan to see debug details.</p>}

      {safe && (
        <>
          <div className="row">
            <button className="secondary" onClick={copyJson}>
              {copied ? 'Copied ✓' : 'Copy full result as JSON'}
            </button>
          </div>

          <ShapeProblems title="Unexpected scan result shape" problems={safe.problems} />

          <h3>Scan</h3>
          <table className="kv">
            <tbody>
              <tr><th>URL</th><td className="break">{safe.url}</td></tr>
              <tr><th>Page</th><td>{safe.pageKind}</td></tr>
              <tr><th>Root</th><td>{safe.root}</td></tr>
              <tr><th>Strategy</th><td>{safe.strategy ?? NONE}{safe.strategyWasForced ? ' (forced)' : ' (auto)'}</td></tr>
              <tr><th>Duration</th><td>{safe.durationMs ?? '?'} ms</td></tr>
              <tr><th>Scanned at</th><td>{safe.scannedAt === NONE ? NONE : new Date(safe.scannedAt).toLocaleString()}</td></tr>
              <tr><th>Session</th><td><code>{safe.scanSessionId ?? NONE}</code></td></tr>
            </tbody>
          </table>

          <h3>Strategy attempts</h3>
          <table className="grid">
            <thead><tr><th>Strategy</th><th>Candidates</th><th>Rejected</th><th>Items</th></tr></thead>
            <tbody>
              {safe.attempts.map((a, i) => (
                <tr key={i} className={a.id === safe.strategy ? 'chosen' : ''} title={a.description}>
                  <td>{a.id}</td>
                  <td>{a.candidates ?? '?'}</td>
                  <td>{a.rejected.length}</td>
                  <td>{a.count ?? '?'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {safe.attempts
            .filter((a) => a.rejected.length > 0)
            .map((a) => (
              <div key={a.id}>
                <p className="muted small">{a.id}: rejected {a.rejected.length} non-post control(s)</p>
                <ul className="small">
                  {a.rejected.map((r, j) => (
                    <li key={j} className="break">
                      <code>{r.container}</code> {r.reason} <span className="muted">"{r.preview}"</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}

          <h3>Control discovery</h3>
          <ControlSummary items={safe.items} />

          <h3>Bulk toolbar</h3>
          <ToolbarSection tabId={tabId} scanSessionId={safe.scanSessionId} />

          <h3>Items ({items.length})</h3>
          <div className="filters">
            {(['ALL', ...AUDIENCES] as const).map((f) => (
              <button key={f} className={`chip ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>
                {f === 'ALL' ? 'All' : AUDIENCE_LABELS[f]}
              </button>
            ))}
          </div>
          <p className="muted small">
            Click an item for its details and a "Highlight on page" button. ONLY_ME items also offer "Select this post",
            and once selected, "Move this post to Trash". "Add to batch" only adds an ONLY_ME post to the extension's
            cleanup plan: nothing on Facebook changes until you review the batch.
          </p>
          <ol className="items">
            {items.map((it) => (
              <li key={`${safe.scanSessionId ?? 'no-session'}:${it.position}`}>
                <ErrorBoundary label={`Item #${it.position}`}>
                  <ItemRow
                    item={it}
                    scanSessionId={safe.scanSessionId}
                    strategyText={`${safe.strategy ?? NONE}${safe.strategyWasForced ? ' (forced)' : ' (auto)'}`}
                    tabId={tabId}
                    action={
                      it.itemId ? (
                        <ItemActionPanel
                          item={it}
                          ctx={actionContext}
                          state={itemActions[it.itemId] ?? IDLE_ACTION}
                          update={updateItemAction(it.itemId)}
                          refreshActionState={refreshActionState}
                        />
                      ) : null
                    }
                    selected={!!it.itemId && !!itemActions[it.itemId]?.selected}
                    batchToggle={<BatchToggle item={it} plan={plan} editBlock={batchEditBlock} onToggle={onToggleBatch} />}
                  />
                </ErrorBoundary>
              </li>
            ))}
          </ol>

          <ActionLog log={actionState?.log ?? []} locked={actionState?.locked ?? null} queueLog={props.queueLog ?? []} />
          {actionStateError && <p className="warn small">Action log unavailable: {actionStateError}</p>}

          <details className="inventory">
            <summary>Label inventory ({safe.labelInventory.length})</summary>
            <p className="muted small">
              Most common aria-label / title / alt / svg title values under the scan root. If items come back UNKNOWN,
              look here for the real audience wording and add it to facebookSelectors.ts.
            </p>
            <table className="grid">
              <thead><tr><th>Count</th><th>Value</th></tr></thead>
              <tbody>
                {safe.labelInventory.map((l, i) => (
                  <tr key={i}><td>{l.count ?? '?'}</td><td className="break">{l.value}</td></tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}
    </details>
  );
}

/** The controls discovered in each row, in the order they're listed. */
const CONTROL_ROWS: { kind: ControlKind; label: string; button: string }[] = [
  { kind: 'checkbox', label: 'Checkbox', button: 'Highlight checkbox' },
  { kind: 'menuButton', label: 'More/options button', button: 'Highlight menu' },
  { kind: 'viewButton', label: 'View button', button: 'Highlight view' },
  { kind: 'audienceIndicator', label: 'Audience indicator', button: 'Highlight audience' },
];

type Discovery = Pick<SafeControl, 'found' | 'confidence' | 'ambiguousCandidates'>;

function isAmbiguous(d: Discovery): boolean {
  return !d.found && d.ambiguousCandidates > 0;
}

/** Diagnostic only: how many rows each control was found / missing / ambiguous in. */
function ControlSummary({ items }: { items: SafeItem[] }) {
  const reported = items.filter((it): it is SafeItem & { controls: SafeRowControls } => it.controls !== null);
  if (items.length === 0) return <p className="muted small">No post rows.</p>;
  if (reported.length === 0) return <p className="muted small">This scanner build doesn't report controls. Reload the extension and the Facebook tab.</p>;

  const rows: { label: string; pick: (c: SafeRowControls) => Discovery }[] = [
    ...CONTROL_ROWS.map((r) => ({ label: r.label, pick: (c: SafeRowControls) => c[r.kind] })),
    { label: 'Permalink', pick: (c: SafeRowControls) => c.permalink },
  ];
  return (
    <>
      <p className="muted small">
        {reported.length} post row(s){reported.length < items.length ? ` (${items.length - reported.length} without control data)` : ''}.
        Diagnostic only: this never affects a post's classification.
      </p>
      <table className="grid">
        <thead>
          <tr><th>Control</th><th>Found</th><th>High / Med / Low</th><th>Missing</th><th>Ambiguous</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const ds = reported.map((it) => r.pick(it.controls));
            const found = ds.filter((d) => d.found);
            const conf = (c: string) => found.filter((d) => d.confidence === c).length;
            const ambiguous = ds.filter(isAmbiguous).length;
            return (
              <tr key={r.label}>
                <td>{r.label}</td>
                <td className={found.length === ds.length ? 'ok' : ''}>{found.length}</td>
                <td className="muted">{conf('HIGH')} / {conf('MEDIUM')} / {conf('LOW')}</td>
                <td className={ds.length - found.length - ambiguous > 0 ? 'warn' : ''}>{ds.length - found.length - ambiguous}</td>
                <td className={ambiguous > 0 ? 'warn' : ''}>{ambiguous}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

type ToolbarStatus = { kind: 'idle' } | { kind: 'busy' } | { kind: 'done'; toolbar: ToolbarDiscovery } | { kind: 'error'; message: string };

/**
 * V1B diagnostic, read-only: discovers the Activity Log's bulk toolbar now (select one post
 * first: Facebook may only enable the actions then) and can outline the Trash button.
 */
function ToolbarSection({ tabId, scanSessionId }: { tabId: number | null; scanSessionId: string | null }) {
  const [status, setStatus] = useState<ToolbarStatus>({ kind: 'idle' });
  const disabled = tabId === null || !scanSessionId;

  async function discover() {
    if (tabId === null || !scanSessionId) return;
    setStatus({ kind: 'busy' });
    try {
      setStatus({ kind: 'done', toolbar: await fetchToolbar(tabId, scanSessionId) });
    } catch (e) {
      setStatus({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  const trashRequest: PopupRequest | null =
    tabId !== null && scanSessionId ? { type: 'FPC_TOOLBAR_HIGHLIGHT_TAB', tabId, scanSessionId, action: 'trash' } : null;

  return (
    <>
      <p className="muted small">Read-only. Select exactly one post first: Facebook may only enable its bulk actions then.</p>
      <div className="row">
        <button className="secondary small" disabled={disabled || status.kind === 'busy'} onClick={discover}>
          {status.kind === 'done' ? 'Discover again' : 'Discover toolbar'}
        </button>
        <HighlightButton request={trashRequest} label="Highlight Trash" />
      </div>
      {status.kind === 'error' && <p className="error small">{status.message}</p>}
      {status.kind === 'done' && (
        <>
          <ToolbarChecklist toolbar={status.toolbar} />
          <p className="small break">{status.toolbar.reason}</p>
          {status.toolbar.element && <p className="small">Element: <code>{status.toolbar.element}</code></p>}
          <details>
            <summary className="small muted">Toolbar signals ({status.toolbar.signals.length})</summary>
            <ul className="labels">
              {status.toolbar.signals.map((sig, i) => <li key={i}>{sig}</li>)}
            </ul>
          </details>
          <ul className="controls">
            {BULK_ACTION_KINDS.map((k) => (
              <ControlLine key={k} label={BULK_ACTION_LABELS[k]} d={status.toolbar.actions[k]} />
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function ShapeProblems({ title, problems }: { title: string; problems: string[] }) {
  if (problems.length === 0) return null;
  return (
    <div className="shape-problems">
      <p className="small"><strong>{title}</strong> ({problems.length})</p>
      <ul>
        {problems.map((p, i) => (
          <li key={i}>{p}</li>
        ))}
      </ul>
    </div>
  );
}

/** Label sources in the order they're listed in an item's details. */
const LABEL_SOURCES: { source: string; title: string }[] = [
  { source: 'aria-label', title: 'aria-label' },
  { source: 'aria-labelledby', title: 'aria-labelledby' },
  { source: 'title-attr', title: 'title' },
  { source: 'tooltip-attr', title: 'data-tooltip-content' },
  { source: 'svg-title', title: 'svg <title>' },
  { source: 'img-alt', title: 'img alt' },
];
const KNOWN_LABEL_SOURCES = new Set(LABEL_SOURCES.map((g) => g.source));

/** Where a highlight request goes: the scan session and item, which the content script maps to exact elements. */
interface HighlightTarget {
  tabId: number | null;
  scanSessionId: string | null;
  itemId: string | null;
}

/**
 * Outline the row (control undefined) or one control the scan discovered in it. Only
 * scanSessionId + itemId + control are sent: nothing is re-found from text.
 */
function rowHighlight({ tabId, scanSessionId, itemId }: HighlightTarget, control?: ControlKind): PopupRequest | null {
  if (tabId === null || !scanSessionId || !itemId) return null;
  return { type: 'FPC_HIGHLIGHT_ITEM', tabId, scanSessionId, itemId, control };
}

function ControlLine({ label, d, highlight }: { label: string; d: SafeControl; highlight?: ReactNode }) {
  const ambiguous = isAmbiguous(d);
  return (
    <li className="control">
      <div className="control-head">
        <span className={d.found ? 'ok' : ambiguous ? 'warn' : 'muted'}>{d.found ? '✓' : ambiguous ? '?' : '✗'}</span>
        <span className="control-label">{label}</span>
        <span className={`conf ${d.found ? '' : 'muted'}`}>
          {d.found ? d.confidence ?? '?' : ambiguous ? `ambiguous (${d.ambiguousCandidates})` : 'missing'}
        </span>
      </div>
      <p className="small break">{d.reason}</p>
      {d.found && highlight}
      <details>
        <summary className="small muted">
          Signals ({d.signals.length}){d.candidateDescriptions.length > 0 ? ` · candidates (${d.candidates ?? '?'})` : ''}
        </summary>
        {d.element && <p className="small break">Element: <code>{d.element}</code>{d.controlId && <> · id <code>{d.controlId}</code></>}</p>}
        <ul className="labels">
          {d.signals.map((s, i) => <li key={i}>{s}</li>)}
        </ul>
        {d.candidateDescriptions.length > 0 && (
          <>
            <p className="small muted">Candidates</p>
            <ul className="labels">
              {d.candidateDescriptions.map((s, i) => <li key={i}>{s}</li>)}
            </ul>
          </>
        )}
      </details>
    </li>
  );
}

function PermalinkLine({ p }: { p: SafePermalink }) {
  const ambiguous = isAmbiguous(p);
  return (
    <li className="control">
      <div className="control-head">
        <span className={p.found ? 'ok' : ambiguous ? 'warn' : 'muted'}>{p.found ? '✓' : ambiguous ? '?' : '✗'}</span>
        <span className="control-label">Permalink</span>
        <span className={`conf ${p.found ? '' : 'muted'}`}>
          {p.found ? p.confidence ?? '?' : ambiguous ? `ambiguous (${p.ambiguousCandidates})` : 'missing'}
        </span>
      </div>
      {p.href && <a className="small break" href={p.href} target="_blank" rel="noreferrer">{p.href}</a>}
      <p className="small break">{p.reason}</p>
      {p.candidateHrefs.length > 1 && (
        <ul className="labels">
          {p.candidateHrefs.map((h, i) => <li key={i}>{h}</li>)}
        </ul>
      )}
    </li>
  );
}

function RowControlsSection({ controls, target }: { controls: SafeRowControls | null; target: HighlightTarget }) {
  if (!controls) return <p className="muted small">Not reported by this scanner build. Reload the extension and the Facebook tab, then scan again.</p>;
  return (
    <>
      <ul className="controls">
        {CONTROL_ROWS.map((r) => (
          <ControlLine
            key={r.kind}
            label={r.label}
            d={controls[r.kind]}
            highlight={<HighlightButton request={rowHighlight(target, r.kind)} label={r.button} />}
          />
        ))}
        <PermalinkLine p={controls.permalink} />
      </ul>
      <details>
        <summary className="small">
          Interactive elements in this row ({controls.interactive.length}
          {controls.interactiveTotal !== null && controls.interactiveTotal > controls.interactive.length ? ` of ${controls.interactiveTotal}` : ''})
        </summary>
        <p className="muted small">What control discovery saw: role, accessible name and aria-* signals of each button/link/checkbox.</p>
        <table className="grid">
          <thead><tr><th>Element</th><th>Name</th><th>Signals</th></tr></thead>
          <tbody>
            {controls.interactive.map((x, i) => (
              <tr key={i} className={x.assignedTo ? 'used' : ''}>
                <td className="break">
                  <code>{x.element}</code>
                  {x.assignedTo && <><br /><strong>→ {CONTROL_ROWS.find((r) => r.kind === x.assignedTo)?.label}</strong></>}
                </td>
                <td className="break">{x.name || <span className="muted">(none)</span>}<br /><span className="muted">{x.nameSource}</span></td>
                <td className="break muted">{x.signals.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </>
  );
}

interface ItemRowProps {
  item: SafeItem;
  scanSessionId: string | null;
  strategyText: string;
  tabId: number | null;
  /** V1A action panel (renders nothing for non-ONLY_ME items). */
  action: ReactNode;
  /** Selected through this popup in the current scan. */
  selected: boolean;
  /** V2A "Add to batch" control (renders nothing for non-ONLY_ME items). Extension UI only, never Facebook's checkbox. */
  batchToggle: ReactNode;
}

function ItemRow({ item, scanSessionId, strategyText, tabId, action, selected, batchToggle }: ItemRowProps) {
  const [open, setOpen] = useState(false);

  const cannotHighlight =
    tabId === null ? 'No Facebook tab connected.' :
    !scanSessionId ? 'This scan has no scanSessionId.' :
    !item.itemId ? 'This item has no itemId.' :
    null;
  const target: HighlightTarget = { tabId, scanSessionId, itemId: item.itemId };

  const labelGroups = [
    ...LABEL_SOURCES,
    // Anything else, e.g. "unknown" for the older plain-string format.
    ...[...new Set(item.labelsSeen.map((l) => l.source))]
      .filter((s) => !KNOWN_LABEL_SOURCES.has(s))
      .map((s) => ({ source: s, title: s })),
  ]
    .map((g) => ({ ...g, values: item.labelsSeen.filter((l) => l.source === g.source).map((l) => l.value) }))
    .filter((g) => g.values.length > 0);

  return (
    <div className={`item ${open ? 'open' : ''}`}>
      <div className="item-line">
        <button className="item-head" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="caret">{open ? '▾' : '▸'}</span>
          <span className="muted idx">#{item.index ?? item.position}</span>
          <span className={`pill aud-${item.audience}`}>{AUDIENCE_LABELS[item.audience]}</span>
          <span className="preview">{item.preview || '(no text)'}</span>
          {selected && <span className="ok small" title="Selected through this popup">☑</span>}
          {item.problems.length > 0 && <span className="warn small" title="Unexpected data shape">⚠</span>}
        </button>
        {batchToggle}
      </div>

      {open && (
        <div className="item-body">
          <ShapeProblems title="Unexpected item data" problems={item.problems} />

          <ErrorBoundary label="Action">{action}</ErrorBoundary>

          <HighlightButton request={rowHighlight(target)} label="Highlight on page" />
          {cannotHighlight && <p className="warn small">Highlight unavailable: {cannotHighlight} Scan again.</p>}

          <table className="kv">
            <tbody>
              <tr>
                <th>Classification</th>
                <td><code className={`aud-${item.audience}`}>{item.audience}</code></td>
              </tr>
              <tr><th>Strategy</th><td>{strategyText}</td></tr>
              <tr><th>Container</th><td className="break"><code>{item.container}</code></td></tr>
              <tr>
                <th>Item ID</th>
                <td>
                  <code>{item.itemId ?? NONE}</code>{' '}
                  <span className="muted">(scan {scanSessionId ? scanSessionId.slice(0, 8) : NONE})</span>
                </td>
              </tr>
              <tr><th>Why</th><td className="break">{item.reason}</td></tr>
              <tr><th>Evidence tier</th><td>{item.audienceBasis}</td></tr>
              <tr>
                <th>Date</th>
                <td className="break">
                  {item.date ? <>{item.date.text} <span className="muted">({item.date.source})</span></> : <span className="muted">not detected</span>}
                </td>
              </tr>
              {item.permalink && (
                <tr>
                  <th>Permalink</th>
                  <td className="break"><a href={item.permalink} target="_blank" rel="noreferrer">{item.permalink}</a></td>
                </tr>
              )}
            </tbody>
          </table>

          <h4>Controls in this row</h4>
          <RowControlsSection controls={item.controls} target={target} />

          <h4>Evidence</h4>
          {item.evidence.length > 0 ? (
            <table className="grid evidence">
              <thead>
                <tr><th>Used</th><th>Source</th><th>Value</th><th>→</th><th>Rule</th></tr>
              </thead>
              <tbody>
                {item.evidence.map((e, i) => (
                  <tr key={i} className={e.used ? 'used' : ''}>
                    <td>{e.used ? '✓' : ''}</td>
                    <td title={e.element}>{e.source}<br /><span className="muted">{e.strength}</span></td>
                    <td className="break">{e.rawValue}</td>
                    <td>{e.matched ?? (e.recognized ? 'unmapped' : '?')}</td>
                    <td className="break muted">{e.rule}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted small">No audience-related evidence inside this item.</p>
          )}

          <h4>Labels inside this item</h4>
          {labelGroups.length === 0 && <p className="muted small">No aria-label / title / svg title / alt values.</p>}
          {labelGroups.map((g) => (
            <div key={g.source}>
              <p className="small muted">{g.title} ({g.values.length})</p>
              <ul className="labels">
                {g.values.map((v, i) => (
                  <li key={i}>{v}</li>
                ))}
              </ul>
            </div>
          ))}
          <details>
            <summary className="small">Visible short text ({item.visibleLabels.length})</summary>
            <ul className="labels">
              {item.visibleLabels.map((v, i) => (
                <li key={i}>{v}</li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </div>
  );
}
