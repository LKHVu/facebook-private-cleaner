/**
 * V2A / V2B popup UI: the Cleanup batch. At most MAX_BATCH_SIZE (20) ONLY_ME posts, moved to Trash
 * with one Facebook bulk Trash operation, after three separate confirmations:
 *
 *   plan (DRAFT)   "Add to batch" on ONLY_ME rows, or "Add first 20 eligible" (scan order).
 *                  Extension-side only: nothing on Facebook changes, nothing is scrolled or loaded.
 *   Review batch   our review screen (REVIEW) plus a live, read-only preflight of every post.
 *                  Still nothing on Facebook changes.
 *   Select these N posts        only when the preflight passed for all N: the content script
 *                               preflights again, then ticks their checkboxes (SELECTED)
 *   Continue to Facebook confirmation   it clicks the toolbar's Trash button once (DIALOG_OPEN)
 *   Confirm move N posts to Trash       it clicks Facebook's confirm button once, then verifies each post.
 *
 * The popup owns DRAFT and REVIEW. From SELECTING on, what is shown comes from the content
 * script's state (ActionState.batch), never from this UI's own idea of where the batch is. While a
 * step runs, that state is polled for its progress (display only).
 * The popup only asks; facebookBatchAction.ts re-checks every safety condition before each click.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  ActionState,
  BatchPreflight,
  BatchProgress,
  BatchProgressPhase,
  BatchRequest,
  BatchResponse,
  BatchSnapshot,
  BatchState,
  BatchStep,
  Failure,
  PopupRequest,
  PreflightCheckKey,
  ToolbarDiscovery,
} from '../shared/types';
import { MAX_BATCH_SIZE, PREFLIGHT_CHECK_KEYS, SCANNER_PROTOCOL, canTransition, isBatchActive } from '../shared/types';
import { HighlightButton } from './HighlightButton';
import { AUDIENCE_LABELS } from './labels';
import type { SafeItem, SafeResult } from './normalize';
import { batchIneligibility } from './safetyRules';
import { DialogView, ToolbarChecklist, fetchToolbar, toolbarReady } from './TrashActions';

/** How often the batch's progress is read from the Facebook tab while a step runs. */
const PROGRESS_POLL_MS = 400;

// ---------------------------------------------------------------------------
// The plan (DRAFT / REVIEW): extension-side only, in memory only
// ---------------------------------------------------------------------------

export interface BatchPlan {
  batchId: string;
  scanSessionId: string;
  createdAt: string;
  /** In scan order. Never more than MAX_BATCH_SIZE. */
  itemIds: string[];
  /** The scanned permalink of each item (controls.permalink.href), same order. Sent so the content script can compare. */
  permalinks: string[];
  state: Extract<BatchState, 'DRAFT' | 'REVIEW'>;
}

export function newPlan(scanSessionId: string, itemIds: string[] = [], permalinks: string[] = []): BatchPlan {
  return { batchId: crypto.randomUUID(), scanSessionId, createdAt: new Date().toISOString(), itemIds, permalinks, state: 'DRAFT' };
}

/** DRAFT ⇄ REVIEW, through the shared transition table. */
export function planTo(plan: BatchPlan, to: BatchPlan['state']): BatchPlan {
  if (!canTransition(plan.state, to)) throw new Error(`Invalid batch state change ${plan.state} → ${to}.`);
  return { ...plan, state: to };
}

export { batchIneligibility };

type Pair = readonly [string, string];

function pairsOf(plan: BatchPlan): Pair[] {
  return plan.itemIds.map((id, i) => [id, plan.permalinks[i]] as const);
}

/** The plan holding exactly these (itemId, permalink) pairs, in scan order. */
function withPairs(plan: BatchPlan, pairs: Pair[], order: SafeItem[]): BatchPlan {
  const pos = new Map(order.map((o, i) => [o.itemId, i]));
  const at = (id: string) => pos.get(id) ?? order.length;
  const sorted = [...pairs].sort((a, b) => at(a[0]) - at(b[0]));
  return { ...plan, itemIds: sorted.map((p) => p[0]), permalinks: sorted.map((p) => p[1]) };
}

/** The plan without these items. */
export function removePlanItems(plan: BatchPlan, ids: string[]): BatchPlan {
  const keep = (_: string, i: number) => !ids.includes(plan.itemIds[i]);
  return { ...plan, itemIds: plan.itemIds.filter(keep), permalinks: plan.permalinks.filter(keep) };
}

/**
 * Adds or removes one item. Returns the new plan, or a reason. Never more than MAX_BATCH_SIZE:
 * an item beyond the limit is refused, not swapped in.
 */
export function togglePlanItem(plan: BatchPlan, item: SafeItem, order: SafeItem[]): BatchPlan | string {
  if (plan.state !== 'DRAFT') return 'the batch is under review';
  const id = item.itemId;
  if (!id) return 'no item id';
  if (plan.itemIds.includes(id)) return removePlanItems(plan, [id]);
  const why = batchIneligibility(item);
  if (why) return why;
  if (plan.itemIds.length >= MAX_BATCH_SIZE) return `Maximum batch size reached (${MAX_BATCH_SIZE})`;
  return withPairs(plan, [...pairsOf(plan), [id, item.controls!.permalink.href!]], order);
}

/** Every currently scanned post that may join a batch, in scan order. */
export function eligibleItems(order: SafeItem[]): SafeItem[] {
  return order.filter((it) => batchIneligibility(it) === null);
}

/**
 * "Add first 20 eligible": adds the currently scanned eligible posts not yet in the plan, in scan
 * order, until the plan holds MAX_BATCH_SIZE. Extension-side only: no Facebook checkbox is
 * clicked, nothing is scrolled, no older posts are loaded. Posts already in the plan stay.
 */
export function addEligible(plan: BatchPlan, order: SafeItem[]): { plan: BatchPlan; added: number; remaining: number } {
  if (plan.state !== 'DRAFT') return { plan, added: 0, remaining: 0 };
  const outside = eligibleItems(order).filter((it) => !plan.itemIds.includes(it.itemId!));
  const take = outside.slice(0, Math.max(0, MAX_BATCH_SIZE - plan.itemIds.length));
  const next = withPairs(plan, [...pairsOf(plan), ...take.map((it) => [it.itemId!, it.controls!.permalink.href!] as const)], order);
  return { plan: next, added: take.length, remaining: outside.length - take.length };
}

