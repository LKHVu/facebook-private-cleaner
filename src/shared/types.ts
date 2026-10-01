// Types shared by the popup, the background service worker and the content script.
// Everything here must stay JSON-serialisable: it crosses chrome.runtime messaging.

export type Audience = 'ONLY_ME' | 'FRIENDS' | 'PUBLIC' | 'UNKNOWN';

export const AUDIENCES: readonly Audience[] = ['ONLY_ME', 'FRIENDS', 'PUBLIC', 'UNKNOWN'];

/**
 * Bump whenever ScanResult / ScannedItem or a content-script message changes shape. A Facebook tab keeps running the
 * scanner an older build injected until the extension is reloaded and the tab refreshed,
 * so the popup compares this with ScanResult.protocol before trusting the data.
 */
export const SCANNER_PROTOCOL = 12;

/** Where a piece of evidence was read from. */
export type EvidenceSource =
  | 'aria-label'
  | 'aria-labelledby'
  | 'title-attr'
  | 'tooltip-attr'
  | 'img-alt'
  | 'svg-title'
  | 'visible-text';

/**
 * strong = an accessibility label / tooltip, which Facebook uses to name the
 *          audience icon ("Shared with Only me").
 * weak   = a short piece of visible text that happens to equal an audience name.
 */
export type EvidenceStrength = 'strong' | 'weak';

export interface AudienceEvidence {
  source: EvidenceSource;
  strength: EvidenceStrength;
  /** The original string as found in the DOM (truncated). */
  rawValue: string;
  /** The normalised phrase that was looked up in the audience dictionary. */
  phrase: string;
  /** The audience this evidence points to, or null if recognised-but-unmapped (e.g. "Custom"). */
  matched: Audience | null;
  /** false = looked like an audience label ("Shared with X") but X is not in the dictionary. */
  recognized: boolean;
  /** Human-readable explanation of which rule fired. */
  rule: string;
  /** Short description of the element the evidence came from. */
  element: string;
  /** True if this evidence contributed to the final decision. */
  used: boolean;
}

/**
 * Which evidence tier decided the audience: strong = accessibility labels / tooltips,
 * weak = visible text only, none = no matching evidence (always UNKNOWN).
 */
export type AudienceBasis = 'strong' | 'weak' | 'none';

/** Best-effort, display-only date of an item. Never used to identify a post. */
export interface ItemDate {
  text: string;
  /** Where the text was read from, e.g. "time[datetime]" or "day heading + time text". */
  source: string;
}

/** A raw label string found inside an item, with where it came from. */
export interface LabelSeen {
  source: EvidenceSource;
  value: string;
}

export interface ScannedItem {
  index: number;
  /**
   * Key into the content script's scan-session map (scanSessionId + itemId -> the exact
   * DOM element this item was built from). Only meaningful together with ScanResult.scanSessionId.
   */
  itemId: string;
  audience: Audience;
  /** Why the item got its audience. */
  reason: string;
  /** Evidence tier behind `audience`. V1A only acts on ONLY_ME items decided by strong evidence. */
  audienceBasis: AudienceBasis;
  /** Best-effort date for display in confirmations, or null if none was detected. */
  date: ItemDate | null;
  /** First ~200 chars of the item's visible text. */
  preview: string;
  /** Best-guess link to the post, if one was found. */
  permalink: string | null;
  /** Short description of the container element. */
  container: string;
  evidence: AudienceEvidence[];
  /** Every aria-label/title/alt/svg-title value inside the item (deduped, capped) – for tuning selectors. */
  labelsSeen: LabelSeen[];
  /** Short visible text fragments inside the item (deduped, capped). */
  visibleLabels: string[];
  /** V0.5 control discovery inside this exact row. Diagnostic only: never affects `audience`. */
  controls: RowControls;
}

// ---------------------------------------------------------------------------
// Control discovery (V0.5, read-only)
// ---------------------------------------------------------------------------

/** Controls whose DOM element the content script keeps, so the popup can ask to highlight them. */
export type ControlKind = 'checkbox' | 'menuButton' | 'viewButton' | 'audienceIndicator';

export const CONTROL_KINDS: readonly ControlKind[] = ['checkbox', 'menuButton', 'viewButton', 'audienceIndicator'];

export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface ControlDiscovery {
  found: boolean;
  /** null when not found. */
  confidence: Confidence | null;
  /** Human-readable explanation of which rule picked (or failed to pick) the control. */
  reason: string;
  /** `${itemId}:${kind}` when found; the popup highlights by itemId + kind, this is informational. */
  controlId: string | null;
  /** Short description of the chosen element, or null. */
  element: string | null;
  /** Signals seen on the chosen control, or on the candidates when none was chosen. */
  signals: string[];
  /** Elements that survived filtering for this control. */
  candidates: number;
  /** > 0 when several candidates matched equally well, so none was chosen. */
  ambiguousCandidates: number;
  /** Short descriptions of the candidates (capped). */
  candidateDescriptions: string[];
}

export interface PermalinkDiscovery {
  found: boolean;
  confidence: Confidence | null;
  href: string | null;
  reason: string;
  /** > 0 when several distinct post URLs were found and none was chosen. */
  ambiguousCandidates: number;
  /** Distinct post-URL hrefs found in the row (capped). */
  candidateHrefs: string[];
}

