// @vitest-environment jsdom
/**
 * Originating chat of a needs-you debt: `payload.session` resolves to a chat
 * title through the batched, cached `sessionTitles` lookup, and the debt card
 * and the continuation prompt name where to go back to.
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskFlowBar, type TaskFlowBarProps } from '../src/client/TaskFlowBar.tsx'
import { buildModel, parseLedgerText, type NeedsYouItem } from '../src/client/fold.ts'
import { buildHandoff } from '../src/client/handoff.ts'
import type { TaskflowLedgerState } from '../src/client/ledger.ts'
import type { ReviewPlansState } from '../src/client/reviewPlans.ts'
import {
  createSessionTitles, debtSessionId, SESSION_TITLE_BATCH, SESSION_TITLE_TTL_MS,
  sessionDestination, type SessionTitle, type SessionTitleMap, type SessionTitlesSource, type SessionTitlesState,
} from '../src/client/sessionTitles.ts'

const NOW = Date.parse('2026-11-26T12:00:00-05:00')
const DESKTOP = 'local_5b1c7a2e-3d4f-4a6b-9c8d-0e1f2a3b4c5d'
const CODEX = '019d8f2a-1111-7222-8333-444455556666'

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

  it('names the tool and title, marking archived chats', () => {
    expect(sessionDestination(DESKTOP, state([[DESKTOP, { tool: 'claude-code', title: '桌面任务' }]])))
      .toEqual({ label: '去处', value: 'Claude Code ·「桌面任务」' })
    expect(sessionDestination(CODEX, state([[CODEX, { tool: 'codex', title: '线程', archived: true }]])))
      .toEqual({ label: '去处', value: 'Codex ·「线程」（已归档）' })
    expect(sessionDestination(CODEX, state([[CODEX, { tool: 'codex', title: '线程', archived: false }]])).value)
      .toBe('Codex ·「线程」')
  })

  it('falls back to a short id while loading and when no title is found', () => {
    expect(sessionDestination(DESKTOP, state([]))).toEqual({ label: '来源会话', value: '5b1c7a2e（正在查标题）' })
    expect(sessionDestination(CODEX, state([[CODEX, null]]))).toEqual({ label: '来源会话', value: '019d8f2a（标题查不到）' })
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

  it('adds the full session id to the continuation prompt only when the debt names one', () => {
    const named = debtOf(debtLine('有会话', { session: DESKTOP }))
    expect(buildHandoff(named, 'TaskFlow', [], NOW).prompt)
      .toContain(`- 来源会话：${DESKTOP}（提出这条的聊天，需要前因后果时先回那里看）`)
    const bare = debtOf(debtLine('无会话', {}))
    expect(buildHandoff(bare, 'TaskFlow', [], NOW).prompt).not.toContain('来源会话')
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
  ): void {
    const ledger: TaskflowLedgerState = { events: parseLedgerText(ledgerLines().join('\n')), read: true, exists: true }
    const props = {
      useLedger: (select: (state: TaskflowLedgerState) => unknown) => select(ledger),
      useReviewPlans: (select: (state: ReviewPlansState) => unknown) => select({ plans: [], read: true, observer: null }),
      useSessionTitles,
      seal: vi.fn(),
      todos: vi.fn().mockResolvedValue([]),
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

  it('requests every open debt session once and shows resolved and archived destinations', () => {
    const request = vi.fn()
    renderBar(fixed({
      titles: new Map<string, SessionTitle | null>([
        [DESKTOP, { tool: 'claude-code', title: 'TaskFlow / 待收口 / 来源会话 · v1', archived: false }],
        [CODEX, { tool: 'codex', title: 'Codex 线程', archived: true }],
      ]),
    }), request)
    expect(request).toHaveBeenLastCalledWith([CODEX, DESKTOP, 'local_park-0001'])
    const desktop = openCard('桌面来的')
    expect(within(desktop).getByText('去处')).toBeTruthy()
    expect(within(desktop).getByText('Claude Code ·「TaskFlow / 待收口 / 来源会话 · v1」').getAttribute('title')).toBe(DESKTOP)
    const codex = openCard('Codex 来的')
    expect(within(codex).getByText('Codex ·「Codex 线程」（已归档）')).toBeTruthy()
    const bare = openCard('没写会话')
    expect(within(bare).queryByText('去处')).toBeNull()
    expect(within(bare).queryByText('来源会话')).toBeNull()
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
