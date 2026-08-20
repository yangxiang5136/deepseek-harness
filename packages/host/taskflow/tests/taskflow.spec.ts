import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  chmod, mkdir, mkdtemp, readFile, readlink, rmdir, stat, symlink, unlink, writeFile,
} from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import TaskflowLedgerGateway, {
  formatSealLine,
  isNeedsYouOpen,
  isNeedsYouOpenAt,
  LEGACY_CLOSE_MS,
  parseLedger,
} from '../src/index.ts'
import {
  acquireLedgerLock, appendLedgerLine, assertSafeLedgerAlias, readLedgerFile, readMonthlyLedgers,
} from '../src/ledger.ts'

const contexts: Context[] = []
const PROJECT = 'TaskFlow'
const TASK = 't'

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  delete process.env.DSH_TASKFLOW_LEDGER
  delete process.env.DSH_TASKFLOW_ATTENTION_DIR
  vi.useRealTimers()
})

/** Build a ledger line at an epoch-ms instant. */
function line(event: string, atMs: number, over: Partial<Record<string, unknown>> = {}): string {
  const record: Record<string, unknown> = {
    ts: new Date(atMs).toISOString(),
    surface: 'codex',
    project: PROJECT,
    task: TASK,
    event,
    ...over,
  }
  if (record.schema_version === 2 && event === 'needs-you' && record.payload === undefined) {
    record.payload = { kind: 'review', ref: 'test-fixture' }
  }
  return JSON.stringify(record)
}

function resolver(
  atMs: number,
  target: { eventId?: string; ts: string },
  over: Partial<Record<string, unknown>> = {},
): string {
  return line('done', atMs, {
    schema_version: 2,
    event_id: randomUUID(),
    surface: 'dsh',
    payload: {
      seal: true,
      confirmation_ref: 'dsh-ui:seal-click',
      ...(target.eventId === undefined
        ? { resolves_ts: target.ts }
        : { resolves_event_id: target.eventId }),
    },
    ...over,
  })
}

const T0 = Date.parse('2026-08-15T12:00:00-04:00')
const DEBT_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_DEBT_ID = '22222222-2222-4222-8222-222222222222'
const OTHER_DEBT_ID = '33333333-3333-4333-8333-333333333333'
const SEAL_ID = '44444444-4444-4444-8444-444444444444'
const LEGACY_SEAL_ID = '55555555-5555-4555-8555-555555555555'
const ROLLOVER_DEBT_ID = '66666666-6666-4666-8666-666666666666'
const SEAL_WORKER = fileURLToPath(new URL('./fixtures/seal-worker.ts', import.meta.url))

function parseObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value)
  if (typeof parsed !== 'object' || parsed === null) throw new Error('expected JSON object')
  return parsed as Record<string, unknown>
}

async function writePrivateLedger(path: string, text: string): Promise<void> {
  await writeFile(path, text, { encoding: 'utf8', mode: 0o600 })
  await chmod(path, 0o600)
}

async function runSealWorker(path: string): Promise<Record<string, unknown>> {
  const child = spawn(process.execPath, [
    '--import', 'tsx', SEAL_WORKER, path, PROJECT, TASK, new Date(T0).toISOString(), DEBT_ID,
  ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => { stdout += chunk })
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', resolve)
  })
  if (code !== 0) throw new Error(`seal worker exited ${String(code)}: ${stderr}`)
  const marker = stdout.split('\n').find(row => row.startsWith('TASKFLOW_RESULT:'))
  if (marker === undefined) throw new Error(`seal worker returned no result: ${stdout}`)
  return parseObject(marker.slice('TASKFLOW_RESULT:'.length))
}

describe('parseLedger', () => {
  it('parses well-formed lines and skips corrupt or shapeless ones', () => {
    const text = [
      line('start', T0),
      '{broken json',
      JSON.stringify({ ts: 'x', event: 'done' }),
      '',
      line('needs-you', T0 + 1000, { schema_version: 2, event_id: DEBT_ID }),
    ].join('\n')
    const events = parseLedger(text)
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({ event: 'needs-you', schema_version: 2, event_id: DEBT_ID })
  })
})

