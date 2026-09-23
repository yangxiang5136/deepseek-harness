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
