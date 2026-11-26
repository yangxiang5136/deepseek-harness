import * as fs from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import TaskflowLedgerGateway, {
  claudeSessionsDirectory, codexSessionIndexPath, sessionTitlesPath,
} from '../src/index.ts'
import {
  readSessionTitles, SESSION_ID_MAX, SESSION_TITLE_IDS_MAX, SESSION_TITLE_MAX,
  type ClaudeSessionMemo, type SessionTitleSources,
} from '../src/sessionTitles.ts'

vi.mock('node:fs/promises', { spy: true })

const directories: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  delete process.env.DSH_TASKFLOW_LEDGER
  delete process.env.DSH_TASKFLOW_ATTENTION_DIR
  delete process.env.DSH_TASKFLOW_CLAUDE_SESSIONS_DIR
  delete process.env.DSH_TASKFLOW_CODEX_SESSION_INDEX
  delete process.env.DSH_TASKFLOW_SESSION_TITLES
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(directories.splice(0).map(path => fs.rm(path, { recursive: true, force: true })))
})

async function directory(): Promise<string> {
  const path = await fs.mkdtemp(join(tmpdir(), 'taskflow-session-titles-'))
  directories.push(path)
  return path
}

/** Synthetic source locations under one temp root; nothing exists until written. */
async function sources(): Promise<SessionTitleSources & { root: string; store: string }> {
  const root = await directory()
  const store = join(root, 'claude', 'account', 'org')
  await fs.mkdir(store, { recursive: true })
  return {
    root,
    store,
    claudeSessionsDir: join(root, 'claude'),
    codexIndexPath: join(root, 'session_index.jsonl'),
    fallbackPath: join(root, 'session-titles.json'),
  }
}

async function session(store: string, name: string, value: unknown): Promise<string> {
  const path = join(store, `${name}.json`)
  await fs.writeFile(path, typeof value === 'string' ? value : JSON.stringify(value))
  return path
}

function codexLines(rows: unknown[]): string {
  return rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n')
}

function fallback(titles: unknown, over: Record<string, unknown> = {}): string {
  return JSON.stringify({ schemaVersion: 1, titles, ...over })
}

function opened(path: string): number {
  return vi.mocked(fs.open).mock.calls.filter(([target]) => target === path).length
}

