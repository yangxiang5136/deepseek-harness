/**
 * The human's pinned mainlines, one small JSON file on the bus. The browser
 * half used to keep pins in localStorage, where no AI and no second browser
 * could read them; this file is the shared copy. Only an explicit board
 * gesture writes it, and the write replaces one project's list atomically.
 */

import { randomUUID } from 'node:crypto'
import { open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { TaskflowMainline, TaskflowMainlines, TaskflowMainlinesRequest, TaskflowMainlinesResult } from './types.ts'

/** Most mainlines one project may pin; more than this stops being a ranking. */
export const MAINLINES_PER_PROJECT = 3

/** Longest direction sentence (one line, like a seal note). */
export const MAINLINE_DIRECTION_MAX = 280

const MAX_BYTES = 64 * 1024
const MAX_PROJECTS = 64

function isLine(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max && !/[\0\r\n]/.test(value)
}

function isMainline(value: unknown): value is TaskflowMainline {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  if (Object.keys(row).some(key => !['task', 'direction', 'directionBy'].includes(key))) return false
  if (!isLine(row.task, 240)) return false
  if ((row.direction === undefined) !== (row.directionBy === undefined)) return false
  return row.direction === undefined
    || (isLine(row.direction, MAINLINE_DIRECTION_MAX) && (row.directionBy === 'ai' || row.directionBy === 'human'))
}

function isList(value: unknown): value is TaskflowMainline[] {
  return Array.isArray(value) && value.length <= MAINLINES_PER_PROJECT && value.every(isMainline)
    && new Set(value.map(entry => entry.task)).size === value.length
}

/**
 * Validate a parsed mainlines document.
 * @param value - untrusted JSON value.
 * @returns The document when every project list is well formed, else null.
 */
export function parseMainlines(value: unknown): TaskflowMainlines | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const doc = value as Record<string, unknown>
  if (doc.schemaVersion !== 1 || Object.keys(doc).some(key => key !== 'schemaVersion' && key !== 'projects')) return null
  const projects = doc.projects
  if (typeof projects !== 'object' || projects === null || Array.isArray(projects)) return null
  const entries = Object.entries(projects)
  if (entries.length > MAX_PROJECTS || !entries.every(([name, list]) => isLine(name, 120) && isList(list))) return null
  return { schemaVersion: 1, projects: projects as Record<string, TaskflowMainline[]> }
}

/**
 * Read the pinned mainlines. A missing file is the empty state; an unreadable
 * or malformed one rejects so the board shows the failure instead of "no pins".
 * @param path - absolute host-selected file.
 * @returns The validated document.
 */
export async function readMainlines(path: string): Promise<TaskflowMainlines> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { schemaVersion: 1, projects: {} }
    throw error
  }
  let value: unknown
  try {
    value = Buffer.byteLength(text) > MAX_BYTES ? null : JSON.parse(text)
  } catch {
    value = null
  }
  const parsed = parseMainlines(value)
  if (parsed === null) throw new Error(`Invalid TaskFlow mainlines file: ${path}`)
  return parsed
}

/**
 * Replace one project's pinned mainlines. An empty list removes the project.
 * The file is rewritten through a sibling temp file and an atomic rename.
 * @param path - absolute host-selected file.
 * @param request - display project plus its complete new list.
 * @returns Business outcome; a malformed request writes nothing.
 */
export async function writeMainlines(path: string, request: TaskflowMainlinesRequest): Promise<TaskflowMainlinesResult> {
  if (!isLine(request.project, 120) || !isList(request.mainlines)) {
    return { saved: false, reason: 'invalid-request', mainlines: null }
  }
  const current = await readMainlines(path)
  const projects = Object.fromEntries(Object.entries(current.projects).filter(([name]) => name !== request.project))
  if (request.mainlines.length > 0) projects[request.project] = request.mainlines
  if (Object.keys(projects).length > MAX_PROJECTS) return { saved: false, reason: 'invalid-request', mainlines: null }
  const next: TaskflowMainlines = { schemaVersion: 1, projects }
  const temp = join(dirname(path), `.mainlines-${randomUUID()}.tmp`)
  try {
    const handle = await open(temp, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, path)
  } catch (error: unknown) {
    await rm(temp, { force: true })
    throw error
  }
  return { saved: true, reason: null, mainlines: next }
}
