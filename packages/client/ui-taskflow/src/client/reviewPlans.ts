import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { parseReviewPlan, type ReviewPlan } from './reviewPlan.ts'
import { displayProject } from './fold.ts'

import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'

type ReviewReadResult = Awaited<ReturnType<ClientRemote['taskflow']['reviewPlans']>>

/** Raw read-only Remote response. */
export type ReviewPlanFiles = Extract<ReviewReadResult, { ok: true }>['value']

/** Local observer health metadata from the host. */
export type ReviewObserver = NonNullable<ReviewPlanFiles['observer']>

/** Last good plan files and a visible read or validation failure. */
export interface ReviewPlansState {
  plans: readonly ReviewPlan[]
  read: boolean
  observer: ReviewObserver | null
  error?: string
}

/** Observable with single-flight refresh and reconnect generation isolation. */
export interface ReviewPlansSource extends HostObservable<ReviewPlansState> {
  refresh(): void
  reset(): void
}

/**
 * Read and strictly validate plans while preserving the last good result on failure.
 * @param read - Read-only Remote adapter.
 * @returns Observable consumed by the project panel.
 */
export function createReviewPlans(read: () => Promise<ReviewPlanFiles>): ReviewPlansSource {
  let state: ReviewPlansState = { plans: [], read: false, observer: null }
  let generation = 0
  let pending: Promise<void> | undefined
  const listeners = new Set<() => void>()
  const publish = (next: ReviewPlansState): void => {
    state = next
    for (const notify of listeners) notify()
  }
  return {
    getSnapshot: () => state,
    subscribe: (notify) => { listeners.add(notify); return () => { listeners.delete(notify) } },
    refresh: () => {
      if (pending !== undefined) return
      const issued = generation
      pending = read().then((answer) => {
        if (issued !== generation) return
        const plans = answer.files.map((file) => {
          try { return parseReviewPlan(JSON.parse(file.text) as unknown) }
          catch (error: unknown) {
            // Native JSON.parse and the local strict parser throw Error instances.
            throw new Error(`${file.name}: ${(error as Error).message}`)
          }
        })
        if (new Set(plans.map(plan => displayProject(plan.project))).size !== plans.length) throw new Error('同一项目存在多个审阅计划')
        publish({ plans, read: true, observer: answer.observer })
      }).catch((error: unknown) => {
        if (issued === generation) publish({ ...state, error: error instanceof Error ? error.message : '审阅计划读取失败' })
      }).then(() => { if (issued === generation) pending = undefined })
    },
    reset: () => { generation += 1; pending = undefined; publish({ plans: [], read: false, observer: null }) },
  }
}
