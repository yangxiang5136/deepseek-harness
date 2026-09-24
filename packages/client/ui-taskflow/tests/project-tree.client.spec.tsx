// @vitest-environment jsdom
/**
 * Project tree (Branch Compass inside TaskFlow, 2026-09-24): a tray project
 * name opens that project's mainline, its unresolved branches and its todo
 * items; parked side-branches (needs-you kind `park`) live only here.
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskflowTodoFile } from '@deepseek-ai/dsh-api-remotes/client'
import { TaskFlowBar, type TaskFlowBarProps } from '../src/client/TaskFlowBar.tsx'
import type { TaskFlowFace } from '../src/client/face.ts'
import type { TaskflowLedgerState } from '../src/client/ledger.ts'
import { buildModel, IDLE_PAUSE_MS, parseLedgerText } from '../src/client/fold.ts'
import {
  buildProjectTree, MAINLINE_PINS_KEY, readPins, TREE_WINDOW_MS, writePins,
} from '../src/client/projectTree.ts'
import { parseTodoItems, todosForProject, todoTitle } from '../src/client/todo.ts'
import { PANEL_BRANCH_ROWS, PANEL_TODO_ROWS, ProjectPanel } from '../src/client/ProjectPanel.tsx'
import { buildHandoff, eventLine, PROMPT_TIMELINE_ROWS, shellArg } from '../src/client/handoff.ts'

const NOW = Date.parse('2026-09-24T12:00:00-04:00')
const MIN = 60_000

let seq = 0
function ev(
  event: string, minutesAgo: number, task: string,
  over: Record<string, unknown> = {},
): string {
  seq += 1
  return JSON.stringify({
    schema_version: 2,
    event_id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    ts: new Date(NOW - minutesAgo * MIN).toISOString(),
    surface: 'claude-code',
    project: 'ARK',
    task,
    event,
    ...over,
  })
}

function debt(minutesAgo: number, task: string, kind: string, over: Record<string, unknown> = {}): string {
  return ev('needs-you', minutesAgo, task, { payload: { kind, ref: `ref-${task}` }, ...over })
}

function treeOf(lines: string[], pin?: string) {
  const events = parseLedgerText(lines.join('\n'))
  return buildProjectTree(events, buildModel(events, NOW), 'ARK', pin, NOW)
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('buildProjectTree', () => {
  const WEEK = [
    ev('start', 600, '主线'),
    ev('switch', 590, '主线'),
    ev('done', 560, '主线'),
    ev('start', 500, '已完成分支'),
    ev('done', 480, '已完成分支'),
    ev('start', 470, '放弃分支'),
    ev('drop', 460, '放弃分支'),
    ev('start', 10, '跑着的分支', { surface: 'codex' }),
    ev('start', 300, '停了的分支'),
    ev('start', 200, '等你的分支'),
    debt(190, '等你的分支', 'decision'),
    debt(100, '停放的方向', 'park'),
    debt(9 * 24 * 60, '上周的欠账', 'review', { project: 'MSC_AI' }),
    ev('start', 50, '别的项目', { project: 'digital-me' }),
  ]

  it('splits the week into mainline, unresolved branches and settled ones', () => {
    const tree = treeOf(WEEK, '主线')
    expect(tree).toMatchObject({ label: 'ARK', mainline: '主线', pinned: true })
    expect(tree.main?.state).toBe('done')
    expect(tree.mainNodes).toHaveLength(3)
    expect(tree.mainDur).toBe(40 * MIN)
    expect(tree.branches.map(b => [b.task, b.state])).toEqual([
      ['上周的欠账', 'waiting'],
      ['停了的分支', 'stalled'],
      ['等你的分支', 'waiting'],
      ['停放的方向', 'parked'],
      ['跑着的分支', 'running'],
    ])
    expect(tree.branches.find(b => b.task === '跑着的分支')?.surface).toBe('codex')
    expect(tree.branches.find(b => b.task === '上周的欠账')?.activeDur).toBe(0)
    expect(tree.settled.map(b => [b.task, b.state])).toEqual([['放弃分支', 'drop'], ['已完成分支', 'done']])
    expect(tree.branchDur).toBe(20 * MIN + 10 * MIN + 10 * MIN)
    expect(tree.candidates).not.toContain('别的项目')
  })

  it('suggests the most active task when nothing is pinned', () => {
    const tree = treeOf(WEEK)
    expect(tree).toMatchObject({ mainline: '主线', pinned: false })
  })

  it('keeps a quiet pin as the mainline and a pickable candidate', () => {
    const tree = treeOf(WEEK, '上个月的主线')
    expect(tree).toMatchObject({ mainline: '上个月的主线', main: null, mainNodes: [], mainDur: 0 })
    expect(tree.candidates[0]).toBe('上个月的主线')
  })

  it('caps each silent gap at the idle window and folds nothing for an empty project', () => {
    const tree = treeOf([ev('start', 300, 'a'), ev('done', 60, 'a')])
    expect(tree.mainDur).toBe(IDLE_PAUSE_MS)
    expect(treeOf([])).toMatchObject({ mainline: null, main: null, branches: [], candidates: [] })
  })

  it('skips other projects\u2019 debts and parks an old side-branch from before the window', () => {
    const tree = treeOf([
      debt(9 * 24 * 60, '旧停放', 'park'),
      debt(20, '别处', 'review', { project: 'job' }),
    ])
    expect(tree.branches).toEqual([])
    expect(tree.main).toMatchObject({ task: '旧停放', state: 'parked', activeDur: 0 })
    expect(tree.candidates).toEqual(['旧停放'])
  })

  it('ignores events outside the window and in the future', () => {
    const old = TREE_WINDOW_MS / MIN + 5
    expect(treeOf([ev('start', old, '老任务'), ev('start', -30, '未来任务')]).candidates).toEqual([])
  })
})

describe('parked debts in the bar fold', () => {
  it('keeps park debts out of the tray list and away from the running rows', () => {
    const events = parseLedgerText([
      ev('start', 20, '方向'),
      debt(10, '方向', 'park'),
      debt(5, '评审', 'review'),
    ].join('\n'))
    const model = buildModel(events, NOW)
    expect(model.parked.map(d => d.task)).toEqual(['方向'])
    expect(model.needsYou.map(d => d.task)).toEqual(['评审'])
  })
})

describe('mainline pins', () => {
  it('round-trips through storage and ignores malformed values', () => {
    writePins({ ARK: '主线' })
    expect(readPins()).toEqual({ ARK: '主线' })
    window.localStorage.setItem(MAINLINE_PINS_KEY, JSON.stringify({ ARK: 1, job: '找工作' }))
    expect(readPins()).toEqual({ job: '找工作' })
    window.localStorage.setItem(MAINLINE_PINS_KEY, '[]')
    expect(readPins()).toEqual({})
    window.localStorage.setItem(MAINLINE_PINS_KEY, 'null')
    expect(readPins()).toEqual({})
    window.localStorage.setItem(MAINLINE_PINS_KEY, '{')
    expect(readPins()).toEqual({})
  })

  it('survives blocked storage', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    expect(() => { writePins({ ARK: 'x' }) }).not.toThrow()
  })
})

describe('todo extraction', () => {
  it('shortens a line to its bold lead or its first clause', () => {
    expect(todoTitle('🆕【09-19 由 INBOX 路由】**TaskFlow 加「支线停放位」** —— 更轻')).toBe('TaskFlow 加「支线停放位」')
    expect(todoTitle('方舟地推（9/28前落实）：先整理 · next:补充')).toBe('方舟地推（9/28前落实）：先整理')
    expect(todoTitle('P0 **架构** 收口 — 细节')).toBe('P0 架构 收口')
  })

  it('lists open, non-struck items with P1 first and due dates kept', () => {
    const text = [
      '# ARK',
      '- [ ] 先写的 P2 之外 due:2026-10-01',
      '## P1 现在',
      '- [ ] 现在做 · 细节',
      '- [x] 已完成',
      '- [ ] ~~作废~~',
      '- [ ] 🆕',
      '## P2 下一步',
      '- [ ] 以后做',
    ].join('\n')
    expect(parseTodoItems(text)).toEqual([
      { title: '现在做', due: null, p1: true },
      { title: '先写的 P2 之外', due: '2026-10-01', p1: false },
      { title: '以后做', due: null, p1: false },
    ])
  })

  it('maps todo files onto board projects', () => {
    const files: TaskflowTodoFile[] = [
      { name: 'DME.md', text: '- [ ] 数字' },
      { name: 'ARK.md', text: '- [ ] 方舟' },
      { name: 'hfes-paper.md', text: '- [ ] 不上板' },
    ]
    expect(todosForProject(files, 'digital-me').map(i => i.title)).toEqual(['数字'])
    expect(todosForProject(files, 'machine')).toEqual([])
  })
})

describe('handoff prompt', () => {
  function debtOf(lines: string[], task: string) {
    const events = parseLedgerText(lines.join('\n'))
    const model = buildModel(events, NOW)
    const item = [...model.needsYou, ...model.parked].find(d => d.task === task)
    if (item === undefined) throw new Error(`no open debt ${task}`)
    return { events, item }
  }

  it('tells the story, the ask and the att commands for an aliased park', () => {
    const history = Array.from({ length: PROMPT_TIMELINE_ROWS + 2 }, (_, i) =>
      ev('switch', 500 - i, '方向', { project: 'MSC_AI' }))
    const { events, item } = debtOf([
      ...history,
      debt(100, '方向', 'park', { project: 'MSC_AI', payload: { kind: 'park', ref: 'sess_1', note: "Sean's idea" } }),
      ev('done', 50, '方向', { project: 'MSC_AI', surface: 'dsh', event: 'custom-event', payload: { seal: true } }),
    ], '方向')
    const h = buildHandoff(item, 'ARK', events, NOW)
    expect(h.status).toMatch(/^停放中/)
    expect(h.latest?.event).toBe('custom-event')
    expect(h.prompt).toContain('- 项目：ARK（账本里写作 MSC_AI）')
    expect(h.prompt).toContain('- 说明：Sean\'s idea')
    expect(h.prompt).toContain('- …更早还有 4 条')
    expect(h.prompt).toContain('custom-event · Sean 已收口')
    expect(h.prompt).toContain(`--resolves-event-id ${item.eventId as string}`)
    expect(h.prompt).toContain("att start '方向' -p 'MSC_AI' -s <你的表面>")
  })

  it('falls back for legacy ids, unknown kinds and missing fields', () => {
    const { events, item } = debtOf([
      JSON.stringify({ ts: new Date(NOW - 60 * MIN).toISOString(), surface: 'codex', project: 'ARK', task: '旧停放', event: 'needs-you', payload: { kind: 'park' } }),
    ], '旧停放')
    const h = buildHandoff(item, 'ARK', events, NOW)
    expect(h.latest).toBeNull()
    expect(h.prompt).toContain('- 收口入口：（未写）')
    expect(h.prompt).toContain(`--resolves-ts ${shellArg(item.ts)}`)
    expect(h.prompt).not.toContain('账本里写作')

    const other = debtOf([debt(10, '怪', 'odd')], '怪')
    expect(buildHandoff(other.item, 'ARK', other.events, NOW).prompt).not.toContain('撤回这条停放')
    expect(eventLine({ ...other.item, event: 'needs-you', payload: null })).toMatch(/等 Sean$/)
  })

  it('quotes shell arguments that carry apostrophes', () => {
    expect(shellArg("it's")).toBe("'it'\\''s'")
  })
})

describe('project panel on its own', () => {
  it('renders an empty project without a mainline picker and lists a dropped branch', () => {
    const onPin = vi.fn()
    const empty = treeOf([])
    const { unmount } = render(
      <ProjectPanel tree={empty} events={[]} now={NOW} todos={{ status: 'ready', items: [] }} onPin={onPin} onClose={vi.fn()} />,
    )
    expect(screen.queryByRole('button', { name: /设为主线/ })).toBeNull()
    expect(screen.getByText('还没有任务')).toBeTruthy()
    unmount()

    const tree = treeOf([
      ev('start', 30, '主线'), ev('start', 20, '放掉的'), ev('drop', 10, '放掉的'),
      debt(5, '一个名字特别特别长以至于要被截断的分支任务', 'review'),
    ], '主线')
    render(<ProjectPanel tree={tree} events={[]} now={NOW} todos={{ status: 'loading' }} onPin={onPin} onClose={vi.fn()} />)
    fireEvent.click(screen.getByText(/已了结 1 条（完成 0）/))
    expect(screen.getByText(/✕ 放掉的/)).toBeTruthy()
    expect(screen.getByText(/^一个名字特别.*…$/)).toBeTruthy()
  })
})

describe('project panel in the bar', () => {
  function renderBar(lines: string[], todos: TaskFlowFace['todos']) {
    const state: TaskflowLedgerState = { events: parseLedgerText(lines.join('\n')), read: true, exists: true }
    const useLedger = (<R,>(selector: (s: TaskflowLedgerState) => R): R => selector(state))
    const seal = vi.fn()
    const props = { useLedger, seal, todos } as unknown as TaskFlowBarProps
    const view = render(<TaskFlowBar {...props} />)
    fireEvent.click(view.container.firstElementChild as Element)
    return view
  }

  const todoFile = (count: number): TaskflowTodoFile[] => [{
    name: 'ARK.md',
    text: Array.from({ length: count }, (_, i) => `- [ ] 待办${i + 1}${i === 0 ? ' due:2026-09-28' : ''}`).join('\n'),
  }]

  it('opens from the tray project name, reads todos, pins a mainline and closes', async () => {
    const todos = vi.fn().mockResolvedValue(todoFile(PANEL_TODO_ROWS + 2))
    renderBar([
      ev('start', 60, '主线'),
      ev('done', 30, '主线'),
      ev('start', 200, '大分支'),
      ev('switch', 100, '大分支'),
      debt(90, '大分支', 'merge'),
      debt(80, '奇怪类型', 'custom'),
    ], todos)

    const name = screen.getByRole('button', { name: 'ARK' })
    fireEvent.click(name)
    expect(name.getAttribute('aria-pressed')).toBe('true')
    const panel = screen.getByRole('region', { name: 'ARK 项目树' })
    expect(within(panel).getByText('读取中…')).toBeTruthy()
    await within(panel).findByTitle('待办1')
    expect(within(panel).getByText(/09-28/)).toBeTruthy()
    expect(within(panel).getByText('还有 2 条')).toBeTruthy()
    // Unpinned, the most active task stands in as the mainline.
    expect(within(panel).getByText('主线是推测的，鼠标移到任务上可改')).toBeTruthy()
    expect(within(panel).getByText('主线占 57%')).toBeTruthy()
    expect(within(panel).getByText('等你合并')).toBeTruthy()
    expect(within(panel).getByText('等你收口')).toBeTruthy()

    // Confirm the suggestion from the mainline row's hover chip (keyboard).
    const confirm = within(panel).getByRole('button', { name: '把「大分支」设为主线' })
    fireEvent.keyDown(confirm, { key: 'a' })
    expect(readPins()).toEqual({})
    fireEvent.keyDown(confirm, { key: 'Enter' })
    expect(readPins()).toEqual({ ARK: '大分支' })
    expect(within(panel).queryByText('主线是推测的，鼠标移到任务上可改')).toBeNull()

    // Pin a settled task from the 已了结 list.
    fireEvent.click(within(panel).getByText(/已了结 1 条/))
    const settledRow = within(panel).getByText(/✓ 主线/)
    fireEvent.click(within(settledRow).getByText('设为主线'))
    expect(readPins()).toEqual({ ARK: '主线' })
    expect(within(panel).getByText('分支占 57%，重心偏到分支了')).toBeTruthy()
    expect(within(panel).getByText('已完成')).toBeTruthy()

    // A branch row's chip pins by mouse; the waiting mainline tag opens its card.
    fireEvent.click(within(panel).getByRole('button', { name: '把「奇怪类型」设为主线' }))
    expect(readPins()).toEqual({ ARK: '奇怪类型' })
    fireEvent.click(within(panel).getByRole('button', { name: '查看「奇怪类型」详情' }))
    expect(within(panel).getByRole('region', { name: '奇怪类型 详情' })).toBeTruthy()
    expect(within(panel).getByText('等 Sean 处理（custom）')).toBeTruthy()

    fireEvent.click(within(panel).getByText('收起'))
    expect(screen.queryByRole('region', { name: 'ARK 项目树' })).toBeNull()
    fireEvent.click(name)
    fireEvent.click(name)
    expect(screen.queryByRole('region', { name: 'ARK 项目树' })).toBeNull()
  })

  it('shows every branch state, the +N toggle and the settled list', async () => {
    const many = Array.from({ length: PANEL_BRANCH_ROWS + 1 }, (_, i) => debt(100 + i, `欠账${i}`, 'review'))
    window.localStorage.setItem(MAINLINE_PINS_KEY, JSON.stringify({ ARK: '主线' }))
    renderBar([
      ev('start', 400, '主线'),
      ev('drop', 399, '主线'),
      ev('start', 5, '跑'),
      ev('start', 300, '停'),
      debt(50, '相邻方向', 'park'),
      ev('start', 40, '做完'),
      ev('done', 30, '做完'),
      ...many,
    ], vi.fn().mockResolvedValue([]))
    fireEvent.click(screen.getByRole('button', { name: 'ARK' }))
    const panel = screen.getByRole('region', { name: 'ARK 项目树' })
    await within(panel).findByText('这个项目没有待办')
    expect(within(panel).getByText('已放弃')).toBeTruthy()

    const more = within(panel).getByText('还有 4 条未了结分支')
    fireEvent.click(more)
    for (const label of ['进行中', '停放', '5小时无动静']) expect(within(panel).getByText(label)).toBeTruthy()
    fireEvent.click(within(panel).getByText('只看前 8 条'))
    expect(within(panel).queryByText('进行中')).toBeNull()

    const settled = within(panel).getByText(/已了结 1 条（完成 1）/)
    fireEvent.click(settled)
    expect(within(panel).getByText(/✓ 做完/)).toBeTruthy()
  })

  it('opens a debt card from its tag, copies the prompt, and closes it', async () => {
    renderBar([
      ev('start', 300, '主线'),
      ev('start', 200, '评审稿', { surface: 'codex' }),
      debt(100, '评审稿', 'review', { surface: 'codex', payload: { kind: 'review', ref: '~/draft.md', note: '看第二节' } }),
      ev('start', 20, '评审稿', { surface: 'claude-code' }),
    ], vi.fn().mockResolvedValue([]))
    window.localStorage.setItem(MAINLINE_PINS_KEY, JSON.stringify({ ARK: '主线' }))
    fireEvent.click(screen.getByRole('button', { name: 'ARK' }))
    const panel = screen.getByRole('region', { name: 'ARK 项目树' })
    const tag = within(panel).getByRole('button', { name: '查看「评审稿」详情' })
    fireEvent.keyDown(tag, { key: ' ' })
    const card = within(panel).getByRole('region', { name: '评审稿 详情' })
    expect(tag.getAttribute('aria-expanded')).toBe('true')
    expect(within(card).getByText('等 Sean 审阅')).toBeTruthy()
    expect(within(card).getByText('~/draft.md')).toBeTruthy()
    expect(within(card).getByText('看第二节')).toBeTruthy()
    expect(within(card).queryByText('提出后还没有新动作')).toBeNull()
    expect(within(card).getAllByText(/claude-code 开工/).length).toBeGreaterThan(0)

    // jsdom has no clipboard: the card asks for a manual copy.
    fireEvent.click(within(card).getByText('复制 prompt'))
    await within(card).findByText('复制失败，请手动选中下面的文字')
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    fireEvent.click(within(card).getByText('复制 prompt'))
    await within(card).findByText('已复制 ✓')
    expect(writeText.mock.calls[0]?.[0]).toMatch(/^# 续接任务：评审稿/)
    Reflect.deleteProperty(navigator, 'clipboard')

    fireEvent.click(tag)
    expect(within(panel).queryByRole('region', { name: '评审稿 详情' })).toBeNull()
    fireEvent.click(tag)
    fireEvent.click(within(panel).getByText('关闭'))
    expect(within(panel).queryByRole('region', { name: '评审稿 详情' })).toBeNull()
  })

  it('reports a failed todo read and an empty week', async () => {
    renderBar([debt(8 * 24 * 60, '旧账', 'review')], vi.fn().mockRejectedValue(new Error('down')))
    fireEvent.click(screen.getByRole('button', { name: 'ARK' }))
    const panel = screen.getByRole('region', { name: 'ARK 项目树' })
    await within(panel).findByText('待办读取失败：down')
    expect(within(panel).getByText('近 7 天没有活动记录')).toBeTruthy()
    expect(within(panel).getByText('等你审阅')).toBeTruthy()
  })

  it('names a non-Error rejection and marks a quiet pinned mainline', async () => {
    window.localStorage.setItem(MAINLINE_PINS_KEY, JSON.stringify({ ARK: '安静的主线' }))
    renderBar([debt(10, '欠账', 'review', { payload: { kind: 'review' } })], vi.fn().mockRejectedValue('nope'))
    fireEvent.click(screen.getByRole('button', { name: 'ARK' }))
    const panel = screen.getByRole('region', { name: 'ARK 项目树' })
    await within(panel).findByText('待办读取失败：读取失败')
    expect(within(panel).getByText('近 7 天没动')).toBeTruthy()
    fireEvent.click(within(panel).getByRole('button', { name: '查看「欠账」详情' }))
    expect(within(panel).getAllByText('（未写）')).toHaveLength(2)
  })

  it('drops a todo answer that arrives after the panel closed', async () => {
    let resolve: (files: TaskflowTodoFile[]) => void = () => {}
    let reject: (error: unknown) => void = () => {}
    const todos = vi.fn()
      .mockReturnValueOnce(new Promise<TaskflowTodoFile[]>((r) => { resolve = r }))
      .mockReturnValueOnce(new Promise<TaskflowTodoFile[]>((_, r) => { reject = r }))
    renderBar([debt(10, '欠账', 'review')], todos)
    const name = screen.getByRole('button', { name: 'ARK' })
    fireEvent.click(name)
    fireEvent.click(name)
    await act(async () => { resolve(todoFile(1)) })
    fireEvent.click(name)
    fireEvent.click(name)
    await act(async () => { reject(new Error('late')) })
    expect(screen.queryByTitle('待办1')).toBeNull()
    expect(screen.queryByText(/late/)).toBeNull()
  })
})
