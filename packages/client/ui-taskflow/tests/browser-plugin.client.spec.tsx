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
import { HistoryStrip } from '../src/client/HistoryStrip.tsx'
import type { TaskFlowFace } from '../src/client/face.ts'
import type { TaskflowLedgerState } from '../src/client/ledger.ts'
import { parseLedgerText, LEGACY_CLOSE_MS, type FoldModel } from '../src/client/fold.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/**
 * ResizeObserver double for jsdom: fires once on observe (like the real one)
 * with a fixed 120px content width — the clearance publisher ignores entries
 * (it reads offsetHeight) and the row observer consumes the width.
 */
class FakeResizeObserver {
  // Method-position type: bivariant, so the DOM callback assigns and the
  // partial entry passes without a single type assertion (tsc and the
  // typed-lint rule disagree about whether one would be necessary).
  private readonly cb: {
    fire(entries: Array<Pick<ResizeObserverEntry, 'contentRect'>>, observer: FakeResizeObserver): void
  }['fire']

  constructor(cb: ResizeObserverCallback) {
    this.cb = cb
  }

  observe(): void {
    this.cb([{ contentRect: new DOMRectReadOnly(0, 0, 120, 28) }], this)
  }

  disconnect(): void {}
  unobserve(): void {}
}

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
    const now = Date.parse('2026-08-20T12:00:00-04:00')
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const eventId = '123e4567-e89b-42d3-a456-426614174001'
    const debtTs = new Date(now - 10 * LEGACY_CLOSE_MS).toISOString()
    const state = stateOf([
      ledgerLine('needs-you', debtTs, {
        schema_version: 2,
        event_id: eventId,
        payload: { kind: 'review', ref: 'branch-x' },
      }),
      ledgerLine('start', new Date(now - 5 * 60_000).toISOString(), { task: '移植 client' }),
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
      resolvesEventId: eventId,
      confirmationRef: 'dsh-ui:seal-click',
    })
  })

  it('keeps seal progress isolated for two identical legacy debt rows', async () => {
    const debtTs = new Date(Date.now() - 10 * LEGACY_CLOSE_MS).toISOString()
    const duplicate = ledgerLine('needs-you', debtTs, { payload: { kind: 'review' } })
    let finishFirst: ((value: { sealed: true; message: null }) => void) | undefined
    const first = new Promise<{ sealed: true; message: null }>((resolve) => {
      finishFirst = resolve
    })
    const seal = vi.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValue({ sealed: true, message: null })
    renderBar(stateOf([duplicate, duplicate]), seal)

    fireEvent.click(screen.getByText('空闲'))
    fireEvent.click(screen.getByText('TaskFlow'))
    const buttons = screen.getAllByRole('button', { name: '收口 ✓' })
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[0]!)
    expect(screen.getByRole('button', { name: '收口中…' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: '收口 ✓' })).toHaveLength(1)

    finishFirst?.({ sealed: true, message: null })
    await screen.findByText('已收口 ✓')
    expect(screen.getAllByRole('button', { name: '收口 ✓' })).toHaveLength(1)
  })

  it('accumulates same-named history only within the selected project', () => {
    const model: FoldModel = {
      history: [
        {
          start: 1_000, end: 121_000, task: '共享任务', project: 'alpha',
          surface: 'codex', dur: 120_000, drop: false, note: null,
        },
        {
          start: 122_000, end: 302_000, task: '共享任务', project: 'beta',
          surface: 'claude-code', dur: 180_000, drop: false, note: null,
        },
      ],
      current: null,
      lanes: [],
      background: [],
      needsYou: [],
    }
    render(
      <HistoryStrip
        model={model}
        now={400_000}
        measure={() => 0}
        stripW={900}
        clickPop={{ type: 'seg', idx: 0 }}
        onTogglePop={() => {}}
      />,
    )

    expect(screen.getByText('累计').parentElement?.textContent).toBe('累计2m')
    expect(screen.getByText('段数').parentElement?.textContent).toBe('段数1 段')
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

  it('publishes its height as the clearance variable on the frame and clears it on unmount', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    const state = stateOf([])
    const useLedger = (<R,>(selector: (s: TaskflowLedgerState) => R): R => selector(state))
    const props = { useLedger, seal: vi.fn() } as unknown as TaskFlowBarProps
    const view = render(
      <div data-testid="frame">
        <div data-shell-overlay="">
          <TaskFlowBar {...props} />
        </div>
      </div>,
    )
    const frame = view.getByTestId('frame')
    // jsdom heights are 0; what matters is that the seam is published…
    expect(frame.style.getPropertyValue('--dsh-shell-bottom-clearance')).toBe('0px')
    // …stays published across the collapse/expand element swap…
    fireEvent.click(screen.getByText('空闲'))
    expect(screen.getByText('TaskFlow')).toBeTruthy()
    expect(frame.style.getPropertyValue('--dsh-shell-bottom-clearance')).toBe('0px')
    // …and never survives the bar itself (no stale padding after dispose).
    view.unmount()
    expect(frame.style.getPropertyValue('--dsh-shell-bottom-clearance')).toBe('')
  })

  it('folds chips beyond the measured row width into +N whose detail is in the popover', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    const base = Date.now()
    const state = stateOf([
      ledgerLine('start', new Date(base - 60_000).toISOString(), { task: '主线任务甲' }),
      ledgerLine('delegate', new Date(base - 50_000).toISOString(), { task: '泳道乙', payload: { engine: 'dsh-creator' } }),
      ledgerLine('delegate', new Date(base - 40_000).toISOString(), { task: '泳道丙', payload: { engine: 'codex' } }),
    ])
    renderBar(state, vi.fn())
    fireEvent.click(screen.getByText(/主线任务甲/))
    // The fake observer reports a 120px row: only the first chip fits.
    expect(screen.getByText('+2')).toBeTruthy()
    fireEvent.click(screen.getByText('TaskFlow'))
    expect(screen.getByText('更多 running')).toBeTruthy()
    expect(screen.getByText('泳道乙')).toBeTruthy()
    expect(screen.getByText('泳道丙')).toBeTruthy()
  })

  it('publishes the clearance through the one-shot fallback when ResizeObserver is absent', () => {
    // jsdom really has no ResizeObserver here (no stub): the publisher's
    // observe-less immediate publish must still land on the frame.
    const state = stateOf([])
    const useLedger = (<R,>(selector: (s: TaskflowLedgerState) => R): R => selector(state))
    const props = { useLedger, seal: vi.fn() } as unknown as TaskFlowBarProps
    const view = render(
      <div data-testid="frame">
        <div data-shell-overlay="">
          <TaskFlowBar {...props} />
        </div>
      </div>,
    )
    expect(view.getByTestId('frame').style.getPropertyValue('--dsh-shell-bottom-clearance')).toBe('0px')
  })

  it('measures text through the canvas seat when a 2D context exists', () => {
    const measureText = vi.fn((text: string) => ({ width: text.length * 7 }))
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({ font: '', measureText } as unknown as CanvasRenderingContext2D)
    const state = stateOf([
      ledgerLine('start', new Date(Date.now() - 60_000).toISOString(), { task: '当前活' }),
    ])
    renderBar(state, vi.fn())
    fireEvent.click(screen.getByText(/当前活/))
    expect(measureText).toHaveBeenCalled()
  })

  it('renders through the heuristic seat when canvas access throws', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
      throw new Error('no canvas')
    })
    const state = stateOf([
      ledgerLine('start', new Date(Date.now() - 60_000).toISOString(), { task: '当前活' }),
    ])
    renderBar(state, vi.fn())
    fireEvent.click(screen.getByText(/当前活/))
    expect(screen.getByText('TaskFlow')).toBeTruthy()
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
