/** Saved review plans and exact debt closure through the assembled keyless Web application. */
import { appendFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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

const GOLDEN = fileURLToPath(new URL('./snapshots/taskflow-project-access/review-plans.expected.txt', import.meta.url))
const NOW = Date.parse('2026-10-07T04:00:00Z')
const MODE = webSnapshotMode()
const SHARED_TASK = '核对角色与正文'
const DEBT_A = '123e4567-e89b-42d3-a456-426614175001'
const DEBT_B = '123e4567-e89b-42d3-a456-426614175002'
const ROLE_REF = '/private/ark/roles.md'
const DOCUMENT_REF = '/private/ark/documents.md'
const CHAT_TITLES = {
  roles: 'ARK / 小程序架构 / 用户与角色 · v3',
  demo: 'ARK / 小程序架构 / 任务与复用 · v2',
  documents: 'ARK / 产品文档 / MRD与PRD · v4',
  channel: 'ARK / 渠道验证 / 预算与成本 · v2',
  offline: 'ARK / 线下教学 / 培训安排 · v1',
}
const UPDATED_DEMO_CHAT = 'ARK / 小程序架构 / 任务与复用 · v3'

function reviewPlan() {
  return {
    schemaVersion: 1,
    project: 'ARK',
    revision: 1,
    updatedAt: new Date(NOW).toISOString(),
    basisRef: '/private/ark/review-order.md#review',
    items: [
      { id: 'roles', threadId: 'ark-roles', chatTitle: CHAT_TITLES.roles, title: '核对用户与角色', ref: ROLE_REF, order: 1, lane: 'main', reason: '先明确本轮角色', debtEventIds: [DEBT_A] },
      { id: 'demo', threadId: 'ark-demo', chatTitle: CHAT_TITLES.demo, title: '体验任务与复用', ref: '/private/ark/demo.html', order: 2, lane: 'main', reason: '检查一条完整任务', debtEventIds: [] },
      { id: 'documents', threadId: 'ark-documents', chatTitle: CHAT_TITLES.documents, title: '审阅MRD与PRD', ref: DOCUMENT_REF, order: 3, lane: 'main', reason: '再核对全文表达', after: ['roles'], debtEventIds: [DEBT_B] },
      { id: 'channel', threadId: 'ark-channel', chatTitle: CHAT_TITLES.channel, title: '核对渠道预算', ref: '/private/ark/budget.md', order: 4, lane: 'parallel', reason: '可以并行核对成本', debtEventIds: [] },
      { id: 'offline', threadId: 'ark-offline', chatTitle: CHAT_TITLES.offline, title: '检查线下教学', ref: '/private/ark/training.md', order: 5, lane: 'conditional', reason: '按培训时间安排', condition: '近期需要培训时提前', debtEventIds: [] },
      { id: 'roles-followup', threadId: 'ark-roles', chatTitle: CHAT_TITLES.roles, title: '核对角色边界补充', ref: '/private/ark/roles-followup.md', order: 1.5, lane: 'main', reason: '接着核对同一聊天的补充步骤', debtEventIds: [] },
    ],
    overrides: [] as Array<{ itemId: string; order: number; ref: string; reason: string }>,
    sources: [{
      surface: 'codex', threadId: 'ark-roles', latestMessageId: 'user-1',
      observedAt: new Date(NOW).toISOString(), reconciledMessageId: 'user-1',
      reconciledAt: new Date(NOW).toISOString(), status: 'fresh', sourceRef: 'local:ark-review/user-1',
    }],
  }
}

function eventLine(id: string, event: string, minute: number, payload: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    schema_version: 2, event_id: id, ts: new Date(NOW - minute * 60_000).toISOString(),
    surface: 'codex', project: 'ARK', task: SHARED_TASK, event, payload,
  })}\n`
}

describe('web e2e: TaskFlow saved review plans', () => {
  let busRoot: string | undefined
  let ledgerPath: string
  let planPath: string
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    busRoot = await mkdtemp(join(tmpdir(), 'dsh-taskflow-review-plans-'))
    ledgerPath = join(busRoot, 'events-2026-10.jsonl')
    const todoDir = join(busRoot, 'todo')
    const reviewPlansDir = join(busRoot, 'review-plans')
    const watchStatusPath = join(busRoot, 'review-watch-status.json')
    await mkdir(todoDir, { mode: 0o700 })
    await mkdir(reviewPlansDir, { mode: 0o700 })
    planPath = join(reviewPlansDir, 'ARK.json')
    await writeFile(ledgerPath, [
      eventLine('123e4567-e89b-42d3-a456-426614175000', 'start', 5),
      eventLine(DEBT_A, 'needs-you', 4, { kind: 'review', ref: ROLE_REF, note: '角色候选尚待审阅' }),
      eventLine(DEBT_B, 'needs-you', 3, { kind: 'review', ref: DOCUMENT_REF, note: '全文仍需独立审阅' }),
    ].join(''), { mode: 0o600 })
    await writeFile(planPath, JSON.stringify(reviewPlan()), { mode: 0o600 })
    await writeFile(watchStatusPath, JSON.stringify({
      lastScanAt: new Date(NOW).toISOString(), lastErrorCount: 0,
      coverage: ['Codex', 'Claude Code'], excluded: ['云聊天', 'Cowork'],
    }), { mode: 0o600 })
    vi.stubEnv('DSH_TASKFLOW_LEDGER', ledgerPath)
    vi.stubEnv('DSH_TASKFLOW_ATTENTION_DIR', busRoot)
    vi.stubEnv('DSH_TASKFLOW_TODO_DIR', todoDir)
    vi.stubEnv('DSH_TASKFLOW_REVIEW_PLANS_DIR', reviewPlansDir)
    vi.stubEnv('DSH_TASKFLOW_REVIEW_WATCH_STATUS', watchStatusPath)
    scaffold = await launchWebScaffold({})
    const channel = process.env.DSH_TEST_BROWSER_CHANNEL
    browser = await chromium.launch(channel === undefined ? {} : { channel })
    page = await browser.newPage({ viewport: { width: 1680, height: 1200 }, locale: ZH_BROWSER_LOCALE, timezoneId: 'Asia/Shanghai' })
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

  it('refreshes guidance while preserving exact independent review debts', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-taskflow-review-plans'))
    await page.getByText(SHARED_TASK, { exact: true }).locator('..').locator('..').click()
    const picker = page.getByRole('combobox', { name: '项目' })
    await picker.selectOption('ARK')
    const plan = page.getByRole('region', { name: 'ARK 审阅顺序' })
    await plan.getByRole('listitem', { name: `审阅聊天 ${CHAT_TITLES.roles}`, exact: true }).waitFor()
    const initialOrder = await plan.locator('[data-review-thread]').evaluateAll(rows => rows.map(row => row.getAttribute('data-review-thread')))
    expect(initialOrder).toEqual(['ark-roles', 'ark-demo', 'ark-documents', 'ark-offline', 'ark-channel'])
    expect(await plan.getByText(CHAT_TITLES.roles, { exact: true }).count()).toBe(1)
    expect(await plan.getByRole('listitem').count()).toBe(5)
    expect(await plan.getByRole('button').count()).toBe(0)
    expect(await plan.getByText('核对用户与角色', { exact: true }).isVisible()).toBe(false)
    expect(await plan.getByText('先明确本轮角色', { exact: true }).isVisible()).toBe(false)
    expect(await plan.getByText('近期需要培训时提前', { exact: true }).isVisible()).toBe(false)
    expect(await page.getByText(/主线占|分支占|\d+%/u).count()).toBe(0)
    await plan.getByRole('list', { name: '可并行审阅', exact: true }).waitFor()
    const initialSnapshot = await plan.ariaSnapshot()
    const qaScreenshotPath = process.env.DSH_TASKFLOW_REVIEW_QA_SCREENSHOT
    if (qaScreenshotPath !== undefined) await page.screenshot({ path: qaScreenshotPath, fullPage: true })

    const debtCard = page.getByRole('region', { name: `${SHARED_TASK} 详情` })
    const tray = page.getByRole('region', { name: '待你收口', exact: true })
    const trayDebts = tray.getByRole('button', { name: SHARED_TASK, exact: true })
    await trayDebts.nth(0).click()
    await debtCard.getByText(ROLE_REF, { exact: true }).waitFor()
    await debtCard.getByRole('button', { name: '关闭', exact: true }).click()
    await trayDebts.nth(1).click()
    await debtCard.getByText(DOCUMENT_REF, { exact: true }).waitFor()
    await debtCard.getByRole('button', { name: '关闭', exact: true }).click()

    await appendFile(ledgerPath, eventLine('123e4567-e89b-42d3-a456-426614175003', 'done', 1))
    await trayDebts.nth(0).click()
    await debtCard.locator('dd').filter({ hasText: 'codex 完成' }).first().waitFor({ timeout: 25_000 })
    await expect.poll(() => tray.getByRole('button', { name: SHARED_TASK, exact: true }).count(), { timeout: 25_000 }).toBe(2)
    await debtCard.getByRole('button', { name: '关闭', exact: true }).click()

    const updatedPlan = reviewPlan()
    updatedPlan.revision = 2
    updatedPlan.items[1]!.title = '体验任务与第二次复用'
    updatedPlan.items[1]!.chatTitle = UPDATED_DEMO_CHAT
    updatedPlan.overrides = [{ itemId: 'demo', order: 0, ref: 'local:ark-review/user-2', reason: '本轮先看Demo' }]
    updatedPlan.sources[0]!.latestMessageId = 'user-2'
    updatedPlan.sources[0]!.status = 'pending'
    await writeFile(planPath, JSON.stringify(updatedPlan), { mode: 0o600 })
    await plan.getByRole('listitem', { name: `审阅聊天 ${UPDATED_DEMO_CHAT}`, exact: true }).waitFor({ timeout: 25_000 })
    await plan.getByText('信息来源 · 有新信息待核对', { exact: true }).click()
    await plan.getByText('Codex · 有新信息待核对', { exact: true }).waitFor()
    expect(await plan.locator('[data-review-thread]').first().getAttribute('data-review-thread')).toBe('ark-demo')
    expect(await tray.getByRole('button', { name: SHARED_TASK, exact: true }).count()).toBe(2)
    const updatedSnapshot = await plan.ariaSnapshot()

    await trayDebts.nth(0).click()
    await debtCard.getByText(ROLE_REF, { exact: true }).waitFor()
    await debtCard.getByRole('button', { name: '收口', exact: true }).click()
    await expect.poll(async () => {
      const rows = (await readFile(ledgerPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { payload?: { resolves_event_id?: string; seal?: boolean } })
      return rows.filter(row => row.payload?.seal === true).map(row => row.payload?.resolves_event_id)
    }, { timeout: 25_000 }).toEqual([DEBT_A])
    await plan.locator('[data-review-thread="ark-roles"]').getByText('相关待审已收口', { exact: true }).waitFor({ timeout: 25_000 })
    await plan.locator('[data-review-thread="ark-documents"]').getByText('待审阅', { exact: true }).waitFor()
    expect(await trayDebts.count()).toBe(1)
    const sealedSnapshot = await plan.ariaSnapshot()

    await writeFile(planPath, '{', { mode: 0o600 })
    const readError = plan.getByRole('status')
    await expect.poll(() => readError.textContent(), { timeout: 25_000 }).toContain('审阅计划读取失败：')
    await plan.getByRole('listitem', { name: `审阅聊天 ${UPDATED_DEMO_CHAT}`, exact: true }).waitFor()
    expect(await plan.locator('[data-review-thread]').first().getAttribute('data-review-thread')).toBe('ark-demo')
    await plan.locator('[data-review-thread="ark-documents"]').getByText('待审阅', { exact: true }).waitFor()

    await compareOrRefreshGolden(GOLDEN, [
      'INITIAL', initialSnapshot,
      'CHAT-IDENTITY', 'same-thread-reading-steps=2', 'visible-chat-rows=5', 'duplicate-chat-name=1', 'plan-action-buttons=0', 'branch-percentages=0',
      'EXACT-OPEN-IN-TRAY', `roles=${ROLE_REF}`, `documents=${DOCUMENT_REF}`,
      'ORDINARY-DONE', 'open-review-debts=2',
      'UPDATED-IN-PLACE', updatedSnapshot,
      'EXACT-SEAL', `resolved=${DEBT_A}`, sealedSnapshot,
      'INVALID-PLAN', 'last-valid-chat-order=ark-demo,ark-roles,ark-documents,ark-offline,ark-channel', 'read-error=visible',
    ].join('\n'), MODE)
    expect(tripwire.pageErrors).toEqual([])
  }, 180_000)
})
