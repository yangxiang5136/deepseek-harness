/** TaskFlow project access in the shipped Web Loader composition, with an isolated attention bus and no model calls. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, vi } from 'vitest'
import {
  compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const GOLDEN = fileURLToPath(new URL('./snapshots/taskflow-project-access/project-access.expected.txt', import.meta.url))
const NOW = Date.parse('2026-10-07T04:00:00Z')
const MODE = webSnapshotMode()

describe('web e2e: TaskFlow project access without a closure debt', () => {
  let busRoot: string | undefined
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    busRoot = await mkdtemp(join(tmpdir(), 'dsh-taskflow-project-access-'))
    const ledgerPath = join(busRoot, 'events.jsonl')
    const todoDir = join(busRoot, 'todo')
    await mkdir(todoDir, { mode: 0o700 })
    await writeFile(ledgerPath, `${JSON.stringify({
      schema_version: 2,
      event_id: '123e4567-e89b-42d3-a456-426614174001',
      ts: new Date(NOW - 5 * 60_000).toISOString(),
      event: 'start',
      task: '核对史官接续点',
      project: 'digital-me',
      surface: 'codex',
      payload: {},
    })}\n`, { mode: 0o600 })
    await writeFile(join(todoDir, 'job.md'), '- [ ] 准备申请材料\n', { mode: 0o600 })
    vi.stubEnv('DSH_TASKFLOW_LEDGER', ledgerPath)
    vi.stubEnv('DSH_TASKFLOW_ATTENTION_DIR', busRoot)
    vi.stubEnv('DSH_TASKFLOW_TODO_DIR', todoDir)

    // No replay fixture: the scaffold's route-only adapter refuses any model call.
    scaffold = await launchWebScaffold({})
    const channel = process.env.DSH_TEST_BROWSER_CHANNEL
    browser = await chromium.launch(channel === undefined ? {} : { channel })
    page = await browser.newPage({
      viewport: { width: 1680, height: 1000 },
      locale: ZH_BROWSER_LOCALE,
      timezoneId: 'Asia/Shanghai',
    })
    await page.addInitScript((now) => { Date.now = () => now }, NOW)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    try {
      await browser?.close()
      await scaffold?.close()
    } finally {
      vi.unstubAllEnvs()
      if (busRoot !== undefined) await rm(busRoot, { recursive: true, force: true })
    }
  })

  it('opens the current-only project and todo-only project through the header picker', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-taskflow-project-access'))
    const mini = page.getByText('核对史官接续点', { exact: true }).locator('..').locator('..')
    await mini.click()
    const picker = page.getByRole('combobox', { name: '项目' })
    await picker.waitFor({ timeout: 10_000 })
    await expect.poll(() => picker.getByRole('option').allTextContents()).toEqual(['项目', 'digital-me', 'job'])
    const history = await page.getByText('当前任务已记录，切换或结束后显示时间线', { exact: true }).textContent()
    const projects = await picker.getByRole('option').allTextContents()
    await page.getByText('没有待你收口的事', { exact: true }).waitFor()

    await picker.selectOption('digital-me')
    const currentTree = page.getByRole('region', { name: 'digital-me 项目树' })
    await currentTree.waitFor()
    await currentTree.getByText('这个项目没有待办', { exact: true }).waitFor()
    const current = [
      `current.tree=${await currentTree.getAttribute('aria-label')}`,
      `current.task=${await currentTree.getByText('核对史官接续点', { exact: true }).textContent()}`,
      `current.state=${await currentTree.getByText('进行中', { exact: true }).textContent()}`,
    ]

    await picker.selectOption('job')
    const todoTree = page.getByRole('region', { name: 'job 项目树' })
    await todoTree.getByText('准备申请材料', { exact: true }).waitFor()
    const todo = [
      `todo.tree=${await todoTree.getAttribute('aria-label')}`,
      `todo.activity=${await todoTree.getByText('近 7 天没有活动', { exact: true }).textContent()}`,
      `todo.task=${await todoTree.getByText('还没有任务', { exact: true }).textContent()}`,
      `todo.next=${await todoTree.getByText('准备申请材料', { exact: true }).textContent()}`,
    ]
    const snapshot = [
      `history=${history}`,
      ...projects.map(project => `project=${project}`),
      ...current,
      ...todo,
    ].join('\n')
    await compareOrRefreshGolden(GOLDEN, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
