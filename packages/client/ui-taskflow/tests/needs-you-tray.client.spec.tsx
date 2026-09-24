// @vitest-environment jsdom
/**
 * Needs-you tray (2026-09-23): open debts sit at the bottom of the expanded
 * bar, grouped by display project, three rows per column, a deferred seal
 * with a five-second 撤销 window, and a remembered fold state.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskFlowBar, type TaskFlowBarProps } from '../src/client/TaskFlowBar.tsx'
import { fmtAge, TRAY_COLLAPSED_KEY } from '../src/client/NeedsYouTray.tsx'
import { SEAL_UNDO_MS, useDeferredSeal } from '../src/client/deferredSeal.ts'
import type { TaskFlowFace } from '../src/client/face.ts'
import type { TaskflowLedgerState } from '../src/client/ledger.ts'
import { groupDebtsByProject, parseLedgerText, type NeedsYouItem } from '../src/client/fold.ts'

const NOW = Date.parse('2026-09-23T12:00:00-04:00')

function debtLine(project: string, task: string, hoursAgo: number, kind = 'review'): string {
  return JSON.stringify({
    ts: new Date(NOW - hoursAgo * 3_600_000).toISOString(),
    surface: 'codex', project, task, event: 'needs-you', payload: { kind, ref: `ref-${task}` },
  })
}

function renderBar(lines: string[], seal: TaskFlowFace['seal']) {
  const state: TaskflowLedgerState = { events: parseLedgerText(lines.join('\n')), read: true, exists: true }
  const useLedger = (<R,>(selector: (s: TaskflowLedgerState) => R): R => selector(state))
  const todos = vi.fn().mockResolvedValue([])
  const props = { useLedger, seal, todos } as unknown as TaskFlowBarProps
  const view = render(<TaskFlowBar {...props} />)
  fireEvent.click(screen.getByText('空闲'))
  return view
}

const LEDGER = [
  debtLine('ARK', '方舟一', 50),
  debtLine('MSC_AI', '方舟二', 40, 'decision'),
  debtLine('ARK', '方舟三', 30),
  debtLine('ARK', '方舟四', 20),
  debtLine('digital-me', '数字一', 10),
]

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('groupDebtsByProject', () => {
  it('folds display aliases, orders busiest project first and longest-owed first', () => {
    const debts = [
      { project: 'digital-me', task: 'a', owed: 5 },
      { project: 'MSC_AI', task: 'b', owed: 9 },
      { project: 'ARK', task: 'c', owed: 20 },
    ] as NeedsYouItem[]
    const groups = groupDebtsByProject(debts)
    expect(groups.map(g => g.project)).toEqual(['ARK', 'digital-me'])
    expect(groups[0]!.items.map(d => d.task)).toEqual(['c', 'b'])
    // Identity is untouched: the MSC_AI row still carries its written name.
    expect(groups[0]!.items[1]!.project).toBe('MSC_AI')
  })
})

describe('fmtAge', () => {
  it('reads as days, hours, or minutes', () => {
    expect(fmtAge(670 * 3_600_000)).toBe('27天')
    expect(fmtAge(30 * 3_600_000)).toBe('30小时')
    expect(fmtAge(29 * 60_000)).toBe('29分钟')
    expect(fmtAge(5_000)).toBe('1分钟')
  })
})

describe('NeedsYouTray', () => {
  it('shows debts without opening the title popover, three rows per project', () => {
    renderBar(LEDGER, vi.fn())
    expect(screen.getByText('待你收口')).toBeTruthy()
    expect(screen.queryByText('待收口')).toBeNull()
    // ARK column (MSC_AI folded in) shows the three oldest, then 还有 1 条.
    expect(screen.getByRole('button', { name: '方舟一' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '方舟二' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '方舟三' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '方舟四' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '还有 1 条' }))
    expect(screen.getByRole('button', { name: '方舟四' })).toBeTruthy()
    expect(screen.getByText('决定')).toBeTruthy()
  })

  it('shows an unknown kind verbatim and an all-clear when nothing is owed', () => {
    const first = renderBar([debtLine('ARK', '方舟五', 5, 'custom')], vi.fn())
    expect(screen.getByText('custom')).toBeTruthy()
    first.unmount()
    renderBar([], vi.fn())
    expect(screen.getByText('没有待你收口的事')).toBeTruthy()
  })

  it('opens a row in its project tree card and seals it with a note', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const seal = vi.fn().mockResolvedValue({ sealed: true, message: null })
    renderBar(LEDGER, seal)
    const row = screen.getByRole('button', { name: '方舟二' })
    fireEvent.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('region', { name: 'ARK 项目树' })).toBeTruthy()
    const card = screen.getByRole('region', { name: '方舟二 详情' })
    expect(within(card).getByText('ref-方舟二')).toBeTruthy()
    expect(within(card).getByText(/账本里写作 MSC_AI/)).toBeTruthy()

    // The same row closes the card again; another row switches to its card.
    fireEvent.click(row)
    expect(screen.queryByRole('region', { name: '方舟二 详情' })).toBeNull()
    fireEvent.click(row)

    const input = within(screen.getByRole('region', { name: '方舟二 详情' })).getByRole('textbox')
    fireEvent.change(input, { target: { value: '  决定已拍板，下次先问清楚范围  ' } })
    fireEvent.keyDown(input, { key: 'a' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.queryByRole('region', { name: '方舟二 详情' })).toBeNull()
    await act(async () => { vi.advanceTimersByTime(SEAL_UNDO_MS + 10) })
    expect(seal.mock.calls[0]![0]).toMatchObject({
      project: 'MSC_AI', task: '方舟二', confirmationRef: 'dsh-ui:seal-click', note: '决定已拍板，下次先问清楚范围',
    })
  })


  it('writes the seal only after the undo window, and undo cancels it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const seal = vi.fn().mockResolvedValue({ sealed: true, message: null })
    renderBar(LEDGER, seal)

    fireEvent.click(screen.getByRole('button', { name: '收口 数字一' }))
    expect(screen.queryByRole('button', { name: '数字一' })).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('已收口：数字一')
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(screen.getByRole('button', { name: '数字一' })).toBeTruthy()
    act(() => { vi.advanceTimersByTime(SEAL_UNDO_MS + 100) })
    expect(seal).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '收口 方舟二' }))
    act(() => { vi.advanceTimersByTime(SEAL_UNDO_MS - 100) })
    expect(seal).not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(200) })
    expect(seal).toHaveBeenCalledTimes(1)
    expect(seal.mock.calls[0]![0]).toMatchObject({
      project: 'MSC_AI', task: '方舟二', confirmationRef: 'dsh-ui:seal-click',
    })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('counts every queued seal in the undo toast', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    renderBar(LEDGER, vi.fn())
    fireEvent.click(screen.getByRole('button', { name: '收口 数字一' }))
    fireEvent.click(screen.getByRole('button', { name: '收口 方舟一' }))
    expect(screen.getByRole('status').textContent).toContain('已收口 2 条，最近：方舟一')
  })

  it.each([
    ['still writing', () => new Promise<never>(() => {}), 4],
    ['sealed', () => Promise.resolve({ sealed: true, message: null }), 4],
    ['refused', () => Promise.resolve({ sealed: false, message: 'no-open-needs-you' }), 5],
    ['failed', () => Promise.reject(new Error('down')), 5],
  ] as const)('counts a row out of the tray only while its seal is writing or written (%s)', async (_state, outcome, expected) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    renderBar(LEDGER, vi.fn(outcome))
    fireEvent.click(screen.getByRole('button', { name: '收口 数字一' }))
    await act(async () => { vi.advanceTimersByTime(SEAL_UNDO_MS + 10) })
    const trayCount = screen.getByRole('region', { name: '待你收口' }).querySelector('button span:nth-child(2)')?.textContent
    expect(trayCount).toBe(String(expected))
  })

  it('queues one seal per debt and ignores an undo for a debt that is not pending', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const seal = vi.fn().mockResolvedValue({ sealed: true, message: null })
    const [first, second] = parseLedgerText([debtLine('ARK', '一', 5), debtLine('ARK', '二', 4)].join('\n'))
      .map((e, ledgerIndex): NeedsYouItem => ({ ...e, ledgerIndex, kind: 'review', owed: 0 }))
    const { result } = renderHook(() => useDeferredSeal(seal, 100))
    act(() => { result.current.queue(first!) })
    act(() => { result.current.queue(first!) })
    act(() => { result.current.undo(second!) })
    expect(result.current.pendingCount).toBe(1)
    await act(async () => { vi.advanceTimersByTime(150) })
    expect(seal).toHaveBeenCalledTimes(1)
  })

  it('brings a row back when the seal call itself fails or is refused without a reason', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const seal = vi.fn()
      .mockRejectedValueOnce(new Error('wire down'))
      .mockRejectedValueOnce('boom')
      .mockResolvedValueOnce({ sealed: false, message: null })
    renderBar(LEDGER, seal)
    fireEvent.click(screen.getByRole('button', { name: '收口 数字一' }))
    fireEvent.click(screen.getByRole('button', { name: '收口 方舟一' }))
    fireEvent.click(screen.getByRole('button', { name: '收口 方舟三' }))
    await act(async () => { vi.advanceTimersByTime(SEAL_UNDO_MS + 10) })
    expect(screen.getByText('收口失败：wire down')).toBeTruthy()
    expect(screen.getByText('收口失败：boom')).toBeTruthy()
    expect(screen.getByText('收口失败：seal refused')).toBeTruthy()
  })

  it('brings a row back with the reason when the host refuses the seal', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const seal = vi.fn().mockResolvedValue({ sealed: false, message: 'no-open-needs-you' })
    renderBar(LEDGER, seal)
    fireEvent.click(screen.getByRole('button', { name: '收口 数字一' }))
    await act(async () => { vi.advanceTimersByTime(SEAL_UNDO_MS + 10) })
    expect(screen.getByRole('button', { name: '数字一' })).toBeTruthy()
    expect(screen.getByText('收口失败：no-open-needs-you')).toBeTruthy()
  })

  it('caps its grid while a project panel is open', () => {
    renderBar(LEDGER, vi.fn())
    const row = screen.getByRole('button', { name: '方舟一' })
    expect(row.closest('[data-panel-open]')).toBeNull()
    const head = screen.getByRole('button', { name: 'ARK' })
    fireEvent.click(head)
    expect(row.closest('[data-panel-open]')).not.toBeNull()
    fireEvent.click(head)
    expect(row.closest('[data-panel-open]')).toBeNull()
    const css = readFileSync(resolve(import.meta.dirname, '../src/client/NeedsYouTray.module.css'), 'utf8')
    expect(css).toMatch(/\[data-panel-open\] \.grid \{\s*max-height: min\(20vh, 152px\);/)
  })

  it('folds to its header and remembers the choice', () => {
    const first = renderBar(LEDGER, vi.fn())
    fireEvent.click(screen.getByRole('button', { name: /待你收口/ }))
    expect(screen.queryByRole('button', { name: '方舟一' })).toBeNull()
    expect(window.localStorage.getItem(TRAY_COLLAPSED_KEY)).toBe('1')
    first.unmount()

    renderBar(LEDGER, vi.fn())
    expect(screen.getByText('5')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '方舟一' })).toBeNull()
  })

  it('unfolds again, and still folds when storage is blocked', () => {
    window.localStorage.setItem(TRAY_COLLAPSED_KEY, '1')
    const first = renderBar(LEDGER, vi.fn())
    fireEvent.click(screen.getByRole('button', { name: /待你收口/ }))
    expect(screen.getByRole('button', { name: '方舟一' })).toBeTruthy()
    expect(window.localStorage.getItem(TRAY_COLLAPSED_KEY)).toBe('0')
    first.unmount()

    const blocked = (): never => { throw new Error('blocked') }
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked)
    renderBar(LEDGER, vi.fn())
    expect(screen.getByRole('button', { name: '方舟一' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /待你收口/ }))
    expect(screen.queryByRole('button', { name: '方舟一' })).toBeNull()
  })
})
