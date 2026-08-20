/** File readers and the cross-language writer lock for the TaskFlow ledger. */

import { randomUUID } from 'node:crypto'
import { constants, type Dirent, type Stats } from 'node:fs'
import {
  lstat, mkdir, open, readFile, readdir, readlink, rename, rm, rmdir, stat, symlink, unlink,
} from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { hostname } from 'node:os'
import { basename, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { TaskflowLedgerSnapshot } from './types.ts'

const MONTH_FILE = /^events-\d{4}-(?:0[1-9]|1[0-2])\.jsonl$/
const LOCK_RETRY_MS = 25
const LOCK_WAIT_MS = 5_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const V2_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
const LEGACY_TIMESTAMP = /(?:Z|[+-]\d{2}:?\d{2})$/
const EVENTS = new Set(['start', 'switch', 'delegate', 'needs-you', 'done', 'drop'])
const SURFACES = new Set(['claude-code', 'cowork', 'codex', 'dsh', 'human'])
const PROJECTS = new Set([
  'PhD Dissertation', 'digital-me', 'TaskFlow', 'my-memories',
  'job', 'life-admin', 'machine', 'ARK',
])
const NEEDS_YOU_KINDS = new Set(['merge', 'decision', 'review'])
const ROOT_FIELDS = new Set([
  'schema_version', 'event_id', 'ts', 'surface', 'project', 'task', 'event', 'payload',
])
const PAYLOAD_FIELDS = new Set([
  'note', 'kind', 'ref', 'engine', 'provenance', 'session', 'run', 'seal',
  'resolves_event_id', 'resolves_ts', 'confirmation_ref',
])

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function pause(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
    && !value.includes('\0') && !value.includes('\r') && !value.includes('\n')
}

/**
 * Check the canonical lowercase UUID spelling shared with the Python writer.
 * @param value - untrusted identity value.
 * @returns True only for the canonical 8-4-4-4-12 lowercase representation.
 */
export function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

function isTimestamp(value: unknown, v2: boolean): value is string {
  if (!isNonemptyString(value)) return false
  if (!(v2 ? V2_TIMESTAMP : LEGACY_TIMESTAMP).test(value)) return false
  return Number.isFinite(Date.parse(value))
}

function hasOnly(payload: Record<string, unknown>, fields: Set<string>): boolean {
  return Object.keys(payload).every(field => fields.has(field))
}

function isAuditedLegacyIdentitySeal(record: Record<string, unknown>): boolean {
  if (record.surface !== 'dsh' || record.event !== 'done') return false
  const payload = record.payload
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false
  const audit = payload as Record<string, unknown>
  return audit.seal === true && Object.hasOwn(audit, 'resolves_ts')
    && !Object.hasOwn(audit, 'resolves_event_id')
    && isTimestamp(audit.resolves_ts, false) && isNonemptyString(audit.confirmation_ref)
}

function assertV2Resolver(record: Record<string, unknown>, path: string, line: number): void {
  const event = record.event
  const rawPayload = record.payload
  if (rawPayload !== undefined && (typeof rawPayload !== 'object'
    || rawPayload === null || Array.isArray(rawPayload))) {
    throw new Error(`Invalid TaskFlow v2 payload at ${path}:${line}`)
  }
  const payload = (rawPayload ?? {}) as Record<string, unknown>
  if (!hasOnly(payload, PAYLOAD_FIELDS)) {
    throw new Error(`Invalid TaskFlow v2 payload fields at ${path}:${line}`)
  }
  for (const [field, value] of Object.entries(payload)) {
    if (field === 'seal') continue
    if (!isNonemptyString(value)) {
      throw new Error(`Invalid TaskFlow v2 payload value at ${path}:${line}`)
    }
  }
  const hasId = Object.hasOwn(payload, 'resolves_event_id')
  const hasTs = Object.hasOwn(payload, 'resolves_ts')
  if (hasId && !isCanonicalUuid(payload.resolves_event_id)) {
    throw new Error(`Invalid TaskFlow resolves_event_id at ${path}:${line}`)
  }
  if (hasTs && !isTimestamp(payload.resolves_ts, false)) {
    throw new Error(`Invalid TaskFlow resolves_ts at ${path}:${line}`)
  }
  if (event === 'done') {
    if (!hasOnly(payload, new Set([
      'note', 'seal', 'resolves_event_id', 'resolves_ts', 'confirmation_ref',
    ]))) {
      throw new Error(`Invalid TaskFlow done fields at ${path}:${line}`)
    }
    if (Object.hasOwn(payload, 'seal') && payload.seal !== true) {
      throw new Error(`Invalid TaskFlow done seal at ${path}:${line}`)
    }
    if (payload.seal === true) {
      if (record.surface !== 'dsh' || hasId === hasTs
        || !isNonemptyString(payload.confirmation_ref)) {
        throw new Error(`Invalid TaskFlow audited seal at ${path}:${line}`)
      }
    } else if (hasId || hasTs || Object.hasOwn(payload, 'confirmation_ref')) {
      throw new Error(`Invalid TaskFlow ordinary done resolver at ${path}:${line}`)
    }
    return
  }
  if (event === 'drop') {
    if (!hasOnly(payload, new Set(['note', 'resolves_event_id', 'resolves_ts']))) {
      throw new Error(`Invalid TaskFlow drop fields at ${path}:${line}`)
    }
    if (Object.hasOwn(payload, 'seal') || Object.hasOwn(payload, 'confirmation_ref')) {
      throw new Error(`Invalid TaskFlow drop seal fields at ${path}:${line}`)
    }
    if ((hasId || hasTs)
      && (hasId === hasTs || typeof payload.note !== 'string'
        || !/^superseded(?:\b|:)/i.test(payload.note))) {
      throw new Error(`Invalid TaskFlow resolving drop at ${path}:${line}`)
    }
    return
  }
  if (event === 'needs-you') {
    if (!hasOnly(payload, new Set(['note', 'kind', 'ref']))
      || !NEEDS_YOU_KINDS.has(payload.kind as string) || !isNonemptyString(payload.ref)) {
      throw new Error(`Invalid TaskFlow needs-you payload at ${path}:${line}`)
    }
  } else if (event === 'delegate') {
    if (!hasOnly(payload, new Set(['note', 'engine', 'provenance', 'session', 'run']))
      || !isNonemptyString(payload.engine)
      || !['provenance', 'session', 'run'].some(field => isNonemptyString(payload[field]))) {
      throw new Error(`Invalid TaskFlow delegate payload at ${path}:${line}`)
    }
  } else if (!hasOnly(payload, new Set(['note']))) {
    throw new Error(`Invalid TaskFlow ${String(event)} payload at ${path}:${line}`)
  }
  if (hasId || hasTs || Object.hasOwn(payload, 'seal')
    || Object.hasOwn(payload, 'confirmation_ref')) {
    throw new Error(`Invalid TaskFlow resolver fields at ${path}:${line}`)
  }
}

function assertV2Record(record: Record<string, unknown>, path: string, line: number): void {
  const looksV2 = record.schema_version === 2 || Object.hasOwn(record, 'event_id')
  if (!looksV2) {
    if (record.schema_version !== undefined && record.schema_version !== 1) {
      throw new Error(`Invalid TaskFlow schema_version at ${path}:${line}`)
    }
    return
  }
  if (record.schema_version !== 2 || !isCanonicalUuid(record.event_id)) {
    throw new Error(`Invalid TaskFlow v2 identity at ${path}:${line}`)
  }
  if (!hasOnly(record, ROOT_FIELDS)) {
    throw new Error(`Invalid TaskFlow v2 root fields at ${path}:${line}`)
  }
  if (!isTimestamp(record.ts, true)) {
    throw new Error(`Invalid TaskFlow v2 timestamp at ${path}:${line}`)
  }
  if (!isNonemptyString(record.surface) || !SURFACES.has(record.surface)
    || !isNonemptyString(record.project) || !isNonemptyString(record.task)
    || record.task.length > 240) {
    throw new Error(`Invalid TaskFlow v2 core fields at ${path}:${line}`)
  }
  const legacyIdentitySeal = isAuditedLegacyIdentitySeal(record)
  if (!legacyIdentitySeal && (!PROJECTS.has(record.project)
    || record.task !== record.task.normalize('NFKC').trim())) {
    throw new Error(`Invalid TaskFlow v2 identity fields at ${path}:${line}`)
  }
  if (!EVENTS.has(record.event as string)) {
    throw new Error(`Invalid TaskFlow v2 event at ${path}:${line}`)
  }
  assertV2Resolver(record, path, line)
}

function assertLedgerText(text: string, path: string): void {
  const lines = text.split('\n')
  for (const [index, line] of lines.entries()) {
    if (line === '' && index === lines.length - 1) continue
    if (line.trim() === '') {
      throw new Error(`Invalid TaskFlow blank JSONL row at ${path}:${index + 1}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (error: unknown) {
      throw new Error(`Invalid TaskFlow JSONL at ${path}:${index + 1}`, { cause: error })
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error(`Invalid TaskFlow event object at ${path}:${index + 1}`)
    }
    const record = parsed as Record<string, unknown>
    if (typeof record.ts !== 'string' || typeof record.surface !== 'string'
      || typeof record.project !== 'string' || typeof record.task !== 'string'
      || typeof record.event !== 'string') {
      throw new Error(`Invalid TaskFlow event fields at ${path}:${index + 1}`)
    }
    assertV2Record(record, path, index + 1)
  }
}

function assertPrivateRegular(info: Stats, path: string): void {
  if (!info.isFile()) throw new Error(`TaskFlow ledger is not a regular file: ${path}`)
  if ((info.mode & 0o777) !== 0o600) {
    throw new Error(`TaskFlow ledger must have mode 0600: ${path}`)
  }
}

async function readPrivateLedger(path: string): Promise<{ text: string; mtimeMs: number }> {
  const flags = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
  const handle = await open(path, flags)
  try {
    const info = await handle.stat()
    assertPrivateRegular(info, path)
    const text = await handle.readFile('utf8')
    assertLedgerText(text, path)
    return { text, mtimeMs: info.mtimeMs }
  } finally {
    await handle.close()
  }
}

/**
 * Read one explicitly selected ledger file.
 * @param path - exact JSONL file path.
 * @returns Raw text and file metadata, or a missing snapshot for ENOENT.
 */
export async function readLedgerFile(path: string): Promise<TaskflowLedgerSnapshot> {
  try {
    const file = await readPrivateLedger(path)
    return { path, exists: true, mtimeMs: file.mtimeMs, text: file.text }
  } catch (error: unknown) {
    if (!isCode(error, 'ENOENT')) throw error
    return { path, exists: false, mtimeMs: null, text: '' }
  }
}

/**
 * Read every monthly ledger in chronological filename order. The rotating
 * `events.jsonl` alias is excluded so its current-month target is not returned
 * twice. One corrupt or unreadable month rejects the complete snapshot.
 * @param directory - attention directory containing monthly JSONL files.
 * @returns Concatenated text and aggregate metadata, or a missing snapshot for ENOENT.
 */
export async function readMonthlyLedgers(directory: string): Promise<TaskflowLedgerSnapshot> {
  let entries: Dirent[]
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error: unknown) {
    if (isCode(error, 'ENOENT')) {
      return { path: directory, exists: false, mtimeMs: null, text: '' }
    }
    throw error
  }
  const directoryInfo = await stat(directory)
  const paths = entries
    .filter(entry => MONTH_FILE.test(entry.name))
    .map(entry => join(directory, entry.name))
    .sort()
  const files = await Promise.all(paths.map(path => readPrivateLedger(path)))
  const text = files
    .map(file => file.text === '' || file.text.endsWith('\n') ? file.text : `${file.text}\n`)
    .join('')
  const mtimeMs = Math.max(directoryInfo.mtimeMs, ...files.map(file => file.mtimeMs))
  return { path: directory, exists: true, mtimeMs, text }
}

interface LockOwner {
  pid: number
  hostname: string
  token: string
}

async function readLockOwner(lockPath: string): Promise<LockOwner | null> {
  try {
    const value: unknown = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8'))
    if (typeof value !== 'object' || value === null) return null
    const owner = value as Record<string, unknown>
    if (typeof owner.pid !== 'number' || typeof owner.hostname !== 'string'
      || typeof owner.token !== 'string') return null
    return { pid: owner.pid, hostname: owner.hostname, token: owner.token }
  } catch (_error: unknown) {
    // A missing, partial, or corrupt lease is unverifiable, never live proof.
    return null
  }
}

/**
 * Acquire the attention root's cross-language directory lock. Every writer
 * uses `.taskflow-ledger.lock/owner.json`; rotation and append therefore form
 * one serialized operation across Node and Python processes. A release acts
 * only while its token remains the recorded owner. Existing locks are never
 * auto-broken: after the bounded wait, a dead lease requires manual review.
 * @param directory - attention directory whose ledger is being mutated.
 * @param timing - test-only shorter wait/poll values; production uses 5 s/25 ms.
 * @returns Release callback, or null when the lock stays busy.
 */
export async function acquireLedgerLock(
  directory: string,
  timing: { waitMs?: number; pollMs?: number } = {},
): Promise<(() => Promise<void>) | null> {
  const lockPath = join(directory, '.taskflow-ledger.lock')
  const ownerPath = join(lockPath, 'owner.json')
  const token = randomUUID().replaceAll('-', '')
  const deadline = performance.now() + (timing.waitMs ?? LOCK_WAIT_MS)
  while (true) {
    let created = false
    try {
      await mkdir(lockPath, { mode: 0o700 })
      created = true
      const owner = JSON.stringify({
        version: 1,
        pid: process.pid,
        hostname: hostname(),
        created_at: new Date().toISOString(),
        token,
      }) + '\n'
      const handle = await open(ownerPath, 'wx', 0o600)
      try {
        await handle.writeFile(owner, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      return async () => {
        const current = await readLockOwner(lockPath)
        if (current?.token !== token) return
        try {
          await unlink(ownerPath)
          await rmdir(lockPath)
        } catch (error: unknown) {
          if (!isCode(error, 'ENOENT')) throw error
        }
      }
    } catch (error: unknown) {
      if (!isCode(error, 'EEXIST')) {
        if (created) await rm(lockPath, { recursive: true, force: true })
        throw error
      }
    }
    if (performance.now() >= deadline) return null
    await pause(timing.pollMs ?? LOCK_RETRY_MS)
  }
}

/**
 * Validate the public ledger alias without following it. It may be absent or
 * point by a single relative filename to one monthly ledger in this directory.
 * @param directory - attention directory containing `events.jsonl`.
 * @returns Safe monthly target name, or null when the alias is absent.
 */
export async function assertSafeLedgerAlias(directory: string): Promise<string | null> {
  const aliasPath = join(directory, 'events.jsonl')
  let info: Stats
  try {
    info = await lstat(aliasPath)
  } catch (error: unknown) {
    if (isCode(error, 'ENOENT')) return null
    throw error
  }
  if (!info.isSymbolicLink()) {
    throw new Error(`TaskFlow ledger alias is not a symlink: ${aliasPath}`)
  }
  const target = await readlink(aliasPath)
  if (target !== basename(target) || !MONTH_FILE.test(target)) {
    throw new Error(`TaskFlow ledger alias has an unsafe target: ${aliasPath}`)
  }
  const targetPath = join(directory, target)
  const targetInfo = await lstat(targetPath)
  assertPrivateRegular(targetInfo, targetPath)
  return target
}

async function openRegularAppend(path: string): Promise<FileHandle> {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NONBLOCK
    | constants.O_NOFOLLOW
  const handle = await open(path, flags, 0o600)
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error(`TaskFlow ledger is not a regular file: ${path}`)
    return handle
  } catch (error: unknown) {
    await handle.close()
    throw error
  }
}

/**
 * Ensure the wall-clock month's file exists and atomically point
 * `events.jsonl` at it. A regular-file alias is refused rather than replaced,
 * and an existing pointer to a later month never rewinds.
 * @param directory - attention directory under the held ledger lock.
 * @param now - single wall-clock instant for month selection.
 * @returns Exact monthly file path to append.
 */
export async function ensureMonthlyLedger(directory: string, now: Date): Promise<string> {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const name = `events-${now.getFullYear()}-${pad(now.getMonth() + 1)}.jsonl`
  const monthPath = join(directory, name)
  const aliasPath = join(directory, 'events.jsonl')
  const temporaryAlias = join(directory, `.events.jsonl.${randomUUID()}.tmp`)
  const currentName = await assertSafeLedgerAlias(directory)
  const handle = await openRegularAppend(monthPath)
  try {
    await handle.chmod(0o600)
    await handle.sync()
  } finally {
    await handle.close()
  }
  if (currentName !== null && currentName >= name) return monthPath
  await symlink(name, temporaryAlias)
  try {
    await rename(temporaryAlias, aliasPath)
  } finally {
    try {
      await unlink(temporaryAlias)
    } catch (error: unknown) {
      if (!isCode(error, 'ENOENT')) throw error
    }
  }
  return monthPath
}


/**
 * Durably append one already-formatted JSON line while the ledger lock is held.
 * Existing permissive files are tightened to the writer contract's 0600 mode.
 * @param path - exact monthly file or explicit test override.
 * @param line - JSON text without a trailing newline.
 */
export async function appendLedgerLine(path: string, line: string): Promise<void> {
  const handle = await openRegularAppend(path)
  try {
    await handle.chmod(0o600)
    await handle.writeFile(`${line}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}