/** "Add to batch" on an ONLY_ME row. Extension UI only: it never touches Facebook's checkbox. */
export function BatchToggle({ item, plan, editBlock, onToggle }: { item: SafeItem; plan: BatchPlan | null; editBlock: string | null; onToggle(item: SafeItem): void }) {
  if (item.audience !== 'ONLY_ME' || !item.itemId) return null;
  const inPlan = !!plan?.itemIds.includes(item.itemId);
  const full = !inPlan && !!plan && plan.itemIds.length >= MAX_BATCH_SIZE;
  const why = editBlock ?? (inPlan ? null : batchIneligibility(item) ?? (full ? `Maximum batch size reached (${MAX_BATCH_SIZE})` : null));
  return (
    <label className={`batch-toggle ${why ? 'muted' : ''}`} title={why ? `Can't change the batch: ${why}` : 'Extension-side cleanup plan only. Nothing on Facebook changes.'}>
      <input type="checkbox" checked={inPlan} disabled={!!why} onChange={() => onToggle(item)} />
      <span className="small">Add to batch</span>
    </label>
  );
}

/**
 * V3B: the plan under review is the current attempt of a cleanup-queue batch. The queue decides
 * what the batch holds; this panel still does every Facebook step exactly as for a hand-picked batch.
 */
export interface QueueLink {
  /** The V2B batchId of the queue batch's current attempt. */
  batchId: string;
  /** e.g. "Queue batch 2 of 6". */
  label: string;
  /** A live preflight of the queue batch finished (read-only). */
  onPreflight(pf: BatchPreflight): void;
  /** "Remove failed items from this batch": the queue takes them out and hands back the smaller plan. */
  onRemoveFailed(ids: string[], pf: BatchPreflight | null): void;
  /** Leave the review: back to the queue, nothing on Facebook changed. */
  onBack(): void;
}

// ---------------------------------------------------------------------------
// Talking to the content script
// ---------------------------------------------------------------------------

interface BatchIds {
  batchId: string;
  scanSessionId: string;
  itemIds: string[];
  permalinks: string[];
}

