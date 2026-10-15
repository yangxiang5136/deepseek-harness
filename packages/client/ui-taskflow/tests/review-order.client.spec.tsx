// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskFlowBar, type TaskFlowBarProps } from '../src/client/TaskFlowBar.tsx'
import { ReviewPlan } from '../src/client/ReviewOrderPanel.tsx'
import { parseReviewPlan } from '../src/client/reviewPlan.ts'
import { parseLedgerText } from '../src/client/fold.ts'
import type { TaskflowLedgerState } from '../src/client/ledger.ts'
import type { ReviewPlansState } from '../src/client/reviewPlans.ts'

const NOW = Date.parse('2026-10-15T04:00:00Z')
const FIRST = '123e4567-e89b-42d3-a456-426614174001'
const SECOND = '123e4567-e89b-42d3-a456-426614174002'
const THIRD = '123e4567-e89b-42d3-a456-426614174003'
const plan = () => parseReviewPlan({
  schemaVersion: 1, project: 'ARK', revision: 1, updatedAt: new Date(NOW).toISOString(), basisRef: 'ARK/review.md',
  items: [
    { id: 'roles', title: '核对角色', ref: 'roles.md', order: 1, lane: 'main', reason: '先核对职责', debtEventIds: [FIRST] },
    { id: 'demo', title: '查看演示', ref: 'demo.html', order: 2, lane: 'parallel', reason: '观察实际流程', after: ['roles'], debtEventIds: [SECOND] },
  ], overrides: [], sources: [],
})
const state = (): ReviewPlansState => ({ plans: [plan()], read: true, observer: null })
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear() })

describe('review order and exact debt detail', () => {
  it('opens each same-task debt by identity and preserves unlisted debts in the tray', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const ledger: TaskflowLedgerState = {
      read: true, exists: true, events: parseLedgerText([FIRST, SECOND, THIRD].map((event_id, index) => JSON.stringify({
        schema_version: 2, event_id, ts: new Date(NOW - 3000).toISOString(),
        project: 'ARK', surface: 'codex', task: index === 2 ? '独立事项' : '同一任务', event: 'needs-you',
        payload: { kind: 'review', ref: `exact-ref-${index}` },
      })).join('\n')),
    }
    const props = {
      useLedger: (select: (value: TaskflowLedgerState) => unknown) => select(ledger),
      useReviewPlans: (select: (value: ReviewPlansState) => unknown) => select(state()),
      seal: vi.fn(), todos: vi.fn().mockResolvedValue([]),
    } as unknown as TaskFlowBarProps
    render(<TaskFlowBar {...props} />)
    fireEvent.click(screen.getByText('空闲'))
    fireEvent.change(screen.getByRole('combobox', { name: '项目' }), { target: { value: 'ARK' } })
    const order = await screen.findByRole('region', { name: 'ARK 审阅顺序' })
    fireEvent.click(within(order).getByRole('button', { name: `查看待审记录 核对角色 ${FIRST}` }))
    expect(within(screen.getByRole('region', { name: '同一任务 详情' })).getByText('exact-ref-0')).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('收口备注 / 给 AI 的反馈（可选，一行）'), { target: { value: '仅给第一项的反馈' } })
    fireEvent.click(within(order).getByRole('button', { name: `查看待审记录 查看演示 ${SECOND}` }))
    expect(within(screen.getByRole('region', { name: '同一任务 详情' })).getByText('exact-ref-1')).toBeTruthy()
    expect(screen.getByPlaceholderText<HTMLInputElement>('收口备注 / 给 AI 的反馈（可选，一行）').value).toBe('')
    expect(within(order).getByRole('list', { name: '建议顺序' }).querySelectorAll('li')).toHaveLength(1)
    expect(within(order).getByRole('list', { name: '可并行审阅' }).querySelectorAll('li')).toHaveLength(1)
    expect(within(screen.getByRole('region', { name: '待你收口' })).getByText('独立事项')).toBeTruthy()
  })

  it('shows pending source reconciliation and stale observer health separately from the saved revision', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const current = state()
    current.observer = { lastScanAt: new Date(NOW - 31_000).toISOString(), lastErrorCount: 0, coverage: ['Codex', 'Claude Code'], excluded: ['云聊天', 'Cowork'] }
    current.plans[0]!.sources.push({ surface: 'codex', threadId: 'chat', latestMessageId: 'new', observedAt: new Date(NOW).toISOString(), status: 'pending', sourceRef: 'chat-ref' })
    render(<ReviewPlan project="ARK" state={current} events={[]} debts={[]} onOpenDebt={vi.fn()} />)
    expect(screen.getByText('监听可能中断')).toBeTruthy()
    expect(screen.getByText('Codex · 有新信息待核对')).toBeTruthy()
    expect(screen.getByText('云聊天 / Cowork 未接入')).toBeTruthy()
    expect(screen.getAllByText('待核对记录')).toHaveLength(2)
  })
})
