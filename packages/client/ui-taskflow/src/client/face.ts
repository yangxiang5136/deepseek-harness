/** The bar's injected business face (registered at the shell.overlay entry). */

import type { TaskflowSealRequest } from '@deepseek-ai/dsh-api-remotes/client'
import type { TaskflowLedgerSource } from './ledger.ts'

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
  }
  /**
   * Seal (收口) one pinned open debt through the host gate.
   * @param request - pinned debt identity plus the confirmation source.
   * @returns Business outcome; never throws for business refusals.
   */
  seal(request: TaskflowSealRequest): Promise<TaskflowSealOutcome>
}
