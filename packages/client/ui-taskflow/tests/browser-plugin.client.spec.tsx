// @vitest-environment jsdom
/**
 * Browser-plugin wiring and the seal checkmark flow: the plugin registers the
 * shell.overlay entry with its face, the face's seal verb carries the wire and
 * business refusals as outcomes, and the rendered bar walks mini → expanded →
 * tray card → seal with the audit pin intact.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  TaskflowLedgerSnapshot, TaskflowSealResult, TaskflowTodoSnapshot,
} from '@deepseek-ai/dsh-api-remotes/client'
import { apply, inject } from '../src/client/index.ts'
import { TaskFlowBar, type TaskFlowBarProps } from '../src/client/TaskFlowBar.tsx'
import { ChipRow, popAnchor } from '../src/client/ChipRow.tsx'
import barCss from '../src/client/TaskFlowBar.module.css'
import { HistoryStrip } from '../src/client/HistoryStrip.tsx'
import { MiniBar } from '../src/client/MiniBar.tsx'
import { TitlePopover } from '../src/client/TitlePopover.tsx'
import type { TaskFlowFace } from '../src/client/face.ts'
import type { ClickPop } from '../src/client/interaction.ts'
import type { TaskflowLedgerState } from '../src/client/ledger.ts'
import {
  IDLE_PAUSE_MS, LEGACY_CLOSE_MS, parseLedgerText, REFRESH_MS,
  type Chip, type CurrentTask, type FoldModel, type HistorySegment, type Lane,
} from '../src/client/fold.ts'
import { SEAL_UNDO_MS } from '../src/client/deferredSeal.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  FakeResizeObserver.width = 120
})

/**
 * ResizeObserver double for jsdom: fires once on observe (like the real one)
 * with a fixed content width (120px unless a test overrides it) — the
 * clearance publisher ignores entries (it reads offsetHeight) and the row
 * observer consumes the width.
 */
class FakeResizeObserver {
  static width = 120

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
    this.cb([{ contentRect: new DOMRectReadOnly(0, 0, FakeResizeObserver.width, 28) }], this)
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
  todos?: () => Promise<Wire<TaskflowTodoSnapshot>>
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
  const todos = vi.fn(overrides.todos
    ?? (() => Promise.resolve({
      ok: true as const,
      value: { dir: '/bus/todo/projects', exists: true, files: [{ name: 'ARK.md', text: '- [ ] 地推' }] },
    })))
  ctx.provide('remote.taskflow', { read, seal, todos })
  return { ctx, slots: ctx.get('slots') as SlotRegistry, read, seal, todos }
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