/** One interactive element inside a row, with the signals control discovery looked at. */
export interface InteractiveElementInfo {
  element: string;
  /** Accessible name as computed by control discovery (truncated). */
  name: string;
  /** Where the name came from: aria-labelledby, aria-label, label, text, title, svg-title, img-alt, none. */
  nameSource: string;
  /** e.g. "aria-haspopup=menu", "aria-expanded=false", "icon-only", "not rendered". */
  signals: string[];
  /** Which control discovery assigned this element to, if any. */
  assignedTo: ControlKind | null;
}

export interface RowControls {
  checkbox: ControlDiscovery;
  menuButton: ControlDiscovery;
  viewButton: ControlDiscovery;
  audienceIndicator: ControlDiscovery;
  permalink: PermalinkDiscovery;
  /** Interactive elements inside the row (capped at a few dozen). */
  interactive: InteractiveElementInfo[];
  /** Interactive elements inside the row before capping. */
  interactiveTotal: number;
}

/** A row a strategy found but then rejected as a page control (e.g. the bulk-selection toolbar). */
export interface RejectedCandidate {
  reason: string;
  preview: string;
  container: string;
}

export interface StrategyAttempt {
  id: string;
  description: string;
  /** Rows find() returned, before rejecting non-item controls. */
  candidates: number;
  /** Candidates dropped as non-item controls; candidates - rejected.length === count. */
  rejected: RejectedCandidate[];
  /** Items this strategy yields. */
  count: number;
}

export type AudienceCounts = Record<Audience, number>;

