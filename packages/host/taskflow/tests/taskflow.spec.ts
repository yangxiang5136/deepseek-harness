import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import TaskflowLedgerGateway, {
  CLOSE_MS,
  formatSealLine,
  isNeedsYouOpen,
  isNeedsYouOpenAt,
  parseLedger,
} from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  delete process.env.DSH_TASKFLOW_LEDGER
})

/** Build a ledger line at an epoch-ms instant. */
function line(event: string, atMs: number, over: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    ts: new Date(atMs).toISOString(),
    surface: 'codex',
    project: 'p',
    task: 't',
    event,
    ...over,
  })
}

const T0 = Date.parse('2026-08-15T12:00:00-04:00')

describe('parseLedger', () => {
  it('parses well-formed lines and skips corrupt or shapeless ones', () => {
    const text = [
      line('start', T0),
      '{broken json',
      JSON.stringify({ ts: 'x', event: 'done' }),
      '',
      line('needs-you', T0 + 1000),
    ].join('\n')
    const events = parseLedger(text)
    expect(events).toHaveLength(2)
    expect(events[1]?.event).toBe('needs-you')
  })
})

describe('isNeedsYouOpen', () => {
  it('treats a lone needs-you as open', () => {
    const events = parseLedger(line('needs-you', T0))
    expect(isNeedsYouOpen(events, 'p', 't')).toBe(true)
  })

  it('keeps the debt open when done follows within CLOSE_MS (AI wrap-up)', () => {
    const events = parseLedger([
      line('needs-you', T0),
      line('done', T0 + 1000),
    ].join('\n'))
    expect(isNeedsYouOpen(events, 'p', 't')).toBe(true)
  })

  it('closes the debt when a terminal lands at least CLOSE_MS later', () => {
    for (const terminal of ['done', 'drop']) {
      const events = parseLedger([
        line('needs-you', T0),
        line(terminal, T0 + CLOSE_MS),
      ].join('\n'))
      expect(isNeedsYouOpen(events, 'p', 't')).toBe(false)
    }
  })

  it('matches debts by exact project and task only', () => {
    const events = parseLedger(line('needs-you', T0, { task: 'other' }))
    expect(isNeedsYouOpen(events, 'p', 't')).toBe(false)
  })
})

describe('isNeedsYouOpenAt', () => {
  it('pins the exact needs-you event and refuses unknown references', () => {
    const events = parseLedger([
      line('needs-you', T0),
      line('done', T0 + 1000),
    ].join('\n'))
    const ts = new Date(T0).toISOString()
    expect(isNeedsYouOpenAt(events, 'p', 't', ts)).toBe(true)
    expect(isNeedsYouOpenAt(events, 'p', 't', new Date(T0 + 5000).toISOString())).toBe(false)
  })
})

describe('formatSealLine', () => {
  it('emits an att-compatible done event carrying the seal audit trail', () => {
    const audit = { resolvesTs: new Date(T0).toISOString(), confirmationRef: 'dsh-ui:seal-click' }
    const parsed = JSON.parse(
      formatSealLine('p', 't', new Date(T0), audit),
    ) as Record<string, unknown>
    expect(parsed).toMatchObject({
      surface: 'dsh',
      project: 'p',
      task: 't',
      event: 'done',
      payload: { seal: true, resolves_ts: audit.resolvesTs, confirmation_ref: audit.confirmationRef },
    })
    expect(Date.parse(parsed.ts as string)).toBe(T0)
    expect(parsed.ts as string).toMatch(/[+-]\d{2}:\d{2}$/)
  })
})

describe('TaskflowLedgerGateway', () => {
  async function harness(ledgerText: string | null): Promise<{
    gateway: TaskflowLedgerGateway
    path: string
  }> {
    const dir = await mkdtemp(join(tmpdir(), 'taskflow-'))
    const path = join(dir, 'events.jsonl')
    if (ledgerText !== null) await writeFile(path, ledgerText, 'utf8')
    process.env.DSH_TASKFLOW_LEDGER = path
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(TaskflowLedgerGateway)
    return { gateway: ctx.get('taskflow') as TaskflowLedgerGateway, path }
  }

  it('publishes read and seal under the taskflow namespace', async () => {
    const { gateway } = await harness('')
    expect(gateway.typertRemote).toMatchObject({ serviceKey: 'taskflow', namespace: 'taskflow' })
    expect(remoteMethods(gateway)).toEqual([
      { method: 'read', invocation: { kind: 'direct' } },
      { method: 'seal', invocation: { kind: 'direct' } },
    ])
  })

  it('read returns the raw text and an empty state for a missing file', async () => {
    const text = `${line('start', T0)}\n`
    const { gateway } = await harness(text)
    const snapshot = await gateway.read()
    expect(snapshot).toMatchObject({ exists: true, text })
    const missing = await harness(null)
    expect(await missing.gateway.read()).toMatchObject({ exists: false, text: '' })
  })

  const AUDIT = { resolvesTs: new Date(T0).toISOString(), confirmationRef: 'dsh-ui:seal-click' }

  it('seal appends exactly one audited done line for the pinned open debt', async () => {
    const { gateway, path } = await harness(`${line('needs-you', T0)}\n`)
    const result = await gateway.seal({ project: 'p', task: 't', ...AUDIT })
    expect(result.sealed).toBe(true)
    const written = (await readFile(path, 'utf8')).trimEnd().split('\n')
    expect(written).toHaveLength(2)
    expect(JSON.parse(written[1] ?? '')).toMatchObject({
      event: 'done',
      payload: { seal: true, resolves_ts: AUDIT.resolvesTs, confirmation_ref: AUDIT.confirmationRef },
    })
  })

  it('seal refuses a closed debt, a mismatched reference, and a missing ledger', async () => {
    const { gateway } = await harness([
      line('needs-you', T0),
      line('done', T0 + CLOSE_MS),
    ].join('\n'))
    expect(await gateway.seal({ project: 'p', task: 't', ...AUDIT })).toMatchObject({
      sealed: false, reason: 'no-open-needs-you',
    })
    const open = await harness(`${line('needs-you', T0)}\n`)
    expect(await open.gateway.seal({
      project: 'p', task: 't', ...AUDIT, resolvesTs: new Date(T0 + 5000).toISOString(),
    })).toMatchObject({ sealed: false, reason: 'no-open-needs-you' })
    const missing = await harness(null)
    expect(await missing.gateway.seal({ project: 'p', task: 't', ...AUDIT })).toMatchObject({
      sealed: false, reason: 'ledger-missing',
    })
  })
})