describe('needs-you resolution', () => {
  it('keeps the legacy v1 terminal heuristic as read-only compatibility', () => {
    const early = parseLedger([
      line('needs-you', T0),
      line('done', T0 + LEGACY_CLOSE_MS - 1),
    ].join('\n'))
    expect(isNeedsYouOpen(early, PROJECT, TASK)).toBe(true)

    for (const terminal of ['done', 'drop']) {
      const old = parseLedger([
        line('needs-you', T0),
        line(terminal, T0 + LEGACY_CLOSE_MS),
      ].join('\n'))
      expect(isNeedsYouOpen(old, PROJECT, TASK)).toBe(false)
    }
  })

  it('never lets an ordinary done or drop close a v2 debt', () => {
    for (const terminal of ['done', 'drop']) {
      const events = parseLedger([
        line('needs-you', T0, { schema_version: 2, event_id: DEBT_ID }),
        line(terminal, T0 + 10 * LEGACY_CLOSE_MS),
      ].join('\n'))
      expect(isNeedsYouOpen(events, PROJECT, TASK)).toBe(true)
    }
  })

  it('does not let a future v2 ordinary terminal heuristic-close a legacy debt', () => {
    for (const terminal of ['done', 'drop']) {
      const events = parseLedger([
        line('needs-you', T0),
        line(terminal, T0 + 2 * LEGACY_CLOSE_MS, {
          schema_version: 2,
          event_id: randomUUID(),
        }),
      ].join('\n'))
      expect(isNeedsYouOpen(events, PROJECT, TASK)).toBe(true)
    }
  })

  it('keeps legacy fallback active after an invalid explicit resolver', () => {
    const ts = new Date(T0).toISOString()
    const invalid = resolver(T0 + 1000, { ts }, {
      payload: { seal: true, resolves_ts: ts },
    })
    const events = parseLedger([
      line('needs-you', T0),
      invalid,
      line('done', T0 + LEGACY_CLOSE_MS),
    ].join('\n'))
    expect(isNeedsYouOpen(events, PROJECT, TASK)).toBe(false)
  })

  it('closes one v2 debt only with an exact audited seal', () => {
    const firstTs = new Date(T0).toISOString()
    const secondTs = new Date(T0 + 1000).toISOString()
    const events = parseLedger([
      line('needs-you', T0, { schema_version: 2, event_id: DEBT_ID }),
      line('needs-you', T0 + 1000, { schema_version: 2, event_id: SECOND_DEBT_ID }),
      resolver(T0 + 2000, { eventId: DEBT_ID, ts: firstTs }),
    ].join('\n'))
    expect(isNeedsYouOpenAt(events, PROJECT, TASK, firstTs, DEBT_ID)).toBe(false)
    expect(isNeedsYouOpenAt(events, PROJECT, TASK, secondTs, SECOND_DEBT_ID)).toBe(true)
    expect(isNeedsYouOpen(events, PROJECT, TASK)).toBe(true)
  })

  it('requires confirmation_ref and exact target identity for a done seal', () => {
    const debt = line('needs-you', T0, { schema_version: 2, event_id: DEBT_ID })
    const target = { eventId: DEBT_ID, ts: new Date(T0).toISOString() }
    const missingConfirmation = resolver(T0 + 1000, target, {
      payload: { seal: true, resolves_event_id: DEBT_ID },
    })
    const wrongTarget = resolver(T0 + 2000, target, {
      payload: { seal: true, confirmation_ref: 'human', resolves_event_id: OTHER_DEBT_ID },
    })
    expect(isNeedsYouOpen(
      parseLedger([debt, missingConfirmation, wrongTarget].join('\n')), PROJECT, TASK,
    ))
      .toBe(true)
  })

  it('accepts an audited done resolver only from the v2 dsh seal writer', () => {
    const ts = new Date(T0).toISOString()
    const debt = line('needs-you', T0, { schema_version: 2, event_id: DEBT_ID })
    const wrongSurface = resolver(T0 + 1000, { eventId: DEBT_ID, ts }, { surface: 'codex' })
    expect(isNeedsYouOpen(parseLedger([debt, wrongSurface].join('\n')), PROJECT, TASK))
      .toBe(true)
  })

  it('does not treat a legacy row carrying resolver fields as an exact resolver', () => {
    const ts = new Date(T0).toISOString()
    for (const rawResolver of [
      line('done', T0 + 1000, {
        surface: 'dsh',
        payload: { seal: true, confirmation_ref: 'human', resolves_ts: ts },
      }),
      line('drop', T0 + 1000, {
        payload: { note: 'Superseded: replacement', resolves_ts: ts },
      }),
    ]) {
      expect(isNeedsYouOpen(
        parseLedger([line('needs-you', T0), rawResolver].join('\n')), PROJECT, TASK,
      ))
        .toBe(true)
    }
  })

  it('allows an exact drop withdrawal without pretending it is a human seal', () => {
    const events = parseLedger([
      line('needs-you', T0, { schema_version: 2, event_id: DEBT_ID }),
      line('drop', T0 + 1000, {
        schema_version: 2,
        event_id: randomUUID(),
        payload: { note: 'Superseded: replacement', resolves_event_id: DEBT_ID },
      }),
    ].join('\n'))
    expect(isNeedsYouOpen(events, PROJECT, TASK)).toBe(false)
  })

  it('does not treat a targeted drop as withdrawal without a superseded note', () => {
    const events = parseLedger([
      line('needs-you', T0, { schema_version: 2, event_id: DEBT_ID }),
      line('drop', T0 + 1000, { payload: { resolves_event_id: DEBT_ID } }),
    ].join('\n'))
    expect(isNeedsYouOpen(events, PROJECT, TASK)).toBe(true)
  })

  it('falls back to exact resolves_ts only for an unambiguous target without event_id', () => {
    const ts = new Date(T0).toISOString()
    const legacy = line('needs-you', T0)
    const exact = resolver(T0 + 2 * LEGACY_CLOSE_MS, { ts })
    expect(isNeedsYouOpenAt(parseLedger([legacy, exact].join('\n')), PROJECT, TASK, ts))
      .toBe(false)

    const duplicated = parseLedger([legacy, legacy, exact].join('\n'))
    expect(isNeedsYouOpenAt(duplicated, PROJECT, TASK, ts)).toBe(false)
    expect(isNeedsYouOpen(duplicated, PROJECT, TASK)).toBe(true)

    const v2 = line('needs-you', T0, { schema_version: 2, event_id: DEBT_ID })
    expect(isNeedsYouOpenAt(parseLedger([v2, exact].join('\n')), PROJECT, TASK, ts, DEBT_ID))
      .toBe(true)
  })

  it('uses append order for causality even when the resolver clock runs behind', () => {
    const ts = new Date(T0).toISOString()
    const events = parseLedger([
      line('needs-you', T0, { schema_version: 2, event_id: DEBT_ID }),
      resolver(T0 - 1000, { eventId: DEBT_ID, ts }),
    ].join('\n'))
    expect(isNeedsYouOpenAt(events, PROJECT, TASK, ts, DEBT_ID)).toBe(false)
  })

  it('matches debts by exact project and task', () => {
    const events = parseLedger(line('needs-you', T0, { task: 'other' }))
    expect(isNeedsYouOpen(events, PROJECT, TASK)).toBe(false)
  })
})

