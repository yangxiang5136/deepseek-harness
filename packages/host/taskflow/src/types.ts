/** Wire types for the `taskflow` Remote namespace. */

/** One-shot read of the attention ledger source. */
export interface TaskflowLedgerSnapshot {
  /** Absolute file override or production attention-directory path the host read. */
  path: string
  /** False when the selected ledger source does not exist. Other I/O failures reject. */
  exists: boolean
  /** File mtime in epoch milliseconds; null when `exists` is false. */
  mtimeMs: number | null
  /** Chronologically concatenated raw JSONL text; empty when `exists` is false. */
  text: string
}

/**
 * Identify the debt to seal. The request uses `event_id` when the target has
 * one and otherwise falls back to the legacy timestamp, and carries the
 * explicit human confirmation reference recorded by the resolver.
 */
export interface TaskflowSealRequest {
  /** Exact project string of the open needs-you. */
  project: string
  /** Exact task phrase of the open needs-you. */
  task: string
  /** The `ts` of the specific needs-you event being resolved. */
  resolvesTs: string
  /** The target's `event_id`; omitted only for a legacy target without one. */
  resolvesEventId?: string
  /** Fixed human gesture reference; P0 accepts only `dsh-ui:seal-click`. */
  confirmationRef: string
  /**
   * Sean's closing note / feedback for future AIs: one line, at most
   * 280 characters after trimming; omit for a bare seal.
   */
  note?: string
}

/** Exact debt selected by a caller from a verified native human completion statement. */
export interface TaskflowPhaseConfirmationRequest {
  /** Exact project string of the open needs-you. */
  project: string
  /** Exact task phrase of the open needs-you. */
  task: string
  /** Raw timestamp of the specific debt; required for legacy debts. */
  resolvesTs: string
  /** Canonical identity when the target debt has an event ID. */
  resolvesEventId?: string
  /** Native interactive Codex thread UUID. */
  threadId: string
  /** Absolute transcript path under the host's Codex sessions or archived_sessions. */
  sourcePath: string
  /** Byte offset of the exact complete human response_item record. */
  byteOffset: number
  /** One verbatim user quotation, at most 280 characters; also the seal's note. */
  quote: string
}

/** Outcome of a seal attempt; never throws for business outcomes. */
export interface TaskflowSealResult {
  /** True when the done event was appended. */
  sealed: boolean
  /** Business reason when not sealed; null on success. */
  reason: 'no-open-needs-you' | 'ledger-missing' | 'ledger-busy' | 'invalid-request' | null
  /** The appended JSON line on success; null otherwise. */
  line: string | null
}

/** One project todo file from the bus todo directory, raw. */
export interface TaskflowTodoFile {
  /** File name, e.g. `ARK.md`; the client maps it to a ledger project. */
  name: string
  /** Raw markdown text; the client extracts open items. */
  text: string
}

/** One-shot read of the bus todo projects directory. */
export interface TaskflowTodoSnapshot {
  /** Absolute directory the host read. */
  dir: string
  /** False when the directory does not exist (a legitimate empty state). */
  exists: boolean
  /** Regular `*.md` files in name order; symlinks and other entries are skipped. */
  files: TaskflowTodoFile[]
}

/** One top-level review-plan JSON file; business validation belongs to the client. */
export interface TaskflowReviewPlanFile {
  /** File name within the configured review-plan directory. */
  name: string
  /** UTF-8 JSON object text, preserved without normalization. */
  text: string
}

/** Public health fields from the local review watcher, excluding its private cursors. */
export interface TaskflowReviewObserver {
  /** Last completed local-source scan, or null before the first scan. */
  lastScanAt: string | null
  /** Failed source reads in the latest scan, or null before the first scan. */
  lastErrorCount: number | null
  /** Adapter identities included in source scanning. */
  coverage: string[]
  /** Source categories explicitly outside this watcher's coverage. */
  excluded: string[]
}

/** Bounded read of the host-configured project review-plan directory. */
export interface TaskflowReviewPlanSnapshot {
  /** Absolute directory selected by the host, never by the Remote caller. */
  dir: string
  /** False only when the directory is missing; invalid files and I/O errors reject. */
  exists: boolean
  /** Regular top-level `*.json` files in filename order. */
  files: TaskflowReviewPlanFile[]
  /** Whitelisted watcher health, or null when its status file is missing. */
  observer: TaskflowReviewObserver | null
}

/** One pinned mainline: a ledger task name and, optionally, where it is heading. */
export interface TaskflowMainline {
  /** Exact ledger task name the human pinned. */
  task: string
  /** One-line direction; present together with `directionBy`. */
  direction?: string
  /** Who wrote `direction`: an AI draft, or the human (which an AI must not overwrite). */
  directionBy?: 'ai' | 'human'
}

/** The pinned mainlines of every project, keyed by display project. */
export interface TaskflowMainlines {
  schemaVersion: 1
  /** At most three mainlines per project, in the human's order. */
  projects: Record<string, TaskflowMainline[]>
}

/** Replace one project's pinned mainlines; an empty list unpins the project. */
export interface TaskflowMainlinesRequest {
  /** Display project (aliases folded, e.g. ARK). */
  project: string
  /** The complete new list for that project. */
  mainlines: TaskflowMainline[]
}

/** Outcome of a pin write; never throws for a malformed request. */
export interface TaskflowMainlinesResult {
  saved: boolean
  reason: 'invalid-request' | null
  /** The document after the write; null when nothing was written. */
  mainlines: TaskflowMainlines | null
}
