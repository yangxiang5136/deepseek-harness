// @vitest-environment jsdom
/**
 * Browser-plugin wiring and the seal checkmark flow: the plugin registers the
 * shell.overlay entry with its face, the face's seal verb carries the wire and
 * business refusals as outcomes, and the rendered bar walks mini → expanded →
 * title popover → seal with the audit pin intact.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import type { TaskflowLedgerSnapshot, TaskflowSealResult } from '@deepseek-ai/dsh-api-remotes/client'
import { apply, inject } from '../src/client/index.ts'
import { TaskFlowBar, type TaskFlowBarProps } from '../src/client/TaskFlowBar.tsx'
import type { TaskFlowFace } from '../src/client/face.ts'
import type { TaskflowLedgerState } from '../src/client/ledger.ts'
import { parseLedgerText, CLOSE_MS } from '../src/client/fold.ts'

afterEach(cleanup)

type Wire<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

function ledgerLine(event: string, ts: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ts, surface: 'claude-code', project: 'digital-me', task: '交付评审', event, ...over,
  })
}

async function bench(overrides: {
  read?: () => Promise<Wire<TaskflowLedgerSnapshot>>
  seal?: () => Promise<Wire<TaskflowSealResult>>
} = {}) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  class RemoteService extends Service {
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }
  }
  new RemoteService(ctx)
  const read = vi.fn(overrides.read
    ?? (() => Promise.resolve({
      ok: true as const,
      value: { path: '/bus/events.jsonl', exists: true, mtimeMs: 1, text: '' },
    })))
  const seal = vi.fn(overrides.seal
    ?? (() => Promise.resolve({
      ok: true as const,
      value: { sealed: true as const, reason: null, line: '{}' },
    })))
  ctx.provide('remote.taskflow', { read, seal })
  return { ctx, slots: ctx.get('slots') as SlotRegistry, read, seal }
}

function declare(slots: SlotRegistry): void {
  slots.register({
    name: 'root',
    children: { 'shell.overlay': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('ui-taskflow browser plugin', () => {
  it('declares only the overlay registry and the taskflow Remote', () => {
    expect(inject).toEqual(['slots', 'remote', 'remote.taskflow'])
  })

  it('registers the bar with its face and reads the ledger on load', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const entry = b.slots.entries('shell.overlay')[0]!
    expect(entry.component).toBe(TaskFlowBar)
    expect(entry.options).toMatchObject({ id: 'taskflow-bar', order: 100 })
    await vi.waitFor(() => { expect(b.read).toHaveBeenCalled() })

    const face = (entry.inject as unknown as () => TaskFlowFace)()
    await vi.waitFor(() => { expect(face.hooks.ledger.getSnapshot().read).toBe(true) })
    await b.ctx.fiber.dispose()
  })

  it('maps wire failures and host refusals to seal outcomes, refolding on success', async () => {
    const b = await bench({
      seal: vi.fn()
        .mockResolvedValueOnce({ ok: false, error: { code: 'REMOTE_ERROR', message: 'down' } })
        .mockResolvedValueOnce({ ok: true, value: { sealed: false, reason: 'no-open-needs-you', line: null } })
        .mockResolvedValueOnce({ ok: true, value: { sealed: true, reason: null, line: '{}' } }),
    })
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const face = (b.slots.entries('shell.overlay')[0]!.inject as unknown as () => TaskFlowFace)()
    const request = {
      project: 'digital-me',
      task: '交付评审',
      resolvesTs: '2026-08-15T08:00:00-04:00',
      confirmationRef: 'dsh-ui:seal-click',
    }

    expect(await face.seal(request)).toEqual({ sealed: false, message: 'REMOTE_ERROR: down' })
    expect(await face.seal(request)).toEqual({ sealed: false, message: 'no-open-needs-you' })
    const before = b.read.mock.calls.length
    expect(await face.seal(request)).toEqual({ sealed: true, message: null })
    // A successful seal refolds immediately instead of waiting for the poll.
    expect(b.read.mock.calls.length).toBeGreaterThan(before)
    await b.ctx.fiber.dispose()
  })

  it('surfaces a read failure on the ledger snapshot (fail-loud)', async () => {
    const b = await bench({
      read: () => Promise.reject(new Error('boom')),
    })
    declare(b.slots)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const face = (b.slots.entries('shell.overlay')[0]!.inject as unknown as () => TaskFlowFace)()
    await vi.waitFor(() => { expect(face.hooks.ledger.getSnapshot().error).toBe('boom') })
    expect(errors).toHaveBeenCalled()
    errors.mockRestore()
    await b.ctx.fiber.dispose()
  })
})

describe('TaskFlowBar surface', () => {
  /** Render the bar over a fixed ledger state with a controllable seal verb. */
  function renderBar(state: TaskflowLedgerState, seal: TaskFlowFace['seal']) {
    const useLedger = (<R,>(selector: (s: TaskflowLedgerState) => R): R => selector(state))
    const props = { useLedger, seal } as unknown as TaskFlowBarProps
    return render(<TaskFlowBar {...props} />)
  }

  function stateOf(lines: string[]): TaskflowLedgerState {
    return { events: parseLedgerText(lines.join('\n')), read: true, exists: true }
  }

  it('walks mini → expanded → title popover → seal with the audit pin intact', async () => {
    // A debt owed well past CLOSE_MS plus a running current task.
    const debtTs = new Date(Date.now() - 10 * CLOSE_MS).toISOString()
    const state = stateOf([
      ledgerLine('needs-you', debtTs, { payload: { kind: 'review', ref: 'branch-x' } }),
      ledgerLine('start', new Date(Date.now() - 5 * 60_000).toISOString(), { task: '移植 client' }),
    ])
    const seal = vi.fn().mockResolvedValue({ sealed: true, message: null })
    renderBar(state, seal)

    // Collapsed mini bar carries the current task label.
    fireEvent.click(screen.getByText(/移植 client/))
    // Expanded: strip + chip row + head title.
    expect(screen.getByText('TaskFlow')).toBeTruthy()
    fireEvent.click(screen.getByText('TaskFlow'))
    expect(screen.getByText('待收口')).toBeTruthy()
    expect(screen.getByText(/交付评审 · 欠账/)).toBeTruthy()
    expect(screen.getByText('branch-x')).toBeTruthy()

    fireEvent.click(screen.getByText('收口 ✓'))
    await screen.findByText('已收口 ✓')
    expect(seal).toHaveBeenCalledWith({
      project: 'digital-me',
      task: '交付评审',
      resolvesTs: debtTs,
      confirmationRef: 'dsh-ui:seal-click',
    })
  })

  it('shows the read error on both the mini label and the expanded header', () => {
    const state: TaskflowLedgerState = { events: [], read: true, exists: true, error: 'boom' }
    renderBar(state, vi.fn())
    expect(screen.getByText('⚠ 账本读取失败')).toBeTruthy()
    fireEvent.click(screen.getByText('⚠ 账本读取失败'))
    expect(screen.getByText(/账本读取失败：boom/)).toBeTruthy()
    // No events at all: the strip says so instead of rendering nothing.
    expect(screen.getByText('今日暂无注意力事件')).toBeTruthy()
    expect(screen.getByText('无进行中任务')).toBeTruthy()
  })

  it('opens the empty popover as 一切正常 and collapses back to the mini bar', () => {
    const state = stateOf([
      ledgerLine('start', new Date(Date.now() - 60_000).toISOString(), { task: '当前活' }),
    ])
    renderBar(state, vi.fn())
    fireEvent.click(screen.getByText(/当前活/))
    fireEvent.click(screen.getByText('TaskFlow'))
    expect(screen.getByText('一切正常')).toBeTruthy()
    fireEvent.click(screen.getByText('▾'))
    expect(screen.queryByText('一切正常')).toBeNull()
    expect(screen.getByText(/当前活/)).toBeTruthy()
  })
})