export interface ScanResult {
  /** SCANNER_PROTOCOL of the scanner that produced this result. */
  protocol: number;
  /** Identifies this scan's element map in the content script; a newer scan or a page reload invalidates it. */
  scanSessionId: string;
  url: string;
  pageKind: 'ACTIVITY_LOG' | 'OTHER_FACEBOOK';
  scannedAt: string;
  durationMs: number;
  root: string;
  /** Strategy used to split the page into items, or null if none found anything. */
  strategy: string | null;
  strategyWasForced: boolean;
  attempts: StrategyAttempt[];
  total: number;
  counts: AudienceCounts;
  items: ScannedItem[];
  /** Most frequent label strings on the page – helps when Facebook changes its DOM. */
  labelInventory: { value: string; count: number }[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// V1A checkbox action (select / unselect one post)
// ---------------------------------------------------------------------------

export type CheckboxAction = 'SELECT_CHECKBOX' | 'UNSELECT_CHECKBOX';

export interface CheckboxActionRequest {
  /** SCANNER_PROTOCOL of the popup; the content script refuses a mismatch. */
  protocol: number;
  scanSessionId: string;
  itemId: string;
  action: CheckboxAction;
  /** Must be true: set only by the popup's confirmation step. */
  confirmed: boolean;
}

/** missing = the element is no longer connected to the page. unknown = no readable or a self-contradicting state. */
export type CheckState = 'checked' | 'unchecked' | 'mixed' | 'unknown' | 'missing';

export interface CheckboxStateChange {
  before: CheckState;
  after: CheckState;
  /** Whether `after` is an allowed outcome for this checkbox. */
  ok: boolean;
  /** What was allowed, e.g. "unchanged" or "checked". */
  expected: string;
}

export interface CheckboxVerification {
  target: CheckboxStateChange;
  /** null = no previous / next row in the scan, or that row has no stored checkbox. */
  previousRow: CheckboxStateChange | null;
  nextRow: CheckboxStateChange | null;
  /** null = the master "select all" checkbox was not found, so it could not be checked directly. */
  master: CheckboxStateChange | null;
  masterNote: string;
  /** Every other checkbox on the page, compared before and after. */
  otherCheckboxes: { compared: number; changed: number; disappeared: number };
  urlUnchanged: boolean;
  /** Empty when everything matched expectations. Anything here locks further actions. */
  unexpected: string[];
}

export type ActionErrorCode =
  | 'PROTOCOL_MISMATCH'
  | 'UNKNOWN_ACTION'
  | 'NOT_CONFIRMED'
  | 'BUSY'
  | 'LOCKED'
  | 'STALE_SESSION'
  | 'NAVIGATED'
  | 'ITEM_NOT_FOUND'
  | 'ROW_DISCONNECTED'
  | 'NOT_ONLY_ME'
  | 'WEAK_EVIDENCE'
  | 'CLASSIFICATION_CHANGED'
  | 'CHECKBOX_NOT_HIGH'
  | 'CHECKBOX_MISSING'
  | 'CHECKBOX_DISCONNECTED'
  | 'CHECKBOX_OUTSIDE_ROW'
  | 'ROWS_OVERLAP'
  | 'SELECT_ALL_CONTROL'
  | 'AMBIGUOUS'
  | 'ROW_IDENTITY_CHANGED'
  | 'NOT_SELECTED_BY_EXTENSION'
  | 'STATE_UNREADABLE'
  | 'ALREADY_IN_STATE'
  | 'DISABLED'
  | 'PAGE_STATE_UNEXPECTED'
  | 'VERIFICATION_FAILED'
  | 'TRASH_PENDING'
  /** A V2A cleanup batch is selecting, selected, or waiting at / past Facebook's dialog. */
  | 'BATCH_ACTIVE'
  /** V3A: older Activity Log entries are being loaded (the page is scrolling and changing). */
  | 'AUTOLOAD_ACTIVE'
  | 'INTERNAL_ERROR';

export interface ActionLogEntry {
  timestamp: string;
  scanSessionId: string;
  /** One itemId; for a batch-wide entry every item id on BATCH_CREATED, otherwise "(N items)" (compact for large batches). */
  itemId: string;
  action: CheckboxAction | string;
  /** The scan-time classification, or null when the item wasn't found. */
  classification: Audience | null;
  checkboxConfidence: Confidence | null;
  /** SUCCESS, REFUSED:<code>, or UNEXPECTED:<code>. Never contains Facebook content. */
  result: string;
  /** V2A batch entries only. */
  batchId?: string;
  batchState?: BatchState;
  count?: number;
  /** V3A auto-load entries only: counts and the stop reason, never Facebook content. */
  autoLoad?: {
    runId: string;
    rows: number;
    addedRows: number;
    attempts: number;
    elapsedMs: number;
    stopReason: AutoLoadStopReason | null;
  };
}

export interface CheckboxActionSuccess {
  ok: true;
  success: true;
  action: CheckboxAction;
  itemId: string;
  /** The target checkbox's state after the action. */
  checked: boolean;
  verification: CheckboxVerification;
  log: ActionLogEntry[];
}

export interface CheckboxActionFailure {
  ok: false;
  success: false;
  code: ActionErrorCode;
  error: string;
  /** The popup should ask for a new scan before trying again. */
  needsRescan: boolean;
  /** Further actions are refused until the Facebook tab is reloaded. */
  locked: boolean;
  /** Present when the click happened and the result was then checked. */
  verification: CheckboxVerification | null;
  log: ActionLogEntry[];
}

export type CheckboxActionResponse = CheckboxActionSuccess | CheckboxActionFailure;

/** A V1B Trash flow waiting for the user's second confirmation (Facebook's dialog is open). */
export interface PendingTrashInfo {
  scanSessionId: string;
  itemId: string;
  pendingId: string;
  since: string;
}

export interface ActionState {
  /** Why actions are locked, or null. */
  locked: string | null;
  log: ActionLogEntry[];
  /** Scan sessions used up by a Trash attempt: every action on them is refused until a new scan. */
  retiredSessions: string[];
  pendingTrash: PendingTrashInfo | null;
  /** The V2A batch in progress, or the last one that finished (see isBatchActive). */
  batch: BatchSnapshot | null;
  /** V3A: the auto-load run in progress, or the last one that finished (see isAutoLoadActive). */
  autoLoad: AutoLoadSnapshot | null;
  /**
   * V4: document.visibilityState === 'visible' in the Facebook tab. A cleanup run starts a batch
   * only while it is true (Facebook may be throttled in a hidden tab). Read-only.
   */
  pageVisible: boolean;
}

// ---------------------------------------------------------------------------
// V1B: the bulk toolbar and Facebook's Trash confirmation dialog (discovery is read-only)
// ---------------------------------------------------------------------------

export type BulkActionKind = 'archive' | 'trash' | 'changeAudience';

export const BULK_ACTION_KINDS: readonly BulkActionKind[] = ['archive', 'trash', 'changeAudience'];

export interface ToolbarDiscovery {
  /** The toolbar container itself. */
  found: boolean;
  confidence: Confidence | null;
  reason: string;
  element: string | null;
  signals: string[];
  /** One discovery per bulk action, searched for only inside the toolbar. */
  actions: Record<BulkActionKind, ControlDiscovery>;
  /** Rendered checkboxes on the page that read as checked, not counting the master select-all. */
  selectedCount: number;
  /** State of the master select-all checkbox, or "not found". */
  masterState: string;
  /** Rendered checkboxes whose state can't be read (neither aria-checked nor a native input). */
  unreadableCount: number;
  /**
   * V2B, diagnostic only: short visible text fragments inside the toolbar that contain a number
   * (e.g. Facebook's own "N selected" wording), and that number when exactly one was found.
   * Never used for a safety decision: selectedCount (the checkbox reading) is authoritative.
   */
  countTexts: string[];
  visibleCount: number | null;
}

export type DialogButtonRole = 'confirm' | 'cancel' | 'close' | 'other';

export interface DialogButtonInfo {
  element: string;
  name: string;
  nameSource: string;
  signals: string[];
  role: DialogButtonRole;
}

export interface DialogDiscovery {
  found: boolean;
  reason: string;
  /** role attribute (dialog / alertdialog) or the tag name. */
  role: string | null;
  /** aria-label / aria-labelledby, or the first heading inside the dialog. */
  name: string | null;
  /** Short visible text of the dialog (clipped). */
  text: string;
  /** The dialog's name, headings or text mention Trash. */
  mentionsTrash: boolean;
  /** Rendered dialogs that appeared after the toolbar click. */
  newDialogs: number;
  buttons: DialogButtonInfo[];
  confirm: ControlDiscovery;
  cancel: ControlDiscovery;
  /** How long it took for the dialog to appear (or how long we waited). */
  waitedMs: number;
}

export type TrashStep = 'OPEN_DIALOG' | 'CONFIRM' | 'CANCEL';

export interface TrashRequest {
  protocol: number;
  scanSessionId: string;
  itemId: string;
  step: TrashStep;
  /** From the OPEN_DIALOG response; required for CONFIRM and CANCEL. */
  pendingId: string | null;
  /** Must be true: set only by the popup's confirmation step for this exact step. */
  confirmed: boolean;
}

/** How each previously mapped row was found after the Trash. */
export interface OtherRowsCheck {
  total: number;
  /** The exact row element is still connected. */
  connected: number;
  /** The row element is gone but its post link is still on the page (Facebook re-rendered the list). */
  rerendered: number;
  /** Neither the row element nor its post link is on the page any more. */
  missing: number;
  /** itemIds of the missing rows (capped). */
  missingIds: string[];
}

export interface TrashVerification {
  targetRowDisconnected: boolean;
  targetPermalinkAbsent: boolean;
  otherRows: OtherRowsCheck;
  /** Checked checkboxes on the page after the action, master excluded. */
  selectedCount: number;
  urlUnchanged: boolean;
  dialogClosed: boolean;
  waitedMs: number;
  /** Why the outcome is not SUCCESS; empty on success. */
  notes: string[];
}

export type TrashErrorCode =
  | ActionErrorCode
  | 'NO_PERMALINK'
  | 'NOT_SELECTED'
  | 'OTHER_SELECTED'
  | 'TOOLBAR_NOT_HIGH'
  | 'NO_PENDING'
  | 'PENDING_EXPIRED'
  | 'DIALOG_NOT_FOUND'
  | 'DIALOG_NOT_HIGH'
  | 'DIALOG_CHANGED'
  | 'UNEXPECTED_AFTER_TRASH';

export interface TrashDialogOpened {
  ok: true;
  step: 'OPEN_DIALOG';
  pendingId: string;
  toolbar: ToolbarDiscovery;
  dialog: DialogDiscovery;
  log: ActionLogEntry[];
}

export interface TrashCompleted {
  ok: true;
  step: 'CONFIRM';
  /** INCONCLUSIVE: Facebook's confirmation was clicked, but removal could not be verified. Rescan required either way. */
  outcome: 'SUCCESS' | 'INCONCLUSIVE';
  verification: TrashVerification;
  log: ActionLogEntry[];
}

export interface TrashCancelled {
  ok: true;
  step: 'CANCEL';
  /** Facebook's own Cancel / Close button was clicked (only when it was identified with HIGH confidence). */
  clickedCancel: boolean;
  note: string;
  log: ActionLogEntry[];
}

export interface TrashFailure {
  ok: false;
  step: TrashStep | null;
  code: TrashErrorCode;
  error: string;
  needsRescan: boolean;
  locked: boolean;
  /** Something was clicked on Facebook during this step before it failed. */
  clicked: boolean;
  toolbar: ToolbarDiscovery | null;
  dialog: DialogDiscovery | null;
  verification: TrashVerification | null;
  log: ActionLogEntry[];
}

export type TrashResponse = TrashDialogOpened | TrashCompleted | TrashCancelled | TrashFailure;

// ---------------------------------------------------------------------------
// V2A / V2B: controlled cleanup batch (up to MAX_BATCH_SIZE ONLY_ME posts, one bulk Trash)
// ---------------------------------------------------------------------------

/** Hard limit (V2B: 20), enforced by the popup AND by the content script. A larger request is refused, never truncated. */
export const MAX_BATCH_SIZE = 20;

/**
 * DRAFT and REVIEW exist only in the popup (a plan: nothing on Facebook changes). From
 * SELECTING on, the content script owns the state and reports it in ActionState.batch.
 */
export type BatchState =
  | 'DRAFT'
  | 'REVIEW'
  | 'SELECTING'
  | 'SELECTED'
  | 'DIALOG_OPEN'
  | 'CONFIRMING'
  | 'VERIFYING'
  | 'SUCCESS'
  | 'PARTIAL'
  | 'INCONCLUSIVE'
  | 'FAILED'
  | 'CANCELLED';

/** Every allowed state change. Anything else is a bug and is refused. */
export const BATCH_TRANSITIONS: Record<BatchState, readonly BatchState[]> = {
  DRAFT: ['REVIEW', 'CANCELLED'],
  REVIEW: ['DRAFT', 'SELECTING', 'CANCELLED'],
  SELECTING: ['SELECTED', 'FAILED'],
  SELECTED: ['DIALOG_OPEN', 'CANCELLED', 'FAILED'],
  // Back to SELECTED when Facebook's dialog was cancelled: the posts are still selected.
  DIALOG_OPEN: ['CONFIRMING', 'SELECTED', 'FAILED'],
  CONFIRMING: ['VERIFYING', 'FAILED'],
  VERIFYING: ['SUCCESS', 'PARTIAL', 'INCONCLUSIVE', 'FAILED'],
  SUCCESS: [],
  PARTIAL: [],
  INCONCLUSIVE: [],
  FAILED: [],
  CANCELLED: [],
};

/** While a batch is in one of these, every other action and every new scan is refused. */
export const BATCH_ACTIVE_STATES: readonly BatchState[] = ['SELECTING', 'SELECTED', 'DIALOG_OPEN', 'CONFIRMING', 'VERIFYING'];

export function canTransition(from: BatchState, to: BatchState): boolean {
  return BATCH_TRANSITIONS[from].includes(to);
}

export function isBatchActive(state: BatchState | null | undefined): boolean {
  return !!state && BATCH_ACTIVE_STATES.includes(state);
}

/**
 *   PREFLIGHT      read-only: check every item on the live page and report per-item results (no state change)
 *   SELECT         preflight every item, then select their checkboxes one at a time (REVIEW -> SELECTED)
 *   UNSELECT       unselect every checkbox this batch selected (SELECTED -> CANCELLED)
 *   OPEN_DIALOG    click the toolbar's Trash button once, discover Facebook's dialog (SELECTED -> DIALOG_OPEN)
 *   CANCEL_DIALOG  click Facebook's HIGH Cancel (DIALOG_OPEN -> SELECTED)
 *   CONFIRM        click Facebook's HIGH confirm once, then verify (DIALOG_OPEN -> ... -> outcome)
 */
export type BatchStep = 'PREFLIGHT' | 'SELECT' | 'UNSELECT' | 'OPEN_DIALOG' | 'CANCEL_DIALOG' | 'CONFIRM';

export interface BatchRequest {
  protocol: number;
  scanSessionId: string;
  batchId: string;
  step: BatchStep;
  /** PREFLIGHT / SELECT: the plan, at most MAX_BATCH_SIZE. Other steps: the same ids again (must match the batch). */
  itemIds: string[];
  /** PREFLIGHT / SELECT: the scanned permalink of each item, in the same order. Other steps: ignored. */
  permalinks: string[];
  /** Must be true for every write step: set only by the popup's confirmation step for this exact step. PREFLIGHT is read-only. */
  confirmed: boolean;
}

/** The preflight's check groups. */
export type PreflightCheckKey = 'onlyMeStrong' | 'checkboxHigh' | 'identityUnchanged' | 'currentlyUnchecked';

export const PREFLIGHT_CHECK_KEYS: readonly PreflightCheckKey[] = ['onlyMeStrong', 'checkboxHigh', 'identityUnchanged', 'currentlyUnchecked'];

/** One item's preflight result. */
export interface BatchItemCheck {
  itemId: string;
  ok: boolean;
  code: string | null;
  error: string | null;
  /**
   * true = passed, false = the check that failed, null = not evaluated (an item stops at its first
   * failing check). Display only: `ok` is the gate.
   */
  checks: Record<PreflightCheckKey, boolean | null>;
}

/** Every item checked on the live page, plus the page-wide conditions. Nothing is clicked to produce it. */
export interface BatchPreflight {
  batchId: string;
  checkedAt: string;
  items: BatchItemCheck[];
  ready: number;
  failed: number;
  /** Page-wide reasons no selection may start (already-selected checkboxes, master state, stale scan, shared checkbox). */
  pageProblems: string[];
  /** Not a failure: e.g. every loaded post is in the batch, so Facebook may mark select-all fully checked. */
  warnings: string[];
  /** Every item ok and no page problem: the only case in which SELECT may click. */
  ok: boolean;
}

/** Diagnostic / UI progress of the running (or last) batch step. Published while the step runs. */
export type BatchProgressPhase =
  | 'PREFLIGHT'
  | 'SELECTING'
  | 'SELECTED'
  | 'UNSELECTING'
  | 'OPENING_DIALOG'
  | 'AWAITING_FINAL_CONFIRMATION'
  | 'VERIFYING';

export interface BatchProgress {
  phase: BatchProgressPhase;
  done: number;
  total: number;
  /** The item being worked on now, if any. */
  currentItemId: string | null;
  updatedAt: string;
}

export interface BatchSelectionVerification {
  /** Each batch target's checkbox state now. */
  targets: { itemId: string; state: CheckState; ok: boolean }[];
  targetsSelected: number;
  expected: number;
  /** Mapped rows not in the batch. */
  nonTargetRows: { compared: number; selected: number; missing: number; selectedIds: string[] };
  /** Every other checkbox on the page, compared with its state before the first click. */
  otherCheckboxes: { compared: number; changed: number; disappeared: number };
  /** V2B: mapped rows (targets or not) that were on the page when selection began and have left it (capped). */
  rowsLeft: string[];
  /** V2B: targets whose row, stored checkbox, classification or permalink can no longer be proven the same. */
  staleTargets: string[];
  /** Rendered checked checkboxes on the page, master excluded. */
  pageSelected: number;
  masterState: CheckState | 'not found';
  urlUnchanged: boolean;
  /** Empty when everything matched. */
  unexpected: string[];
}

export interface BatchRollback {
  /** itemIds whose checkbox this batch had selected (and verified) before the failure. */
  selectedBeforeFailure: string[];
  rolledBack: string[];
  rollbackFailures: { itemId: string; reason: string }[];
  /** Every rollback click verified AND nothing on the page is still selected. */
  complete: boolean;
}

export type BatchItemOutcome = 'REMOVED' | 'STILL_PRESENT' | 'UNCERTAIN';

/**
 * What a target's ORIGINAL row element, still connected after the Trash, shows now (read-only):
 *   SAME_TARGET     it still links the target's permalink
 *   DIFFERENT_POST  it links post URL(s), none of which the target row had at scan time (recycled row)
 *   STALE_SHELL     it links no post URL and has no post controls (checkbox, audience, View, menu) left
 *   UNKNOWN         anything else: e.g. still post-like with no link, or one of the target's scan-time links remains
 */
export type BatchRowIdentity = 'SAME_TARGET' | 'DIFFERENT_POST' | 'STALE_SHELL' | 'UNKNOWN';

export interface BatchTrashVerification {
  items: {
    itemId: string;
    outcome: BatchItemOutcome;
    rowDisconnected: boolean;
    permalinkAbsent: boolean;
    /**
     * V2B: the nearest non-target rows before and after it (in scan order) are still listed, so the
     * post's absence is not just Facebook unloading that part of the list. null = it has no such neighbour.
     */
    neighboursListed: boolean | null;
    /** Only for a still-connected original row (null when it is gone): what it represents now. */
    rowIdentity: BatchRowIdentity | null;
    /** The permalink control discovery picks in that row now, or null. Diagnostic. */
    currentRowPermalink: string | null;
    /** Distinct post URLs linked from that row now. */
    currentRowPostUrls: number | null;
    /** That row still has a checkbox, audience indicator, View or menu control. */
    currentRowPostLike: boolean | null;
    /** Why the outcome was reached, in one line. */
    reason: string;
  }[];
  removed: number;
  stillPresent: number;
  uncertain: number;
  otherRows: OtherRowsCheck;
  /** Checked checkboxes on the page, master counted when fully checked. */
  selectedCount: number;
  urlUnchanged: boolean;
  dialogClosed: boolean;
  waitedMs: number;
  notes: string[];
}

export type BatchOutcome = 'SUCCESS' | 'PARTIAL' | 'INCONCLUSIVE' | 'FAILED';

/** The content script's view of the batch. No Facebook content: ids, states and discovery results only. */
export interface BatchSnapshot {
  batchId: string;
  scanSessionId: string;
  createdAt: string;
  state: BatchState;
  /** In the order they were selected (document order). */
  itemIds: string[];
  /** itemIds this batch selected and has not unselected since. */
  selectedByBatch: string[];
  history: { state: BatchState; at: string }[];
  /** The live preflight SELECT ran before its first click. */
  preflight: BatchPreflight | null;
  progress: BatchProgress | null;
  selection: BatchSelectionVerification | null;
  toolbar: ToolbarDiscovery | null;
  dialog: DialogDiscovery | null;
  rollback: BatchRollback | null;
  verification: BatchTrashVerification | null;
  lastError: { code: string; error: string } | null;
}

export type BatchErrorCode =
  | TrashErrorCode
  | 'BATCH_TOO_LARGE'
  | 'BATCH_EMPTY'
  | 'BATCH_MALFORMED'
  | 'BATCH_PREFLIGHT_FAILED'
  | 'BATCH_SELECTION_FAILED'
  | 'BATCH_UNSELECT_FAILED'
  | 'BATCH_NOT_FOUND'
  | 'BATCH_WRONG_STATE'
  | 'BATCH_EXPIRED'
  | 'PERMALINK_MISMATCH'
  | 'SELECTED_COUNT_MISMATCH'
  | 'INVARIANT_VIOLATION'
  /** V2B: Facebook's master select-all became fully checked. Stopped, and rolled back where possible. */
  | 'MASTER_FULLY_SELECTED';

export interface BatchSuccess {
  ok: true;
  step: BatchStep;
  /** null only for PREFLIGHT, which creates no batch. */
  batch: BatchSnapshot | null;
  /** PREFLIGHT: the live per-item check. */
  preflight: BatchPreflight | null;
  /** e.g. what Facebook's Cancel did. */
  note: string | null;
  log: ActionLogEntry[];
}

export interface BatchFailure {
  ok: false;
  step: BatchStep | null;
  code: BatchErrorCode;
  error: string;
  needsRescan: boolean;
  locked: boolean;
  /** Something was clicked on Facebook during this step before it stopped. */
  clicked: boolean;
  /** PREFLIGHT / SELECT: the live per-item check, when it ran. */
  preflight: BatchPreflight | null;
  batch: BatchSnapshot | null;
  log: ActionLogEntry[];
}

export type BatchResponse = BatchSuccess | BatchFailure;

// ---------------------------------------------------------------------------
// V3A: automatic Activity Log loading (read-only: it only scrolls the page)
// ---------------------------------------------------------------------------

/** Auto-load stops once this many Activity Log rows are loaded on the page. Safety cap: change it here. */
export const MAX_AUTO_LOADED_ROWS = 500;

/** "Load next N": how many more rows to aim for (stopping a little above is fine: Facebook loads in chunks). */
export const LOAD_NEXT_ROWS = 50;

/** Attempts in a row that add no rows before auto-load treats the Activity Log as fully loaded. */
export const AUTOLOAD_MAX_NO_GROWTH = 3;

/** Generous overall time limit for one auto-load run. */
export const AUTOLOAD_MAX_MS = 10 * 60_000;

/**
 *   NEXT_N      load about LOAD_NEXT_ROWS more rows, then stop
 *   UNTIL_END   keep loading until Facebook adds no more rows (or a safety limit is reached)
 *   UP_TO       V5: keep loading until about AutoLoadRequest.targetRows rows are loaded in total
 *               (at most MAX_AUTO_LOADED_ROWS), or Facebook adds no more rows
 */
export type AutoLoadMode = 'NEXT_N' | 'UNTIL_END' | 'UP_TO';

export type AutoLoadState = 'IDLE' | 'LOADING' | 'STOPPING' | 'COMPLETE' | 'FAILED';

/** While a run is in one of these, scans and every action are refused. */
export const AUTOLOAD_ACTIVE_STATES: readonly AutoLoadState[] = ['LOADING', 'STOPPING'];

export function isAutoLoadActive(state: AutoLoadState | null | undefined): boolean {
  return !!state && AUTOLOAD_ACTIVE_STATES.includes(state);
}

/**
 * COMPLETE: USER_STOPPED, TARGET_REACHED, NO_MORE_ROWS, SAFETY_CAP, TIME_LIMIT.
 * FAILED:   NAVIGATED, PAGE_STATE_UNEXPECTED, INTERNAL_ERROR.
 */
export type AutoLoadStopReason =
  | 'USER_STOPPED'
  | 'TARGET_REACHED'
  | 'NO_MORE_ROWS'
  | 'SAFETY_CAP'
  | 'TIME_LIMIT'
  | 'NAVIGATED'
  | 'PAGE_STATE_UNEXPECTED'
  | 'INTERNAL_ERROR';

/** Progress of the running (or last) auto-load, published while it runs. Counts only, no Facebook content. */
export interface AutoLoadSnapshot {
  runId: string;
  mode: AutoLoadMode;
  /** NEXT_N / UP_TO: the row count this run aims for. null for UNTIL_END. */
  targetRows: number | null;
  /** MAX_AUTO_LOADED_ROWS of the content script that ran it. */
  maxRows: number;
  state: AutoLoadState;
  startedAt: string;
  updatedAt: string;
  elapsedMs: number;
  /** Rows the scanner's row discovery found when loading started. */
  startingRows: number;
  /** During loading: startingRows plus the growth of a cheap per-row count. At the end: counted again exactly. */
  currentRows: number;
  addedRows: number;
  /** Scroll-to-bottom attempts so far. */
  attempts: number;
  consecutiveNoGrowth: number;
  /** Rows the last attempt added (0 = no growth), or null before the first attempt finished. */
  lastGrowth: number | null;
  stopReason: AutoLoadStopReason | null;
  /** One line for the UI, e.g. "No new rows after 3 attempts." */
  stopMessage: string | null;
  /** The row strategy used for counting (same rules as the scan). */
  strategy: string | null;
  /** The scroll container that is scrolled, e.g. "document" or "div[role=main]". */
  container: string;
  /** Scroll position of that container after the last scroll, for checking that the page really scrolled. */
  scrollTop: number;
  scrollHeight: number;
  /** The Facebook tab is hidden: Facebook may not load while it isn't visible, so no-growth attempts aren't counted. */
  pageHidden: boolean;
  /** Anything unusual seen while loading (e.g. the row count went down). */
  notes: string[];
}

export interface AutoLoadRequest {
  protocol: number;
  mode: AutoLoadMode;
  /** UP_TO only: the total number of loaded rows to aim for (capped at MAX_AUTO_LOADED_ROWS). */
  targetRows?: number;
  /** The popup's forced item strategy ('' / undefined = auto), so rows are counted like the next scan counts them. */
  strategy?: string;
}

export type AutoLoadErrorCode =
  | 'PROTOCOL_MISMATCH'
  | 'UNKNOWN_ACTION'
  | 'AUTOLOAD_ACTIVE'
  | 'NO_AUTOLOAD'
  | 'LOCKED'
  | 'BUSY'
  | 'TRASH_PENDING'
  | 'BATCH_ACTIVE'
  | 'SELECTION_PRESENT'
  | 'PAGE_STATE_UNEXPECTED'
  | 'INTERNAL_ERROR';

export type AutoLoadResponse =
  | { ok: true; autoLoad: AutoLoadSnapshot }
  | { ok: false; code: AutoLoadErrorCode; error: string };

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Popup -> background service worker. */
export type PopupRequest =
  | { type: 'FPC_SCAN_TAB'; tabId: number; strategy?: string }
  | { type: 'FPC_HIGHLIGHT_ITEM'; tabId: number; scanSessionId: string; itemId: string; control?: ControlKind }
  | { type: 'FPC_CHECKBOX_ACTION_TAB'; tabId: number; request: CheckboxActionRequest }
  | { type: 'FPC_ACTION_STATE_TAB'; tabId: number }
  | { type: 'FPC_TOOLBAR_DISCOVER_TAB'; tabId: number; scanSessionId: string }
  | { type: 'FPC_TOOLBAR_HIGHLIGHT_TAB'; tabId: number; scanSessionId: string; action: BulkActionKind }
  | { type: 'FPC_TRASH_TAB'; tabId: number; request: TrashRequest }
  | { type: 'FPC_BATCH_TAB'; tabId: number; request: BatchRequest }
  | { type: 'FPC_BATCH_HIGHLIGHT_TAB'; tabId: number; scanSessionId: string; itemIds: string[] }
  | { type: 'FPC_AUTOLOAD_START_TAB'; tabId: number; request: AutoLoadRequest }
  | { type: 'FPC_AUTOLOAD_STOP_TAB'; tabId: number; runId: string }
  /** V4: start a cleanup run of exactly this approved snapshot of the queue (the background worker checks it against the stored queue). */
  | { type: 'FPC_RUN_START'; tabId: number; approval: RunApproval; strategy?: string; build?: string }
  /** V4: stop the run at its next safe point (rolling back the current batch's selection / dialog where it can). */
  | { type: 'FPC_RUN_STOP'; runId: string }
  /** V4: continue a run paused because Facebook was not visible (a fresh scan and reconciliation come first). */
  | { type: 'FPC_RUN_RESUME'; runId: string }
  /** V4: close the panel of a finished run. */
  | { type: 'FPC_RUN_END'; runId: string }
  /** Which build the running background service worker is (WorkerInfoResponse). */
  | { type: 'FPC_WORKER_INFO' };

export type WorkerInfoResponse = { ok: true; build: string } | Failure;

// ---------------------------------------------------------------------------
// V4: cleanup run (the remaining queue batches, approved once, run one batch at a time)
// ---------------------------------------------------------------------------

/** One queue batch as the user approved it: its key and the normalised permalinks of its planned posts. */
export interface RunApprovedBatch {
  key: string;
  /** 0-based queue batch index. */
  index: number;
  permalinks: string[];
}

/** What "Run remaining batches" approved. Never extended afterwards. */
export interface RunApproval {
  queueId: string;
  batches: RunApprovedBatch[];
  posts: number;
}

/** Background worker -> extension pages (not stored: it holds post text): the run's fresh scan, so an open tester shows it. */
export type RunBroadcast = { type: 'FPC_RUN_SCAN'; tabId: number; runId: string; result: ScanResult };

/** Background service worker -> content script. */
export type ContentRequest =
  | { type: 'FPC_PING' }
  | { type: 'FPC_SCAN'; strategy?: string }
  /** Without `control` the whole row is highlighted. */
  | { type: 'FPC_HIGHLIGHT'; scanSessionId: string; itemId: string; control?: ControlKind }
  | { type: 'FPC_CHECKBOX_ACTION'; request: CheckboxActionRequest }
  | { type: 'FPC_ACTION_STATE' }
  | { type: 'FPC_TOOLBAR_DISCOVER'; scanSessionId: string }
  | { type: 'FPC_TOOLBAR_HIGHLIGHT'; scanSessionId: string; action: BulkActionKind }
  | { type: 'FPC_TRASH'; request: TrashRequest }
  | { type: 'FPC_BATCH'; request: BatchRequest }
  /** Outlines the stored checkbox of each item (at most MAX_BATCH_SIZE). Read-only. */
  | { type: 'FPC_BATCH_HIGHLIGHT'; scanSessionId: string; itemIds: string[] }
  /** V3A: validate, discard the current scan session, then load older rows in the background. Answers at once. */
  | { type: 'FPC_AUTOLOAD_START'; request: AutoLoadRequest }
  /** V3A: stop after the current scroll/wait iteration. */
  | { type: 'FPC_AUTOLOAD_STOP'; runId: string };

export type Failure = { ok: false; error: string };

/**
 * forward()'s refusal when a request that needs an existing scan session (actions, action state) finds
 * no scanner in the tab: a freshly loaded page that nothing has scanned yet. Not unsafe: such a page has
 * no lock, batch, pending Trash or loading run (they all live in the scanner). A scan injects it.
 */
export const SCANNER_NOT_RUNNING_ERROR = 'The scanner is not running in this tab (the page was reloaded or the extension updated). Please scan again.';

export function isScannerNotRunningError(error: string | null | undefined): boolean {
  return error === SCANNER_NOT_RUNNING_ERROR;
}
export type ScanResponse = { ok: true; result: ScanResult } | Failure;
export type SimpleResponse = { ok: true } | Failure;
/**
 * `outlined` says what was outlined, e.g. when an invisible control's visible wrapper was used instead.
 * `details` are debug lines: the stored element's rect, which element's box was drawn, and its rect.
 */
export type HighlightResponse = { ok: true; outlined: string; details: string[] } | Failure;
export type ActionStateResponse = { ok: true; state: ActionState } | Failure;
export type ToolbarResponse = { ok: true; toolbar: ToolbarDiscovery } | Failure;
