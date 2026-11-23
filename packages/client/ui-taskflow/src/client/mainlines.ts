import type { TaskflowMainline, TaskflowMainlines } from '@deepseek-ai/dsh-api-remotes/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** The shared pins as last read, plus a visible read failure. */
export interface MainlinesState {
  /** Pinned mainlines by display project. */
  projects: Readonly<Record<string, readonly TaskflowMainline[]>>
  read: boolean
  error?: string
}

/** Observable over the bus pins file with single-flight refresh. */
export interface MainlinesSource extends HostObservable<MainlinesState> {
  refresh(): void
  reset(): void
  /** Publish a document the host just wrote, without waiting for the poll. */
  accept(doc: TaskflowMainlines): void
}

/**
 * Read the shared pins, keeping the last good answer when a read fails.
 * @param read - Remote adapter for the pins document.
 * @returns Observable consumed by the bar.
 */
export function createMainlines(read: () => Promise<TaskflowMainlines>): MainlinesSource {
  let state: MainlinesState = { projects: {}, read: false }
  let generation = 0
  let pending: Promise<void> | undefined
  const listeners = new Set<() => void>()
  const publish = (next: MainlinesState): void => {
    state = next
    for (const notify of listeners) notify()
  }
  return {
    getSnapshot: () => state,
    subscribe: (notify) => { listeners.add(notify); return () => { listeners.delete(notify) } },
    refresh: () => {
      if (pending !== undefined) return
      const issued = generation
      pending = read().then((doc) => {
        if (issued === generation) publish({ projects: doc.projects, read: true })
      }).catch((error: unknown) => {
        if (issued === generation) publish({ ...state, error: error instanceof Error ? error.message : '主线读取失败' })
      }).then(() => { if (issued === generation) pending = undefined })
    },
    reset: () => { generation += 1; pending = undefined; publish({ projects: {}, read: false }) },
    accept: (doc) => { publish({ projects: doc.projects, read: true }) },
  }
}
