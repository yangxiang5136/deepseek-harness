// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskFlowBar, type TaskFlowBarProps } from '../src/client/TaskFlowBar.tsx'
import { parseLedgerText } from '../src/client/fold.ts'
import type { TaskflowLedgerState } from '../src/client/ledger.ts'
import { parseReviewPlan } from '../src/client/reviewPlan.ts'
import type { ReviewPlansState } from '../src/client/reviewPlans.ts'
import type { SessionTitlesState } from '../src/client/sessionTitles.ts'
import { readView, TASKFLOW_VIEW_KEY } from '../src/client/viewState.ts'

const NOW = Date.parse('2026-10-15T08:00:00Z')

beforeEach(() => {
  localStorage.clear()
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  localStorage.clear()
})

function props(): TaskFlowBarProps {
  const ledger: TaskflowLedgerState = {
    read: true, exists: true,
    events: parseLedgerText(JSON.stringify({
      schema_version: 2, event_id: '123e4567-e89b-42d3-a456-426614174001',
      ts: new Date(NOW - 1000).toISOString(), project: 'ARK', surface: 'codex',
      task: '待审稿', event: 'needs-you', payload: { kind: 'review', ref: 'ARK/review.md' },
    })),
  }
  const plans: ReviewPlansState = {
    read: true, observer: null,
    plans: [parseReviewPlan({
      schemaVersion: 1, project: 'ARK', revision: 1, updatedAt: new Date(NOW).toISOString(), basisRef: 'ARK/plan.md',
      items: [{ id: 'review', title: '审阅步骤', threadId: 'ark-review', chatTitle: 'ARK / 产品 / 待审稿 · v1', ref: 'ARK/review.md', order: 1, lane: 'main', reason: '先审阅', debtEventIds: [] }],
      overrides: [], sources: [],
    })],
  }
  return {
    useLedger: (select: (value: TaskflowLedgerState) => unknown) => select(ledger),
    useReviewPlans: (select: (value: ReviewPlansState) => unknown) => select(plans),
    useSessionTitles: (select: (value: SessionTitlesState) => unknown) => select({ titles: new Map() }),
    requestSessionTitles: vi.fn(),
    seal: vi.fn(), todos: vi.fn().mockResolvedValue([{ name: 'job.md', text: '- [ ] 申请材料' }]),
  } as unknown as TaskFlowBarProps
}

async function openArk(): Promise<void> {
  fireEvent.click(screen.getByText('空闲'))
  const picker = screen.getByRole('combobox', { name: '项目' })
  await within(picker).findByRole('option', { name: 'job' })
  fireEvent.change(picker, { target: { value: 'ARK' } })
}