describe('formatSealLine', () => {
  it('emits a schema-v2 done resolver with its own event_id and exact target id', () => {
    const audit = {
      resolvesTs: new Date(T0).toISOString(),
      resolvesEventId: DEBT_ID,
      confirmationRef: 'dsh-ui:seal-click',
      eventId: SEAL_ID,
    }
    const parsed = JSON.parse(
      formatSealLine(PROJECT, TASK, new Date(T0), audit),
    ) as Record<string, unknown>
    expect(parsed).toMatchObject({
      schema_version: 2,
      event_id: SEAL_ID,
      surface: 'dsh',
      project: PROJECT,
      task: TASK,
      event: 'done',
      payload: {
        seal: true,
        resolves_event_id: DEBT_ID,
        confirmation_ref: audit.confirmationRef,
      },
    })
    expect(parsed.payload).not.toHaveProperty('resolves_ts')
    expect(Date.parse(parsed.ts as string)).toBe(T0)
    expect(parsed.ts as string).toMatch(/[+-]\d{2}:\d{2}$/)
  })

  it('emits resolves_ts only for a legacy target', () => {
    const parsed = JSON.parse(formatSealLine(PROJECT, TASK, new Date(T0), {
      resolvesTs: new Date(T0).toISOString(),
      confirmationRef: 'human',
      eventId: LEGACY_SEAL_ID,
    })) as { payload: Record<string, unknown> }
    expect(parsed.payload).toMatchObject({ resolves_ts: new Date(T0).toISOString() })
    expect(parsed.payload).not.toHaveProperty('resolves_event_id')
  })
})

