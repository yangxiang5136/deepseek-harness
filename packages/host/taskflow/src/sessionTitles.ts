/**
 * Read-only title lookup for the chat sessions that needs-you debts name in
 * `payload.session`. Three optional sources answer in precedence order: the
 * Claude desktop session store, the Codex session index, and a fallback JSON
 * file for hosts without either store. A lookup never rejects: a missing,
 * oversized, unreadable, or malformed source contributes no titles, and later
 * sources still answer. Only the four named Claude session fields are read
 * from a session file; nothing else in it leaves this module.
 */

import { constants, type Dirent, type Stats } from 'node:fs'
import { open, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { TaskflowSessionTitle, TaskflowSessionTool } from './types.ts'

/** Most session ids one lookup answers; the Remote rejects longer requests. */
export const SESSION_TITLE_IDS_MAX = 500

/** Longest session id a lookup resolves; longer ids resolve to nothing. */
export const SESSION_ID_MAX = 256

/** Longest returned title in code points, after whitespace normalization. */
export const SESSION_TITLE_MAX = 200

const CLAUDE_LISTING_MAX = 50_000
const CLAUDE_SCAN_MAX = 2000
const CLAUDE_FILE_BYTES_MAX = 2 * 1024 * 1024
const CODEX_INDEX_BYTES_MAX = 20 * 1024 * 1024
const FALLBACK_BYTES_MAX = 4 * 1024 * 1024
const CLAUDE_FILE = /^local_.+\.json$/
const TOOLS: ReadonlySet<unknown> = new Set<TaskflowSessionTool>(['claude-code', 'codex'])
const FALLBACK_ROOT_FIELDS = new Set(['schemaVersion', 'titles'])
const FALLBACK_ENTRY_FIELDS = new Set(['tool', 'title', 'archived'])

/** Host-selected source locations for one lookup. */
export interface SessionTitleSources {
  /** Claude desktop store root; session files sit at `<root>/<a>/<b>/local_<uuid>.json`. */
  claudeSessionsDir: string
  /** Codex `session_index.jsonl`: one `{id, thread_name, updated_at}` object per line. */
  codexIndexPath: string
  /** Fallback `{"schemaVersion":1,"titles":{...}}` file for hosts without the live stores. */
  fallbackPath: string
}

/** Title and ids extracted from one Claude session file at a recorded size and mtime. */
export interface ClaudeSessionEntry {
  /** File size when the fields were read. */
  size: number
  /** File modification time when the fields were read. */
  mtimeMs: number
  /** The file's `sessionId` and `cliSessionId`, where present. */
  ids: string[]
  /** Title built from `title` and `isArchived`. */
  title: TaskflowSessionTitle
}

/**
 * Claude session fields by file path, owned by one gateway. A file whose size
 * and mtime still match is not read again; entries for files absent from the
 * latest store listing are dropped.
 */
export type ClaudeSessionMemo = Map<string, ClaudeSessionEntry>

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= SESSION_ID_MAX
}

function normalizeTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const title = value.replace(/[\s\p{Cc}]+/gu, ' ').trim()
  if (title === '') return null
  return Array.from(title).slice(0, SESSION_TITLE_MAX).join('').trimEnd()
}

async function entries(directory: string): Promise<Dirent[]> {
  try {
    return await readdir(directory, { withFileTypes: true })
  } catch {
    // A missing or unreadable store directory lists no session files; sibling directories still list.
    return []
  }
}

async function listClaudeFiles(root: string): Promise<string[]> {
  const files: string[] = []
  for (const first of await entries(root)) {
    if (!first.isDirectory()) continue
    for (const second of await entries(join(root, first.name))) {
      if (!second.isDirectory()) continue
      const directory = join(root, first.name, second.name)
      for (const entry of await entries(directory)) {
        if (entry.isFile() && CLAUDE_FILE.test(entry.name)) files.push(join(directory, entry.name))
      }
    }
  }
  return files.sort().slice(0, CLAUDE_LISTING_MAX)
}

function claudeEntry(value: unknown, info: Stats): ClaudeSessionEntry | null {
  if (!isObject(value)) return null
  const title = normalizeTitle(value.title)
  if (title === null) return null
  return {
    size: info.size,
    mtimeMs: info.mtimeMs,
    ids: [value.sessionId, value.cliSessionId].filter(isSessionId),
    title: {
      tool: 'claude-code',
      title,
      ...(typeof value.isArchived === 'boolean' ? { archived: value.isArchived } : {}),
    },
  }
}

async function readClaudeFile(
  path: string, previous: ClaudeSessionEntry | undefined,
): Promise<ClaudeSessionEntry | null> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (info.size > CLAUDE_FILE_BYTES_MAX) return null
    if (previous?.size === info.size && previous.mtimeMs === info.mtimeMs) return previous
    return claudeEntry(JSON.parse(await handle.readFile('utf8')), info)
  } finally {
    await handle.close()
  }
}

async function readClaudeEntry(
  path: string, previous: ClaudeSessionEntry | undefined,
): Promise<ClaudeSessionEntry | null> {
  try {
    return await readClaudeFile(path, previous)
  } catch {
    // An unreadable, linked, or half-written session file is skipped; the other files still answer.
    return null
  }
}