describe('TaskFlow viewing preference across remounts', () => {
  it('restores the expanded project and its review order without reopening a debt card or replaying a seal', async () => {
    const input = props()
    const page = render(<TaskFlowBar {...input} />)
    expect(screen.queryByRole('combobox', { name: '项目' })).toBeNull()
    await openArk()
    fireEvent.click(within(screen.getByRole('region', { name: '待你收口' })).getByRole('button', { name: '待审稿' }))
    expect(screen.getByRole('region', { name: '待审稿 详情' })).toBeTruthy()
    page.unmount()
    render(<TaskFlowBar {...input} />)
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '项目' }).value).toBe('ARK')
    expect(screen.getByRole('region', { name: 'ARK 审阅顺序' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: '待审稿 详情' })).toBeNull()
    expect(input.seal).not.toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem(TASKFLOW_VIEW_KEY)!)).toEqual({ version: 1, collapsed: false, openProject: 'ARK' })
  })

  it('remembers a project switch and does not follow another page while mounted', async () => {
    const input = props()
    const page = render(<TaskFlowBar {...input} />)
    await openArk()
    const picker = screen.getByRole<HTMLSelectElement>('combobox', { name: '项目' })
    fireEvent.change(picker, { target: { value: 'job' } })
    page.unmount()
    const next = render(<TaskFlowBar {...input} />)
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '项目' }).value).toBe('job')
    expect(screen.getByRole('region', { name: 'job 项目树' })).toBeTruthy()
    localStorage.setItem(TASKFLOW_VIEW_KEY, JSON.stringify({ version: 1, collapsed: false, openProject: 'ARK' }))
    fireEvent(window, new StorageEvent('storage', { key: TASKFLOW_VIEW_KEY }))
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '项目' }).value).toBe('job')
    next.unmount()
    render(<TaskFlowBar {...input} />)
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '项目' }).value).toBe('ARK')
  })

  it.each(['empty selection', 'panel close', 'tray toggle'] as const)('keeps an explicit project close after remount: %s', async (gesture) => {
    const input = props()
    const page = render(<TaskFlowBar {...input} />)
    await openArk()
    if (gesture === 'empty selection') fireEvent.change(screen.getByRole('combobox', { name: '项目' }), { target: { value: '' } })
    else if (gesture === 'panel close') fireEvent.click(within(screen.getByRole('region', { name: 'ARK 项目树' })).getByRole('button', { name: '收起' }))
    else fireEvent.click(within(screen.getByRole('region', { name: '待你收口' })).getByRole('button', { name: 'ARK' }))
    page.unmount()
    render(<TaskFlowBar {...input} />)
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '项目' }).value).toBe('')
    expect(screen.queryByRole('region', { name: 'ARK 审阅顺序' })).toBeNull()
  })

  it('remains collapsed after an explicit collapse and retains the project for the next expansion', async () => {
    const input = props()
    const page = render(<TaskFlowBar {...input} />)
    await openArk()
    fireEvent.click(screen.getByRole('button', { name: '▾' }))
    page.unmount()
    render(<TaskFlowBar {...input} />)
    expect(screen.queryByRole('combobox', { name: '项目' })).toBeNull()
    fireEvent.click(screen.getByText('空闲'))
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '项目' }).value).toBe('ARK')
    expect(screen.getByRole('region', { name: 'ARK 审阅顺序' })).toBeTruthy()
  })

  it('keeps the page usable when storage reads and writes fail', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full') })
    render(<TaskFlowBar {...props()} />)
    await openArk()
    expect(screen.getByRole('region', { name: 'ARK 审阅顺序' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '▾' }))
    expect(screen.queryByRole('combobox', { name: '项目' })).toBeNull()
  })

  it('keeps source failures visible when restoring an expanded view with no project selected', async () => {
    localStorage.setItem(TASKFLOW_VIEW_KEY, JSON.stringify({ version: 1, collapsed: false, openProject: null }))
    const input = {
      ...props(),
      useReviewPlans: (select: (value: ReviewPlansState) => unknown) => select({ plans: [], read: true, observer: null, error: '计划离线' }),
      useSessionTitles: (select: (value: SessionTitlesState) => unknown) => select({ titles: new Map() }),
      requestSessionTitles: vi.fn(),
      todos: vi.fn().mockRejectedValue(new Error('待办离线')),
    } as unknown as TaskFlowBarProps
    render(<TaskFlowBar {...input} />)
    expect(screen.getByText('审阅计划读取失败：计划离线')).toBeTruthy()
    expect(await screen.findByText('待办读取失败：待办离线')).toBeTruthy()
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '项目' }).value).toBe('')
  })
})

describe('durable viewing preference validation', () => {
  it.each([
    '{invalid', 'null', '[]', '42',
    JSON.stringify({ version: 2, collapsed: false, openProject: 'ARK' }),
    JSON.stringify({ version: 1, collapsed: 'false', openProject: 'ARK' }),
    JSON.stringify({ version: 1, collapsed: false }),
    JSON.stringify({ version: 1, collapsed: false, openProject: 3 }),
    JSON.stringify({ version: 1, collapsed: false, openProject: ' ' }),
  ])('falls back safely for an invalid saved preference: %s', (text) => {
    localStorage.setItem(TASKFLOW_VIEW_KEY, text)
    expect(readView()).toEqual({ collapsed: true, openProject: null })
  })

  it('restores a closed project and excludes unrelated state', () => {
    localStorage.setItem(TASKFLOW_VIEW_KEY, JSON.stringify({ version: 1, collapsed: false, openProject: null, selectedDebtKey: 'old-debt', seal: true }))
    expect(readView()).toEqual({ collapsed: false, openProject: null })
  })
})