describe('ledger reads', () => {
  it('aggregates monthly files in order without duplicating the rotating symlink', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'taskflow-months-'))
    const july = line('start', T0, { task: 'july' })
    const august = line('start', T0 + 1000, { task: 'august' })
    await writePrivateLedger(join(dir, 'events-2026-07.jsonl'), july)
    await writePrivateLedger(join(dir, 'events-2026-08.jsonl'), `${august}\n`)
    await symlink('events-2026-08.jsonl', join(dir, 'events.jsonl'))

    const snapshot = await readMonthlyLedgers(dir)
    expect(snapshot.exists).toBe(true)
    expect(snapshot.text.trimEnd().split('\n')).toEqual([july, august])
  })

  it('returns empty only for ENOENT and rejects an unreadable source', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'taskflow-read-'))
    expect(await readLedgerFile(join(dir, 'missing.jsonl'))).toMatchObject({ exists: false })
    await expect(readLedgerFile(dir)).rejects.toBeInstanceOf(Error)
  })

  it('rejects a permissive ledger instead of presenting exposed state as healthy', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'taskflow-mode-'))
    const path = join(dir, 'events-2026-08.jsonl')
    await writeFile(path, `${line('start', T0)}\n`, { encoding: 'utf8', mode: 0o644 })
    await chmod(path, 0o644)
    await expect(readLedgerFile(path)).rejects.toThrow(/mode 0600/)
    await expect(readMonthlyLedgers(dir)).rejects.toThrow(/mode 0600/)
  })

  it('tightens an existing append target to 0600 before syncing the line', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'taskflow-append-mode-'))
    const path = join(dir, 'override.jsonl')
    await writeFile(path, '', { encoding: 'utf8', mode: 0o644 })
    await chmod(path, 0o644)
    await appendLedgerLine(path, line('start', T0))
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await readFile(path, 'utf8')).trim()).toBe(line('start', T0))
  })

  it('refuses to append through a symlink override', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'taskflow-nofollow-'))
    const target = join(dir, 'target.jsonl')
    const alias = join(dir, 'override.jsonl')
    await writePrivateLedger(target, '')
    await symlink('target.jsonl', alias)
    await expect(appendLedgerLine(alias, line('start', T0))).rejects.toBeInstanceOf(Error)
    expect(await readFile(target, 'utf8')).toBe('')
  })

  it('fails loud on a month-named symlink instead of silently omitting it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'taskflow-month-symlink-'))
    await writePrivateLedger(join(dir, 'target.jsonl'), `${line('start', T0)}\n`)
    await symlink('target.jsonl', join(dir, 'events-2026-08.jsonl'))
    await expect(readMonthlyLedgers(dir)).rejects.toBeInstanceOf(Error)
  })

  it('rejects a safe-looking alias whose monthly target is itself a symlink', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'taskflow-pointer-target-'))
    await writePrivateLedger(join(dir, 'target.jsonl'), `${line('start', T0)}\n`)
    await symlink('target.jsonl', join(dir, 'events-2026-08.jsonl'))
    await symlink('events-2026-08.jsonl', join(dir, 'events.jsonl'))
    await expect(assertSafeLedgerAlias(dir)).rejects.toThrow(/regular file/)
  })

  it('rejects a corrupt row instead of returning a partial or empty ledger', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'taskflow-corrupt-'))
    await writePrivateLedger(join(dir, 'events-2026-07.jsonl'), `${line('start', T0)}\n`)
    await writePrivateLedger(join(dir, 'events-2026-08.jsonl'), '{broken json\n')
    await expect(readMonthlyLedgers(dir)).rejects.toThrow(/Invalid TaskFlow JSONL/)
  })

  it('rejects blank or whitespace rows except the final newline terminator', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'taskflow-blank-row-'))
    const path = join(dir, 'events-2026-08.jsonl')
    for (const gap of ['', '   ']) {
      await writePrivateLedger(
        path, `${line('start', T0)}\n${gap}\n${line('done', T0 + 1000)}\n`,
      )
      await expect(readLedgerFile(path)).rejects.toThrow(/blank JSONL row/)
    }
  })

  it('rejects malformed v2 identity, timestamp, and resolver fields before folding', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'taskflow-invalid-v2-'))
    const path = join(dir, 'override.jsonl')
    const badRows = [
      line('needs-you', T0, { schema_version: 2, event_id: 'not-a-uuid' }),
      JSON.stringify({
        ts: '2026-08-15T12:00:00-0400', surface: 'codex', project: PROJECT, task: TASK,
        event: 'needs-you', schema_version: 2, event_id: DEBT_ID,
      }),
      line('done', T0, {
        schema_version: 2,
        event_id: randomUUID(),
        payload: { resolves_event_id: DEBT_ID },
      }),
      line('drop', T0, {
        schema_version: 2,
        event_id: randomUUID(),
        payload: { note: 'replacement', resolves_event_id: DEBT_ID },
      }),
      line('start', T0, {
        schema_version: 2, event_id: randomUUID(), surface: 'untrusted-surface',
      }),
      line('start', T0, {
        schema_version: 2, event_id: randomUUID(), project: 'DME',
      }),
      line('start', T0, {
        schema_version: 2, event_id: randomUUID(), task: 'ＴａｓｋＦｌｏｗ',
      }),
      line('done', T0, {
        schema_version: 2,
        event_id: randomUUID(),
        surface: 'codex',
        payload: {
          seal: true,
          resolves_event_id: DEBT_ID,
          confirmation_ref: 'dsh-ui:seal-click',
        },
      }),
      line('needs-you', T0, {
        schema_version: 2,
        event_id: randomUUID(),
        payload: { kind: 'maybe', ref: 'test-fixture' },
      }),
    ]
    for (const badRow of badRows) {
      await writePrivateLedger(path, `${badRow}\n`)
      await expect(readLedgerFile(path)).rejects.toThrow(/Invalid TaskFlow/)
    }
  })

  it.skipIf(process.platform === 'win32')('rejects a partial monthly read instead of hiding it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'taskflow-partial-'))
    const ok = join(dir, 'events-2026-07.jsonl')
    const denied = join(dir, 'events-2026-08.jsonl')
    await writePrivateLedger(ok, line('start', T0))
    await writePrivateLedger(denied, line('start', T0 + 1000))
    await chmod(denied, 0o000)
    try {
      await expect(readMonthlyLedgers(dir)).rejects.toMatchObject({ code: 'EACCES' })
    } finally {
      await chmod(denied, 0o600)
    }
  })
})

