import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readReviewPlanFiles, readReviewWatchStatus } from '../src/review-plans.ts'

vi.mock('node:fs/promises', { spy: true })

const directories: string[] = []
const PLAN_BYTES = 256 * 1024

async function directory(): Promise<string> {
  const path = await fs.mkdtemp(join(tmpdir(), 'taskflow-review-plans-'))
  directories.push(path)
  return path
}

function objectAtBytes(bytes: number): string {
  return JSON.stringify({ value: 'x'.repeat(bytes - Buffer.byteLength('{"value":""}')) })
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map(path => fs.rm(path, { recursive: true, force: true })))
})

describe('project review-plan reads', () => {
  it('preserves JSON text, sorts top-level file names and leaves business validation to the client', async () => {
    const dir = await directory()
    const ark = '{ "project": "ARK", "unsupported_by_client": true }\n'
    await fs.writeFile(join(dir, 'digital-me.json'), '{}')
    await fs.writeFile(join(dir, 'ARK.json'), ark)
    await fs.writeFile(join(dir, 'notes.txt'), 'not JSON')
    await fs.mkdir(join(dir, 'nested'))
    await fs.writeFile(join(dir, 'nested', 'ignored.json'), '{}')
    expect(await readReviewPlanFiles(dir)).toEqual({
      dir, exists: true, observer: null, files: [
        { name: 'ARK.json', text: ark },
        { name: 'digital-me.json', text: '{}' },
      ],
    })
    expect(await fs.readFile(join(dir, 'ARK.json'), 'utf8')).toBe(ark)
  })

  it('distinguishes missing from existing empty directories and rejects relative or NUL paths', async () => {
    const dir = await directory()
    const missing = join(dir, 'missing')
    expect(await readReviewPlanFiles(missing)).toEqual({ dir: missing, exists: false, files: [], observer: null })
    expect(await readReviewPlanFiles(dir)).toEqual({ dir, exists: true, files: [], observer: null })
    await expect(readReviewPlanFiles('relative')).rejects.toThrow(/absolute path/)
    await expect(readReviewPlanFiles(`${dir}\0`)).rejects.toThrow(/NUL/)
  })

  it('rejects non-directory roots and JSON-named directories', async () => {
    const dir = await directory()
    const file = join(dir, 'root')
    await fs.writeFile(file, '{}')
    await expect(readReviewPlanFiles(file)).rejects.toThrow(/real directory/)
    await fs.mkdir(join(dir, 'directory.json'))
    await expect(readReviewPlanFiles(dir)).rejects.toThrow(/regular file/)
  })

  it('rejects directory and plan symlinks without reading their targets', async () => {
    const dir = await directory()
    const plans = join(dir, 'plans')
    await fs.mkdir(plans)
    const outside = join(dir, 'outside.json')
    await fs.writeFile(outside, '{"private":"outside"}')
    const linked = join(dir, 'linked')
    await fs.symlink(plans, linked, 'dir')
    await expect(readReviewPlanFiles(linked)).rejects.toThrow(/real directory/)
    await fs.symlink(outside, join(plans, 'ARK.json'), 'file')
    await expect(readReviewPlanFiles(plans)).rejects.toThrow(/regular file/)
  })

  it.each(['{', '\ufeff{}', 'null', '[]', '"value"', 'true', '42'])(
    'rejects malformed or non-object JSON (%s) instead of returning a partial snapshot', async (text) => {
      const dir = await directory()
      await fs.writeFile(join(dir, 'A-valid.json'), '{}')
      await fs.writeFile(join(dir, 'Z-invalid.json'), text)
      await expect(readReviewPlanFiles(dir)).rejects.toThrow(/review plan.*JSON|JSON object/)
    },
  )

  it('rejects invalid UTF-8 without including private source text in diagnostics', async () => {
    const dir = await directory()
    await fs.writeFile(join(dir, 'ARK.json'), Buffer.from([123, 34, 120, 34, 58, 34, 0xff, 34, 125]))
    await expect(readReviewPlanFiles(dir)).rejects.toThrow(/UTF-8 JSON/)
    await fs.writeFile(join(dir, 'ARK.json'), '{"private-marker":"unterminated')
    const failure = await readReviewPlanFiles(dir).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).not.toContain('private-marker')
  })

  it('accepts the per-file byte limit and rejects oversized multibyte content', async () => {
    const dir = await directory()
    const path = join(dir, 'ARK.json')
    const exact = objectAtBytes(PLAN_BYTES)
    await fs.writeFile(path, exact)
    expect((await readReviewPlanFiles(dir)).files[0]?.text).toBe(exact)
    await fs.writeFile(path, JSON.stringify({ value: '汉'.repeat(100_000) }))
    await expect(readReviewPlanFiles(dir)).rejects.toThrow(/exceeds 262144 bytes/)
  })

  it('bounds the complete serialized snapshot including JSON string escaping', async () => {
    const dir = await directory()
    const text = `${'\t'.repeat(PLAN_BYTES - 2)}{}`
    for (let index = 0; index < 3; index++) await fs.writeFile(join(dir, `${index}.json`), text)
    expect((await readReviewPlanFiles(dir)).files).toHaveLength(3)
    await fs.writeFile(join(dir, '3.json'), text)
    await expect(readReviewPlanFiles(dir)).rejects.toThrow(/snapshot exceeds 2097152 bytes/)
  })

  it('accepts 64 plans and rejects more', async () => {
    const dir = await directory()
    await Promise.all(Array.from({ length: 64 }, (_, index) => fs.writeFile(join(dir, `${index}.json`), '{}')))
    expect((await readReviewPlanFiles(dir)).files).toHaveLength(64)
    await fs.writeFile(join(dir, 'extra.json'), '{}')
    await expect(readReviewPlanFiles(dir)).rejects.toThrow(/exceeds 64 JSON files/)
  })

  it.skipIf(process.platform === 'win32')('rejects backslashes in a JSON file name', async () => {
    const dir = await directory()
    await fs.writeFile(join(dir, '..\\outside.json'), '{}')
    await expect(readReviewPlanFiles(dir)).rejects.toThrow(/Unsafe.*file name/)
  })

  it.skipIf(process.platform === 'win32')('propagates directory and file permission errors', async () => {
    const dir = await directory()
    await fs.chmod(dir, 0o000)
    try {
      await expect(readReviewPlanFiles(dir)).rejects.toMatchObject({ code: 'EACCES' })
    } finally {
      await fs.chmod(dir, 0o700)
    }
    const path = join(dir, 'ARK.json')
    await fs.writeFile(path, '{}')
    await fs.chmod(path, 0o000)
    try {
      await expect(readReviewPlanFiles(dir)).rejects.toMatchObject({ code: 'EACCES' })
    } finally {
      await fs.chmod(path, 0o600)
    }
  })

  it('propagates root lookup failures instead of reporting a missing directory', async () => {
    const dir = await directory()
    const failure = Object.assign(new Error('denied'), { code: 'EACCES' })
    vi.spyOn(fs, 'lstat').mockRejectedValueOnce(failure)
    await expect(readReviewPlanFiles(dir)).rejects.toBe(failure)
  })

  it('rejects a replaced file and closes the opened handle', async () => {
    const dir = await directory()
    const path = join(dir, 'ARK.json')
    await fs.writeFile(path, '{}')
    const handle = await fs.open(path, constants.O_RDONLY)
    const original = await handle.stat()
    vi.spyOn(handle, 'stat').mockResolvedValueOnce(Object.assign(original, { ino: original.ino + 1 }))
    vi.spyOn(fs, 'open').mockResolvedValueOnce(handle)
    await expect(readReviewPlanFiles(dir)).rejects.toThrow(/changed before reading/)
    await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' })
  })

  it('rejects a non-regular opened object and closes its handle', async () => {
    const dir = await directory()
    const path = join(dir, 'ARK.json')
    await fs.writeFile(path, '{}')
    const handle = await fs.open(path, constants.O_RDONLY)
    const original = await handle.stat()
    vi.spyOn(handle, 'stat').mockResolvedValueOnce(Object.assign(original, { isFile: () => false }))
    vi.spyOn(fs, 'open').mockResolvedValueOnce(handle)
    await expect(readReviewPlanFiles(dir)).rejects.toThrow(/changed before reading/)
    await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' })
  })

  it('bounds a file that grows after opening', async () => {
    const dir = await directory()
    const path = join(dir, 'ARK.json')
    await fs.writeFile(path, '{}')
    const handle = await fs.open(path, constants.O_RDONLY)
    const original = await handle.stat()
    await fs.writeFile(path, objectAtBytes(PLAN_BYTES + 1))
    vi.spyOn(handle, 'stat').mockResolvedValueOnce(original)
    vi.spyOn(fs, 'open').mockResolvedValueOnce(handle)
    await expect(readReviewPlanFiles(dir)).rejects.toThrow(/exceeds 262144 bytes/)
    await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' })
  })

  it('rejects content changes during a read', async () => {
    const dir = await directory()
    const path = join(dir, 'ARK.json')
    await fs.writeFile(path, '{}')
    const handle = await fs.open(path, constants.O_RDONLY)
    const original = await handle.stat()
    vi.spyOn(handle, 'stat')
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(Object.assign(await fs.stat(path), { mtimeMs: original.mtimeMs + 1 }))
    vi.spyOn(fs, 'open').mockResolvedValueOnce(handle)
    await expect(readReviewPlanFiles(dir)).rejects.toThrow(/changed while reading/)
    await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' })
  })

  it('rejects replacement of the configured directory during a snapshot', async () => {
    const dir = await directory()
    const info = await fs.lstat(dir)
    vi.spyOn(fs, 'lstat')
      .mockResolvedValueOnce(info)
      .mockResolvedValueOnce(Object.assign(await fs.stat(dir), { ino: info.ino + 1 }))
    await expect(readReviewPlanFiles(dir)).rejects.toThrow(/directory changed while reading/)
  })
})