describe('Claude desktop session store', () => {
  it('reads a desktop id from its own file without scanning the rest of the store', async () => {
    const src = await sources()
    const own = await session(src.store, 'local_aaa', {
      sessionId: 'local_aaa', cliSessionId: 'cli-aaa', title: '桌面任务', isArchived: false,
      permissions: { secret: 'never returned' },
    })
    const other = await session(src.store, 'local_bbb', { sessionId: 'local_bbb', title: '别的' })
    expect(await readSessionTitles(['local_aaa'], src, new Map())).toEqual({
      local_aaa: { tool: 'claude-code', title: '桌面任务', archived: false },
    })
    expect(opened(own)).toBe(1)
    expect(opened(other)).toBe(0)
  })

  it('maps CLI ids by scanning, normalizes titles and returns only the named fields', async () => {
    const src = await sources()
    await session(src.store, 'local_aaa', {
      sessionId: 'local_aaa', cliSessionId: 'cli-aaa', title: '  桌面\n\t任务  ', isArchived: true,
      connectors: ['private'],
    })
    await session(src.store, 'local_bbb', { sessionId: 'local_bbb', title: '没有归档标记', isArchived: 'no' })
    await fs.writeFile(join(src.store, 'notes.txt'), '{}')
    await fs.mkdir(join(src.store, 'local_dir.json'))
    await fs.writeFile(join(src.claudeSessionsDir, 'account', 'stray.json'), '{}')
    await fs.writeFile(join(src.claudeSessionsDir, 'top.json'), '{}')
    expect(await readSessionTitles(['cli-aaa', 'local_bbb', 'unknown'], src, new Map())).toEqual({
      'cli-aaa': { tool: 'claude-code', title: '桌面 任务', archived: true },
      local_bbb: { tool: 'claude-code', title: '没有归档标记' },
    })
  })

  it('skips malformed, untitled and oversized files while the others answer', async () => {
    const src = await sources()
    await session(src.store, 'local_bad', '{"sessionId":')
    await session(src.store, 'local_null', 'null')
    await session(src.store, 'local_text', '"title"')
    await session(src.store, 'local_list', '[{"title":"x"}]')
    await session(src.store, 'local_blank', { sessionId: 'local_blank', title: ' \n ' })
    await session(src.store, 'local_numeric', { sessionId: 'local_numeric', title: 7 })
    await session(src.store, 'local_big', { sessionId: 'local_big', title: '大', pad: 'x'.repeat(2 * 1024 * 1024) })
    await session(src.store, 'local_ok', { sessionId: 'local_ok', cliSessionId: 'cli-ok', title: '正常' })
    const ids = ['local_bad', 'local_null', 'local_text', 'local_list', 'local_blank', 'local_numeric',
      'local_big', 'cli-ok']
    const memo: ClaudeSessionMemo = new Map()
    expect(await readSessionTitles(ids, src, memo)).toEqual({
      'cli-ok': { tool: 'claude-code', title: '正常' },
    })
    expect([...memo.keys()]).toEqual([join(src.store, 'local_ok.json')])
  })

  it.skipIf(process.platform === 'win32')('skips an unreadable file while the others answer', async () => {
    const src = await sources()
    const locked = await session(src.store, 'local_locked', { sessionId: 'local_locked', title: '锁住' })
    await fs.chmod(locked, 0o000)
    await session(src.store, 'local_ok', { sessionId: 'local_ok', title: '正常' })
    expect(await readSessionTitles(['local_locked', 'local_ok'], src, new Map())).toEqual({
      local_ok: { tool: 'claude-code', title: '正常' },
    })
  })

  it('reuses memoized fields while size and mtime match and drops entries for removed files', async () => {
    const src = await sources()
    const path = await session(src.store, 'local_aaa', { sessionId: 'local_aaa', title: '第一版' })
    // Millisecond-exact times, so restoring the mtime reproduces the memoized value exactly.
    const mtime = new Date('2026-11-01T00:00:00.000Z')
    await fs.utimes(path, mtime, mtime)
    const memo: ClaudeSessionMemo = new Map()
    expect(await readSessionTitles(['local_aaa'], src, memo)).toMatchObject({ local_aaa: { title: '第一版' } })
    await fs.writeFile(path, JSON.stringify({ sessionId: 'local_aaa', title: '第二版' }))
    await fs.utimes(path, mtime, mtime)
    expect(await readSessionTitles(['local_aaa'], src, memo)).toMatchObject({ local_aaa: { title: '第一版' } })
    const later = new Date(mtime.getTime() + 5_000)
    await fs.utimes(path, later, later)
    expect(await readSessionTitles(['local_aaa'], src, memo)).toMatchObject({ local_aaa: { title: '第二版' } })
    await fs.writeFile(path, '{"broken"')
    expect(await readSessionTitles(['local_aaa'], src, memo)).toEqual({})
    expect(memo.has(path)).toBe(false)
    await session(src.store, 'local_aaa', { sessionId: 'local_aaa', title: '第三版' })
    await readSessionTitles(['local_aaa'], src, memo)
    expect(memo.has(path)).toBe(true)
    await fs.rm(path)
    expect(await readSessionTitles(['local_aaa'], src, memo)).toEqual({})
    expect(memo.size).toBe(0)
  })

  it('scans at most 2000 store files but reads a desktop id from its own file in any store size', async () => {
    const src = await sources()
    const paths: string[] = []
    for (let i = 0; i <= 2001; i += 1) {
      const name = `local_${String(i).padStart(4, '0')}`
      paths.push(await session(src.store, name, { sessionId: name, cliSessionId: `cli-${i}`, title: `第${i}个` }))
    }
    const storeOpens = (): number => paths.reduce((count, path) => count + opened(path), 0)
    vi.mocked(fs.open).mockClear()
    expect(await readSessionTitles(['cli-1999', 'cli-2000'], src, new Map())).toEqual({
      'cli-1999': { tool: 'claude-code', title: '第1999个' },
    })
    expect(storeOpens()).toBe(2000)
    expect(opened(paths[2000]!)).toBe(0)
    vi.mocked(fs.open).mockClear()
    expect(await readSessionTitles(['local_0000', 'local_2001'], src, new Map())).toEqual({
      local_0000: { tool: 'claude-code', title: '第0个' },
      local_2001: { tool: 'claude-code', title: '第2001个' },
    })
    expect(storeOpens()).toBe(2)
    // Files read for desktop ids do not count against the scan cap.
    vi.mocked(fs.open).mockClear()
    expect(await readSessionTitles(['local_2001', 'cli-1999', 'cli-2000'], src, new Map())).toEqual({
      local_2001: { tool: 'claude-code', title: '第2001个' },
      'cli-1999': { tool: 'claude-code', title: '第1999个' },
    })
    expect(storeOpens()).toBe(2001)
  })

  it('stops scanning once every id resolves', async () => {
    const src = await sources()
    const paths: string[] = []
    for (let i = 0; i < 10; i += 1) {
      const name = `local_${i}`
      paths.push(await session(src.store, name, { sessionId: name, cliSessionId: `cli-${i}`, title: `第${i}个` }))
    }
    vi.mocked(fs.open).mockClear()
    expect(await readSessionTitles(['cli-3', 'local_7'], src, new Map())).toEqual({
      'cli-3': { tool: 'claude-code', title: '第3个' },
      local_7: { tool: 'claude-code', title: '第7个' },
    })
    expect(paths.map(opened)).toEqual([1, 1, 1, 1, 0, 0, 0, 1, 0, 0])
  })

  it.skipIf(process.platform === 'win32')('lists sibling directories when one cannot be read', async () => {
    const src = await sources()
    const locked = join(src.claudeSessionsDir, 'account', 'locked')
    await fs.mkdir(locked)
    await session(locked, 'local_hidden', { sessionId: 'local_hidden', title: '藏起来' })
    await fs.chmod(locked, 0o000)
    await session(src.store, 'local_aaa', { sessionId: 'local_aaa', title: '可读' })
    try {
      expect(await readSessionTitles(['local_aaa', 'local_hidden'], src, new Map())).toEqual({
        local_aaa: { tool: 'claude-code', title: '可读' },
      })
    } finally {
      await fs.chmod(locked, 0o700)
    }
  })
})