describe('shared ledger lock', () => {
  it('writes the Python-compatible owner lease and times out on a live owner', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'taskflow-lock-'))
    const lock = join(dir, '.taskflow-ledger.lock')
    const release = await acquireLedgerLock(dir)
    expect(release).not.toBeNull()
    const owner = parseObject(await readFile(join(lock, 'owner.json'), 'utf8'))
    expect(owner).toMatchObject({ version: 1, pid: process.pid, hostname: hostname() })
    expect(typeof owner.created_at).toBe('string')
    expect(typeof owner.token).toBe('string')
    expect((await stat(lock)).mode & 0o777).toBe(0o700)
    expect((await stat(join(lock, 'owner.json'))).mode & 0o777).toBe(0o600)
    expect(await acquireLedgerLock(dir, { waitMs: 50, pollMs: 5 })).toBeNull()
    await release?.()
  })

  it('fails closed on an abandoned lock instead of risking stale-lock ABA', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'taskflow-lock-'))
    const lock = join(dir, '.taskflow-ledger.lock')
    await mkdir(lock)
    await writeFile(join(lock, 'owner.json'), JSON.stringify({
      version: 1,
      pid: 99_999_999,
      hostname: hostname(),
      created_at: '2026-01-01T00:00:00Z',
      token: 'stale',
    }), { mode: 0o600 })
    expect(await acquireLedgerLock(dir, { waitMs: 50, pollMs: 5 })).toBeNull()
    expect(parseObject(await readFile(join(lock, 'owner.json'), 'utf8'))).toMatchObject({
      token: 'stale',
    })
    await unlink(join(lock, 'owner.json'))
    await rmdir(lock)
  })

  it('does not release a lock after its ownership token changes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'taskflow-lock-'))
    const lock = join(dir, '.taskflow-ledger.lock')
    const release = await acquireLedgerLock(dir)
    await writeFile(join(lock, 'owner.json'), JSON.stringify({
      version: 1,
      pid: process.pid,
      hostname: hostname(),
      created_at: '',
      token: 'replacement',
    }), 'utf8')
    await release?.()
    expect((await stat(lock)).isDirectory()).toBe(true)
    await unlink(join(lock, 'owner.json'))
    await rmdir(lock)
  })

  it('mutually excludes an independent Python writer using the shared lease', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'taskflow-python-lock-'))
    const script = [
      'import datetime as dt, json, os, socket, sys, uuid',
      'root = sys.argv[1]',
      'lock = os.path.join(root, ".taskflow-ledger.lock")',
      'os.mkdir(lock, 0o700)',
      'token = uuid.uuid4().hex',
      'owner = {"version": 1, "pid": os.getpid(), "hostname": socket.gethostname(), "created_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "token": token}',
      'owner_path = os.path.join(lock, "owner.json")',
      'fd = os.open(owner_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)',
      'os.write(fd, (json.dumps(owner, separators=(",", ":")) + "\\n").encode())',
      'os.fsync(fd)',
      'os.close(fd)',
      'print("READY", flush=True)',
      'sys.stdin.readline()',
      'current = json.loads(open(owner_path, encoding="utf-8").read())',
      'if current.get("token") == token:',
      '    os.unlink(owner_path)',
      '    os.rmdir(lock)',
    ].join('\n')
    const child = spawn('python3', ['-c', script, dir], { stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    let stderr = ''
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { reject(new Error(`Python lock did not start: ${stderr}`)) }, 2000)
      child.on('error', reject)
      child.stdout.on('data', (chunk: string) => {
        if (!chunk.includes('READY')) return
        clearTimeout(timeout)
        resolve()
      })
    })
    try {
      expect(await acquireLedgerLock(dir, { waitMs: 75, pollMs: 5 })).toBeNull()
    } finally {
      child.stdin.end('\n')
      const code = await new Promise<number | null>((resolve) => { child.on('close', resolve) })
      expect(code, stderr).toBe(0)
    }
    const release = await acquireLedgerLock(dir, { waitMs: 100, pollMs: 5 })
    expect(release).not.toBeNull()
    await release?.()
  })
})