describe('review watcher health reads', () => {
  const status = {
    lastScanAt: '2026-10-15T07:01:02.123456+00:00',
    lastErrorCount: 0,
    coverage: ['codex-local', 'claude-code-local'],
    excluded: ['cloud-only chats', 'Cowork without local adapter', 'subagents', 'automations'],
  }

  it('returns only health fields and never leaks private cursors or paths', async () => {
    const dir = await directory()
    const path = join(dir, 'status.json')
    await fs.writeFile(path, JSON.stringify({
      ...status,
      files: { '/private/transcript.jsonl': { offset: 123, digest: 'private' } },
      privateCursor: 'do-not-send',
    }))
    const observer = await readReviewWatchStatus(path)
    expect(observer).toEqual(status)
    const snapshot = await readReviewPlanFiles(join(dir, 'missing-plans'), observer)
    expect(snapshot).toEqual({ dir: join(dir, 'missing-plans'), exists: false, files: [], observer: status })
    expect(JSON.stringify(snapshot)).not.toContain('/private/')
    expect(JSON.stringify(snapshot)).not.toContain('privateCursor')
  })

  it('distinguishes a missing status file from a present pre-scan status', async () => {
    const dir = await directory()
    const path = join(dir, 'status.json')
    expect(await readReviewWatchStatus(path)).toBeNull()
    const empty = { lastScanAt: null, lastErrorCount: null, coverage: [], excluded: [] }
    await fs.writeFile(path, JSON.stringify(empty))
    expect(await readReviewWatchStatus(path)).toEqual(empty)
  })

  it.each([
    { lastScanAt: 'not-a-date' },
    { lastScanAt: '2026-10-15T07:01:02' },
    { lastScanAt: '2026-10-15T77:01:02Z' },
    { lastScanAt: 1 },
    { lastErrorCount: -1 },
    { lastErrorCount: 0.5 },
    { lastErrorCount: '0' },
    { coverage: null },
    { coverage: [''] },
    { coverage: [1] },
    { coverage: ['x'.repeat(201)] },
    { coverage: ['bad\nlabel'] },
    { coverage: Array.from({ length: 33 }, () => 'adapter') },
    { excluded: {} },
  ])('rejects invalid health metadata (%j)', async (override) => {
    const dir = await directory()
    const path = join(dir, 'status.json')
    await fs.writeFile(path, JSON.stringify({ ...status, ...override }))
    await expect(readReviewWatchStatus(path)).rejects.toThrow(/Invalid.*health fields/)
  })

  it('rejects absent required health fields, symlinks, oversized files and real I/O errors', async () => {
    const dir = await directory()
    const path = join(dir, 'status.json')
    await fs.writeFile(path, '{}')
    await expect(readReviewWatchStatus(path)).rejects.toThrow(/health fields/)
    await fs.writeFile(path, objectAtBytes(4097))
    await expect(readReviewWatchStatus(path)).rejects.toThrow(/exceeds 4096 bytes/)
    const linked = join(dir, 'linked.json')
    await fs.symlink(path, linked, 'file')
    await expect(readReviewWatchStatus(linked)).rejects.toThrow(/regular file/)
    const failure = Object.assign(new Error('denied'), { code: 'EACCES' })
    vi.spyOn(fs, 'lstat').mockRejectedValueOnce(failure)
    await expect(readReviewWatchStatus(path)).rejects.toBe(failure)
  })
})