describe('Codex session index', () => {
  it('keeps the entry with the latest parsable updated_at and falls back to the later line', async () => {
    const src = await sources()
    await fs.writeFile(src.codexIndexPath, codexLines([
      { id: 'thread-a', thread_name: '旧名字', updated_at: '2026-11-20T10:00:00Z' },
      { id: 'thread-a', thread_name: '新名字', updated_at: '2026-11-21T10:00:00Z' },
      { id: 'thread-a', thread_name: '更早的重复', updated_at: '2026-11-19T10:00:00Z' },
      { id: 'thread-b', thread_name: '同时间先写', updated_at: '2026-11-21T10:00:00Z' },
      { id: 'thread-b', thread_name: '同时间后写', updated_at: '2026-11-21T10:00:00Z' },
      { id: 'thread-c', thread_name: '有时间', updated_at: '2026-11-21T10:00:00Z' },
      { id: 'thread-c', thread_name: '时间坏了', updated_at: 'yesterday' },
      { id: 'thread-d', thread_name: '无时间先写' },
      { id: 'thread-d', thread_name: '无时间后写', updated_at: 5 },
      '',
      '{"id":"thread-e","thread_name":',
      'null',
      '[]',
      { id: 42, thread_name: '数字 id' },
      { id: 'thread-f' },
      { id: 'thread-f', thread_name: '   ' },
      { id: 'not-requested', thread_name: '不要' },
    ]))
    expect(await readSessionTitles(['thread-a', 'thread-b', 'thread-c', 'thread-d', 'thread-e', 'thread-f'], src, new Map()))
      .toEqual({
        'thread-a': { tool: 'codex', title: '新名字' },
        'thread-b': { tool: 'codex', title: '同时间后写' },
        'thread-c': { tool: 'codex', title: '有时间' },
        'thread-d': { tool: 'codex', title: '无时间后写' },
      })
  })

  it('never lets a missing or unparsable updated_at reset the ordering', async () => {
    const src = await sources()
    await fs.writeFile(src.codexIndexPath, codexLines([
      { id: 'newest-first', thread_name: '最新', updated_at: '2026-11-25T00:00:00Z' },
      { id: 'newest-first', thread_name: '没有时间' },
      { id: 'newest-first', thread_name: '较旧', updated_at: '2026-11-01T00:00:00Z' },
      { id: 'broken-between', thread_name: '最新', updated_at: '2026-11-21T10:00:00Z' },
      { id: 'broken-between', thread_name: '时间坏了', updated_at: 'x' },
      { id: 'broken-between', thread_name: '最旧', updated_at: '2026-11-01T10:00:00Z' },
      { id: 'broken-first', thread_name: '时间坏了', updated_at: 'x' },
      { id: 'broken-first', thread_name: '较旧', updated_at: '2026-11-01T10:00:00Z' },
      { id: 'broken-first', thread_name: '没有时间' },
      { id: 'oldest-first', thread_name: '最旧', updated_at: '2026-11-01T10:00:00Z' },
      { id: 'oldest-first', thread_name: '时间坏了', updated_at: 'x' },
      { id: 'oldest-first', thread_name: '最新', updated_at: '2026-11-21T10:00:00Z' },
    ]))
    expect(await readSessionTitles(['newest-first', 'broken-between', 'broken-first', 'oldest-first'], src, new Map()))
      .toEqual({
        'newest-first': { tool: 'codex', title: '最新' },
        'broken-between': { tool: 'codex', title: '最新' },
        'broken-first': { tool: 'codex', title: '较旧' },
        'oldest-first': { tool: 'codex', title: '最新' },
      })
  })

  it('contributes nothing when the index is oversized, not a file, or missing', async () => {
    const src = await sources()
    const row = codexLines([{ id: 'thread-a', thread_name: '名字', updated_at: '2026-11-21T10:00:00Z' }])
    await fs.writeFile(src.codexIndexPath, `${row}\n`)
    await fs.truncate(src.codexIndexPath, 20 * 1024 * 1024 + 1)
    expect(await readSessionTitles(['thread-a'], src, new Map())).toEqual({})
    await fs.rm(src.codexIndexPath)
    await fs.mkdir(src.codexIndexPath)
    expect(await readSessionTitles(['thread-a'], src, new Map())).toEqual({})
    await fs.rmdir(src.codexIndexPath)
    expect(await readSessionTitles(['thread-a'], src, new Map())).toEqual({})
  })

  it.skipIf(process.platform === 'win32')('contributes nothing when the index cannot be read', async () => {
    const src = await sources()
    await fs.writeFile(src.codexIndexPath, codexLines([{ id: 'thread-a', thread_name: '名字' }]))
    await fs.chmod(src.codexIndexPath, 0o000)
    expect(await readSessionTitles(['thread-a'], src, new Map())).toEqual({})
  })
})