  it('reads todo files through the face and names a wire failure', async () => {
    const b = await bench({
      todos: vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          value: { dir: '/bus/todo/projects', exists: true, files: [{ name: 'ARK.md', text: '- [ ] 地推' }] },
        })
        .mockResolvedValueOnce({ ok: false, error: { code: 'REMOTE_ERROR', message: 'down' } }),
    })
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const face = (b.slots.entries('shell.overlay')[0]!.inject as unknown as () => TaskFlowFace)()
    expect(await face.todos()).toEqual([{ name: 'ARK.md', text: '- [ ] 地推' }])
    await expect(face.todos()).rejects.toThrow('REMOTE_ERROR: down')
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
    const todos = vi.fn().mockResolvedValue([])
    const props = { useLedger, seal, todos } as unknown as TaskFlowBarProps
    return render(<TaskFlowBar {...props} />)
  }

  function stateOf(lines: string[]): TaskflowLedgerState {
    return { events: parseLedgerText(lines.join('\n')), read: true, exists: true }
  }

  it('counts silent work beside the title and opens its list without collapsing', () => {
    // Local wall-clock noon: sameDay() folds in the machine's zone.
    const now = new Date(2026, 7, 20, 12).getTime()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const at = (minutesAgo: number): string => new Date(now - minutesAgo * 60_000).toISOString()
    // 旧任务 was preempted 80 min ago and never finished: a silent background task.
    renderBar(stateOf([
      ledgerLine('start', at(90), { task: '旧任务' }),
      ledgerLine('start', at(80), { task: '新任务' }),
      ledgerLine('start', at(5), { task: '新任务' }),
    ]), vi.fn())
    fireEvent.click(screen.getByText(/新任务/))
    const badge = screen.getByRole('button', { name: '无心跳 1' })
    expect(badge.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(badge)
    expect(badge.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('无心跳')).toBeTruthy()
    expect(screen.getByText(/旧任务 · /)).toBeTruthy()
    fireEvent.click(badge)
    expect(screen.queryByText('无心跳')).toBeNull()
    expect(screen.getByText('TaskFlow')).toBeTruthy()
  })

  it('walks mini → expanded → quiet popover → tray card → bare seal with the audit pin intact', async () => {
    const now = new Date(2026, 7, 20, 12).getTime()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
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
    // The title popover no longer lists debts: they live in the tray alone.
    expect(screen.queryByRole('button', { name: /^无心跳/ })).toBeNull()
    // Nothing silent renders nothing — not even a stray count.
    expect(screen.getByText('TaskFlow').parentElement?.textContent).toBe('TaskFlow▾')
    fireEvent.click(screen.getByText('TaskFlow'))
    expect(screen.getByText('一切正常')).toBeTruthy()
    expect(screen.queryByText('待收口')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '交付评审' }))
    const card = screen.getByRole('region', { name: '交付评审 详情' })
    expect(within(card).getByText('branch-x')).toBeTruthy()
    fireEvent.click(within(card).getByRole('button', { name: '收口' }))
    await act(async () => { vi.advanceTimersByTime(SEAL_UNDO_MS + 10) })
    expect(seal).toHaveBeenCalledWith({
      project: 'digital-me',
      task: '交付评审',
      resolvesTs: debtTs,
      resolvesEventId: eventId,
      confirmationRef: 'dsh-ui:seal-click',
    })
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
      parked: [],
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

  it('ignores a zero-width row observation and splits at the fallback row width', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    FakeResizeObserver.width = 0
    const base = Date.now()
    const state = stateOf([
      ledgerLine('start', new Date(base - 60_000).toISOString(), { task: '主线任务甲' }),
      ledgerLine('delegate', new Date(base - 50_000).toISOString(), { task: '泳道乙', payload: { engine: 'dsh-creator' } }),
      ledgerLine('delegate', new Date(base - 40_000).toISOString(), { task: '泳道丙', payload: { engine: 'codex' } }),
    ])
    renderBar(state, vi.fn())
    fireEvent.click(screen.getByText(/主线任务甲/))
    expect(screen.getByText('泳道丙')).toBeTruthy()
    expect(screen.queryByText(/^\+\d+$/)).toBeNull()
  })

  it('advances the walking clock between ledger refreshes, pausing an idle current task', () => {
    let clock = Date.parse('2026-08-20T08:00:00-04:00')
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const state = stateOf([
      ledgerLine('start', new Date(clock - 60_000).toISOString(), { task: '当前活' }),
    ])
    renderBar(state, vi.fn())
    expect(screen.queryByText('闲置')).toBeNull()
    clock += IDLE_PAUSE_MS
    act(() => { vi.advanceTimersByTime(3 * REFRESH_MS) })
    expect(screen.getByText('当前活')).toBeTruthy()
    expect(screen.getByText('闲置')).toBeTruthy()
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

  it('measures text through the canvas seat at each role font, reassigning the font only on change', () => {
    const measureText = vi.fn((text: string) => ({ width: text.length * 7 }))
    const fonts: string[] = []
    const context = {
      measureText,
      set font(value: string) {
        fonts.push(value)
      },
    }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(context as unknown as CanvasRenderingContext2D)
    const now = Date.now()
    const at = (minutesAgo: number): string => new Date(now - minutesAgo * 60_000).toISOString()
    // Two finished segments: the strip measures both labels at the meta font.
    const state = stateOf([
      ledgerLine('start', at(5), { task: '甲' }),
      ledgerLine('done', at(4), { task: '甲' }),
      ledgerLine('start', at(4), { task: '乙' }),
      ledgerLine('done', at(3), { task: '乙' }),
      ledgerLine('start', at(1), { task: '当前活' }),
    ])
    renderBar(state, vi.fn())
    fireEvent.click(screen.getByText(/当前活/))
    expect(fonts.some(font => font.startsWith('600 15px'))).toBe(true)
    expect(fonts.some(font => font.startsWith('400 12px'))).toBe(true)
    expect(fonts.length).toBeLessThan(measureText.mock.calls.length)
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

const MIN = 60_000

function modelOf(over: Partial<FoldModel> = {}): FoldModel {
  return { history: [], current: null, lanes: [], background: [], needsYou: [], parked: [], ...over }
}

function segment(task: string, project: string, start: number, end: number, over: Partial<HistorySegment> = {}): HistorySegment {
  return { start, end, task, project, surface: 'codex', dur: end - start, drop: false, note: null, ...over }
}

const CURRENT: CurrentTask = {
  start: 0, lastEvt: 0, task: '主线', project: 'p', surface: 'codex', paused: false, activeDur: 5 * MIN,
}

const LANE: Lane = {
  delegateTask: '泳道', project: 'p', engine: 'dsh', openTs: 2 * MIN, lastDshTs: 2 * MIN,
  status: 'running', labelTask: null, ticks: 0,
}

describe('MiniBar label', () => {
  function miniBar(model: FoldModel, loading = false) {
    return <MiniBar model={model} now={10 * MIN} loading={loading} onExpand={() => {}} rootRef={() => {}} />
  }

  function mini(model: FoldModel, loading = false) {
    return render(miniBar(model, loading))
  }

  it('carries the shared type tokens while collapsed (no banner ancestor)', () => {
    const { container } = mini(modelOf({ current: CURRENT }))
    expect(container.firstElementChild?.classList.contains(barCss.scale as string)).toBe(true)
  })

  it('keeps the running task apart from its minutes and +N', () => {
    mini(modelOf({ current: CURRENT, lanes: [LANE] }))
    expect(screen.getByText('主线')).toBeTruthy()
    expect(screen.getByText('5m +1')).toBeTruthy()
  })

  it('shows an idle current task with a 闲置 pill and a separate +N', () => {
    const view = mini(modelOf({ current: { ...CURRENT, paused: true }, lanes: [LANE] }))
    expect(screen.getByText('主线')).toBeTruthy()
    expect(screen.getByText('闲置')).toBeTruthy()
    expect(screen.getByText('+1')).toBeTruthy()
    view.rerender(miniBar(modelOf({ current: { ...CURRENT, paused: true } })))
    expect(screen.queryByText('+1')).toBeNull()
  })

  it('falls back to the first running lane at wall time when nothing is current', () => {
    mini(modelOf({ lanes: [LANE] }))
    expect(screen.getByText('泳道')).toBeTruthy()
    expect(screen.getByText('8m')).toBeTruthy()
  })

  it('reads 加载账本… before the first ledger read settles', () => {
    mini(modelOf({ current: CURRENT }), true)
    expect(screen.getByText('加载账本…')).toBeTruthy()
    expect(screen.queryByText('主线')).toBeNull()
  })
})

describe('ChipRow', () => {
  const chips: Chip[] = [
    { kind: 'cur', src: 'claude-code', task: '主线', project: 'p', start: 0, paused: true, activeDur: MIN, lastEvt: 0 },
    { kind: 'run', src: 'dsh', task: '泳道', project: 'p', start: MIN, ticks: 2 },
    { kind: 'bg', src: 'codex', task: '后台', project: 'q', start: 0, activeDur: 2 * MIN, lastEvt: 15 * MIN },
  ]

  function row(clickPop: ClickPop | null, onTogglePop: (pop: ClickPop | null) => void = () => {}) {
    return <ChipRow chips={chips} overflowCount={3} now={20 * MIN} clickPop={clickPop} onTogglePop={onTogglePop} />
  }

  it('marks the lead chip and splits the idle state out of the task', () => {
    const { container } = render(row(null))
    const cur = container.querySelector('[data-kind="cur"]')
    expect(cur?.hasAttribute('data-paused')).toBe(true)
    expect(cur?.textContent).toBe('主线闲置claude-code')
    expect(container.querySelector('[data-kind="run"]')?.hasAttribute('data-paused')).toBe(false)
    expect(screen.getByText('主线')).toBeTruthy()
    expect(screen.getByText('+3')).toBeTruthy()
  })

  it('anchors a chip popover to the right when it would run past the window', () => {
    Object.defineProperty(document.documentElement, 'clientWidth', { value: 1000, configurable: true })
    const at = (left: number): HTMLElement => ({ getBoundingClientRect: () => ({ left }) }) as unknown as HTMLElement
    expect(popAnchor(null)).toEqual({ left: 0 })
    expect(popAnchor(at(500))).toEqual({ left: 0 })
    expect(popAnchor(at(900))).toEqual({ right: 0 })
    const { container } = render(row({ type: 'chip', index: 1 }))
    const pop = container.querySelector('[data-kind="run"] > div') as HTMLElement
    expect(pop.style.left === '0px' || pop.style.right === '0px').toBe(true)
    Reflect.deleteProperty(document.documentElement, 'clientWidth')
  })

  it('toggles each chip drill-down, whose clicks stay inside it', () => {
    const toggle = vi.fn()
    const view = render(row(null, toggle))
    fireEvent.click(screen.getByText('泳道'))
    expect(toggle).toHaveBeenLastCalledWith({ type: 'chip', index: 1 })

    view.rerender(row({ type: 'chip', index: 0 }, toggle))
    fireEvent.click(screen.getByText('主线 · 闲置'))
    expect(toggle).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText('主线'))
    expect(toggle).toHaveBeenLastCalledWith(null)

    view.rerender(row({ type: 'chip', index: 1 }, toggle))
    expect(screen.getByText('×2')).toBeTruthy()
    view.rerender(row({ type: 'chip', index: 2 }, toggle))
    expect(screen.getByText('2m')).toBeTruthy()
    expect(screen.getByText('5m 前')).toBeTruthy()
  })
})

describe('TitlePopover', () => {
  it('lists silent work under one 无心跳 header and overflowed chips with their ticks', () => {
    const model = modelOf({
      lanes: [{ ...LANE, status: 'interrupted', labelTask: '沉默泳道', lastDshTs: 0 }],
      background: [{
        task: '沉默后台', project: 'p', surface: 'codex', start: 0, lastEvt: MIN, status: 'interrupted', activeDur: 0,
      }],
    })
    const overflow: Chip[] = [
      { kind: 'run', src: 'dsh', task: '溢出', project: 'p', start: 0, ticks: 3 },
      { kind: 'bg', src: 'codex', task: '后台溢出', project: 'p', start: 0 },
    ]
    const outer = vi.fn()
    render(
      <div onClick={outer}>
        <TitlePopover model={model} now={60 * MIN} overflow={overflow} />
      </div>,
    )
    expect(screen.getByText('沉默泳道 · 1h0m 无事件')).toBeTruthy()
    expect(screen.getByText('沉默后台 · 59m 无事件')).toBeTruthy()
    expect(screen.queryByText('静默')).toBeNull()
    expect(screen.getByText('溢出 ×3')).toBeTruthy()
    expect(screen.getByText('后台溢出')).toBeTruthy()
    fireEvent.click(screen.getByText('无心跳'))
    expect(outer).not.toHaveBeenCalled()
  })
})

describe('HistoryStrip labels and drill-downs', () => {
  // Items: a packed series (open right: the current task continues it), a
  // 零碎 block of two fragments, and a lone segment that closed 30 s ago.
  const model = modelOf({
    history: [
      segment('Alpha build v1', 'alpha', 0, 10 * MIN, { note: 'first cut' }),
      segment('Alpha build v2', 'alpha', 11 * MIN, 20 * MIN, { drop: true }),
      segment('ping', 'beta', 21 * MIN, 21 * MIN + 20_000),
      segment('pong', 'beta', 21.5 * MIN, 21.5 * MIN + 10_000),
      segment('Lone task', 'gamma', 22 * MIN, 27 * MIN),
    ],
    current: { ...CURRENT, task: 'Alpha build v3', project: 'alpha' },
  })
  const now = 27 * MIN + 30_000
  const measure = (text: string): number => text.length * 6

  function strip(stripW: number, clickPop: ClickPop | null = null, onTogglePop: (pop: ClickPop | null) => void = () => {}) {
    return (
      <HistoryStrip
        model={model}
        now={now}
        measure={measure}
        stripW={stripW}
        clickPop={clickPop}
        onTogglePop={onTogglePop}
      />
    )
  }

  it('shortens labels that do not fit and leaves blocks under 28px unlabelled until hovered', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const view = render(strip(900))
    expect(screen.getByText('Alpha build ×2 · 19m')).toBeTruthy()
    expect(screen.getByText('Lone task')).toBeTruthy()
    // Too narrow for 零碎 ×2: the block keeps its count rather than cutting it.
    const aggOuter = screen.getByText('×2').parentElement!.parentElement!
    const segOuter = screen.getByText('Lone task').parentElement!.parentElement!

    view.rerender(strip(1400))
    expect(screen.getByText('零碎 ×2')).toBeTruthy()
    view.rerender(strip(300))
    expect(screen.queryByText('零碎 ×2')).toBeNull()
    expect(screen.queryByText('×2')).toBeNull()
    fireEvent.mouseEnter(aggOuter)
    expect(screen.getByText('零碎 ×2 · 30s')).toBeTruthy()
    fireEvent.mouseLeave(aggOuter)
    fireEvent.mouseLeave(aggOuter)
    fireEvent.mouseEnter(segOuter)
    expect(screen.getByText('Lone task · 5m')).toBeTruthy()
    fireEvent.mouseLeave(segOuter)
    act(() => { vi.advanceTimersByTime(200) })
    expect(screen.queryByText('Lone task · 5m')).toBeNull()
    expect(screen.queryByText('零碎 ×2 · 30s')).toBeNull()

    // At 100px the series keeps only its count; hover still shows it whole.
    view.rerender(strip(100))
    expect(screen.queryByText('Alpha build ×2')).toBeNull()
    const packOuter = screen.getByText('×2').parentElement!.parentElement!
    fireEvent.mouseEnter(packOuter)
    expect(screen.getByText('Alpha build ×2 · 19m')).toBeTruthy()
    fireEvent.mouseLeave(packOuter)
    view.unmount()
  })

  it('gives zero-duration history its minimum share', () => {
    const idle = modelOf({ history: [segment('瞬间', 'p', 5 * MIN, 5 * MIN)] })
    const { container } = render(
      <HistoryStrip model={idle} now={10 * MIN} measure={() => 0} stripW={900} clickPop={null} onTogglePop={() => {}} />,
    )
    const outer = container.querySelector<HTMLElement>('[style*="width"]')
    expect(outer?.style.width).toBe(`${(26 / 9).toFixed(2)}%`)
  })

  it('opens the series, 零碎 and segment drill-downs with their members', () => {
    const toggle = vi.fn()
    const view = render(strip(900, { type: 'pack', idx: 0 }, toggle))
    expect(screen.getByText('Alpha build v1 · 10m')).toBeTruthy()
    expect(screen.getByText('first cut')).toBeTruthy()
    expect(screen.getByText('Alpha build v2 · 9m')).toBeTruthy()
    expect(screen.getByText('已放弃')).toBeTruthy()
    fireEvent.click(screen.getByText('first cut'))
    expect(toggle).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Lone task'))
    expect(toggle).toHaveBeenLastCalledWith({ type: 'seg', idx: 2 })

    view.rerender(strip(900, { type: 'agg', idx: 1 }, toggle))
    expect(screen.getByText('2 段 · 30s')).toBeTruthy()
    expect(screen.getByText('ping · 20s')).toBeTruthy()
    fireEvent.click(screen.getByText('×2'))
    expect(toggle).toHaveBeenLastCalledWith(null)

    view.rerender(strip(900, { type: 'seg', idx: 2 }, toggle))
    const pop = screen.getByText('累计').parentElement!.parentElement!
    expect(pop.style.right).toBe('0px')
    expect(screen.getByText('gamma')).toBeTruthy()

    view.rerender(strip(900, { type: 'chip', index: 0 }, toggle))
    expect(screen.queryByText('累计')).toBeNull()
  })

  it('renders a series and a 零碎 block that just closed', () => {
    const later = 100 * MIN
    const fresh = modelOf({
      history: [
        segment('Beta sync a', 'beta', 90 * MIN, 95 * MIN),
        segment('Beta sync b', 'beta', 95 * MIN, later - 55_000),
        segment('x', 'delta', later - 50_000, later - 40_000),
        segment('y', 'delta', later - 40_000, later - 30_000),
      ],
    })
    render(
      <HistoryStrip model={fresh} now={later} measure={() => 0} stripW={900} clickPop={null} onTogglePop={() => {}} />,
    )
    expect(screen.getByText(/^Beta ×2/)).toBeTruthy()
    expect(screen.getByText(/^零碎 ×2/)).toBeTruthy()
  })
})
