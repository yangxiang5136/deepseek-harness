/** The bar's injected business face (registered at the shell.overlay entry). */

import type { TaskflowMainline, TaskflowSealRequest, TaskflowTodoFile } from '@deepseek-ai/dsh-api-remotes/client'
import type { MainlinesSource } from './mainlines.ts'
import type { TaskflowLedgerSource } from './ledger.ts'
import type { ReviewPlansSource } from './reviewPlans.ts'
import type { SessionTitlesSource } from './sessionTitles.ts'

/** Business outcome of a seal click; wire and host refusals both land here. */
export interface TaskflowSealOutcome {
  /** True when the audited done line was appended. */
  sealed: boolean
  /** User-readable refusal when not sealed; null on success. */
  message: string | null
}

/** Injected face: the ledger observable plus the seal verb. */
export interface TaskFlowFace {
  hooks: {
    /** The polled ledger source (bound to `useLedger` by the renderer). */
    ledger: TaskflowLedgerSource
    /** Polled plan metadata, independent of ledger outcomes. */
    reviewPlans: ReviewPlansSource
    /** The human's pinned mainlines, shared through the bus. */
    mainlines: MainlinesSource
    /** Cached titles of the chats that open debts name in `payload.session`. */
    sessionTitles: SessionTitlesSource
  }
  /**
   * Seal (收口) one pinned open debt through the host gate.
   * @param request - pinned debt identity plus the confirmation source.
   * @returns Business outcome; never throws for business refusals.
   */
  seal(request: TaskflowSealRequest): Promise<TaskflowSealOutcome>
  /**
   * Read the bus todo project files for the project tree's "after now" nodes.
   * @returns Raw todo files; rejects with a user-readable message on failure.
   */
  todos(): Promise<TaskflowTodoFile[]>
  /**
   * Replace one project's pinned mainlines after an explicit gesture.
   * @param project - display project.
   * @param mainlines - its complete new list (at most three).
   * @returns Null when saved, else a user-readable refusal.
   */
  setMainlines(project: string, mainlines: TaskflowMainline[]): Promise<string | null>
  /**
   * Look up the titles of these sessions unless cached or already requested;
   * answers arrive through the `sessionTitles` hook.
   * @param ids - session ids of the open debts.
   */
  requestSessionTitles(ids: readonly string[]): void
}
