// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskFlowBar, type TaskFlowBarProps } from '../src/client/TaskFlowBar.tsx'
import { ReviewPlan } from '../src/client/ReviewOrderPanel.tsx'
import { parseReviewPlan } from '../src/client/reviewPlan.ts'
import { buildModel, parseLedgerText } from '../src/client/fold.ts'
import type { TaskflowLedgerState } from '../src/client/ledger.ts'
import { ProjectPanel } from '../src/client/ProjectPanel.tsx'
import { buildProjectTree } from '../src/client/projectTree.ts'
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
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); Reflect.deleteProperty(navigator, 'clipboard') })

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
    const graph = screen.getByRole('img', { name: 'ARK 主线与未了结分支' })
    expect(order.compareDocumentPosition(graph) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
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

  it('leaves projects without a saved plan free of an empty review section', () => {
    const tree = buildProjectTree([], buildModel([], NOW), 'job', undefined, NOW)
    render(<ProjectPanel
      tree={tree} events={[]} now={NOW} todos={{ status: 'ready', items: [] }} onPin={vi.fn()}
      cardTask={null} onCard={vi.fn()} onSeal={vi.fn()} onClose={vi.fn()}
      reviewState={state()} reviewDebts={[]} onOpenDebt={vi.fn()}
    />)
    expect(screen.queryByRole('region', { name: 'job 审阅顺序' })).toBeNull()
    expect(screen.queryByText('建议审阅顺序')).toBeNull()
    expect(screen.getByRole('img', { name: 'job 主线与未了结分支' })).toBeTruthy()
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

  it('copies an entrance or exposes it for manual selection, while showing exact closure and human ordering evidence', async () => {
    const current = state()
    const saved = current.plans[0]!
    saved.items[0]!.condition = '选作首发任务时再看'
    saved.items[0]!.lane = 'conditional'
    saved.items[1]!.debtEventIds = []
    saved.overrides = [{ itemId: 'demo', order: 0, ref: 'human:review-message', reason: '本人要求先看效果' }]
    const events = parseLedgerText([
      JSON.stringify({ schema_version: 2, event_id: FIRST, event: 'needs-you', ts: new Date(NOW - 1000).toISOString(), project: 'ARK', task: '核对角色', surface: 'codex', payload: { kind: 'review', ref: 'roles.md' } }),
      JSON.stringify({ schema_version: 2, event_id: THIRD, event: 'done', ts: new Date(NOW).toISOString(), project: 'ARK', task: '核对角色', surface: 'dsh', payload: { seal: true, resolves_event_id: FIRST, confirmation_ref: 'dsh-ui:seal-click' } }),
    ].join('\n'))
    render(<ReviewPlan project="ARK" state={current} events={events} debts={buildModel(events, NOW).needsYou} onOpenDebt={vi.fn()} />)
    const item = screen.getByRole('listitem', { name: '审阅事项 核对角色' })
    fireEvent.click(within(item).getByRole('button', { name: '复制审阅入口' }))
    expect(await within(item).findByText('复制失败，请手动选中入口')).toBeTruthy()
    expect(within(item).getByText('查看依据与入口').closest('details')?.open).toBe(true)
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    fireEvent.click(within(item).getByRole('button', { name: '复制审阅入口' }))
    expect(await within(item).findByText('已复制入口')).toBeTruthy()
    expect(writeText).toHaveBeenCalledWith('roles.md')
    expect(within(item).getByText('相关待审已收口')).toBeTruthy()
    expect(within(item).getByText('选作首发任务时再看')).toBeTruthy()
    expect(within(item).getByText('按需')).toBeTruthy()
    const demo = screen.getByRole('listitem', { name: '审阅事项 查看演示' })
    expect(within(demo).getByText('尚未关联待审记录')).toBeTruthy()
    expect(within(demo).getByText('本人要求先看效果')).toBeTruthy()
    expect(within(demo).getByText('排序依据：human:review-message')).toBeTruthy()
  })

  it('shows connected source coverage, reconciliation ranges and legacy missing timestamps without claiming acceptance', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const current: ReviewPlansState = {
      read: true,
      plans: [parseReviewPlan({
        ...plan(), items: [{ ...plan().items[0], after: [] }], sources: [
          { surface: 'claude-code', threadId: 'fresh', latestMessageId: 'm2', observedAt: new Date(NOW).toISOString(), status: 'fresh', sourceRef: 'fresh:source', reconciledMessageId: 'm2', reconciledAt: new Date(NOW).toISOString() },
          { surface: 'claude-local', threadId: 'unavailable', latestMessageId: 'm3', observedAt: new Date(NOW).toISOString(), status: 'unavailable', sourceRef: 'unavailable:source', reconciledMessageId: 'm1', pendingFromRef: 'source:range-start', pendingFromMessageId: 'm2', reconciledRef: 'source:prior-reconcile' },
        ],
      })],
      observer: { lastScanAt: new Date(NOW).toISOString(), lastErrorCount: null, coverage: ['codex-local', 'claude-code', 'claude-local', 'claude-browser', 'cloud-only chats'], excluded: [] },
    }
    render(<ReviewPlan project="ARK" state={current} events={[]} debts={[]} onOpenDebt={vi.fn()} />)
    expect(screen.getByText('本机 Codex / Claude Code / 其他来源 / 云聊天 · 3秒检查')).toBeTruthy()
    expect(screen.queryByText(/未接入/)).toBeNull()
    expect(screen.getByText('信息来源 · 查看核对范围')).toBeTruthy()
    expect(screen.getByText('Claude Code · 已核对到该消息')).toBeTruthy()
    expect(screen.getByText('Claude Code · 来源暂不可读')).toBeTruthy()
    expect(screen.getByText('待核对起点：source:range-start')).toBeTruthy()
    expect(screen.getByText('核对依据：source:prior-reconcile')).toBeTruthy()
    expect(screen.getByText('已核对：m1 · 未记录时间')).toBeTruthy()
    expect(screen.queryByRole('list', { name: '可并行审阅' })).toBeNull()
  })

  it.each([
    ['before first response', false, undefined, '读取中…'],
    ['no saved plan', true, undefined, '尚未设置审阅顺序'],
    ['read failure', false, 'offline', '审阅计划读取失败：offline'],
  ] as const)('presents %s distinctly', (_name, read, error, label) => {
    render(<ReviewPlan project="ARK" state={{ plans: [], read, observer: null, ...(error === undefined ? {} : { error }) }} events={[]} debts={[]} onOpenDebt={vi.fn()} />)
    expect(screen.getByText(label)).toBeTruthy()
  })

  it.each([
    ['failed sources', new Date(NOW).toISOString(), 2, '来源检查出错'],
    ['first scan pending', null, 0, '监听可能中断'],
    ['invalid scan metadata', 'unknown', 0, '监听可能中断'],
    ['recent scan', new Date(NOW).toISOString(), 0, '本机 Codex · 3秒检查'],
  ] as const)('presents observer health for %s', (_name, lastScanAt, lastErrorCount, label) => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const current = state()
    current.observer = { lastScanAt, lastErrorCount, coverage: ['Codex'], excluded: [] }
    render(<ReviewPlan project="ARK" state={current} events={[]} debts={[]} onOpenDebt={vi.fn()} />)
    expect(screen.getByText(label)).toBeTruthy()
  })
})
