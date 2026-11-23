/**
 * TaskFlow bottom status bar, browser half: the frame-wide `shell.overlay`
 * entry rendering the attention surface (spec §6 v3.0). Facts arrive through
 * the `taskflow` Remote namespace — the ledger observable polls `read()`
 * every {@link REFRESH_MS}, alongside read-only review plans, and the popover's checkmark drives the audited
 * `seal()` gate; startup and project changes read `todos()` for discovery
 * and the open tree. The fold
 * itself is pure client code over the raw JSONL.
 */
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { TaskflowMainline, TaskflowSealRequest, TaskflowTodoFile } from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the ui-layout SlotMap merge (the shell.overlay list slot).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { REFRESH_MS } from './fold.ts'
import { createTaskflowLedger } from './ledger.ts'
import { createReviewPlans } from './reviewPlans.ts'
import { createMainlines } from './mainlines.ts'
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

  const reviewPlans = createReviewPlans(async () => {
    const answered = await ctx.remote.taskflow.reviewPlans()
    if (!answered.ok) throw new Error(`${answered.error.code}: ${answered.error.message}`)
    return answered.value
  })

  const mainlines = createMainlines(async () => {
    const answered = await ctx.remote.taskflow.mainlines()
    if (!answered.ok) throw new Error(`${answered.error.code}: ${answered.error.message}`)
    return answered.value
  })

  ctx.effect(() => {
    const timer = setInterval(() => { ledger.refresh(); reviewPlans.refresh(); mainlines.refresh() }, REFRESH_MS)
    return () => { clearInterval(timer) }
  }, 'ui-taskflow: ledger poll')

  ctx.on('connection/reset', () => {
    ledger.reset()
    reviewPlans.reset()
    mainlines.reset()
    ledger.refresh()
    reviewPlans.refresh()
    mainlines.refresh()
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

  const todos = async (): Promise<TaskflowTodoFile[]> => {
    const answered = await ctx.remote.taskflow.todos()
    if (!answered.ok) throw new Error(`${answered.error.code}: ${answered.error.message}`)
    return answered.value.files
  }

  const setMainlines = async (project: string, list: TaskflowMainline[]): Promise<string | null> => {
    const answered = await ctx.remote.taskflow.setMainlines({ project, mainlines: list })
    if (!answered.ok) return `${answered.error.code}: ${answered.error.message}`
    if (!answered.value.saved || answered.value.mainlines === null) return answered.value.reason ?? '没有保存'
    mainlines.accept(answered.value.mainlines)
    return null
  }

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'taskflow-bar',
    order: 100,
    inject: (): TaskFlowFace => ({ hooks: { ledger, reviewPlans, mainlines }, seal, todos, setMainlines }),
  }, TaskFlowBar))

  ledger.refresh()
  reviewPlans.refresh()
  mainlines.refresh()
}
