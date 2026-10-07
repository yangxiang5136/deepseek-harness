// @vitest-environment jsdom
/** Project access through the real plugin registration, injected Remote face, and slot renderer. */
import { Context, Service } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { createSlotRenderer } from '@deepseek-ai/dsh-client-web-react'
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'

let ctx: Context | undefined

afterEach(async () => {
  cleanup()
  await ctx?.fiber.dispose()
  ctx = undefined
  localStorage.clear()
  vi.restoreAllMocks()
})

/** The fixture frame declares and renders the same root overlay slot as ui-layout. */
function Frame({ renderSlot }: PropsRuntime<'root'> & PropsRenderSlots<'shell.overlay'>) {
  return <div data-shell-overlay="">{renderSlot('shell.overlay', {})}</div>
}

/** Assemble the production slot machinery around independent, immutable session/workspace sources. */
async function mountPlugin(text: string) {
  ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  const sessions = { ids: [], byId: {}, current: undefined }
  const absent = { sessionId: undefined, hooks: { session: undefined }, props: {} }
  const workspaces = { items: [], phase: 'ready' as const }
  const observable = <T,>(value: T) => ({ getSnapshot: () => value, subscribe: () => () => {} })
  ctx.provide('sessions', { list: observable(sessions), currentProvideInfo: observable(absent) })
  ctx.provide('workspaces', { list: observable(workspaces) })
  slots.install(createSlotRenderer())
  slots.register({
    name: 'root',
    children: { 'shell.overlay': { kind: 'list', scope: 'root' } },
  }, Frame)
  class RemoteService extends Service {
    constructor(serviceCtx: Context) { super(serviceCtx, 'remote') }
  }
  new RemoteService(ctx)
  const read = vi.fn().mockResolvedValue({
    ok: true,
    value: { path: '/fixture/events.jsonl', exists: true, mtimeMs: 1, text },
  })
  const todos = vi.fn().mockResolvedValue({
    ok: true,
    value: { dir: '/fixture/todo', exists: true, files: [{ name: 'job.md', text: '- [ ] 准备申请材料' }] },
  })
  const seal = vi.fn().mockResolvedValue({
    ok: true,
    value: { sealed: false, reason: 'no-open-needs-you', line: null },
  })
  ctx.provide('remote.taskflow', { read, todos, seal })
  await act(async () => { await ctx!.plugin({ inject, apply }).await() })
  render(<>{slots.renderSlot('root', {})}</>)
  return { read, todos, seal }
}

describe('project access through the ui-taskflow plugin', () => {
  it('opens a current-only project and a todo-only project without a closure debt', async () => {
    const now = new Date(2026, 9, 7, 12).getTime()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const remote = await mountPlugin(JSON.stringify({
      schema_version: 2,
      event_id: '123e4567-e89b-42d3-a456-426614174001',
      event: 'start',
      ts: new Date(now - 5 * 60_000).toISOString(),
      task: '核对史官接续点',
      project: 'digital-me',
      surface: 'codex',
      payload: {},
    }))
    fireEvent.click(await screen.findByText('核对史官接续点'))
    const picker = await screen.findByRole<HTMLSelectElement>('combobox', { name: '项目' })
    await within(picker).findByRole('option', { name: 'job' })
    const history = screen.getByText('当前任务已记录，切换或结束后显示时间线').textContent
    const projects = within(picker).getAllByRole('option').map(option => option.textContent)

    fireEvent.change(picker, { target: { value: 'digital-me' } })
    const currentTree = screen.getByRole('region', { name: 'digital-me 项目树' })
    await within(currentTree).findByText('这个项目没有待办')
    const current = {
      tree: currentTree.getAttribute('aria-label'),
      task: within(currentTree).getByText('核对史官接续点').textContent,
      state: within(currentTree).getByText('进行中').textContent,
    }

    fireEvent.change(picker, { target: { value: 'job' } })
    const todoTree = screen.getByRole('region', { name: 'job 项目树' })
    await within(todoTree).findByText('准备申请材料')
    const todo = {
      tree: todoTree.getAttribute('aria-label'),
      activity: within(todoTree).getByText('近 7 天没有活动').textContent,
      task: within(todoTree).getByText('还没有任务').textContent,
      next: within(todoTree).getByText('准备申请材料').textContent,
    }

    expect({ history, projects, current, todo }).toMatchInlineSnapshot(`
      {
        "current": {
          "state": "进行中",
          "task": "核对史官接续点",
          "tree": "digital-me 项目树",
        },
        "history": "当前任务已记录，切换或结束后显示时间线",
        "projects": [
          "项目",
          "digital-me",
          "job",
        ],
        "todo": {
          "activity": "近 7 天没有活动",
          "next": "准备申请材料",
          "task": "还没有任务",
          "tree": "job 项目树",
        },
      }
    `)
    expect(screen.getByText('没有待你收口的事')).toBeTruthy()
    expect(remote.read).toHaveBeenCalled()
    expect(remote.todos).toHaveBeenCalled()
    expect(remote.seal).not.toHaveBeenCalled()
  })
})
