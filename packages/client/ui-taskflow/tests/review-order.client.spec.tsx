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
import type { SessionTitlesState } from '../src/client/sessionTitles.ts'

const NOW = Date.parse('2026-10-15T04:00:00Z')
const FIRST = '123e4567-e89b-42d3-a456-426614174001'
const SECOND = '123e4567-e89b-42d3-a456-426614174002'
const THIRD = '123e4567-e89b-42d3-a456-426614174003'
const ROLES_CHAT = 'ARK / 产品 / 用户与角色 · v1'
const DEMO_CHAT = 'ARK / 架构 / 两级分发与执行 · v1'
const plan = () => parseReviewPlan({
  schemaVersion: 1, project: 'ARK', revision: 1, updatedAt: new Date(NOW).toISOString(), basisRef: 'ARK/review.md',
  items: [
    { id: 'roles', title: '核对角色', threadId: 'roles-chat', chatTitle: ROLES_CHAT, ref: 'roles.md', order: 1, lane: 'main', reason: '先核对职责', debtEventIds: [FIRST] },
    { id: 'demo', title: '查看演示', threadId: 'demo-chat', chatTitle: DEMO_CHAT, ref: 'demo.html', order: 2, lane: 'parallel', reason: '观察实际流程', after: ['roles'], debtEventIds: [SECOND] },
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
      useSessionTitles: (select: (value: SessionTitlesState) => unknown) => select({ titles: new Map() }),
      requestSessionTitles: vi.fn(),
      seal: vi.fn(), todos: vi.fn().mockResolvedValue([]),
    } as unknown as TaskFlowBarProps
    render(<TaskFlowBar {...props} />)
    fireEvent.click(screen.getByText('空闲'))
    fireEvent.change(screen.getByRole('combobox', { name: '项目' }), { target: { value: 'ARK' } })
    const order = await screen.findByRole('region', { name: 'ARK 审阅顺序' })
    const graph = screen.getByRole('img', { name: 'ARK 主线与未了结分支' })
    expect(order.compareDocumentPosition(graph) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(order).queryByRole('button')).toBeNull()
    const tray = screen.getByRole('region', { name: '待你收口' })
    fireEvent.click(within(tray).getAllByRole('button', { name: '同一任务' })[0]!)
    expect(within(screen.getByRole('region', { name: '同一任务 详情' })).getByText('exact-ref-0')).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('收口备注 / 给 AI 的反馈（可选，一行）'), { target: { value: '仅给第一项的反馈' } })
    fireEvent.click(within(tray).getAllByRole('button', { name: '同一任务' })[1]!)
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
      reviewState={state()} sessionTitles={{ titles: new Map() }} destinations={new Map()} reviewDebts={[]}
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
    render(<ReviewPlan project="ARK" state={current} events={[]} debts={[]} />)
    expect(screen.getByText('监听可能中断')).toBeTruthy()
    expect(screen.getByText('Codex · 有新信息待核对')).toBeTruthy()
    expect(screen.getByText('云聊天 / Cowork 未接入')).toBeTruthy()
    expect(screen.getAllByText('待核对记录')).toHaveLength(2)
  })

  it('combines steps into native chat names with one status, while leaving review actions in the tray', () => {
    const current = state()
    const saved = current.plans[0]!
    saved.items[1]!.lane = 'main'
    saved.items[1]!.debtEventIds = []
    saved.items.push({
      ...saved.items[0]!, id: 'full-document', title: '全文核对步骤', order: 4,
      condition: '选作首发任务时再看', reason: '逐段检查完整文档', debtEventIds: [SECOND],
    })
    saved.overrides = [{ itemId: 'full-document', order: 3, ref: 'human:review-message', reason: '本人要求先看效果' }]
    const events = parseLedgerText([
      JSON.stringify({ schema_version: 2, event_id: FIRST, event: 'needs-you', ts: new Date(NOW - 1000).toISOString(), project: 'ARK', task: '核对角色', surface: 'codex', payload: { kind: 'review', ref: 'roles.md' } }),
      JSON.stringify({ schema_version: 2, event_id: SECOND, event: 'needs-you', ts: new Date(NOW - 1000).toISOString(), project: 'ARK', task: '核对正文', surface: 'codex', payload: { kind: 'review', ref: 'full.md' } }),
      JSON.stringify({ schema_version: 2, event_id: THIRD, event: 'done', ts: new Date(NOW).toISOString(), project: 'ARK', task: '核对角色', surface: 'dsh', payload: { seal: true, resolves_event_id: FIRST, confirmation_ref: 'dsh-ui:seal-click' } }),
    ].join('\n'))
    const debts = buildModel(events, NOW).needsYou
    render(<ReviewPlan project="ARK" state={current} events={events} debts={debts} />)
    const order = screen.getByRole('region', { name: 'ARK 审阅顺序' })
    const rows = within(order).getAllByRole('listitem')
    expect(rows.map(row => row.getAttribute('aria-label'))).toEqual([`审阅聊天 ${DEMO_CHAT}`, `审阅聊天 ${ROLES_CHAT}`])
    const chat = within(order).getByRole('listitem', { name: `审阅聊天 ${ROLES_CHAT}` })
    expect(chat.getAttribute('data-review-thread')).toBe('roles-chat')
    expect(within(chat).getByText('待审阅')).toBeTruthy()
    expect(within(chat).queryByText('相关待审已收口')).toBeNull()
    expect(within(order).queryByRole('button')).toBeNull()
    for (const removed of ['核对角色', '全文核对步骤', '逐段检查完整文档', '选作首发任务时再看', 'roles.md', '复制审阅入口', '查看待审记录']) {
      expect(within(order).queryByText(removed)).toBeNull()
    }
    expect(debts.map(debt => debt.eventId)).toEqual([SECOND])
    expect(order.querySelector('details')?.open).toBe(false)
  })

  it('labels a missing native chat title explicitly and keeps generic plan titles usable', () => {
    const current = state()
    const missingTitle = { ...current.plans[0]!.items[0]! }
    delete missingTitle.chatTitle
    current.plans[0]!.items = [
      missingTitle,
      { id: 'generic', title: '通用审阅清单', ref: 'generic.md', order: 2, lane: 'main', reason: '通用计划', debtEventIds: [] },
    ]
    render(<ReviewPlan project="ARK" state={current} events={[]} debts={[]} />)
    expect(screen.getByText('聊天名称待同步（roles-chat）')).toBeTruthy()
    expect(screen.getByText('通用审阅清单')).toBeTruthy()
    expect(screen.queryByText('核对角色')).toBeNull()
  })

  it('uses a single shared closure label rather than completing each reading step', () => {
    const current = state()
    current.plans[0]!.items.push({ ...current.plans[0]!.items[0]!, id: 'full-document', order: 3 })
    const events = parseLedgerText([
      JSON.stringify({ schema_version: 2, event_id: FIRST, event: 'needs-you', ts: new Date(NOW - 1000).toISOString(), project: 'ARK', task: '核对角色', surface: 'codex', payload: { kind: 'review', ref: 'roles.md' } }),
      JSON.stringify({ schema_version: 2, event_id: THIRD, event: 'done', ts: new Date(NOW).toISOString(), project: 'ARK', task: '核对角色', surface: 'dsh', payload: { seal: true, resolves_event_id: FIRST, confirmation_ref: 'dsh-ui:seal-click' } }),
    ].join('\n'))
    render(<ReviewPlan project="ARK" state={current} events={events} debts={[]} />)
    const chat = screen.getByRole('listitem', { name: `审阅聊天 ${ROLES_CHAT}` })
    expect(within(chat).getAllByText('相关待审已收口')).toHaveLength(1)
  })

  it('keeps a replaced debt distinct from an audited closure in the merged chat status', () => {
    const events = parseLedgerText([
      JSON.stringify({ schema_version: 2, event_id: FIRST, event: 'needs-you', ts: new Date(NOW - 1000).toISOString(), project: 'ARK', task: '核对角色', surface: 'codex', payload: { kind: 'review', ref: 'roles.md' } }),
      JSON.stringify({ schema_version: 2, event_id: THIRD, event: 'drop', ts: new Date(NOW).toISOString(), project: 'ARK', task: '核对角色', surface: 'codex', payload: { note: 'superseded: revised draft', resolves_event_id: FIRST } }),
    ].join('\n'))
    render(<ReviewPlan project="ARK" state={state()} events={events} debts={[]} />)
    const chat = screen.getByRole('listitem', { name: `审阅聊天 ${ROLES_CHAT}` })
    expect(within(chat).getByText('待核对新稿')).toBeTruthy()
    expect(within(chat).queryByText('相关待审已收口')).toBeNull()
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
    render(<ReviewPlan project="ARK" state={current} events={[]} debts={[]} />)
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
    render(<ReviewPlan project="ARK" state={{ plans: [], read, observer: null, ...(error === undefined ? {} : { error }) }} events={[]} debts={[]} />)
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
    render(<ReviewPlan project="ARK" state={current} events={[]} debts={[]} />)
    expect(screen.getByText(label)).toBeTruthy()
  })
})
