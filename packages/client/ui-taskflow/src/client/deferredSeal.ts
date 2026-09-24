import { useCallback, useEffect, useRef, useState } from 'react'
import type { NeedsYouItem } from './fold.ts'
import type { TaskFlowFace } from './face.ts'

/** Where the human confirmed a seal: the bar's own checkmark. */
export const SEAL_CONFIRMATION_REF = 'dsh-ui:seal-click'

/** How long a tray seal waits for 撤销 before it is written (Sean, 2026-09-23). */
export const SEAL_UNDO_MS = 5_000

/**
 * Stable identity of a debt row: the event id when the target has one,
 * otherwise the legacy composite the host seal gate pins on.
 * @param debt - one open needs-you item.
 * @returns A key that survives refolds.
 */
export function debtKey(debt: NeedsYouItem): string {
  return debt.eventId === undefined
    ? `legacy\u0000${debt.project}\u0000${debt.task}\u0000${debt.ts}\u0000${debt.ledgerIndex}`
    : `id\u0000${debt.eventId}`
}

/** Per-debt state of a deferred seal. */
export type DeferredState = 'pending' | 'writing' | 'sealed' | { failed: string }

/** What the tray needs from the deferred-seal controller. */
export interface DeferredSeal {
  /** State by {@link debtKey}; absent means untouched. */
  states: Readonly<Record<string, DeferredState>>
  /** The most recently queued debt, for the undo notice; null when none pending. */
  lastPending: NeedsYouItem | null
  /** Number of seals still inside their undo window. */
  pendingCount: number
  /**
   * Queue a seal; it is written after {@link SEAL_UNDO_MS} unless undone.
   * @param note - Sean's optional one-line closing note / feedback for AIs.
   */
  queue(debt: NeedsYouItem, note?: string): void
  /** Cancel a queued seal that has not been written yet. */
  undo(debt: NeedsYouItem): void
}

/**
 * Deferred seal controller. A click hides the row at once and starts a
 * {@link SEAL_UNDO_MS} window; only when it elapses is the audited seal sent
 * through the host gate. It lives on the bar (not the tray) so collapsing the
 * tray or the bar does not cancel a queued seal; closing the page inside the
 * window does, by design — nothing is written.
 * @param seal - the injected seal verb.
 * @param delayMs - undo window; tests shorten it.
 * @returns The controller the tray renders from.
 */
export function useDeferredSeal(seal: TaskFlowFace['seal'], delayMs: number = SEAL_UNDO_MS): DeferredSeal {
  const [states, setStates] = useState<Record<string, DeferredState>>({})
  const [queueOrder, setQueueOrder] = useState<NeedsYouItem[]>([])
  const timers = useRef(new Map<string, number>())

  useEffect(() => () => {
    for (const timer of timers.current.values()) window.clearTimeout(timer)
    timers.current.clear()
  }, [])

  const settle = useCallback((key: string, next: DeferredState | null) => {
    setStates((prev) => {
      if (next !== null) return { ...prev, [key]: next }
      return Object.fromEntries(Object.entries(prev).filter(([k]) => k !== key))
    })
  }, [])

  const queue = useCallback((debt: NeedsYouItem, note?: string) => {
    const key = debtKey(debt)
    const trimmed = note?.trim() ?? ''
    if (timers.current.has(key)) return
    settle(key, 'pending')
    setQueueOrder(prev => [...prev.filter(d => debtKey(d) !== key), debt])
    const timer = window.setTimeout(() => {
      timers.current.delete(key)
      setQueueOrder(prev => prev.filter(d => debtKey(d) !== key))
      settle(key, 'writing')
      void seal({
        project: debt.project,
        task: debt.task,
        resolvesTs: debt.ts,
        ...(debt.eventId === undefined ? {} : { resolvesEventId: debt.eventId }),
        confirmationRef: SEAL_CONFIRMATION_REF,
        ...(trimmed === '' ? {} : { note: trimmed }),
      }).then(
        (outcome) => { settle(key, outcome.sealed ? 'sealed' : { failed: outcome.message ?? 'seal refused' }) },
        (reason: unknown) => { settle(key, { failed: reason instanceof Error ? reason.message : String(reason) }) },
      )
    }, delayMs)
    timers.current.set(key, timer)
  }, [seal, settle, delayMs])

  const undo = useCallback((debt: NeedsYouItem) => {
    const key = debtKey(debt)
    const timer = timers.current.get(key)
    if (timer === undefined) return
    window.clearTimeout(timer)
    timers.current.delete(key)
    setQueueOrder(prev => prev.filter(d => debtKey(d) !== key))
    settle(key, null)
  }, [settle])

  return {
    states,
    lastPending: queueOrder.at(-1) ?? null,
    pendingCount: queueOrder.length,
    queue,
    undo,
  }
}
