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