interface UiFailure {
  batchId: string;
  step: BatchStep;
  code: string | null;
  error: string;
  clicked: boolean;
  preflight: BatchPreflight | null;
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

const STATE_TEXT: Partial<Record<BatchState, string>> = {
  SELECTING: 'Selecting the posts on Facebook…',
  CONFIRMING: "Clicking Facebook's confirmation…",
  VERIFYING: 'Verifying the result…',
};

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

interface PanelProps {
  tabId: number | null;
  safe: SafeResult | null;
  protocolOk: boolean;
  actionState: ActionState | null;
  actionStateError: string | null;
  refreshActionState(): Promise<void>;
  plan: BatchPlan | null;
  setPlan(p: BatchPlan | null): void;
  /** A request is in flight: its message, or null. The Workbench uses it to disable scanning. */
  busy: string | null;
  setBusy(b: string | null): void;
  /** V3A: why nothing may run because older Activity Log entries are loading, or null. */
  loadBlock: string | null;
  /** V3B: set while the plan may be a cleanup-queue batch. */
  queueLink?: QueueLink | null;
  /** V3B: why a hand-picked batch can't be planned now (a cleanup queue exists), or null. */
  manualBlock?: string | null;
  /** V4: a cleanup run drives the batches now: this panel shows no action. */
  runBlock?: string | null;
}

export function BatchPanel(props: PanelProps) {
  const { tabId, safe, protocolOk, actionState, actionStateError, refreshActionState, plan, setPlan, busy, setBusy, loadBlock } = props;
  const queueLink = props.queueLink ?? null;
  /** The queue link, when `p` is the queue batch's current attempt. */
  const queueOf = (p: BatchPlan | null) => (p && queueLink && p.batchId === queueLink.batchId ? queueLink : null);
  const queuePlan = queueOf(plan);
  const [failure, setFailure] = useState<UiFailure | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** The last live preflight (read-only). Only used while it matches the plan under review. */
  const [preflight, setPreflight] = useState<BatchPreflight | null>(null);
  /** The request in flight, so its progress (and not an older step's) is shown. */
  const [inFlight, setInFlight] = useState<{ batchId: string; since: string } | null>(null);
  /** What "Add first 20 eligible" did, shown while the plan is unchanged. */
  const [addNote, setAddNote] = useState<{ text: string; key: string } | null>(null);

  // While a step runs, read the content script's state (and so the batch's progress) regularly.
  useEffect(() => {
    if (!busy) return;
    const t = window.setInterval(() => void refreshActionState(), PROGRESS_POLL_MS);
    return () => window.clearInterval(t);
  }, [busy, refreshActionState]);

  const snap = actionState?.batch ?? null;
  const active = snap && isBatchActive(snap.state) ? snap : null;
  // A finished batch is shown only to the plan that started it.
  const finished = snap && !active && plan && snap.batchId === plan.batchId ? snap : null;
  const scanSessionId = safe?.scanSessionId ?? null;
  const byId = new Map((safe?.items ?? []).filter((it) => it.itemId).map((it) => [it.itemId!, it]));
  const itemsOf = (ids: string[], sid: string) => ids.map((id) => ({ id, item: sid === scanSessionId ? byId.get(id) ?? null : null }));

  const blocker =
    loadBlock ? loadBlock :
    tabId === null ? 'no Facebook tab connected.' :
    !actionState ? (actionStateError ? `could not read the action state (${actionStateError}).` : 'checking the action state…') :
    actionState.locked ? `actions are locked: ${actionState.locked}` :
    !protocolOk ? 'this scan came from a different scanner build. Reload the Facebook tab and scan again.' :
    !scanSessionId ? 'this scan has no session id. Scan again.' :
    actionState.retiredSessions.includes(scanSessionId) ? 'this scan was used for a Trash action, so the list has changed. Scan again.' :
    actionState.pendingTrash ? 'a single-post Trash is waiting for confirmation. Confirm or cancel it first.' :
    null;

  async function send(step: BatchStep, ids: BatchIds, working: string): Promise<BatchResponse | null> {
    if (tabId === null) return null;
    // The hard limit, here too (the content script enforces it again).
    if (ids.itemIds.length > MAX_BATCH_SIZE) {
      setFailure({ batchId: ids.batchId, step, code: 'BATCH_TOO_LARGE', error: `A batch holds at most ${MAX_BATCH_SIZE} posts.`, clicked: false, preflight: null });
      return null;
    }
    setBusy(working);
    setInFlight({ batchId: ids.batchId, since: new Date().toISOString() });
    setFailure(null);
    setNote(null);
    try {
      const request: BatchRequest = {
        protocol: SCANNER_PROTOCOL,
        scanSessionId: ids.scanSessionId,
        batchId: ids.batchId,
        step,
        itemIds: [...ids.itemIds],
        permalinks: [...ids.permalinks],
        // PREFLIGHT only reads the page; every other step is sent only from its own confirmation button.
        confirmed: step !== 'PREFLIGHT',
      };
      const msg: PopupRequest = { type: 'FPC_BATCH_TAB', tabId, request };
      const res: BatchResponse | Failure | undefined = await chrome.runtime.sendMessage(msg);
      if (!res) throw new Error('No response from the background service worker.');
      if (!res.ok && !('code' in res)) throw new Error(res.error);
      if (res.ok) setNote(res.note);
      else setFailure({ batchId: ids.batchId, step, code: res.code, error: res.error, clicked: res.clicked, preflight: res.preflight });
      return res;
    } catch (e) {
      // No answer from the Facebook tab: a write step may or may not have clicked something.
      setFailure({
        batchId: ids.batchId,
        step,
        code: null,
        error: `Could not tell what happened on Facebook: ${e instanceof Error ? e.message : String(e)}. Check the Facebook tab, then reload it.`,
        clicked: step !== 'PREFLIGHT',
        preflight: null,
      });
      return null;
    } finally {
      await refreshActionState();
      setInFlight(null);
      setBusy(null);
    }
  }

  async function runPreflight(p: BatchPlan) {
    setPreflight(null);
    const res = await send('PREFLIGHT', p, `Preflight: checking all ${p.itemIds.length} posts on the live Facebook page (read-only, nothing is clicked)…`);
    if (res?.ok && res.preflight) {
      setPreflight(res.preflight);
      queueOf(p)?.onPreflight(res.preflight);
    }
  }

  // V3B: "Review batch" in the queue hands over a plan already in REVIEW: its live preflight runs once, at once.
  const autoPreflighted = useRef<string | null>(null);
  useEffect(() => {
    if (!queuePlan || !plan || plan.state !== 'REVIEW' || busy || blocker) return;
    const key = `${plan.batchId}:${plan.itemIds.join(',')}`;
    if (autoPreflighted.current === key) return;
    autoPreflighted.current = key;
    void runPreflight(plan);
  }, [queuePlan, plan, busy, blocker]);

  function addEligibleToPlan() {
    if (!safe || !scanSessionId || blocker) return;
    const base = plan ?? newPlan(scanSessionId);
    if (base.state !== 'DRAFT') return;
    const r = addEligible(base, safe.items);
    setPlan(r.plan.itemIds.length > 0 ? r.plan : null);
    const first = base.itemIds.length === 0 ? 'first ' : '';
    setAddNote({
      text:
        r.added === 0
          ? base.itemIds.length >= MAX_BATCH_SIZE
            ? `The batch is already full (${MAX_BATCH_SIZE}).`
            : 'No eligible loaded post is outside this batch.'
          : `Added ${first}${plural(r.added, 'eligible post')}. ${plural(r.remaining, 'eligible post')} ${r.remaining === 1 ? 'remains' : 'remain'} outside this batch.`,
      key: r.plan.itemIds.join(','),
    });
  }

  const idsOf = (s: BatchSnapshot): BatchIds => ({ batchId: s.batchId, scanSessionId: s.scanSessionId, itemIds: s.itemIds, permalinks: [] });
  const shownFailure = failure && (failure.batchId === (active ?? finished)?.batchId || failure.batchId === plan?.batchId) ? failure : null;
  const progress = inFlight && snap && snap.batchId === inFlight.batchId && snap.progress && snap.progress.updatedAt >= inFlight.since ? snap.progress : null;

  let body: ReactNode;
  if (props.runBlock) {
    body = (
      <p className="muted small">
        {props.runBlock} Each of its batches goes through this panel's own steps and checks (preflight, select, Trash, Facebook's confirm,
        verification); follow it in the run panel. No action is available here until the run ends.
      </p>
    );
  } else if (busy) {
    body = <BusyView text={busy} progress={progress} />;
  } else if (active) {
    const posts = itemsOf(active.itemIds, active.scanSessionId);
    if (active.state === 'SELECTED') {
      body = (
        <SecondConfirm
          snap={active}
          posts={posts}
          tabId={tabId}
          onUnselect={() => send('UNSELECT', idsOf(active), `Unselecting all ${active.itemIds.length} posts this batch selected, one click each, then verifying…`)}
          onContinue={() => send('OPEN_DIALOG', idsOf(active), "Checking everything again, clicking Facebook's Trash button once, then looking for Facebook's confirmation dialog…")}
        />
      );
    } else if (active.state === 'DIALOG_OPEN') {
      body = (
        <FinalConfirm
          snap={active}
          onCancel={() => send('CANCEL_DIALOG', idsOf(active), "Cancelling Facebook's dialog…")}
          onConfirm={() => send('CONFIRM', idsOf(active), `Checking everything again, clicking Facebook's confirmation once, then verifying all ${active.itemIds.length} posts…`)}
        />
      );
    } else {
      body = <p className="muted small">{STATE_TEXT[active.state] ?? active.state} If this doesn't change, reload the Facebook tab.</p>;
    }
  } else if (finished) {
    const reusable = !finished.verification && !actionState?.locked && !!scanSessionId && finished.scanSessionId === scanSessionId && !actionState?.retiredSessions.includes(scanSessionId);
    body = (
      <ResultView
        snap={finished}
        posts={itemsOf(finished.itemIds, finished.scanSessionId)}
        onBackToPlan={
          // A queue batch goes back through the queue ("Review batch" starts a new attempt).
          reusable && plan && !queuePlan
            ? () => {
                setFailure(null);
                setNote(null);
                setPreflight(null);
                setPlan(newPlan(plan.scanSessionId, plan.itemIds, plan.permalinks));
              }
            : null
        }
        onClear={() => {
          setFailure(null);
          setNote(null);
          setPreflight(null);
          setPlan(null);
        }}
      />
    );
  } else if (loadBlock) {
    body = <p className="muted small">Batch creation and review are disabled: {loadBlock} A fresh scan restores them when loading ends.</p>;
  } else if (!safe) {
    body = <p className="muted small">Scan first, then tick "Add to batch" on up to {MAX_BATCH_SIZE} ONLY_ME posts, or add the first {MAX_BATCH_SIZE} eligible ones.</p>;
  } else if (!plan && props.manualBlock) {
    body = <p className="muted small">Hand-picked batches are unavailable: {props.manualBlock} Queue batches are reviewed and run here.</p>;
  } else if (plan && plan.state === 'REVIEW') {
    const matching = preflight && preflight.batchId === plan.batchId && sameIds(preflight.items.map((i) => i.itemId), plan.itemIds) ? preflight : null;
    body = (
      <ReviewScreen
        plan={plan}
        posts={itemsOf(plan.itemIds, plan.scanSessionId)}
        currentScan={plan.scanSessionId === scanSessionId}
        blocker={blocker}
        preflight={matching}
        backLabel={queuePlan ? 'Back to queue' : 'Back to plan'}
        onRecheck={() => runPreflight(plan)}
        onCancel={() => {
          setPreflight(null);
          if (queuePlan) queuePlan.onBack();
          else setPlan(planTo(plan, 'DRAFT'));
        }}
        onRemoveFailed={(ids) => {
          setPreflight(null);
          if (queuePlan) {
            queuePlan.onRemoveFailed(ids, matching);
            return;
          }
          const next = removePlanItems(planTo(plan, 'DRAFT'), ids);
          setPlan(next.itemIds.length > 0 ? next : null);
        }}
        onSelect={async () => {
          const res = await send('SELECT', plan, `Checking all ${plan.itemIds.length} posts again, then selecting their checkboxes on Facebook one at a time…`);
          if (res && !res.ok && !res.batch) {
            // A refused preflight changed nothing on Facebook: stay on the review with the new results.
            const q = queueOf(plan);
            if (res.preflight) {
              setPreflight(res.preflight);
              q?.onPreflight(res.preflight);
            } else if (q) q.onBack();
            else setPlan(planTo(plan, 'DRAFT'));
          }
        }}
      />
    );
  } else {
    const eligible = eligibleItems(safe.items);
    body = (
      <PlanView
        plan={plan}
        posts={plan ? itemsOf(plan.itemIds, plan.scanSessionId) : []}
        eligible={eligible.length}
        outside={eligible.filter((it) => !plan?.itemIds.includes(it.itemId!)).length}
        blocker={blocker}
        addNote={addNote && addNote.key === (plan?.itemIds.join(',') ?? '') ? addNote.text : null}
        onAddEligible={addEligibleToPlan}
        onRemove={(id) => {
          if (!plan || plan.state !== 'DRAFT') return;
          const next = removePlanItems(plan, [id]);
          setPlan(next.itemIds.length > 0 ? next : null);
        }}
        onClear={() => setPlan(null)}
        onReview={() => {
          if (!plan) return;
          const reviewed = planTo(plan, 'REVIEW');
          setPlan(reviewed);
          void runPreflight(reviewed);
        }}
      />
    );
  }