describe('fallback title file', () => {
  it('accepts exact entries and ignores invalid ones', async () => {
    const src = await sources()
    await fs.writeFile(src.fallbackPath, fallback({
      local_ok: { tool: 'claude-code', title: ' 远程\n副本 ', archived: true },
      'thread-ok': { tool: 'codex', title: 'Codex 线程' },
      unknownField: { tool: 'codex', title: '多余字段', extra: 1 },
      badTool: { tool: 'cowork', title: '工具不对' },
      blank: { tool: 'codex', title: '' },
      badArchive: { tool: 'codex', title: '归档字段坏', archived: 'yes' },
      list: ['codex', 'title'],
      scalar: 'title',
      empty: null,
      unrequested: { tool: 'codex', title: '没有要' },
    }))
    expect(await readSessionTitles(
      ['local_ok', 'thread-ok', 'unknownField', 'badTool', 'blank', 'badArchive', 'list', 'scalar', 'empty', 'toString'],
      src, new Map(),
    )).toEqual({
      local_ok: { tool: 'claude-code', title: '远程 副本', archived: true },
      'thread-ok': { tool: 'codex', title: 'Codex 线程' },
    })
  })

  it('contributes nothing when the file does not match the schema', async () => {
    const src = await sources()
    const entry = { local_ok: { tool: 'codex', title: '标题' } }
    for (const text of [
      fallback(entry, { schemaVersion: 2 }),
      fallback([entry]),
      fallback(entry, { extra: true }),
      JSON.stringify([entry]),
      '{"schemaVersion":1,',
    ]) {
      await fs.writeFile(src.fallbackPath, text)
      expect(await readSessionTitles(['local_ok'], src, new Map())).toEqual({})
    }
    await fs.rm(src.fallbackPath)
    await fs.mkdir(src.fallbackPath)
    expect(await readSessionTitles(['local_ok'], src, new Map())).toEqual({})
  })
})

