/** Wire types for the `taskflow` Remote namespace. */

/** One-shot read of the attention ledger file. */
export interface TaskflowLedgerSnapshot {
  /** Absolute ledger path the host read. */
  path: string
  /** False when the ledger file is missing or unreadable. */
  exists: boolean
  /** File mtime in epoch milliseconds; null when `exists` is false. */
  mtimeMs: number | null
  /** Raw JSONL text; empty string when `exists` is false. */
  text: string
}

/** Identify the debt to seal by its loose ledger identity. */
export interface TaskflowSealRequest {
  /** Exact project string of the open needs-you. */
  project: string
  /** Exact task phrase of the open needs-you. */
  task: string
}

/** Outcome of a seal attempt; never throws for business outcomes. */
export interface TaskflowSealResult {
  /** True when the done event was appended. */
  sealed: boolean
  /** Business reason when not sealed; null on success. */
  reason: 'no-open-needs-you' | 'ledger-missing' | null
  /** The appended JSON line on success; null otherwise. */
  line: string | null
}