  const debugSnap = active ?? finished;
  const queueTitle = queueLink && (queuePlan || debugSnap?.batchId === queueLink.batchId) ? ` · ${queueLink.label}` : '';
  return (
    <section className="batch-panel">
      <h3>Cleanup batch{queueTitle}</h3>
      {actionState?.locked && <p className="error small">Actions are locked: {actionState.locked} Reload the Facebook tab, check it by hand, then scan again.</p>}
      {body}
      {note && !busy && <p className="small break">{note}</p>}
      {shownFailure && !busy && <FailureView f={shownFailure} />}
      <BatchDebug tabId={tabId} plan={plan} snap={debugSnap} byId={byId} scanSessionId={scanSessionId} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export type Post = { id: string; item: SafeItem | null };

const PHASE_TEXT: Record<BatchProgressPhase, string> = {
  PREFLIGHT: 'Preflight…',
  SELECTING: 'Selecting posts…',
  SELECTED: 'Posts selected.',
  UNSELECTING: 'Unselecting…',
  OPENING_DIALOG: "Clicking Facebook's Trash button, then waiting for its confirmation dialog…",
  AWAITING_FINAL_CONFIRMATION: "Facebook's dialog is open.",
  VERIFYING: 'Verifying removal…',
};

/** A step is running: what was asked, and (once the content script published it) its progress. Display only. */
function BusyView({ text, progress }: { text: string; progress: BatchProgress | null }) {
  return (
    <div className="progress-box" role="status" aria-live="polite">
      <p className="small muted">{text}</p>
      {progress && (
        <>
          <p><strong>{PHASE_TEXT[progress.phase]}</strong></p>
          {progress.total > 1 && (
            <>
              <progress value={progress.done} max={progress.total} />
              <p>
                <strong>{progress.done} / {progress.total}</strong>
                {progress.phase === 'VERIFYING' && <span className="muted small"> verified removed so far</span>}
              </p>
            </>
          )}
          {progress.currentItemId && <p className="small">Current: <code>{progress.currentItemId}</code></p>}
        </>
      )}
    </div>
  );
}

export function PostLine({ n, post, withLink, children }: { n: number; post: Post; withLink?: boolean; children?: ReactNode }) {
  const it = post.item;
  const href = it?.controls?.permalink.href ?? null;
  return (
    <li className="batch-post">
      <span className="muted">{n}.</span>{' '}
      <strong>{it?.date?.text ?? <span className="muted">date not detected</span>}</strong> <code className="small">{post.id}</code>
      <br />
      <span className="small break">{it ? clip(it.preview, 140) || <span className="muted">(no text)</span> : <span className="muted">not in the current scan</span>}</span>
      {withLink && href && (
        <>
          <br />
          <a className="small break" href={href} target="_blank" rel="noreferrer">{href}</a>
        </>
      )}
      {children}
    </li>
  );
}

/** Audience, evidence and checkbox confidence of one planned post, from the scan. */
export function PostMeta({ item }: { item: SafeItem | null }) {
  if (!item) return <span className="small muted">not in the current scan</span>;
  const cb = item.controls?.checkbox;
  const why = batchIneligibility(item);
  return (
    <span className="small">
      <span className="aud-ONLY_ME">{item.audience}</span> · {item.audienceBasis} · checkbox {cb?.confidence ?? '—'}
      {why && <span className="error"> · not eligible: {why}</span>}
    </span>
  );
}

function PlanView(p: {
  plan: BatchPlan | null;
  posts: Post[];
  eligible: number;
  outside: number;
  blocker: string | null;
  addNote: string | null;
  onAddEligible(): void;
  onRemove(id: string): void;
  onClear(): void;
  onReview(): void;
}) {
  const n = p.plan?.itemIds.length ?? 0;
  const full = n >= MAX_BATCH_SIZE;
  return (
    <>
      <p>
        <strong>{n} / {MAX_BATCH_SIZE} selected</strong> <span className="muted small">(extension plan only: Facebook is unchanged)</span>
      </p>
      <p className="small muted">
        {plural(p.eligible, 'eligible ONLY_ME post')} in the current scan{p.eligible > 0 ? `, ${p.outside} not in this batch` : ''}. Only loaded posts
        count: nothing is scrolled or loaded.
      </p>
      <div className="confirm-buttons batch-plan-buttons">
        <button
          className="secondary"
          disabled={!!p.blocker || full || p.outside === 0}
          onClick={p.onAddEligible}
          title={`Adds the currently scanned eligible ONLY_ME posts to this plan, in scan order, up to ${MAX_BATCH_SIZE}. No Facebook checkbox is clicked.`}
        >
          Add first {MAX_BATCH_SIZE} eligible
        </button>
      </div>
      {p.addNote && <p className="small">{p.addNote}</p>}
      {full && <p className="warn small">Maximum batch size reached ({MAX_BATCH_SIZE})</p>}
      {n === 0 && <p className="muted small">Tick "Add to batch" on ONLY_ME posts in the item list below, or add the first eligible ones.</p>}
      {n > 0 && (
        <ul className="batch-list batch-scroll">
          {p.posts.map((post) => (
            <li key={post.id}>
              <label className="batch-plan-item" title="Untick to remove it from the plan. Facebook is not changed.">
                <input type="checkbox" checked onChange={() => p.onRemove(post.id)} />
                <span className="batch-plan-text">
                  <span className="small">
                    <strong>{post.item?.date?.text ?? 'date not detected'}</strong> <code>{post.id}</code>
                  </span>
                  <span className="small break muted">{post.item ? clip(post.item.preview, 90) || '(no text)' : ''}</span>
                  <PostMeta item={post.item} />
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {p.blocker && n > 0 && <p className="muted small">Review unavailable: {p.blocker}</p>}
      <div className="confirm-buttons">
        <button className="secondary" disabled={n === 0} onClick={p.onClear}>
          Clear all
        </button>
        <button className="confirm-go" disabled={n === 0 || !!p.blocker} onClick={p.onReview}>
          Review batch
        </button>
      </div>
    </>
  );
}

const CHECK_LABELS: Record<PreflightCheckKey, string> = {
  onlyMeStrong: 'ONLY_ME strong',
  checkboxHigh: 'Checkbox HIGH',
  identityUnchanged: 'Identity unchanged',
  currentlyUnchecked: 'Currently unchecked',
};

/** The live preflight: counts per check group, failed items, page problems. */
function PreflightView({ pf, posts }: { pf: BatchPreflight; posts: Post[] }) {
  const n = pf.items.length;
  const failedItems = pf.items.filter((i) => !i.ok);
  return (
    <div className={`outcome ${pf.ok ? 'ok-box' : 'error-box'}`}>
      <p className={pf.ok ? 'ok' : ''}>
        <strong>Batch preflight</strong> <span className="muted small">live, read-only · {new Date(pf.checkedAt).toLocaleTimeString()}</span>
      </p>
      <table className="kv preflight">
        <tbody>
          <tr><th>Ready</th><td className={pf.ready === n ? 'ok' : ''}>{pf.ready}</td></tr>
          <tr><th>Failed</th><td className={pf.failed === 0 ? '' : 'error'}>{pf.failed}</td></tr>
          {PREFLIGHT_CHECK_KEYS.map((k) => {
            const pass = pf.items.filter((i) => i.checks[k] === true).length;
            const unknown = pf.items.filter((i) => i.checks[k] === null).length;
            return (
              <tr key={k}>
                <th>{CHECK_LABELS[k]}</th>
                <td className={pass === n ? 'ok' : 'error'}>
                  {pass} / {n}
                  {unknown > 0 && <span className="muted small"> ({unknown} not evaluated)</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {pf.pageProblems.length > 0 && (
        <ul className="small error">
          {pf.pageProblems.map((x, i) => <li key={i} className="break">{x}</li>)}
        </ul>
      )}
      {pf.warnings.length > 0 && (
        <ul className="small warn">
          {pf.warnings.map((x, i) => <li key={i} className="break">{x}</li>)}
        </ul>
      )}
      {failedItems.length > 0 && (
        <table className="grid">
          <thead><tr><th>Failed item</th><th>Reason</th></tr></thead>
          <tbody>
            {failedItems.map((c) => (
              <tr key={c.itemId}>
                <td>
                  <code>{c.itemId}</code>
                  <br />
                  <span className="small">{posts.find((x) => x.id === c.itemId)?.item?.date?.text ?? ''}</span>
                </td>
                <td className="error">{c.code}<br /><span className="small break">{c.error}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ReviewScreen(p: {
  plan: BatchPlan;
  posts: Post[];
  currentScan: boolean;
  blocker: string | null;
  preflight: BatchPreflight | null;
  backLabel: string;
  onRecheck(): void;
  onCancel(): void;
  onRemoveFailed(ids: string[]): void;
  onSelect(): void;
}) {
  const n = p.plan.itemIds.length;
  const all = (ok: (it: SafeItem) => boolean) => p.posts.every((x) => x.item !== null && ok(x.item));
  const checks: [string, boolean][] = [
    ['ONLY_ME', all((it) => it.audience === 'ONLY_ME')],
    ['strong audience evidence', all((it) => it.audienceBasis === 'strong')],
    ['HIGH-confidence checkbox', all((it) => it.controls?.checkbox.confidence === 'HIGH' && it.controls.checkbox.ambiguousCandidates === 0)],
    ['post link to verify with', all((it) => !!it.controls?.permalink.href)],
    ['from the current scan', p.currentScan && p.posts.every((x) => x.item !== null)],
  ];
  const scanOk = checks.every(([, v]) => v) && n > 0 && n <= MAX_BATCH_SIZE;
  const pf = p.preflight;
  const ok = scanOk && !!pf && pf.ok && !p.blocker;
  const failedIds = pf ? pf.items.filter((i) => !i.ok).map((i) => i.itemId) : [];
  return (
    <div className="confirm danger-box" role="alertdialog" aria-label={`Review ${n} posts`}>
      <p><strong>Move {plural(n, 'Facebook post')} to Trash?</strong></p>
      <p className="small">In the scan, all {n} are:</p>
      <ul className="checks small">
        {checks.map(([label, v]) => (
          <li key={label} className={v ? 'ok' : 'error'}>{v ? '✓' : '✗'} {label}</li>
        ))}
      </ul>
      {pf ? <PreflightView pf={pf} posts={p.posts} /> : <p className="muted small">No live preflight for this batch yet.</p>}
      <p className="small">Posts:</p>
      <ol className="batch-review batch-scroll">
        {p.posts.map((post, i) => <PostLine key={post.id} n={i + 1} post={post} withLink />)}
      </ol>
      <p className="small"><strong>No other posts will be selected.</strong></p>
      <p className="small muted">
        The select button is only enabled when every one of the {n} posts passed the live preflight. It then ticks
        these {n} checkboxes on Facebook, one at a time, after checking every one of them again. Nothing is moved
        until you confirm twice more.
      </p>
      {p.blocker && <p className="warn small">Cannot continue: {p.blocker}</p>}
      <div className="confirm-buttons batch-plan-buttons">
        {failedIds.length > 0 && (
          <button className="secondary small" onClick={() => p.onRemoveFailed(failedIds)} title="Removes them from the extension plan only">
            Remove {plural(failedIds.length, 'failed post')} from the {p.backLabel === 'Back to plan' ? 'plan' : 'batch'}
          </button>
        )}
        <button className="secondary small" disabled={!!p.blocker} onClick={p.onRecheck}>
          {pf ? 'Re-run preflight' : 'Run preflight'}
        </button>
      </div>
      <div className="confirm-buttons">
        <button className="secondary" autoFocus onClick={p.onCancel}>
          {p.backLabel}
        </button>
        <button className="confirm-go" disabled={!ok} onClick={p.onSelect}>
          Select these {plural(pf?.ready ?? n, 'post')}
        </button>
      </div>
    </div>
  );
}

function masterText(m: string): string {
  return m === 'mixed' ? 'indeterminate' : m;
}

function SelectionTable({ snap }: { snap: BatchSnapshot }) {
  const v = snap.selection;
  if (!v) return null;
  const nt = v.nonTargetRows;
  const o = v.otherCheckboxes;
  return (
    <table className="kv">
      <tbody>
        <tr><th>Targets selected</th><td className={v.targetsSelected === v.expected ? 'ok' : 'error'}>{v.targetsSelected} / {v.expected}</td></tr>
        <tr>
          <th>Non-target rows</th>
          <td className={nt.selected === 0 ? '' : 'error'}>
            {nt.selected === 0 ? 'unchanged' : `${nt.selected} SELECTED (${nt.selectedIds.join(', ')})`}
            <span className="muted"> ({nt.compared} compared{nt.missing > 0 ? `, ${nt.missing} not on the page` : ''})</span>
          </td>
        </tr>
        <tr>
          <th>Other checkboxes</th>
          <td className={o.changed === 0 ? '' : 'error'}>{o.changed} changed <span className="muted">({o.compared} compared{o.disappeared > 0 ? `, ${o.disappeared} left the page` : ''})</span></td>
        </tr>
        <tr><th>Target identity</th><td className={v.staleTargets.length === 0 ? '' : 'error'}>{v.staleTargets.length === 0 ? 'all proven unchanged' : `NOT PROVEN: ${v.staleTargets.join(', ')}`}</td></tr>
        <tr><th>Rows re-rendered</th><td className={v.rowsLeft.length === 0 ? '' : 'error'}>{v.rowsLeft.length === 0 ? 'none' : v.rowsLeft.join(', ')}</td></tr>
        <tr><th>Master checkbox</th><td className={v.masterState === 'checked' ? 'error' : ''}>{masterText(v.masterState)}</td></tr>
        <tr><th>URL</th><td className={v.urlUnchanged ? '' : 'error'}>{v.urlUnchanged ? 'unchanged' : 'CHANGED'}</td></tr>
      </tbody>
    </table>
  );
}

/** Facebook's own "N selected" text, if one was read. Diagnostic only: never used for safety. */
function VisibleCount({ toolbar, expected }: { toolbar: ToolbarDiscovery; expected: number }) {
  const texts = toolbar.countTexts ?? [];
  if (texts.length === 0) return <p className="muted small">Facebook's own count text: not detected (diagnostic only).</p>;
  const match = toolbar.visibleCount === expected;
  return (
    <p className="muted small">
      Facebook's own count text: {texts.map((t) => `"${t}"`).join(', ')}
      {toolbar.visibleCount !== null && <span className={match ? '' : 'warn'}> ({match ? 'matches' : `≠ ${expected}`})</span>}. Diagnostic only; the
      checkbox count is authoritative.
    </p>
  );
}

type ToolbarCheck = { kind: 'loading' } | { kind: 'ok'; toolbar: ToolbarDiscovery } | { kind: 'error'; message: string };

/** After the posts are selected: our second confirmation, with a live, read-only toolbar check. */
function SecondConfirm(p: { snap: BatchSnapshot; posts: Post[]; tabId: number | null; onUnselect(): void; onContinue(): void }) {
  const { snap, tabId } = p;
  const n = snap.itemIds.length;
  const [check, setCheck] = useState<ToolbarCheck>(snap.toolbar ? { kind: 'ok', toolbar: snap.toolbar } : { kind: 'loading' });

  function recheck() {
    if (tabId === null) return;
    setCheck({ kind: 'loading' });
    fetchToolbar(tabId, snap.scanSessionId).then(
      (toolbar) => setCheck({ kind: 'ok', toolbar }),
      (e: unknown) => setCheck({ kind: 'error', message: e instanceof Error ? e.message : String(e) }),
    );
  }
  useEffect(recheck, [tabId, snap.scanSessionId]);

  const master = check.kind === 'ok' ? check.toolbar.masterState : null;
  const notReady =
    check.kind === 'ok'
      ? master === 'checked'
        ? "Facebook's select-all checkbox is fully checked (MASTER_FULLY_SELECTED): Cancel and unselect"
        : toolbarReady(check.toolbar, n)
      : check.kind === 'error'
        ? check.message
        : 'checking…';
  const verified = snap.selection && snap.selection.unexpected.length === 0;
  return (
    <>
      <div className={`outcome ${verified ? 'ok-box' : 'error-box'}`}>
        <p className={verified ? 'ok' : ''}><strong>{verified ? 'Batch selection verified' : 'Batch selection NOT verified'}</strong></p>
        <SelectionTable snap={snap} />
      </div>
      <div className="confirm danger-box" role="alertdialog" aria-label={`Move these ${n} posts to Trash`}>
        <p><strong>Move these {n} posts to Trash?</strong></p>
        <p className="small">Facebook currently has exactly {n} target posts selected.</p>
        <ol className="batch-review batch-scroll">
          {p.posts.map((post, i) => <PostLine key={post.id} n={i + 1} post={post} />)}
        </ol>
        <h4>Facebook toolbar (checked now)</h4>
        {check.kind === 'loading' && <p className="muted small">Checking the toolbar…</p>}
        {check.kind === 'error' && <p className="error small">{check.message}</p>}
        {check.kind === 'ok' && (
          <>
            <ToolbarChecklist toolbar={check.toolbar} expected={n} />
            <VisibleCount toolbar={check.toolbar} expected={n} />
          </>
        )}
        {check.kind !== 'loading' && notReady && <p className="warn small">Cannot continue: {notReady}.</p>}
        <p className="small muted">
          Continue clicks Facebook's Trash ("Bỏ đi") button once and stops at Facebook's confirmation dialog. You will be asked
          again before that dialog is confirmed.
        </p>
        <div className="confirm-buttons">
          <button className="secondary small" onClick={recheck} disabled={check.kind === 'loading'}>
            Re-check
          </button>
          <button className="secondary" autoFocus onClick={p.onUnselect}>
            Cancel and unselect
          </button>
          <button className="danger" disabled={notReady !== null || !verified} onClick={p.onContinue}>
            Continue to Facebook confirmation
          </button>
        </div>
      </div>
    </>
  );
}

function FinalConfirm(p: { snap: BatchSnapshot; onCancel(): void; onConfirm(): void }) {
  const { snap } = p;
  const n = snap.itemIds.length;
  const d = snap.dialog;
  const confirmName = d?.buttons.find((b) => b.role === 'confirm')?.name ?? 'confirm';
  const high = d?.confirm.confidence === 'HIGH';
  return (
    <div className="confirm danger-box" role="alertdialog" aria-label="Facebook is asking for confirmation">
      <p><strong>Facebook is asking for confirmation.</strong></p>
      <table className="kv">
        <tbody>
          <tr><th>Batch</th><td>{n} posts</td></tr>
          <tr><th>Dialog</th><td>{d?.name ? `"${d.name}"` : <span className="muted">(no name)</span>}</td></tr>
          <tr><th>Confirm</th><td className={high ? 'ok' : 'error'}>{d?.confirm.confidence ?? 'missing'}</td></tr>
          <tr><th>Cancel</th><td className={d?.cancel.confidence === 'HIGH' ? 'ok' : 'warn'}>{d?.cancel.confidence ?? 'missing'}</td></tr>
        </tbody>
      </table>
      {d && (
        <details>
          <summary className="small muted">Dialog details</summary>
          <DialogView dialog={d} />
        </details>
      )}
      <p className="small">
        Only after you press Confirm will the extension click Facebook's "{confirmName}" button, once, after checking all {n} posts again.
      </p>
      <div className="confirm-buttons">
        <button className="secondary" autoFocus onClick={p.onCancel}>
          Cancel
        </button>
        <button className="danger" disabled={!high} onClick={p.onConfirm}>
          Confirm move {n} posts to Trash
        </button>
      </div>
    </div>
  );
}

const RESULT_TITLE: Partial<Record<BatchState, string>> = {
  SUCCESS: 'Moved to Trash (verified)',
  PARTIAL: 'PARTIAL: only some posts were verified as removed',
  INCONCLUSIVE: 'INCONCLUSIVE: could not verify the result',
  FAILED: 'FAILED',
  CANCELLED: 'Batch cancelled: every post was unselected (verified)',
};

type VerifiedItem = NonNullable<BatchSnapshot['verification']>['items'][number];

function yesNo(v: boolean | null): string {
  return v === null ? '—' : v ? 'yes' : 'no';
}

/** Per target: every signal the removal decision used. Diagnostic, to understand Facebook's re-rendering. */
function VerificationDetails({ items }: { items: VerifiedItem[] }) {
  return (
    <details>
      <summary className="small muted">Target verification details</summary>
      <div className="batch-scroll">
        <table className="grid">
          <thead>
            <tr>
              <th>Target</th><th>Target link on page</th><th>Original row connected</th><th>Current row permalink</th>
              <th>Row post-like</th><th>Row identity</th><th>Neighbours listed</th><th>Result</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.itemId}>
                <td><code>{i.itemId}</code></td>
                <td>{yesNo(!i.permalinkAbsent)}</td>
                <td>{yesNo(!i.rowDisconnected)}</td>
                <td className="break">
                  {i.rowDisconnected ? '—' : i.currentRowPermalink ?? 'none'}
                  {i.currentRowPostUrls !== null && i.currentRowPostUrls > 0 && <span className="muted"> ({i.currentRowPostUrls} post URL{i.currentRowPostUrls === 1 ? '' : 's'})</span>}
                </td>
                <td>{yesNo(i.currentRowPostLike)}</td>
                <td>{i.rowIdentity ?? '—'}</td>
                <td>{i.neighboursListed === null ? 'none' : yesNo(i.neighboursListed)}</td>
                <td className={i.outcome === 'REMOVED' ? 'ok' : 'error'}>{i.outcome}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export function ResultView(p: { snap: BatchSnapshot; posts: Post[]; onBackToPlan: (() => void) | null; onClear: (() => void) | null }) {
  const { snap } = p;
  const v = snap.verification;
  const ok = snap.state === 'SUCCESS' || snap.state === 'CANCELLED';
  const rb = snap.rollback;
  const trashed = v !== null;
  return (
    <div className={`outcome ${ok ? 'ok-box' : 'error-box'}`}>
      <p className={ok ? 'ok' : ''}>
        <strong>{RESULT_TITLE[snap.state] ?? snap.state}</strong>
        {snap.lastError && <code className="small"> {snap.lastError.code}</code>}
      </p>
      {snap.lastError && <p className="small break">{snap.lastError.error}</p>}

      {v && (
        <>
          <table className="kv">
            <tbody>
              <tr><th>Removed</th><td className={v.removed === v.items.length ? 'ok' : 'error'}>{v.removed} / {v.items.length}</td></tr>
              <tr><th>Still present</th><td className={v.stillPresent === 0 ? '' : 'error'}>{v.stillPresent}</td></tr>
              <tr><th>Uncertain</th><td className={v.uncertain === 0 ? '' : 'error'}>{v.uncertain}</td></tr>
              <tr>
                <th>Other rows retained</th>
                <td className={v.otherRows.missing === 0 ? 'ok' : 'error'}>
                  {v.otherRows.missing === 0 ? 'yes' : 'NO'} ({v.otherRows.connected} unchanged, {v.otherRows.rerendered} re-rendered, {v.otherRows.missing} missing of {v.otherRows.total})
                </td>
              </tr>
              <tr><th>Selected count</th><td className={v.selectedCount === 0 ? 'ok' : 'error'}>{v.selectedCount}</td></tr>
              <tr><th>URL unchanged</th><td className={v.urlUnchanged ? 'ok' : 'error'}>{v.urlUnchanged ? 'yes' : 'no'}</td></tr>
              <tr><th>Facebook dialog closed</th><td className={v.dialogClosed ? 'ok' : 'error'}>{v.dialogClosed ? 'yes' : 'no'}</td></tr>
              <tr><th>Waited</th><td>{v.waitedMs} ms</td></tr>
            </tbody>
          </table>
          <div className="batch-scroll">
            <table className="grid">
              <thead><tr><th>#</th><th>Target</th><th>Date</th><th>Result</th></tr></thead>
              <tbody>
                {v.items.map((i, k) => {
                  const post = p.posts.find((x) => x.id === i.itemId);
                  return (
                    <tr key={i.itemId}>
                      <td>{k + 1}</td>
                      <td><code>{i.itemId}</code></td>
                      <td>{post?.item?.date?.text ?? '—'}</td>
                      <td className={i.outcome === 'REMOVED' ? 'ok' : 'error'}>
                        {i.outcome}
                        <br />
                        <span className="small muted">{i.reason}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <VerificationDetails items={v.items} />
          {v.notes.length > 0 && (
            <ul className="small">
              {v.notes.map((n, i) => <li key={i} className="break">{n}</li>)}
            </ul>
          )}
        </>
      )}

      {rb && !trashed && <RollbackTable rb={rb} />}

      <p className="small">
        {trashed
          ? snap.state === 'SUCCESS'
            ? 'This scan is now used up. Scan again before doing anything else.'
            : "A full rescan is required. Nothing will be retried automatically. Check Facebook's Trash and the Activity Log yourself."
          : snap.state === 'CANCELLED'
            ? 'Nothing was moved. The plan can be reviewed again (as a new batch).'
            : 'Nothing was moved to Trash.'}
      </p>
      <div className="confirm-buttons">
        {p.onBackToPlan && (
          <button className="secondary" onClick={p.onBackToPlan}>
            Back to plan (new batch)
          </button>
        )}
        {p.onClear && (
          <button className="secondary" onClick={p.onClear}>
            {trashed ? 'Done' : 'Clear batch'}
          </button>
        )}
      </div>
    </div>
  );
}

function RollbackTable({ rb }: { rb: NonNullable<BatchSnapshot['rollback']> }) {
  return (
    <table className="kv">
      <tbody>
        <tr><th>Selected before</th><td>{rb.selectedBeforeFailure.length} {rb.selectedBeforeFailure.length > 0 && <span className="muted small">({rb.selectedBeforeFailure.join(', ')})</span>}</td></tr>
        <tr><th>Unselected</th><td className={rb.rolledBack.length === rb.selectedBeforeFailure.length ? 'ok' : 'error'}>{rb.rolledBack.length} / {rb.selectedBeforeFailure.length}</td></tr>
        <tr>
          <th>Failures</th>
          <td className={rb.rollbackFailures.length === 0 ? 'ok' : 'error'}>
            {rb.rollbackFailures.length === 0 ? 'none' : rb.rollbackFailures.map((f) => `${f.itemId}: ${f.reason}`).join('; ')}
          </td>
        </tr>
        <tr><th>Complete</th><td className={rb.complete ? 'ok' : 'error'}>{rb.complete ? 'yes' : 'NO: actions locked until the Facebook tab is reloaded'}</td></tr>
      </tbody>
    </table>
  );
}

function FailureView({ f }: { f: UiFailure }) {
  return (
    <div className="outcome error-box">
      <p>
        <strong>{f.clicked ? 'Warning: stopped after a click on Facebook' : 'Refused (nothing was clicked)'}</strong>
        {f.code && <code className="small"> {f.code}</code>}
      </p>
      <p className="small break">{f.error}</p>
      {f.preflight && (
        <p className="small">
          Preflight: {f.preflight.ready} ready, {f.preflight.failed} failed{f.preflight.pageProblems.length > 0 ? ', page not ready' : ''}. Details are in the
          batch preflight above.
        </p>
      )}
    </div>
  );
}

/** Diagnostic: ids, states, per-item audience / checkbox and what Facebook shows as selected. No Facebook content. */
function BatchDebug(p: { tabId: number | null; plan: BatchPlan | null; snap: BatchSnapshot | null; byId: Map<string, SafeItem>; scanSessionId: string | null }) {
  const { snap, plan } = p;
  const ids = snap?.itemIds ?? plan?.itemIds ?? [];
  const sid = snap?.scanSessionId ?? plan?.scanSessionId ?? null;
  const selected = new Map(snap?.selection?.targets.map((t) => [t.itemId, t.state]) ?? []);
  const highlight: PopupRequest | null =
    p.tabId !== null && sid && sid === p.scanSessionId && ids.length > 0 && ids.length <= MAX_BATCH_SIZE
      ? { type: 'FPC_BATCH_HIGHLIGHT_TAB', tabId: p.tabId, scanSessionId: sid, itemIds: ids }
      : null;
  const pr = snap?.progress;
  return (
    <details className="batch-debug">
      <summary className="small">Batch debug</summary>
      <table className="kv">
        <tbody>
          <tr><th>Batch ID</th><td><code>{snap?.batchId ?? plan?.batchId ?? '—'}</code></td></tr>
          <tr><th>State</th><td>{snap?.state ?? plan?.state ?? '—'}{snap && plan && snap.batchId !== plan.batchId ? ` (plan ${plan.state})` : ''}</td></tr>
          <tr><th>Size</th><td>{ids.length} / {MAX_BATCH_SIZE}</td></tr>
          <tr><th>Scan session</th><td><code>{sid ? sid.slice(0, 8) : '—'}</code></td></tr>
          <tr><th>Progress</th><td>{pr ? `${pr.phase} ${pr.done} / ${pr.total}${pr.currentItemId ? ` (${pr.currentItemId})` : ''}` : '—'}</td></tr>
          <tr><th>Preflight</th><td>{snap?.preflight ? `${snap.preflight.ready} ready, ${snap.preflight.failed} failed` : '—'}</td></tr>
          <tr><th>Item IDs</th><td className="break">{ids.join(', ') || '—'}</td></tr>
        </tbody>
      </table>
      {ids.length > 0 && (
        <div className="batch-scroll">
          <table className="grid">
            <thead><tr><th>Item</th><th>Audience</th><th>Checkbox</th><th>Facebook selected</th></tr></thead>
            <tbody>
              {ids.map((id) => {
                const it = sid === p.scanSessionId ? p.byId.get(id) : undefined;
                const st = selected.get(id);
                return (
                  <tr key={id}>
                    <td><code>{id}</code></td>
                    <td>{it ? AUDIENCE_LABELS[it.audience] : '—'}</td>
                    <td>{it?.controls?.checkbox.confidence ?? '—'}</td>
                    <td className={st === 'checked' ? 'ok' : ''}>{st === 'checked' ? '✓' : st ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {snap?.selection && <p className="small">Non-target selected: {snap.selection.nonTargetRows.selected}</p>}
      {snap && (
        <p className="small muted break">
          History: {snap.history.map((h) => `${h.state} ${new Date(h.at).toLocaleTimeString()}`).join(' → ')}
        </p>
      )}
      <HighlightButton request={highlight} label="Highlight batch checkboxes" />
    </details>
  );
}