describe('session title lookup', () => {
  it('lets live stores win over the fallback file and skips sources once every id resolves', async () => {
    const src = await sources()
    await session(src.store, 'local_aaa', { sessionId: 'local_aaa', cliSessionId: 'shared-id', title: 'Claude 标题' })
    await fs.writeFile(src.codexIndexPath, codexLines([
      { id: 'shared-id', thread_name: 'Codex 同 id' },
      { id: 'thread-a', thread_name: 'Codex 标题' },
    ]))
    await fs.writeFile(src.fallbackPath, fallback({
      local_aaa: { tool: 'codex', title: '副本' },
      'thread-a': { tool: 'claude-code', title: '副本' },
      'only-copy': { tool: 'codex', title: '只在副本里' },
    }))
    expect(await readSessionTitles(['local_aaa', 'shared-id', 'thread-a', 'only-copy'], src, new Map())).toEqual({
      local_aaa: { tool: 'claude-code', title: 'Claude 标题' },
      'shared-id': { tool: 'claude-code', title: 'Claude 标题' },
      'thread-a': { tool: 'codex', title: 'Codex 标题' },
      'only-copy': { tool: 'codex', title: '只在副本里' },
    })
    vi.mocked(fs.open).mockClear()
    expect(await readSessionTitles(['local_aaa'], src, new Map())).toEqual({
      local_aaa: { tool: 'claude-code', title: 'Claude 标题' },
    })
    expect(opened(src.codexIndexPath)).toBe(0)
    expect(opened(src.fallbackPath)).toBe(0)
  })

  it('caps ids and title length, dedupes ids and never rejects', async () => {
    const src = await sources()
    const ids = Array.from({ length: SESSION_TITLE_IDS_MAX + 1 }, (_, i) => `id-${i}`)
    const long = '标'.repeat(SESSION_ID_MAX + 1)
    const titles = Object.fromEntries([...ids, long].map(id => [id, { tool: 'codex', title: id }]))
    titles['id-0'] = { tool: 'codex', title: `${'😀'.repeat(SESSION_TITLE_MAX - 1)} 尾巴` }
    await fs.writeFile(src.fallbackPath, fallback(titles))
    const answer = await readSessionTitles(['id-0', ...ids, long, '', '  '], src, new Map())
    expect(Object.keys(answer)).toEqual(ids.slice(0, SESSION_TITLE_IDS_MAX))
    expect(answer['id-0']?.title).toBe('😀'.repeat(SESSION_TITLE_MAX - 1))
    expect(await readSessionTitles([], src, new Map())).toEqual({})
    const missing = join(src.root, 'missing')
    expect(await readSessionTitles(['id-1', 'local_x'], {
      claudeSessionsDir: missing, codexIndexPath: join(missing, 'index.jsonl'), fallbackPath: join(missing, 'titles.json'),
    }, new Map())).toEqual({})
  })
})

describe('sessionTitles remote', () => {
  async function gateway(): Promise<TaskflowLedgerGateway> {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(TaskflowLedgerGateway)
    return ctx.get('taskflow') as TaskflowLedgerGateway
  }

  it('answers from the host-selected sources', async () => {
    const src = await sources()
    await session(src.store, 'local_aaa', { sessionId: 'local_aaa', title: '桌面' })
    await fs.writeFile(src.codexIndexPath, codexLines([{ id: 'thread-a', thread_name: 'Codex' }]))
    await fs.writeFile(src.fallbackPath, fallback({ remote: { tool: 'codex', title: '副本' } }))
    process.env.DSH_TASKFLOW_CLAUDE_SESSIONS_DIR = src.claudeSessionsDir
    process.env.DSH_TASKFLOW_CODEX_SESSION_INDEX = src.codexIndexPath
    process.env.DSH_TASKFLOW_SESSION_TITLES = src.fallbackPath
    const service = await gateway()
    expect(await service.sessionTitles({ ids: ['local_aaa', 'thread-a', 'remote', 'missing'] })).toEqual({
      titles: {
        local_aaa: { tool: 'claude-code', title: '桌面' },
        'thread-a': { tool: 'codex', title: 'Codex' },
        remote: { tool: 'codex', title: '副本' },
      },
    })
  })

  it('rejects requests that are not a capped list of nonempty ids', async () => {
    const service = await gateway()
    for (const ids of [
      'local_aaa', [''], ['  '], [7],
      Array.from({ length: SESSION_TITLE_IDS_MAX + 1 }, (_, i) => `id-${i}`),
    ]) {
      await expect(service.sessionTitles({ ids } as never)).rejects.toThrow('Invalid TaskFlow sessionTitles request')
    }
  })

  it('defaults to the desktop stores and a fallback file beside the ledger', async () => {
    expect(claudeSessionsDirectory())
      .toBe(join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions'))
    expect(codexSessionIndexPath()).toBe(join(homedir(), '.codex', 'session_index.jsonl'))
    expect(sessionTitlesPath()).toBe(join(homedir(), 'my-memories', 'attention', 'session-titles.json'))
    process.env.DSH_TASKFLOW_ATTENTION_DIR = '/srv/attention'
    expect(sessionTitlesPath()).toBe(join('/srv/attention', 'session-titles.json'))
    process.env.DSH_TASKFLOW_LEDGER = '/srv/ledger/events.jsonl'
    expect(sessionTitlesPath()).toBe(join('/srv/ledger', 'session-titles.json'))
  })
})
