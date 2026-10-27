import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rename, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { codexConfirmationRef } from '../src/confirmation.ts'
import TaskflowLedgerGateway from '../src/index.ts'
import type { TaskflowPhaseConfirmationRequest } from '../src/types.ts'

const paths = vi.hoisted(() => ({ home: '', replaced: '', denied: false }))
vi.mock('node:os', async original => ({
  ...await original<typeof import('node:os')>(),
  homedir: () => paths.home,
}))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return {
    ...actual,
    lstat: async (path: Parameters<typeof actual.lstat>[0]) => {
      if (paths.denied) throw Object.assign(new Error('denied'), { code: 'EACCES' })
      const info = await actual.lstat(path)
      if (path === paths.replaced) Object.defineProperty(info, 'ino', { value: 0 })
      return info
    },
  }
})

const THREAD = '11111111-1111-4111-8111-111111111111'
const DEBT = '22222222-2222-4222-8222-222222222222'
const QUOTE = '两只猫全部入境交接完成'
const contexts: Context[] = []
let codexRoot: string
let attention: string

beforeEach(async () => {
  paths.replaced = ''
  paths.denied = false
  paths.home = await realpath(await mkdtemp(join(tmpdir(), 'taskflow-confirmation-')))
  codexRoot = join(paths.home, '.codex')
  attention = join(paths.home, 'attention')
  await mkdir(attention)
  process.env.DSH_TASKFLOW_ATTENTION_DIR = attention
})

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  delete process.env.DSH_TASKFLOW_ATTENTION_DIR
  delete process.env.DSH_TASKFLOW_LEDGER
  vi.restoreAllMocks()
})

function meta(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'session_meta',
    payload: { id: THREAD, source: 'vscode', thread_source: 'user', ...over },
  }
}

function message(text = QUOTE, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'response_item',
    payload: {
      type: 'message', id: 'msg-human', role: 'user',
      content: [{ type: 'input_text', text }],
      internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text'] },
      ...over,
    },
  }
}

async function transcript(
  first = meta(), row = message(), directory = 'sessions',
): Promise<TaskflowPhaseConfirmationRequest> {
  const dir = join(codexRoot, directory)
  await mkdir(dir, { recursive: true })
  const sourcePath = join(dir, `rollout-2026-10-27T00-00-00-${THREAD}.jsonl`)
  const prefix = JSON.stringify(first) + '\n'
  await writeFile(sourcePath, prefix + JSON.stringify(row) + '\n')
  return {
    project: 'life-admin', task: '两只猫回国机票与入境流程',
    resolvesTs: '2026-09-19T19:49:35-04:00', resolvesEventId: DEBT,
    threadId: THREAD, sourcePath, byteOffset: Buffer.byteLength(prefix), quote: QUOTE,
  }
}

function gateway(): TaskflowLedgerGateway {
  const ctx = new Context()
  contexts.push(ctx)
  return new TaskflowLedgerGateway(ctx)
}

