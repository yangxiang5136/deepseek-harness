/**
 * TaskFlow bottom status bar, browser half: the frame-wide `shell.overlay`
 * entry rendering the attention surface (spec §6 v3.0). Facts arrive through
 * the `taskflow` Remote namespace — the ledger observable polls `read()`
 * every {@link REFRESH_MS} and the popover's checkmark drives the audited
 * `seal()` gate; the fold itself is pure client code over the raw JSONL.
 */
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { TaskflowSealRequest } from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the ui-layout SlotMap merge (the shell.overlay list slot).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { REFRESH_MS } from './fold.ts'
import { createTaskflowLedger } from './ledger.ts'
import type { TaskFlowFace, TaskflowSealOutcome } from './face.ts'
import { TaskFlowBar } from './TaskFlowBar.tsx'

export type { TaskFlowFace, TaskflowSealOutcome } from './face.ts'
export type { TaskflowLedgerSource, TaskflowLedgerState } from './ledger.ts'

/** Required services: the overlay slot registry and the taskflow Remote. */
export const inject = ['slots', 'remote', 'remote.taskflow']

/**
 * Client plugin body: build the polled ledger source and mount the bar into
 * the shell overlay layer with its injected face.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const ledger = createTaskflowLedger({
    read: async () => {
      const answered = await ctx.remote.taskflow.read()
      if (!answered.ok) throw new Error(`${answered.error.code}: ${answered.error.message}`)
      return answered.value
    },
  }, (error) => {
    console.error('[ui-taskflow] reading the attention ledger failed:', error)
  })

  ctx.effect(() => {
    const timer = setInterval(() => { ledger.refresh() }, REFRESH_MS)
    return () => { clearInterval(timer) }
  }, 'ui-taskflow: ledger poll')

  ctx.on('connection/reset', () => {
    ledger.reset()
    ledger.refresh()
  })

  const seal = async (request: TaskflowSealRequest): Promise<TaskflowSealOutcome> => {
    const answered = await ctx.remote.taskflow.seal(request)
    if (!answered.ok) return { sealed: false, message: `${answered.error.code}: ${answered.error.message}` }
    if (!answered.value.sealed) {
      return { sealed: false, message: answered.value.reason ?? 'seal refused' }
    }
    // The appended done is already on disk; refold without waiting the poll.
    ledger.refresh()
    return { sealed: true, message: null }
  }

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'taskflow-bar',
    order: 100,
    inject: (): TaskFlowFace => ({ hooks: { ledger }, seal }),
  }, TaskFlowBar))

  ledger.refresh()
}