async function fromClaude(
  root: string, wanted: readonly string[], found: Map<string, TaskflowSessionTitle>,
  memo: ClaudeSessionMemo,
): Promise<void> {
  const files = await listClaudeFiles(root)
  const listed = new Set(files)
  for (const path of memo.keys()) {
    if (!listed.has(path)) memo.delete(path)
  }
  const byName = new Map<string, string>()
  for (const path of files.toReversed()) byName.set(basename(path), path)
  const pending = new Set(wanted.filter(id => !found.has(id)))
  const visited = new Set<string>()
  const visit = async (path: string): Promise<void> => {
    visited.add(path)
    const entry = await readClaudeEntry(path, memo.get(path))
    if (entry === null) {
      memo.delete(path)
      return
    }
    memo.set(path, entry)
    for (const id of entry.ids) {
      if (pending.delete(id)) found.set(id, entry.title)
    }
  }
  // A desktop id names its own file, so it resolves from the full listing without scanning the store.
  for (const id of wanted) {
    const path = byName.get(`${id}.json`)
    if (path !== undefined && !visited.has(path)) await visit(path)
  }
  // Only the scan for ids that name no file of their own is capped.
  let budget = CLAUDE_SCAN_MAX
  for (const path of files) {
    if (pending.size === 0 || budget === 0) return
    if (visited.has(path)) continue
    budget -= 1
    await visit(path)
  }
}

async function readBoundedText(path: string, maxBytes: number): Promise<string | null> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > maxBytes) return null
    return await handle.readFile('utf8')
  } finally {
    await handle.close()
  }
}

function parseRow(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line)
    return isObject(value) ? value : null
  } catch {
    // A blank, partial, or corrupt index line is skipped; the remaining lines still answer.
    return null
  }
}

async function fromCodex(
  path: string, wanted: readonly string[], found: Map<string, TaskflowSessionTitle>,
): Promise<void> {
  const text = await readBoundedText(path, CODEX_INDEX_BYTES_MAX)
  if (text === null) return
  const wantedIds = new Set(wanted)
  const latest = new Map<string, { at: number; title: string }>()
  for (const line of text.split('\n')) {
    const row = parseRow(line)
    const id = row?.id
    const title = normalizeTitle(row?.thread_name)
    if (typeof id !== 'string' || title === null || !wantedIds.has(id)) continue
    const at = typeof row?.updated_at === 'string' ? Date.parse(row.updated_at) : Number.NaN
    const previous = latest.get(id)
    // A parsable timestamp outranks a missing or unparsable one; equal timestamps, and lines
    // that both lack one, fall back to file order: the later line wins.
    if (previous === undefined || Number.isNaN(previous.at) || (!Number.isNaN(at) && at >= previous.at)) {
      latest.set(id, { at, title })
    }
  }
  for (const [id, entry] of latest) {
    if (!found.has(id)) found.set(id, { tool: 'codex', title: entry.title })
  }
}

function fallbackTitle(value: unknown): TaskflowSessionTitle | null {
  if (!isObject(value) || Object.keys(value).some(field => !FALLBACK_ENTRY_FIELDS.has(field))) {
    return null
  }
  const title = normalizeTitle(value.title)
  const archived = value.archived
  if (title === null || !TOOLS.has(value.tool)
    || (archived !== undefined && typeof archived !== 'boolean')) return null
  return {
    tool: value.tool as TaskflowSessionTool,
    title,
    ...(archived === undefined ? {} : { archived }),
  }
}

async function fromFallback(
  path: string, wanted: readonly string[], found: Map<string, TaskflowSessionTitle>,
): Promise<void> {
  const text = await readBoundedText(path, FALLBACK_BYTES_MAX)
  if (text === null) return
  const value: unknown = JSON.parse(text)
  if (!isObject(value) || value.schemaVersion !== 1 || !isObject(value.titles)
    || Object.keys(value).some(field => !FALLBACK_ROOT_FIELDS.has(field))) return
  const titles = value.titles
  for (const id of wanted) {
    const title = !found.has(id) && Object.hasOwn(titles, id) ? fallbackTitle(titles[id]) : null
    if (title !== null) found.set(id, title)
  }
}

async function settle(lookup: () => Promise<void>): Promise<void> {
  try {
    await lookup()
  } catch {
    // A missing, unreadable, or malformed source contributes no titles; later sources still answer.
  }
}

/**
 * Resolve display titles for chat session ids. Sources answer in order (the
 * Claude desktop store, then the Codex index, then the fallback file), each
 * only for ids still unresolved, and a source is skipped once every id is
 * resolved. The Claude store lists at most 50,000 session files and skips
 * files over 2 MiB. A Claude desktop id (`local_<uuid>`) is read from its own
 * file first; any other unresolved id scans at most 2000 further files through
 * `memo`, stopping once every id resolves. The Codex index (at most 20 MiB)
 * keeps each id's entry with the latest parsable `updated_at`, which outranks
 * a missing or unparsable one; ties go to the later line. The fallback file
 * (at most 4 MiB) must match its schema exactly; invalid entries are ignored.
 * @param ids - requested ids; only the first 500 distinct ids of at most 256 characters are resolved.
 * @param sources - host-selected source locations.
 * @param memo - the caller's Claude session memo, updated in place.
 * @returns Titles keyed by requested id; ids that no source names are absent. Never rejects.
 */
export async function readSessionTitles(
  ids: readonly string[], sources: SessionTitleSources, memo: ClaudeSessionMemo,
): Promise<Record<string, TaskflowSessionTitle>> {
  const wanted = [...new Set(ids.filter(isSessionId))].slice(0, SESSION_TITLE_IDS_MAX)
  const found = new Map<string, TaskflowSessionTitle>()
  const lookups = [
    () => fromClaude(sources.claudeSessionsDir, wanted, found, memo),
    () => fromCodex(sources.codexIndexPath, wanted, found),
    () => fromFallback(sources.fallbackPath, wanted, found),
  ]
  for (const lookup of lookups) {
    if (wanted.every(id => found.has(id))) break
    await settle(lookup)
  }
  return Object.fromEntries(wanted.flatMap((id) => {
    const title = found.get(id)
    return title === undefined ? [] : [[id, title] as const]
  }))
}