describe('native human phase confirmation', () => {
  it.each(['sessions', 'archived_sessions'])('authenticates an exact human line in %s', async (directory) => {
    const request = await transcript(meta(), message(), directory)
    expect(await codexConfirmationRef(request, codexRoot))
      .toBe(`codex-user:${THREAD}#byte=${request.byteOffset}`)
  })

  it.each([
    { source: 'automation' }, { source: 'subagent' }, { thread_source: 'automation' },
    { parent_thread_id: THREAD }, { forked_from_id: THREAD }, { id: randomUUID() },
  ])('rejects non-native or non-interactive session metadata: %j', async (over) => {
    const request = await transcript(meta(over))
    expect(await codexConfirmationRef(request, codexRoot)).toBeNull()
  })

  it.each([
    { role: 'assistant' },
    { internal_chat_message_metadata_passthrough: { content_item_kinds: ['environment_context'] } },
    { content: [{ type: 'tool_result', text: QUOTE }] },
  ])('rejects assistant, injected, and tool text: %j', async (over) => {
    const request = await transcript(meta(), message(QUOTE, over))
    expect(await codexConfirmationRef(request, codexRoot)).toBeNull()
  })

  it.each(['Automation: automatic task', '<environment_context>', '<INSTRUCTIONS>', '# AGENTS.md'])
  ('rejects machine context wrappers even with human metadata: %s', async (prefix) => {
    const request = await transcript(meta(), message(prefix + '\n' + QUOTE))
    expect(await codexConfirmationRef(request, codexRoot)).toBeNull()
  })

  it('requires the quotation, a complete line, and an exact byte boundary', async () => {
    const request = await transcript()
    expect(await codexConfirmationRef({ ...request, quote: '猫还没有入境' }, codexRoot)).toBeNull()
    expect(await codexConfirmationRef({ ...request, byteOffset: request.byteOffset + 1 }, codexRoot)).toBeNull()
    expect(await codexConfirmationRef({ ...request, byteOffset: 0 }, codexRoot)).toBeNull()
    const text = await readFile(request.sourcePath, 'utf8')
    await writeFile(request.sourcePath, text.slice(0, -1))
    expect(await codexConfirmationRef(request, codexRoot)).toBeNull()
  })

  it('rejects oversized and malformed records', async () => {
    const request = await transcript(meta(), message('a'.repeat(1024 * 1024) + QUOTE))
    expect(await codexConfirmationRef(request, codexRoot)).toBeNull()
    const text = await readFile(request.sourcePath)
    await writeFile(request.sourcePath, Buffer.concat([
      text.subarray(0, request.byteOffset), Buffer.from('{bad json}\n'),
    ]))
    expect(await codexConfirmationRef(request, codexRoot)).toBeNull()
    await writeFile(request.sourcePath, Buffer.concat([
      text.subarray(0, request.byteOffset), Buffer.from([0xff, 10]),
    ]))
    expect(await codexConfirmationRef(request, codexRoot)).toBeNull()
  })

  it('rejects missing, outside, and symbolic-link sources before consuming their content', async () => {
    const request = await transcript()
    expect(await codexConfirmationRef({ ...request, sourcePath: join(paths.home, 'outside.jsonl') }, codexRoot)).toBeNull()
    const link = join(codexRoot, 'archived_sessions')
    await symlink(join(codexRoot, 'sessions'), link)
    expect(await codexConfirmationRef({
      ...request, sourcePath: join(link, `rollout-2026-10-27T00-00-00-${THREAD}.jsonl`),
    }, codexRoot)).toBeNull()
    expect(await codexConfirmationRef({ ...request, sourcePath: request.sourcePath + '.missing.jsonl' }, codexRoot)).toBeNull()
  })

  it('requires absolute, canonical source and root paths', async () => {
    const request = await transcript()
    expect(await codexConfirmationRef({ ...request, sourcePath: 'sessions/source.jsonl' }, codexRoot)).toBeNull()
    expect(await codexConfirmationRef({ ...request, sourcePath: codexRoot + '/sessions/../sessions/source.jsonl' }, codexRoot)).toBeNull()
    expect(await codexConfirmationRef(request, '.codex')).toBeNull()
  })

  it('rejects linked parent directories and mismatched native filenames', async () => {
    const request = await transcript()
    const wrong = join(codexRoot, 'sessions', `rollout-${randomUUID()}.jsonl`)
    await writeFile(wrong, await readFile(request.sourcePath))
    expect(await codexConfirmationRef({ ...request, sourcePath: wrong }, codexRoot)).toBeNull()
    const original = join(paths.home, 'original-codex')
    await rename(codexRoot, original)
    await symlink(original, codexRoot)
    expect(await codexConfirmationRef(request, codexRoot)).toBeNull()
  })

  it('rejects a directory selected as the transcript', async () => {
    const request = await transcript()
    const directory = join(codexRoot, 'sessions', `directory-${THREAD}.jsonl`)
    await mkdir(directory)
    expect(await codexConfirmationRef({ ...request, sourcePath: directory }, codexRoot)).toBeNull()
    expect(await codexConfirmationRef({ ...request, byteOffset: Number.MAX_SAFE_INTEGER }, codexRoot)).toBeNull()
  })

  it('refuses a source replaced while its original message is read', async () => {
    const request = await transcript()
    paths.replaced = request.sourcePath
    expect(await codexConfirmationRef(request, codexRoot)).toBeNull()
  })

  it('propagates inaccessible transcript errors instead of treating them as absent', async () => {
    const request = await transcript()
    paths.denied = true
    await expect(codexConfirmationRef(request, codexRoot)).rejects.toThrow('denied')
  })

  it.each([
    { threadId: 'wrong' }, { byteOffset: -1 }, { byteOffset: 0.5 },
    { quote: '' }, { quote: ' ' + QUOTE }, { quote: QUOTE + '\n' }, { quote: 'a'.repeat(281) },
  ])('rejects invalid source selectors: %j', async (over) => {
    const request = await transcript()
    expect(await codexConfirmationRef({ ...request, ...over }, codexRoot)).toBeNull()
  })

  it('shares the exact seal transaction and preserves the verbatim human source on replay', async () => {
    const request = await transcript()
    const path = join(attention, 'events-2026-09.jsonl')
    await writeFile(path, JSON.stringify({
      schema_version: 2, event_id: DEBT, ts: request.resolvesTs,
      surface: 'codex', project: request.project, task: request.task, event: 'needs-you',
      payload: { kind: 'review', ref: 'retained-source' },
    }) + '\n', { mode: 0o600 })
    const host = gateway()
    const sealed = await host.confirmPhase(request)
    expect(sealed.sealed).toBe(true)
    expect(JSON.parse(sealed.line ?? '{}')).toMatchObject({
      surface: 'dsh', event: 'done', payload: {
        seal: true, resolves_event_id: DEBT, note: QUOTE,
        confirmation_ref: `codex-user:${THREAD}#byte=${request.byteOffset}`,
      },
    })
    expect(await host.confirmPhase(request))
      .toEqual({ sealed: false, reason: 'no-open-needs-you', line: null })
    expect(await readFile(path, 'utf8')).not.toContain('"seal":true')
  })

  it('does not allow the click entry to impersonate a natural confirmation', async () => {
    const request = await transcript()
    expect(await gateway().seal({ ...request, confirmationRef: `codex-user:${THREAD}#byte=1` }))
      .toEqual({ sealed: false, reason: 'invalid-request', line: null })
    expect(await gateway().confirmPhase({ ...request, quote: 'not present' }))
      .toEqual({ sealed: false, reason: 'invalid-request', line: null })
  })
})
