// @vitest-environment jsdom
/**
 * Needs-you chat title caching, debt-card facts, and continuation prompts.
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskflowTodoFile } from '@deepseek-ai/dsh-api-remotes/client'
import { TaskFlowBar, type TaskFlowBarProps } from '../src/client/TaskFlowBar.tsx'
import { buildModel, parseLedgerText, type NeedsYouItem } from '../src/client/fold.ts'
import { buildHandoff } from '../src/client/handoff.ts'
import type { TaskflowLedgerState } from '../src/client/ledger.ts'
import type { ReviewPlansState } from '../src/client/reviewPlans.ts'
import {
  createSessionTitles, debtSessionId, SESSION_TITLE_BATCH, SESSION_TITLE_TTL_MS,
  debtChatFacts, type SessionTitle, type SessionTitleMap, type SessionTitlesSource, type SessionTitlesState,
} from '../src/client/sessionTitles.ts'

const NOW = Date.parse('2026-11-26T12:00:00-05:00')
const DESKTOP = 'local_5b1c7a2e-3d4f-4a6b-9c8d-0e1f2a3b4c5d'
const CODEX = '019d8f2a-1111-7222-8333-444455556666'
const CODEX_TO = `codex://threads/${CODEX}`

let seq = 0
function debtLine(task: string, payload: Record<string, unknown>, kind = 'review'): string {
  seq += 1
  return JSON.stringify({
    schema_version: 2,
    event_id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    ts: new Date(NOW - seq * 60_000).toISOString(),
    surface: 'claude-code', project: 'TaskFlow', task, event: 'needs-you',
    payload: { kind, ref: `ref-${task}`, ...payload },
  })
}

function debtOf(line: string): NeedsYouItem {
  const events = parseLedgerText(line)
  const model = buildModel(events, NOW)
  return [...model.needsYou, ...model.parked][0]!
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

const settle = (): Promise<void> => act(async () => { await Promise.resolve() })

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('session title source', () => {
  it('batches distinct ids into one lookup and settles found and missing ids', async () => {
    const read = vi.fn().mockResolvedValue({
      [DESKTOP]: { tool: 'claude-code', title: '桌面任务' },
    } satisfies SessionTitleMap)
    const source = createSessionTitles(read, vi.fn(), () => NOW)
    const notify = vi.fn()
    const unsubscribe = source.subscribe(notify)
    source.ensure([DESKTOP, CODEX, DESKTOP, 'toString'])
    expect(read).toHaveBeenCalledWith([DESKTOP, CODEX, 'toString'])
    expect(source.getSnapshot().titles.size).toBe(0)
    await settle()
    expect(source.getSnapshot().titles).toEqual(new Map<string, SessionTitle | null>([
      [DESKTOP, { tool: 'claude-code', title: '桌面任务' }], [CODEX, null], ['toString', null],
    ]))
    expect(notify).toHaveBeenCalledTimes(1)
    unsubscribe()
    source.reset()
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('reuses settled and in-flight ids until the TTL passes', async () => {
    let now = NOW
    const pending = deferred<SessionTitleMap>()
    const read = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue({})
    const source = createSessionTitles(read, vi.fn(), () => now)
    source.ensure([DESKTOP])
    source.ensure([DESKTOP])
    expect(read).toHaveBeenCalledTimes(1)
    pending.resolve({ [DESKTOP]: { tool: 'claude-code', title: '桌面任务' } })
    await settle()
    source.ensure([DESKTOP])
    now += SESSION_TITLE_TTL_MS - 1
    source.ensure([DESKTOP])
    expect(read).toHaveBeenCalledTimes(1)
    now += 1
    source.ensure([DESKTOP])
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('splits large requests into host-sized batches', () => {
    const read = vi.fn((_ids: string[]) => Promise.resolve<SessionTitleMap>({}))
    const source = createSessionTitles(read, vi.fn(), () => NOW)
    source.ensure(Array.from({ length: SESSION_TITLE_BATCH + 1 }, (_, i) => `id-${i}`))
    expect(read.mock.calls.map(([ids]) => ids.length)).toEqual([SESSION_TITLE_BATCH, 1])
  })

  it('keeps last good titles and settles unknown ids as missing when a lookup fails', async () => {
    let now = NOW
    const onError = vi.fn()
    const read = vi.fn()
      .mockResolvedValueOnce({ [DESKTOP]: { tool: 'claude-code', title: '桌面任务' } })
      .mockRejectedValueOnce(new Error('REMOTE_ERROR: down'))
    const source = createSessionTitles(read, onError, () => now)
    source.ensure([DESKTOP])
    await settle()
    now += SESSION_TITLE_TTL_MS
    source.ensure([DESKTOP, CODEX])
    await settle()
    expect(onError).toHaveBeenCalledWith(new Error('REMOTE_ERROR: down'))
    expect(source.getSnapshot().titles).toEqual(new Map<string, SessionTitle | null>([
      [DESKTOP, { tool: 'claude-code', title: '桌面任务' }], [CODEX, null],
    ]))
  })

  it('drops lookups on reset and ignores answers to requests issued before it', async () => {
    const first = deferred<SessionTitleMap>()
    const failed = deferred<SessionTitleMap>()
    const second = deferred<SessionTitleMap>()
    const onError = vi.fn()
    const read = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(failed.promise)
      .mockReturnValueOnce(second.promise)
    const source = createSessionTitles(read, onError, () => NOW)
    source.ensure([DESKTOP])
    source.ensure([CODEX])
    source.reset()
    source.ensure([DESKTOP])
    expect(read).toHaveBeenCalledTimes(3)
    first.resolve({ [DESKTOP]: { tool: 'claude-code', title: '旧连接' } })
    failed.reject(new Error('old connection'))
    await settle()
    expect(source.getSnapshot().titles.size).toBe(0)
    expect(onError).not.toHaveBeenCalled()
    // The stale request's completion leaves the new request in flight.
    source.ensure([DESKTOP])
    expect(read).toHaveBeenCalledTimes(3)
    second.resolve({ [DESKTOP]: { tool: 'claude-code', title: '新连接' } })
    await settle()
    expect(source.getSnapshot().titles.get(DESKTOP)).toEqual({ tool: 'claude-code', title: '新连接' })
  })
})

describe('destination text', () => {
  const state = (entries: Array<[string, SessionTitle | null]>): SessionTitlesState => ({ titles: new Map(entries) })

  it.each([
    { to: DESKTOP, id: DESKTOP, tool: 'claude-code', label: 'Claude Code', short: '5b1c7a2e' },
    { to: CODEX_TO, id: CODEX, tool: 'codex', label: 'Codex', short: '019d8f2a' },
  ] as const)('shows the title or lookup status for $to', ({ to, id, tool, label, short }) => {
    const debt = debtOf(debtLine('无会话', {}))
    const row = (value: string) => [{ label: '去处', value, title: to }]
    expect(debtChatFacts(debt, to, state([[id, { tool, title: '会话' }]]))).toEqual(row(`${label} ·「会话」`))
    expect(debtChatFacts(debt, to, state([[id, { tool, title: '会话', archived: true }]])))
      .toEqual(row(`${label} ·「会话」（已归档）`))
    expect(debtChatFacts(debt, to, state([]))).toEqual(row(`${short}（正在查标题）`))
    expect(debtChatFacts(debt, to, state([[id, null]]))).toEqual(row(`${short}（标题查不到）`))
  })

  it.each([
    ['新开:2026-11-27', '新开一个聊天（交接段在 11-27 的回复和简报里）'],
    ['新开:2028-02-29', '新开一个聊天（交接段在 02-29 的回复和简报里）'],
    ['新开:2026-02-29', '新开一个聊天'],
    ['新开:明天', '新开一个聊天'],
    ['新开:', '新开一个聊天'],
    ['手工查阅:资料', '手工查阅:资料'],
  ])('formats %s without a title lookup', (to, value) => {
    const debt = debtOf(debtLine('无会话', {}))
    expect(debtChatFacts(debt, to, state([]))).toEqual([{ label: '去处', value, title: to }])
  })

  it.each([[DESKTOP, DESKTOP], [CODEX_TO, CODEX]])('omits the origin when %s points to %s', (to, session) => {
    const debt = debtOf(debtLine('同一会话', { session }))
    expect(debtChatFacts(debt, to, state([])).map(row => row.label)).toEqual(['去处'])
  })

  it('reads only a nonempty string session from the debt payload', () => {
    expect(debtSessionId(debtOf(debtLine('有会话', { session: DESKTOP })))).toBe(DESKTOP)
    const legacy = (session: unknown): NeedsYouItem => debtOf(JSON.stringify({
      ts: new Date(NOW - 60_000).toISOString(), surface: 'codex', project: 'TaskFlow', task: '旧格式',
      event: 'needs-you', payload: { kind: 'review', ref: 'r', session },
    }))
    expect(debtSessionId(legacy('  '))).toBeNull()
    expect(debtSessionId(legacy(42))).toBeNull()
    expect(debtSessionId(debtOf(debtLine('无会话', {})))).toBeNull()
  })

  it('inserts the raw destination before the origin and preserves the no-destination prompt', () => {
    const named = debtOf(debtLine('有会话', { session: DESKTOP }))
    const originLine = `- 来源会话：${DESKTOP}（提出这条的聊天，需要前因后果时先回那里看）`
    const destinationLine = `- 去处：${CODEX_TO}（待判位记的去处）`
    const without = buildHandoff(named, 'TaskFlow', [], NOW).prompt
    expect(without).toContain(`- 收口入口：ref-有会话\n${originLine}\n- 说明：`)
    expect(without).not.toContain('去处')
    expect(buildHandoff(named, 'TaskFlow', [], NOW, CODEX_TO).prompt)
      .toBe(without.replace(originLine, `${destinationLine}\n${originLine}`))
    const bare = debtOf(debtLine('无会话', {}))
    expect(buildHandoff(bare, 'TaskFlow', [], NOW).prompt).toContain('- 收口入口：ref-无会话\n- 说明：')
    expect(buildHandoff(bare, 'TaskFlow', [], NOW, CODEX_TO).prompt)
      .toContain(`- 收口入口：ref-无会话\n${destinationLine}\n- 说明：`)
  })
})

describe('debt card destination', () => {
  const ledgerLines = (): string[] => [
    debtLine('桌面来的', { session: DESKTOP }),
    debtLine('Codex 来的', { session: CODEX }),
    debtLine('重复会话', { session: DESKTOP }),
    debtLine('没写会话', {}),
    debtLine('停放的', { session: 'local_park-0001' }, 'park'),
  ]

  function renderBar(
    useSessionTitles: (select: (state: SessionTitlesState) => unknown) => unknown,
    requestSessionTitles: (ids: readonly string[]) => void,
    todoFiles: (events: TaskflowLedgerState['events']) => TaskflowTodoFile[] = () => [],
  ): void {
    const ledger: TaskflowLedgerState = { events: parseLedgerText(ledgerLines().join('\n')), read: true, exists: true }
    const props = {
      useLedger: (select: (state: TaskflowLedgerState) => unknown) => select(ledger),
      useReviewPlans: (select: (state: ReviewPlansState) => unknown) => select({ plans: [], read: true, observer: null }),
      useSessionTitles,
      seal: vi.fn(),
      todos: vi.fn().mockResolvedValue(todoFiles(ledger.events)),
      requestSessionTitles,
    } as unknown as TaskFlowBarProps
    render(<TaskFlowBar {...props} />)
    fireEvent.click(screen.getByText('空闲'))
    // The tray lists three rows per project until expanded.
    fireEvent.click(within(screen.getByRole('region', { name: '待你收口' })).getByText(/^还有 \d+ 条$/))
  }

  function openCard(task: string): HTMLElement {
    fireEvent.click(within(screen.getByRole('region', { name: '待你收口' })).getByRole('button', { name: task }))
    return screen.getByRole('region', { name: `${task} 详情` })
  }

  function fixed(state: SessionTitlesState) {
    return (select: (value: SessionTitlesState) => unknown) => select(state)
  }

  it('requests every open debt session once and names the source for debts without a destination', async () => {
    const request = vi.fn()
    renderBar(fixed({
      titles: new Map<string, SessionTitle | null>([
        [DESKTOP, { tool: 'claude-code', title: 'TaskFlow / 待收口 / 来源会话 · v1', archived: false }],
        [CODEX, { tool: 'codex', title: 'Codex 线程', archived: true }],
      ]),
    }), request)
    expect(request).toHaveBeenLastCalledWith([CODEX, DESKTOP, 'local_park-0001'])
    const desktop = openCard('桌面来的')
    expect(within(desktop).getByText('来源会话')).toBeTruthy()
    expect(within(desktop).queryByText('去处')).toBeNull()
    expect(within(desktop).getByText('Claude Code ·「TaskFlow / 待收口 / 来源会话 · v1」').getAttribute('title')).toBe(DESKTOP)
    const codex = openCard('Codex 来的')
    expect(within(codex).getByText('Codex ·「Codex 线程」（已归档）')).toBeTruthy()
    const bare = openCard('没写会话')
    expect(within(bare).queryByText('去处')).toBeNull()
    expect(within(bare).queryByText('来源会话')).toBeNull()
    await settle()
  })

  it('shows the destination before a distinct source and uses it in the card prompt', async () => {
    renderBar(fixed({ titles: new Map([[DESKTOP, { tool: 'claude-code', title: '来源' }]]) }), vi.fn(), (events) => {
      const ids = new Map(events.map(event => [event.task, event.eventId]))
      return [{
        name: 'DME.md',
        text: [
          `  - todo-decide · debt:${ids.get('桌面来的')} · to:${CODEX_TO}`,
          `  - todo-decide · debt:${ids.get('没写会话')} · to:新开:2026-11-27`,
        ].join('\n'),
      }]
    })
    await settle()
    const card = openCard('桌面来的')
    expect([...card.querySelectorAll('dt')].slice(1, 4).map(node => node.textContent))
      .toEqual(['收口入口', '去处', '来源会话'])
    expect(within(card).getByText('019d8f2a（正在查标题）').getAttribute('title')).toBe(CODEX_TO)
    expect(within(card).getByText('Claude Code ·「来源」').getAttribute('title')).toBe(DESKTOP)
    expect(card.querySelector('pre')?.textContent).toContain(`- 去处：${CODEX_TO}（待判位记的去处）\n- 来源会话：${DESKTOP}`)
    const bare = openCard('没写会话')
    expect(within(bare).getByText('去处')).toBeTruthy()
    expect(within(bare).getByText('新开一个聊天（交接段在 11-27 的回复和简报里）').getAttribute('title'))
      .toBe('新开:2026-11-27')
    expect(within(bare).queryByText('来源会话')).toBeNull()
    await settle()
  })

  it('shows the short id when the title is unknown and when the lookup fails', async () => {
    const pending = deferred<SessionTitleMap>()
    const onError = vi.fn()
    const source: SessionTitlesSource = createSessionTitles(() => pending.promise, onError)
    const useSessionTitles = (select: (value: SessionTitlesState) => unknown): unknown =>
      select(useSyncExternalStore(notify => source.subscribe(notify), () => source.getSnapshot()))
    renderBar(useSessionTitles, (ids) => { source.ensure(ids) })
    const card = openCard('桌面来的')
    expect(within(card).getByText('来源会话')).toBeTruthy()
    expect(within(card).getByText('5b1c7a2e（正在查标题）')).toBeTruthy()
    pending.reject(new Error('REMOTE_ERROR: down'))
    await settle()
    expect(onError).toHaveBeenCalled()
    expect(within(card).getByText('5b1c7a2e（标题查不到）')).toBeTruthy()
    expect(within(openCard('Codex 来的')).getByText('019d8f2a（标题查不到）')).toBeTruthy()
  })
})