describe('TaskflowLedgerGateway', () => {
  async function gatewayForPath(path: string): Promise<TaskflowLedgerGateway> {
    process.env.DSH_TASKFLOW_LEDGER = path
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(TaskflowLedgerGateway)
    return ctx.get('taskflow') as TaskflowLedgerGateway
  }

  async function gatewayForAttentionDirectory(path: string): Promise<TaskflowLedgerGateway> {
    delete process.env.DSH_TASKFLOW_LEDGER
    process.env.DSH_TASKFLOW_ATTENTION_DIR = path
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(TaskflowLedgerGateway)
    return ctx.get('taskflow') as TaskflowLedgerGateway
  }

  async function harness(ledgerText: string | null): Promise<{
    gateway: TaskflowLedgerGateway
    path: string
  }> {
    const dir = await mkdtemp(join(tmpdir(), 'taskflow-'))
    const path = join(dir, 'override.jsonl')
    if (ledgerText !== null) await writePrivateLedger(path, ledgerText)
    return { gateway: await gatewayForPath(path), path }
  }

  it('publishes read and seal under the taskflow namespace', async () => {
    const { gateway } = await harness('')
    expect(gateway.typertRemote).toMatchObject({ serviceKey: 'taskflow', namespace: 'taskflow' })
    expect(remoteMethods(gateway)).toEqual([
      { method: 'read', invocation: { kind: 'direct' } },
      { method: 'seal', invocation: { kind: 'direct' } },
    ])
  })

  it('keeps the exact-file override controllable for tests', async () => {
    const text = `${line('start', T0)}\n`
    const { gateway } = await harness(text)
    expect(await gateway.read()).toMatchObject({ exists: true, text })
    const missing = await harness(null)
    expect(await missing.gateway.read()).toMatchObject({ exists: false, text: '' })
  })

  const AUDIT = {
    resolvesTs: new Date(T0).toISOString(),
    resolvesEventId: DEBT_ID,
    confirmationRef: 'dsh-ui:seal-click',
  }

  it('appends one schema-v2 audited resolver for the pinned open debt', async () => {
    const debt = line('needs-you', T0, { schema_version: 2, event_id: DEBT_ID })
    const { gateway, path } = await harness(`${debt}\n`)
    const result = await gateway.seal({ project: PROJECT, task: TASK, ...AUDIT })
    expect(result.sealed).toBe(true)
    const written = (await readFile(path, 'utf8')).trimEnd().split('\n')
    expect(written).toHaveLength(2)
    const appended = parseObject(written[1] ?? '')
    expect(appended).toMatchObject({
      schema_version: 2,
      event: 'done',
      payload: {
        seal: true,
        resolves_event_id: DEBT_ID,
        confirmation_ref: AUDIT.confirmationRef,
      },
    })
    expect(typeof appended.event_id).toBe('string')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('rejects an unsafe events.jsonl alias before an exact-override append', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'taskflow-unsafe-alias-'))
    const path = join(dir, 'override.jsonl')
    const debt = line('needs-you', T0, { schema_version: 2, event_id: DEBT_ID })
    await writePrivateLedger(path, `${debt}\n`)
    await writePrivateLedger(join(dir, 'events.jsonl'), '')
    const before = createHash('sha256').update(await readFile(path)).digest('hex')
    const gateway = await gatewayForPath(path)
    await expect(gateway.seal({ project: PROJECT, task: TASK, ...AUDIT }))
      .rejects.toThrow(/alias is not a symlink/)
    expect(createHash('sha256').update(await readFile(path)).digest('hex')).toBe(before)
  })

  it('rejects an external monthly alias before creating or appending a new month', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'taskflow-external-alias-'))
    const augustPath = join(dir, 'events-2026-08.jsonl')
    const debt = line('needs-you', T0, { schema_version: 2, event_id: DEBT_ID })
    await writePrivateLedger(augustPath, `${debt}\n`)
    await symlink('../outside.jsonl', join(dir, 'events.jsonl'))
    const before = createHash('sha256').update(await readFile(augustPath)).digest('hex')
    const gateway = await gatewayForAttentionDirectory(dir)
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 1, 0, 1, 0))
    await expect(gateway.seal({ project: PROJECT, task: TASK, ...AUDIT }))
      .rejects.toThrow(/unsafe target/)
    expect(createHash('sha256').update(await readFile(augustPath)).digest('hex')).toBe(before)
    await expect(readFile(join(dir, 'events-2026-09.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves a legacy debt raw project and non-NFKC task in its audited seal', async () => {
    const project = 'DME'
    const task = 'ＴａｓｋＦｌｏｗ 收口'
    const resolvesTs = new Date(T0).toISOString()
    const { gateway, path } = await harness(`${line('needs-you', T0, { project, task })}\n`)
    const result = await gateway.seal({
      project,
      task,
      resolvesTs,
      confirmationRef: 'dsh-ui:seal-click',
    })
    expect(result).toMatchObject({ sealed: true })
    const rows = (await readFile(path, 'utf8')).trimEnd().split('\n')
    const appended = parseObject(rows[1] ?? '')
    expect(appended).toMatchObject({
      schema_version: 2,
      surface: 'dsh',
      project,
      task,
      event: 'done',
      payload: {
        seal: true,
        resolves_ts: resolvesTs,
        confirmation_ref: 'dsh-ui:seal-click',
      },
    })
    expect(await readLedgerFile(path)).toMatchObject({ exists: true })
    expect(isNeedsYouOpen(parseLedger(rows.join('\n')), project, task)).toBe(false)
  })

  it('serializes two independent gateways and appends the resolver once', async () => {
    const debt = line('needs-you', T0, { schema_version: 2, event_id: DEBT_ID })
    const { gateway: first, path } = await harness(`${debt}\n`)
    const second = await gatewayForPath(path)
    const outcomes = await Promise.all([
      first.seal({ project: PROJECT, task: TASK, ...AUDIT }),
      second.seal({ project: PROJECT, task: TASK, ...AUDIT }),
    ])
    expect(outcomes.map(result => result.sealed).sort()).toEqual([false, true])
    const written = (await readFile(path, 'utf8')).trimEnd().split('\n')
    expect(written.filter((value) => {
      const payload = parseObject(value).payload
      return typeof payload === 'object' && payload !== null
        && (payload as Record<string, unknown>).seal === true
    })).toHaveLength(1)
  })

  it('serializes two independent Node processes and appends exactly one resolver', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'taskflow-processes-'))
    const path = join(dir, 'override.jsonl')
    const debt = line('needs-you', T0, { schema_version: 2, event_id: DEBT_ID })
    await writePrivateLedger(path, `${debt}\n`)
    const outcomes = await Promise.all([runSealWorker(path), runSealWorker(path)])
    expect(outcomes.map(outcome => outcome.sealed).sort()).toEqual([false, true])
    const written = (await readFile(path, 'utf8')).trimEnd().split('\n')
    expect(written).toHaveLength(2)
    expect(written.filter((value) => {
      const payload = parseObject(value).payload
      return typeof payload === 'object' && payload !== null
        && (payload as Record<string, unknown>).seal === true
    })).toHaveLength(1)
  })

  it('rotates 8/31 debt resolution into September without mutating August', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'taskflow-rollover-'))
    const debtAt = new Date(2026, 7, 31, 23, 59, 0)
    const september = new Date(2026, 8, 1, 0, 1, 0)
    const debt = line('needs-you', debtAt.getTime(), {
      schema_version: 2,
      event_id: ROLLOVER_DEBT_ID,
    })
    const augustPath = join(dir, 'events-2026-08.jsonl')
    await writePrivateLedger(augustPath, `${debt}\n`)
    await symlink('events-2026-08.jsonl', join(dir, 'events.jsonl'))
    const augustHash = createHash('sha256').update(await readFile(augustPath)).digest('hex')
    const gateway = await gatewayForAttentionDirectory(dir)
    vi.useFakeTimers()
    vi.setSystemTime(september)

    expect(await gateway.seal({
      project: PROJECT,
      task: TASK,
      resolvesTs: debtAt.toISOString(),
      resolvesEventId: ROLLOVER_DEBT_ID,
      confirmationRef: 'dsh-ui:seal-click',
    })).toMatchObject({ sealed: true })

    expect(createHash('sha256').update(await readFile(augustPath)).digest('hex')).toBe(augustHash)
    const septemberLines = (await readFile(join(dir, 'events-2026-09.jsonl'), 'utf8'))
      .trimEnd().split('\n')
    expect(septemberLines).toHaveLength(1)
    const appended = parseObject(septemberLines[0] ?? '')
    expect(appended).toMatchObject({
      schema_version: 2,
      payload: { resolves_event_id: ROLLOVER_DEBT_ID },
    })
    expect(typeof appended.event_id).toBe('string')
    expect(await readlink(join(dir, 'events.jsonl'))).toBe('events-2026-09.jsonl')
    expect((await stat(join(dir, 'events-2026-09.jsonl'))).mode & 0o777).toBe(0o600)
  })

  it('refuses an exact withdrawal, mismatched target, invalid confirmation, and missing ledger', async () => {
    const withdrawn = await harness([
      line('needs-you', T0, { schema_version: 2, event_id: DEBT_ID }),
      line('drop', T0 + 1000, {
        schema_version: 2,
        event_id: randomUUID(),
        payload: { note: 'Superseded: replacement', resolves_event_id: DEBT_ID },
      }),
    ].join('\n'))
    expect(await withdrawn.gateway.seal({ project: PROJECT, task: TASK, ...AUDIT }))
      .toMatchObject({
        sealed: false, reason: 'no-open-needs-you',
      })
    const open = await harness(`${line('needs-you', T0, { schema_version: 2, event_id: DEBT_ID })}\n`)
    const before = createHash('sha256').update(await readFile(open.path)).digest('hex')
    expect(await open.gateway.seal({
      project: PROJECT, task: TASK, ...AUDIT, resolvesEventId: OTHER_DEBT_ID,
    })).toMatchObject({ sealed: false, reason: 'no-open-needs-you' })
    expect(await open.gateway.seal({
      project: PROJECT, task: TASK, ...AUDIT, resolvesEventId: 'debt-1',
    })).toMatchObject({ sealed: false, reason: 'invalid-request' })
    expect(await open.gateway.seal({
      project: PROJECT, task: TASK, ...AUDIT, confirmationRef: '',
    })).toMatchObject({ sealed: false, reason: 'invalid-request' })
    expect(await open.gateway.seal({
      project: PROJECT, task: TASK, ...AUDIT, confirmationRef: 'rpc-caller-supplied',
    })).toMatchObject({ sealed: false, reason: 'invalid-request' })
    for (const identity of [
      { project: '   ', task: TASK },
      { project: `${PROJECT}\r`, task: TASK },
      { project: PROJECT, task: `${TASK}\n` },
      { project: PROJECT, task: `bad\0${TASK}` },
      { project: PROJECT, task: 'x'.repeat(241) },
    ]) {
      expect(await open.gateway.seal({ ...identity, ...AUDIT })).toMatchObject({
        sealed: false, reason: 'invalid-request',
      })
    }
    expect(createHash('sha256').update(await readFile(open.path)).digest('hex')).toBe(before)
    const missing = await harness(null)
    expect(await missing.gateway.seal({ project: PROJECT, task: TASK, ...AUDIT })).toMatchObject({
      sealed: false, reason: 'ledger-missing',
    })
  })
})
