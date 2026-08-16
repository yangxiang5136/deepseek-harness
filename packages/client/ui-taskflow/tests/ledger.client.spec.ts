/**
 * Ledger-source semantics: single-flight reads, fail-loud errors that keep
 * the last good events, and the reset generation guard (a reconnect discards
 * the in-flight answer of the previous connection).
 */

import { describe, expect, it, vi } from 'vitest'
import type { TaskflowLedgerSnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import { createTaskflowLedger } from '../src/client/ledger.ts'

const LINE = JSON.stringify({
  ts: '2026-08-15T08:00:00-04:00', surface: 'claude-code',
  project: 'digital-me', task: 't', event: 'start',
})

function snapshotOf(text: string, exists = true): TaskflowLedgerSnapshot {
  return { path: '/bus/events.jsonl', exists, mtimeMs: exists ? 1 : null, text }
}

describe('createTaskflowLedger', () => {
  it('parses the read text and publishes to subscribers', async () => {
    const read = vi.fn().mockResolvedValue(snapshotOf(`${LINE}\n`))
    const ledger = createTaskflowLedger({ read }, () => {})
    const seen = vi.fn()
    ledger.subscribe(seen)
    expect(ledger.getSnapshot()).toMatchObject({ events: [], read: false })

    ledger.refresh()
    await vi.waitFor(() => { expect(ledger.getSnapshot().read).toBe(true) })
    expect(ledger.getSnapshot().events).toHaveLength(1)
    expect(ledger.getSnapshot().events[0]?.task).toBe('t')
    expect(seen).toHaveBeenCalled()
  })

  it('is single-flight: refreshes while a read is pending do not multiply calls', async () => {
    let release: (value: TaskflowLedgerSnapshot) => void = () => {}
    const read = vi.fn(() => new Promise<TaskflowLedgerSnapshot>((resolve) => { release = resolve }))
    const ledger = createTaskflowLedger({ read }, () => {})
    ledger.refresh()
    ledger.refresh()
    ledger.refresh()
    expect(read).toHaveBeenCalledTimes(1)
    release(snapshotOf(''))
    await vi.waitFor(() => { expect(ledger.getSnapshot().read).toBe(true) })
    ledger.refresh()
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('keeps the last events on a failed read and says why (fail-loud)', async () => {
    const read = vi.fn().mockResolvedValueOnce(snapshotOf(`${LINE}\n`))
      .mockRejectedValueOnce(new Error('REMOTE_ERROR: unavailable'))
      .mockResolvedValueOnce(snapshotOf(`${LINE}\n`))
    const onError = vi.fn()
    const ledger = createTaskflowLedger({ read }, onError)

    ledger.refresh()
    await vi.waitFor(() => { expect(ledger.getSnapshot().read).toBe(true) })

    ledger.refresh()
    await vi.waitFor(() => { expect(ledger.getSnapshot().error).toBeDefined() })
    expect(ledger.getSnapshot().events).toHaveLength(1)
    expect(ledger.getSnapshot().error).toBe('REMOTE_ERROR: unavailable')
    expect(onError).toHaveBeenCalledOnce()

    // A later success clears the error.
    ledger.refresh()
    await vi.waitFor(() => { expect(ledger.getSnapshot().error).toBeUndefined() })
  })

  it('reports a missing ledger as a legitimate empty state, not an error', async () => {
    const read = vi.fn().mockResolvedValue(snapshotOf('', false))
    const ledger = createTaskflowLedger({ read }, () => {})
    ledger.refresh()
    await vi.waitFor(() => { expect(ledger.getSnapshot().read).toBe(true) })
    expect(ledger.getSnapshot()).toMatchObject({ exists: false, events: [] })
    expect(ledger.getSnapshot().error).toBeUndefined()
  })

  it('reset discards the in-flight answer and frees the slot for a fresh read', async () => {
    let release: (value: TaskflowLedgerSnapshot) => void = () => {}
    const read = vi.fn(() => new Promise<TaskflowLedgerSnapshot>((resolve) => { release = resolve }))
    const ledger = createTaskflowLedger({ read }, () => {})
    ledger.refresh()
    const staleRelease = release
    ledger.reset()
    ledger.refresh()
    expect(read).toHaveBeenCalledTimes(2)
    // The stale connection's answer must not publish over the reset state.
    staleRelease(snapshotOf(`${LINE}\n`))
    release(snapshotOf(''))
    await vi.waitFor(() => { expect(ledger.getSnapshot().read).toBe(true) })
    expect(ledger.getSnapshot().events).toHaveLength(0)
  })

  it('unsubscribe stops notifications', async () => {
    const read = vi.fn().mockResolvedValue(snapshotOf(''))
    const ledger = createTaskflowLedger({ read }, () => {})
    const seen = vi.fn()
    const stop = ledger.subscribe(seen)
    stop()
    ledger.refresh()
    await vi.waitFor(() => { expect(ledger.getSnapshot().read).toBe(true) })
    expect(seen).not.toHaveBeenCalled()
  })
})
