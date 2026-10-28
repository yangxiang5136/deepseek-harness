// Web e2e scenarios: the settings surface — the modal shell (trigger, nav,
// section switching, both close paths), the Appearance preference row (the
// real theme gesture — click 深色 and the whole cascade runs: ThemeRuntime preference -> Host settings
// -> theme/change -> ui-layout's presenter -> body attribute -> alias token +
// browser theme-color metadata)
// the Language row and busy-state Enter preference (both Host-backed), plus
// Permission as the persisted default for subsequently created sessions.
// Zero model calls: everything is pure client + persistence state on a blank
// frame, so there is no fixture and a stray stream would fail loud on the
// open llm seam.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, vi } from 'vitest'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/settings-chrome', import.meta.url))
const DIALOG_EXPECTED = join(SNAPSHOT_DIR, 'dialog.expected.md')
const PLUGINS_EXPECTED = join(SNAPSHOT_DIR, 'plugins.expected.md')
const PLUGIN_ROW_SELECTOR = '[data-plugin-entry$="ui-settings"]'
const MODE = webSnapshotMode()

describe('web e2e: settings modal and General preferences', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let busRoot: string | undefined

  beforeAll(async () => {
    busRoot = await mkdtemp(join(tmpdir(), 'dsh-settings-taskflow-'))
    const ledger = join(busRoot, 'events.jsonl')
    const todos = join(busRoot, 'todo')
    const plans = join(busRoot, 'review-plans')
    const watchStatus = join(busRoot, 'review-watch-status.json')
    await mkdir(todos, { mode: 0o700 })
    await mkdir(plans, { mode: 0o700 })
    await writeFile(ledger, `${JSON.stringify({
      schema_version: 2, event_id: '123e4567-e89b-42d3-a456-426614176000',
      ts: new Date(Date.now() - 60_000).toISOString(), event: 'start',
      task: '主题校验任务', project: 'TaskFlow', surface: 'codex',
    })}\n`, { mode: 0o600 })
    await writeFile(watchStatus, JSON.stringify({
      lastScanAt: new Date().toISOString(), lastErrorCount: 0,
      coverage: ['Codex'], excluded: [],
    }), { mode: 0o600 })
    vi.stubEnv('DSH_TASKFLOW_LEDGER', ledger)
    vi.stubEnv('DSH_TASKFLOW_ATTENTION_DIR', busRoot)
    vi.stubEnv('DSH_TASKFLOW_TODO_DIR', todos)
    vi.stubEnv('DSH_TASKFLOW_REVIEW_PLANS_DIR', plans)
    vi.stubEnv('DSH_TASKFLOW_REVIEW_WATCH_STATUS', watchStatus)
    scaffold = await launchWebScaffold({})
    const channel = process.env.DSH_TEST_BROWSER_CHANNEL
    browser = await chromium.launch(channel === undefined ? {} : { channel })
    // Chinese browser: the shared page asserts the localized settings surface
    // the client derives from it (the English default has its own spec below).
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
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

  it('opens the settings dialog, switches sections, and closes by every path', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-shell'))
    const trigger = page.getByRole('button', { name: '设置', exact: true })
    expect(await trigger.getAttribute('aria-haspopup')).toBe('dialog')
    expect(await trigger.getAttribute('aria-expanded')).toBe('false')
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor({ timeout: 10_000 })
    expect(await trigger.getAttribute('aria-expanded')).toBe('true')
    // General is active by default; Permission, Language and Appearance are functional.
    expect(await dialog.getByRole('button', { name: '通用设置' }).getAttribute('aria-current')).toBe('true')
    await dialog.getByRole('button', { name: 'Workspace Write' }).waitFor({ timeout: 10_000 })
    await expect.poll(() => dialog.getByText('语言', { exact: true }).count(), { timeout: 5_000 }).toBe(1)
    await expect.poll(() => dialog.getByText('外观', { exact: true }).count(), { timeout: 5_000 }).toBe(1)
    const openDocument = dialog.getByRole('button', { name: '打开配置文件' })
    await openDocument.waitFor({ timeout: 10_000 })
    let openRequests = 0
    await page.route('**/api/settings.openDocument', async (route) => {
      const envelope = route.request().postDataJSON() as {
        rpcId: string
        payload: Record<string, never>
      }
      expect(envelope.payload).toEqual({})
      openRequests += 1
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'server-response',
          rpcId: envelope.rpcId,
          result: { ok: true, value: { opened: true } },
        }),
      })
    })
    await openDocument.click()
    await expect.poll(() => openRequests, { timeout: 5_000 }).toBe(1)
    await expect.poll(() => openDocument.isEnabled(), { timeout: 5_000 }).toBe(true)
    await page.unroute('**/api/settings.openDocument')
    // Golden of the freshly opened dialog (default zh, General active).
    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(DIALOG_EXPECTED, snapshot, MODE)
    // Section switch: aria-current moves (the Models page itself has its own scenario file).
    await dialog.getByRole('button', { name: '模型' }).click()
    await expect.poll(() => dialog.getByRole('button', { name: '模型' }).getAttribute('aria-current'), { timeout: 5_000 }).toBe('true')
    expect(await dialog.getByRole('button', { name: '通用设置' }).getAttribute('aria-current')).toBeNull()
    // Plugins is a read-only projection of the same assembled Loader tree.
    // Capture one stable shipped row rather than the whole inventory so adding
    // an unrelated plugin does not rewrite this surface's golden.
    await dialog.getByRole('button', { name: '插件', exact: true }).click()
    await dialog.getByRole('heading', { name: '插件', exact: true }).waitFor({ timeout: 10_000 })
    await dialog.getByRole('tab', { name: '插件列表', exact: true }).click()
    const pluginRow = dialog.locator(PLUGIN_ROW_SELECTOR)
    await pluginRow.waitFor({ timeout: 10_000 })
    const expectedPluginCount = [...scaffold.ctx.loader.entries()]
      .filter(entry => !entry.options.group)
      .length
    expect(await dialog.getByRole('searchbox', { name: '搜索插件' }).count()).toBe(1)
    expect(await dialog.locator('[data-plugin-entry]').count()).toBe(expectedPluginCount)
    expect(await dialog.locator('[data-plugin-count]').getAttribute('data-plugin-count'))
      .toBe(String(expectedPluginCount))
    expect(await dialog.getByRole('button', { name: '插件', exact: true }).getAttribute('aria-current')).toBe('true')
    expect(await dialog.getByRole('tab', { name: '插件列表', exact: true }).getAttribute('aria-selected')).toBe('true')
    expect(await dialog.getByRole('button', { name: '模型' }).getAttribute('aria-current')).toBeNull()
    const pluginsSnapshot = await captureStableAria(
      page,
      PLUGIN_ROW_SELECTOR,
      scaffold.workspaceCwd,
    )
    await compareOrRefreshGolden(PLUGINS_EXPECTED, pluginsSnapshot, MODE)
    // Close path 1: Escape.
    await page.keyboard.press('Escape')
    await expect.poll(() => page.getByRole('dialog', { name: '设置' }).count(), { timeout: 5_000 }).toBe(0)
    expect(await trigger.getAttribute('aria-expanded')).toBe('false')
    // Close path 2: the header close button (focus lands there on open).
    await trigger.click()
    await page.getByRole('dialog', { name: '设置' }).getByRole('button', { name: '关闭' }).click()
    await expect.poll(() => page.getByRole('dialog', { name: '设置' }).count(), { timeout: 5_000 }).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('stores Permission as the default for future sessions without changing an existing session', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-permission'))
    const existing = scaffold.ctx.sessions.create(SessionId('settings-permission-before'))
    expect(existing.events.find(event => event.type === 'permission/preset')?.data)
      .toEqual({ preset: 'workspace-write' })

    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor({ timeout: 10_000 })
    const selector = dialog.getByRole('button', { name: 'Workspace Write' })
    await selector.waitFor({ timeout: 10_000 })
    await expect.poll(() => selector.isEnabled(), { timeout: 5_000 }).toBe(true)
    await selector.click()
    await page.getByRole('menuitem', { name: 'Read Only' }).click()
    await dialog.getByRole('button', { name: 'Read Only' }).waitFor({ timeout: 10_000 })

    const document = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(document).toContain('permission:')
    expect(document).toContain('defaultPreset: read-only')
    expect(existing.events.find(event => event.type === 'permission/preset')?.data)
      .toEqual({ preset: 'workspace-write' })

    const created = scaffold.ctx.sessions.create(SessionId('settings-permission-after'))
    expect(created.events.map(event => [event.type, event.data])).toEqual([
      ['permission/preset', { preset: 'read-only' }],
      ['sandbox/mode', { mode: 'read-only' }],
      ['approval/policy', { policy: 'ask' }],
    ])

    await dialog.getByRole('button', { name: 'Read Only' }).click()
    await page.getByRole('menuitem', { name: 'Full access' }).click()
    const confirmation = page.getByRole('dialog', { name: '确认启用 Full access？' })
    const enable = confirmation.getByRole('button', { name: '启用 Full access' })
    expect(await enable.isDisabled()).toBe(true)
    await confirmation.getByRole('checkbox').click()
    await enable.click()
    await dialog.getByRole('button', { name: 'Full access' }).waitFor({ timeout: 10_000 })
    const confirmedDocument = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(confirmedDocument).toContain('defaultPreset: danger-full-access')
    const confirmed = scaffold.ctx.sessions.create(SessionId('settings-permission-confirmed'))
    expect(confirmed.events.map(event => [event.type, event.data])).toEqual([
      ['permission/preset', { preset: 'danger-full-access' }],
      ['sandbox/mode', { mode: 'danger-full-access' }],
      ['approval/policy', { policy: 'never' }],
    ])
    await page.keyboard.press('Escape')
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('uses the persisted dark ARK palette while plugins are still loading', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-boot-theme'))
    await page.emulateMedia({ colorScheme: 'light' })
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const initialDialog = page.getByRole('dialog', { name: '设置' })
    const darkCube = initialDialog.getByRole('button', { name: '深色' })
    await darkCube.click()
    await initialDialog.getByRole('button', { name: '方舟', exact: true }).click()
    await expect.poll(() => darkCube.getAttribute('aria-pressed'), { timeout: 5_000 }).toBe('true')
    await expect.poll(async () => readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8'), { timeout: 5_000 })
      .toMatch(/ui-theme:\n\s+preference: dark/)
    await expect.poll(async () => readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8'), { timeout: 5_000 })
      .toMatch(/palette: ark/)
    await page.keyboard.press('Escape')

    // Hold real plugin bundles so the shell-owned loading page remains observable.
    const pluginPattern = '**/plugins/**'
    let releaseBundles = (): void => {}
    const bundlesReleased = new Promise<void>((resolve) => { releaseBundles = resolve })
    await page.route(pluginPattern, async (route) => {
      await bundlesReleased
      await route.continue()
    })

    const warningStart = tripwire.warnings.length
    let reload: ReturnType<Page['reload']> | undefined
    try {
      reload = page.reload({ waitUntil: 'domcontentloaded' })
      const loading = page.getByText('Loading plugins…', { exact: true })
      await loading.waitFor({ timeout: 10_000 })
      const state = await loading.evaluate((element) => {
        const boot = element.parentElement?.parentElement
        if (boot === undefined || boot === null) throw new Error('loading hint is detached from the boot page')
        return {
          attr: document.body.hasAttribute('data-ds-dark-theme'),
          background: getComputedStyle(boot).backgroundColor,
          brand: getComputedStyle(document.body).getPropertyValue('--dsw-alias-brand-primary').trim(),
          colorScheme: document.documentElement.style.colorScheme,
        }
      })
      expect(state).toEqual({
        attr: true,
        background: 'rgb(20, 21, 34)',
        brand: '#A89AFF',
        colorScheme: 'dark',
      })
    } finally {
      releaseBundles()
      await reload
      await page.unroute(pluginPattern)
    }

    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const restoredDialog = page.getByRole('dialog', { name: '设置' })
    await restoredDialog.getByRole('button', { name: '原版', exact: true }).click()
    const systemCube = restoredDialog.getByRole('button', { name: '跟随系统' })
    await systemCube.click()
    await expect.poll(() => systemCube.getAttribute('aria-pressed'), { timeout: 5_000 }).toBe('true')
    await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme')), {
      timeout: 5_000,
    }).toBe(false)
    await page.keyboard.press('Escape')
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('flips the theme through the Appearance cubes and persists across reload and a distinct port', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-appearance'))
    interface ThemeState {
      attr: boolean
      background: string
      /** Pre-migration localStorage key; the Host-backed world never writes it. */
      legacy: string | null
      themeColor: string | null
      themeColorCount: number
      token: string
    }
    const readState = async (target: Page = page): Promise<ThemeState> => await target.evaluate(() => {
      const metas = document.head.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
      const computed = getComputedStyle(document.body)
      return {
        attr: document.body.hasAttribute('data-ds-dark-theme'),
        background: computed.backgroundColor,
        legacy: localStorage.getItem('dsh.theme'),
        themeColor: metas[0]?.content ?? null,
        themeColorCount: metas.length,
        token: computed.getPropertyValue('--dsw-alias-bg-base').trim(),
      }
    })
    const expectThemeColorSynchronized = (state: ThemeState): void => {
      expect(state.themeColorCount).toBe(1)
      expect(state.background).not.toBe('rgba(0, 0, 0, 0)')
      expect(state.themeColor).toBe(state.background)
    }
    // Pin the OS scheme to light so the default `system` preference resolves
    // light and the dark flip below is unambiguously the gesture's doing.
    await page.emulateMedia({ colorScheme: 'light' })
    const light = await readState()
    expect(light.attr).toBe(false)
    expectThemeColorSynchronized(light)

    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor({ timeout: 10_000 })
    const darkCube = dialog.getByRole('button', { name: '深色' })
    expect(await darkCube.getAttribute('aria-pressed')).toBe('false')
    await darkCube.click()
    // The full cascade: pressed state, Host-backed preference, body attribute,
    // alias token flip — all from one real user gesture.
    await expect.poll(() => darkCube.getAttribute('aria-pressed'), { timeout: 5_000 }).toBe('true')
    const dark = await readState()
    expect(dark.attr).toBe(true)
    expect(dark.legacy).toBeNull()
    expect(dark.token).not.toBe(light.token)
    expectThemeColorSynchronized(dark)
    await expect.poll(async () => readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8'), { timeout: 5_000 })
      .toMatch(/ui-theme:\n\s+preference: dark/)
    await page.keyboard.press('Escape')

    // Reload: the preference survives the background Host read + presenter update.
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await page.emulateMedia({ colorScheme: 'light' })
    await expect.poll(async () => (await readState()).attr, { timeout: 5_000 }).toBe(true)
    const reloaded = await readState()
    expect(reloaded.legacy).toBeNull()
    expectThemeColorSynchronized(reloaded)

    // A second live Host binds another ephemeral port but shares the same
    // user-settings home. Its fresh origin has no theme localStorage and still
    // converges to dark before the settings dialog opens.
    const second = await launchWebScaffold({ harnessHome: scaffold.harnessHome })
    const secondPage = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    const secondTripwire = watchConsole(secondPage)
    try {
      expect(second.baseUrl).not.toBe(scaffold.baseUrl)
      await secondPage.emulateMedia({ colorScheme: 'light' })
      await secondPage.goto(second.baseUrl, { waitUntil: 'load' })
      await secondPage.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await expect.poll(async () => (await readState(secondPage)).attr, { timeout: 5_000 }).toBe(true)
      const secondState = await readState(secondPage)
      expect(secondState.legacy).toBeNull()
      expectThemeColorSynchronized(secondState)
      expect(secondTripwire.pageErrors).toEqual([])
      expect(secondTripwire.warnings).toEqual([])
    } finally {
      await secondPage.close()
      await second.close()
    }

    // `system` follows the emulated OS scheme (dark stays dark, light clears).
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const systemCube = page.getByRole('dialog', { name: '设置' }).getByRole('button', { name: '跟随系统' })
    await systemCube.click()
    await expect.poll(() => systemCube.getAttribute('aria-pressed'), { timeout: 5_000 }).toBe('true')
    await expect.poll(async () => (await readState()).attr, { timeout: 5_000 }).toBe(false)
    expectThemeColorSynchronized(await readState())
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(async () => (await readState()).attr, { timeout: 5_000 }).toBe(true)
    expectThemeColorSynchronized(await readState())
    // Restore for the specs that follow: light preference beats the emulated
    // dark OS scheme, leaving the shared page in the light default.
    await page.getByRole('dialog', { name: '设置' }).getByRole('button', { name: '浅色' }).click()
    await expect.poll(async () => (await readState()).attr, { timeout: 5_000 }).toBe(false)
    expectThemeColorSynchronized(await readState())
    await page.keyboard.press('Escape')
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('switches shared dsh and TaskFlow colors, persists the palette, and restores the original colors', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-palette'))
    const readColors = async (target: Page = page) => await target.getByRole('combobox', { name: '项目' })
      .locator('..').locator('..').evaluate((banner) => {
        const body = getComputedStyle(document.body)
        const taskflow = getComputedStyle(banner)
        return {
          dark: document.body.hasAttribute('data-ds-dark-theme'),
          background: body.backgroundColor,
          brand: body.getPropertyValue('--dsw-alias-brand-primary').trim(),
          taskflowBackground: taskflow.backgroundColor,
          taskflowInk: taskflow.color,
          taskflowMain: taskflow.getPropertyValue('--tf-main').trim(),
          wait: taskflow.getPropertyValue('--tf-wait').trim(),
          live: taskflow.getPropertyValue('--tf-live').trim(),
          error: body.getPropertyValue('--dsw-alias-state-error-primary').trim(),
        }
      })
    await page.emulateMedia({ colorScheme: 'light' })
    await page.getByText('主题校验任务', { exact: true }).locator('..').locator('..').click()
    await page.getByRole('combobox', { name: '项目' }).waitFor({ timeout: 10_000 })
    const original = await readColors()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    const ark = dialog.getByRole('button', { name: '方舟', exact: true })
    expect(await dialog.getByRole('button', { name: '原版', exact: true }).getAttribute('aria-pressed')).toBe('true')
    await ark.click()
    await expect.poll(() => ark.getAttribute('aria-pressed')).toBe('true')
    await expect.poll(async () => (await readColors()).taskflowMain).toBe('#5A42F9')
    const lightArk = await readColors()
    expect(lightArk).toMatchObject({
      dark: false,
      background: 'rgb(244, 247, 252)',
      brand: '#5A42F9',
      taskflowBackground: 'rgb(255, 255, 255)',
      taskflowInk: 'rgb(36, 40, 61)',
      wait: original.wait,
      live: original.live,
      error: original.error,
    })
    expect(await ark.evaluate(button => getComputedStyle(button).color)).toBe('rgb(90, 66, 249)')
    await dialog.getByRole('button', { name: '深色', exact: true }).click()
    await expect.poll(async () => (await readColors()).taskflowMain).toBe('#A89AFF')
    expect(await readColors()).toMatchObject({
      dark: true,
      background: 'rgb(20, 21, 34)',
      taskflowBackground: 'rgb(28, 30, 48)',
      taskflowInk: 'rgb(238, 236, 255)',
    })
    await dialog.getByRole('button', { name: '跟随系统', exact: true }).click()
    await expect.poll(async () => (await readColors()).dark).toBe(false)
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(async () => (await readColors()).taskflowMain).toBe('#A89AFF')
    await page.emulateMedia({ colorScheme: 'light' })
    await expect.poll(async () => readColors()).toEqual(lightArk)
    await expect.poll(async () => readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8'))
      .toMatch(/palette: ark/)
    await page.keyboard.press('Escape')

    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await expect.poll(async () => readColors()).toEqual(lightArk)
    await page.getByRole('button', { name: '设置', exact: true }).click()
    expect(await page.getByRole('dialog', { name: '设置' })
      .getByRole('button', { name: '方舟', exact: true }).getAttribute('aria-pressed')).toBe('true')
    await page.keyboard.press('Escape')

    const second = await launchWebScaffold({ harnessHome: scaffold.harnessHome })
    const secondPage = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    const secondTripwire = watchConsole(secondPage)
    try {
      await secondPage.emulateMedia({ colorScheme: 'light' })
      await secondPage.goto(second.baseUrl, { waitUntil: 'load' })
      await secondPage.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await secondPage.getByText('主题校验任务', { exact: true }).locator('..').locator('..').click()
      await expect.poll(async () => readColors(secondPage)).toEqual(lightArk)
      expect(secondTripwire.pageErrors).toEqual([])
      expect(secondTripwire.warnings).toEqual([])
    } finally {
      await secondPage.close()
      await second.close()
    }

    await page.getByRole('button', { name: '设置', exact: true }).click()
    const restoredDialog = page.getByRole('dialog', { name: '设置' })
    await restoredDialog.getByRole('button', { name: '原版', exact: true }).click()
    await expect.poll(async () => readColors()).toEqual(original)
    await restoredDialog.getByRole('button', { name: '方舟', exact: true }).click()
    await expect.poll(async () => readColors()).toEqual(lightArk)
    await restoredDialog.getByRole('button', { name: '原版', exact: true }).click()
    await restoredDialog.getByRole('button', { name: '浅色', exact: true }).click()
    await expect.poll(async () => readColors()).toEqual(original)
    await page.keyboard.press('Escape')
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('persists the busy-state Enter behavior across reload and a distinct port', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-enter-behavior'))
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: '排队发送' }).click()
    await page.getByRole('menuitem', { name: '插话发送' }).click()
    await dialog.getByRole('button', { name: '插话发送' }).waitFor({ timeout: 10_000 })
    expect(await page.evaluate(() => localStorage.getItem('dsh.conversation.busyEnter'))).toBeNull()
    await expect.poll(async () => readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8'), { timeout: 5_000 })
      .toMatch(/ui-conversation:\n\s+busyEnter: steer/)
    await page.keyboard.press('Escape')

    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const reloaded = page.getByRole('dialog', { name: '设置' })
    await reloaded.getByRole('button', { name: '插话发送' }).waitFor({ timeout: 10_000 })

    const second = await launchWebScaffold({ harnessHome: scaffold.harnessHome })
    const secondPage = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    const secondTripwire = watchConsole(secondPage)
    try {
      expect(second.baseUrl).not.toBe(scaffold.baseUrl)
      await secondPage.goto(second.baseUrl, { waitUntil: 'load' })
      await secondPage.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await secondPage.getByRole('button', { name: '设置', exact: true }).click()
      await secondPage.getByRole('dialog', { name: '设置' })
        .getByRole('button', { name: '插话发送' }).waitFor({ timeout: 10_000 })
      expect(await secondPage.evaluate(() => localStorage.getItem('dsh.conversation.busyEnter'))).toBeNull()
      expect(secondTripwire.pageErrors).toEqual([])
      expect(secondTripwire.warnings).toEqual([])
    } finally {
      await secondPage.close()
      await second.close()
    }

    await reloaded.getByRole('button', { name: '插话发送' }).click()
    await page.getByRole('menuitem', { name: '排队发送' }).click()
    await reloaded.getByRole('button', { name: '排队发送' }).waitFor({ timeout: 10_000 })
    expect(await page.evaluate(() => localStorage.getItem('dsh.conversation.busyEnter'))).toBeNull()
    await expect.poll(async () => readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8'), { timeout: 5_000 })
      .toMatch(/ui-conversation:\n\s+busyEnter: queue/)
    await page.keyboard.press('Escape')
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('persists the settings language across reload and a distinct port', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-language'))
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const zhDialog = page.getByRole('dialog', { name: '设置' })
    await zhDialog.waitFor({ timeout: 10_000 })
    // The Language selector pill shows the active locale's own name.
    const selector = zhDialog.getByRole('button', { name: '中文' })
    expect(await selector.getAttribute('aria-haspopup')).toBe('menu')
    await selector.click()
    await page.getByRole('menuitem', { name: 'English' }).click()
    // The settings-owned copy re-registers localized: dialog title, nav,
    // Appearance labels. (Only the settings namespaces are localized —
    // the rest of the app's copy is intentionally out of this row's scope.)
    const enDialog = page.getByRole('dialog', { name: 'Settings' })
    await enDialog.waitFor({ timeout: 10_000 })
    expect(await enDialog.getByRole('button', { name: 'General' }).getAttribute('aria-current')).toBe('true')
    await expect.poll(() => enDialog.getByText('Appearance', { exact: true }).count(), { timeout: 5_000 }).toBe(1)
    expect(await page.evaluate(() => localStorage.getItem('dsh.locale'))).toBeNull()
    await expect.poll(async () => readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8'), { timeout: 5_000 })
      .toMatch(/locale:\n\s+preference: en/)
    // Reload keeps English; then restore zh so shared page state (and the
    // other specs' 设置-anchored selectors + goldens) see the default again.
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    const enTrigger = page.getByRole('button', { name: 'Settings' })
    await enTrigger.waitFor({ timeout: 10_000 })

    // A Chinese browser on another port still receives the explicit English
    // preference from the shared Host settings document.
    const second = await launchWebScaffold({ harnessHome: scaffold.harnessHome })
    const secondPage = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    const secondTripwire = watchConsole(secondPage)
    try {
      expect(second.baseUrl).not.toBe(scaffold.baseUrl)
      await secondPage.goto(second.baseUrl, { waitUntil: 'load' })
      await secondPage.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await secondPage.getByRole('button', { name: 'Settings', exact: true }).click()
      await secondPage.getByRole('dialog', { name: 'Settings' })
        .getByRole('button', { name: 'English' }).waitFor({ timeout: 10_000 })
      expect(await secondPage.evaluate(() => localStorage.getItem('dsh.locale'))).toBeNull()
      expect(secondTripwire.pageErrors).toEqual([])
      expect(secondTripwire.warnings).toEqual([])
    } finally {
      await secondPage.close()
      await second.close()
    }

    await enTrigger.click()
    await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'English' }).click()
    await page.getByRole('menuitem', { name: '中文' }).click()
    await page.getByRole('dialog', { name: '设置' }).waitFor({ timeout: 10_000 })
    expect(await page.evaluate(() => localStorage.getItem('dsh.locale'))).toBeNull()
    await expect.poll(async () => readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8'), { timeout: 5_000 })
      .toMatch(/locale:\n\s+preference: zh/)
    await page.keyboard.press('Escape')
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('opens an English browser in English without any stored preference', async () => {
    // A fresh Host home has no locale preference, so its surface follows the
    // browser rather than the product fallback.
    const fresh = await launchWebScaffold({})
    const enPage = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'en-US' })
    const enTripwire = watchConsole(enPage)
    onTestFailed(() => saveFailureShot(enPage, 'web-e2e-settings-browser-language'))
    try {
      await enPage.goto(fresh.baseUrl, { waitUntil: 'load' })
      await enPage.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      expect(await enPage.evaluate(() => localStorage.getItem('dsh.locale'))).toBeNull()
      await enPage.getByRole('button', { name: 'Settings', exact: true }).click()
      const dialog = enPage.getByRole('dialog', { name: 'Settings' })
      await dialog.waitFor({ timeout: 10_000 })
      await dialog.getByRole('button', { name: 'English' }).waitFor({ timeout: 10_000 })
      // This page has no closing inventory spec to sweep its console, so the
      // scenario clears both tripwire channels itself.
      expect(enTripwire.pageErrors).toEqual([])
      expect(enTripwire.warnings).toEqual([])
    } finally {
      await enPage.close()
      await fresh.close()
    }
  }, 90_000)

  it('keeps compact sidebar actions reachable above an expanded TaskFlow panel', async () => {
    const compact = await browser.newPage({ viewport: { width: 1200, height: 600 }, locale: ZH_BROWSER_LOCALE })
    const compactTripwire = watchConsole(compact)
    onTestFailed(() => saveFailureShot(compact, 'web-e2e-compact-sidebar-short-height'))
    const controlGeometry = async (name: string) => await compact.getByRole('button', { name, exact: true })
      .evaluate((button) => {
        const bounds = button.getBoundingClientRect()
        const glyph = button.querySelector('svg')?.getBoundingClientRect()
        if (glyph === undefined) throw new Error('sidebar action has no glyph')
        let left = 0
        let right = window.innerWidth
        let top = 0
        let bottom = window.innerHeight
        for (let ancestor = button.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor)
          const rect = ancestor.getBoundingClientRect()
          if (style.overflowX !== 'visible') {
            left = Math.max(left, rect.left)
            right = Math.min(right, rect.right)
          }
          if (style.overflowY !== 'visible') {
            top = Math.max(top, rect.top)
            bottom = Math.min(bottom, rect.bottom)
          }
        }
        return {
          width: bounds.width, height: bounds.height,
          glyphWidth: glyph.width, glyphHeight: glyph.height,
          clipped: bounds.left < left || bounds.right > right || bounds.top < top || bounds.bottom > bottom
            || glyph.left < left || glyph.right > right || glyph.top < top || glyph.bottom > bottom,
          reachable: button.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)),
          y: bounds.y,
        }
      })
    try {
      await compact.goto(scaffold.baseUrl, { waitUntil: 'load' })
      await compact.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await compact.getByText('主题校验任务', { exact: true }).locator('..').locator('..').click()
      await compact.getByRole('combobox', { name: '项目' }).waitFor({ timeout: 10_000 })
      await compact.getByRole('button', { name: '收起侧边栏', exact: true }).click()
      const rail = compact.locator('[data-sidebar-collapsed="true"] [class*="_root"][class*="_collapsed"]')
      await compact.getByRole('button', { name: '打开侧边栏', exact: true }).waitFor()
      const initialHeight = await rail.evaluate(element => element.getBoundingClientRect().height)
      // Keep the actual overlay clearance, then reproduce the user's short
      // available column through viewport geometry rather than injected CSS.
      await compact.setViewportSize({ width: 1200, height: Math.round(600 + 199 - initialHeight) })
      await expect.poll(() => rail.evaluate(element => Math.round(element.getBoundingClientRect().height))).toBe(199)
      for (const name of ['添加工作区', '搜索会话', '设置']) {
        await expect.poll(() => controlGeometry(name)).toMatchObject({
          width: 36, height: 36, glyphWidth: 18, glyphHeight: 18, clipped: false, reachable: true,
        })
      }
      const settings = compact.getByRole('button', { name: '设置', exact: true })
      const pinnedY = (await controlGeometry('设置')).y
      await settings.click()
      await compact.getByRole('dialog', { name: '设置' }).waitFor()
      await compact.keyboard.press('Escape')

      const add = compact.getByRole('button', { name: '添加工作区', exact: true })
      await add.scrollIntoViewIfNeeded()
      await expect.poll(() => controlGeometry('添加工作区')).toMatchObject({
        width: 36, height: 36, glyphWidth: 18, glyphHeight: 18, clipped: false, reachable: true,
      })
      expect((await controlGeometry('设置')).y).toBe(pinnedY)
      await add.click()
      await compact.getByRole('dialog', { name: '选择工作区目录' }).waitFor({ timeout: 10_000 })
      await compact.keyboard.press('Escape')

      const search = compact.getByRole('button', { name: '搜索会话', exact: true })
      await search.focus()
      await search.scrollIntoViewIfNeeded()
      await expect.poll(() => controlGeometry('搜索会话')).toMatchObject({
        width: 36, height: 36, glyphWidth: 18, glyphHeight: 18, clipped: false, reachable: true,
      })
      const footer = await controlGeometry('设置')
      expect(footer.y).toBe(pinnedY)
      expect(footer.reachable).toBe(true)
      await search.click()
      await compact.getByRole('button', { name: '收起侧边栏', exact: true }).waitFor()
      const input = compact.getByPlaceholder('搜索会话…', { exact: true })
      await input.waitFor()
      await expect.poll(() => input.evaluate(element => element === document.activeElement)).toBe(true)
      await input.fill('compact-rail-missing-session')
      await compact.getByText('无匹配会话', { exact: true }).waitFor({ timeout: 10_000 })
      expect(compactTripwire.pageErrors).toEqual([])
      expect(compactTripwire.warnings).toEqual([])
    } finally {
      await compact.close()
    }
  }, 60_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['dialog.expected.md', 'plugins.expected.md'])
  })
})
