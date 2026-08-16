/**
 * The bar's ledger source: a HostObservable over the parsed attention ledger,
 * refreshed by polling the `taskflow` Remote (the plugin body owns the 10 s
 * timer). Modeled on ui-cordis's inventory store: reads are single-flight, a
 * failed read keeps the last events and says why (the bar shows the error
 * instead of silently going stale — fail-loud), and reset discards an
 * in-flight read across a reconnect via a generation guard.
 */

import type { TaskflowLedgerSnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { parseLedgerText, type AttentionEvent } from './fold.ts'

/** What the bar reads: parsed events plus read/exists/error state. */
export interface TaskflowLedgerState {
  readonly events: readonly AttentionEvent[]
  /**
   * False until a read settles, so the bar shows a loading line rather than
   * claiming an empty day before it is known.
   */
  readonly read: boolean
  /** False when the ledger file is missing (a legitimate empty state). */
  readonly exists: boolean
  /** Last read failure, shown on the bar (fail-loud); cleared on success. */
  readonly error?: string | undefined
}

/** RPC seam the reads go through; throws with a user-readable message. */
export interface TaskflowLedgerPort {
  read(): Promise<TaskflowLedgerSnapshot>
}

/** Ledger source: an observable of the parsed ledger plus its read trigger. */
export interface TaskflowLedgerSource extends HostObservable<TaskflowLedgerState> {
  /** Read the ledger unless a read is already in flight. */
  refresh(): void
  /** Drop what was read; the next refresh starts from nothing (reconnect). */
  reset(): void
}

/**
 * Create the ledger source.
 * @param port - the Remote seam the read goes through.
 * @param onError - reporter for a failed read (console in production).
 * @returns the ledger observable and its read trigger.
 */
export function createTaskflowLedger(
  port: TaskflowLedgerPort,
  onError: (error: unknown) => void,
): TaskflowLedgerSource {
  const listeners = new Set<() => void>()
  let snapshot: TaskflowLedgerState = { events: [], read: false, exists: true }
  let inFlight: Promise<void> | undefined
  // Bumped by reset; a read whose generation is stale publishes nothing.
  let generation = 0

  const publish = (next: TaskflowLedgerState): void => {
    snapshot = next
    for (const listener of [...listeners]) listener()
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (fn) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    refresh: () => {
      if (inFlight !== undefined) return
      const issued = generation
      inFlight = port.read().then(
        (read) => {
          if (issued !== generation) return
          publish({ events: parseLedgerText(read.text), read: true, exists: read.exists })
        },
        (error: unknown) => {
          if (issued !== generation) return
          onError(error)
          // Keep the last events; dropping them would turn a transient wire
          // failure into an empty strip. The error rides along instead.
          publish({
            events: snapshot.events,
            read: snapshot.read,
            exists: snapshot.exists,
            error: error instanceof Error ? error.message : 'reading the attention ledger failed',
          })
        },
      ).then(() => { if (issued === generation) inFlight = undefined })
    },
    reset: () => {
      generation += 1
      inFlight = undefined
      publish({ events: [], read: false, exists: true })
    },
  }
}
