/** Bounded, read-only access to the host's project review-plan JSON files. */

import { constants, type Stats } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import type { TaskflowReviewObserver, TaskflowReviewPlanSnapshot } from './types.ts'

const MAX_PLAN_BYTES = 256 * 1024
const MAX_PLAN_FILES = 64
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024
const MAX_STATUS_BYTES = 4 * 1024
const SCAN_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function sameFile(first: Stats, second: Stats): boolean {
  return first.dev === second.dev && first.ino === second.ino
}

async function readJsonObject(
  path: string, before: Stats, maxBytes: number, label: string,
): Promise<{ text: string; value: Record<string, unknown> }> {
  if (!before.isFile()) throw new Error(`TaskFlow ${label} must be a regular file: ${path}`)
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || !sameFile(before, opened)) {
      throw new Error(`TaskFlow ${label} changed before reading: ${path}`)
    }
    if (opened.size > maxBytes) {
      throw new Error(`TaskFlow ${label} exceeds ${maxBytes} bytes: ${path}`)
    }
    const buffer = Buffer.alloc(maxBytes + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > maxBytes) {
      throw new Error(`TaskFlow ${label} exceeds ${maxBytes} bytes: ${path}`)
    }
    const after = await handle.stat()
    if (opened.size !== length || after.size !== length
      || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) {
      throw new Error(`TaskFlow ${label} changed while reading: ${path}`)
    }
    let text: string
    let value: unknown
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length))
      value = JSON.parse(text)
    } catch {
      // Parser diagnostics can contain private document text; expose only the file identity.
      throw new Error(`Invalid TaskFlow ${label} UTF-8 JSON: ${path}`)
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`TaskFlow ${label} must contain a JSON object: ${path}`)
    }
    return { text, value: value as Record<string, unknown> }
  } finally {
    await handle.close()
  }
}

function assertAbsolutePath(path: string): void {
  if (!isAbsolute(path) || path.includes('\0')) {
    throw new Error('TaskFlow review source must be an absolute path without NUL bytes')
  }
}

function isLabels(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 32
    && value.every(label => typeof label === 'string' && label.trim() !== ''
      && label.length <= 200 && !/[\0\r\n]/.test(label))
}

/**
 * Read only public watcher health fields from a fixed local JSON file.
 * @param path - absolute host-selected status file, separate from private source cursors.
 * @returns Validated health metadata, or null only when the file is missing.
 */
export async function readReviewWatchStatus(path: string): Promise<TaskflowReviewObserver | null> {
  assertAbsolutePath(path)
  let info: Stats
  try {
    info = await lstat(path)
  } catch (error: unknown) {
    if (isMissing(error)) return null
    throw error
  }
  const { value } = await readJsonObject(path, info, MAX_STATUS_BYTES, 'review watcher status')
  const { lastScanAt, lastErrorCount, coverage, excluded } = value
  if (!(lastScanAt === null || (typeof lastScanAt === 'string'
    && SCAN_TIMESTAMP.test(lastScanAt) && Number.isFinite(Date.parse(lastScanAt))))
    || !(lastErrorCount === null || (Number.isSafeInteger(lastErrorCount)
      && typeof lastErrorCount === 'number' && lastErrorCount >= 0))
    || !isLabels(coverage) || !isLabels(excluded)) {
    throw new Error(`Invalid TaskFlow review watcher health fields: ${path}`)
  }
  return { lastScanAt, lastErrorCount, coverage, excluded }
}

/**
 * Read top-level plan files from an absolute host-selected directory. Any unsafe,
 * malformed, oversized, or unreadable plan rejects the complete snapshot.
 * @param directory - fixed host configuration, never a caller-supplied path.
 * @param observer - validated public health metadata included in the response byte limit.
 * @returns Raw JSON objects in filename order; `exists: false` only for a missing directory.
 */
export async function readReviewPlanFiles(
  directory: string, observer: TaskflowReviewObserver | null = null,
): Promise<TaskflowReviewPlanSnapshot> {
  assertAbsolutePath(directory)
  let directoryInfo: Stats
  try {
    directoryInfo = await lstat(directory)
  } catch (error: unknown) {
    if (isMissing(error)) return { dir: directory, exists: false, files: [], observer }
    throw error
  }
  if (!directoryInfo.isDirectory()) {
    throw new Error(`TaskFlow review-plan directory must be a real directory: ${directory}`)
  }
  const names = (await readdir(directory)).filter(name => name.endsWith('.json')).sort()
  if (names.length > MAX_PLAN_FILES) {
    throw new Error(`TaskFlow review-plan directory exceeds ${MAX_PLAN_FILES} JSON files: ${directory}`)
  }
  const snapshot: TaskflowReviewPlanSnapshot = { dir: directory, exists: true, files: [], observer }
  let snapshotBytes = Buffer.byteLength(JSON.stringify(snapshot))
  for (const name of names) {
    if (basename(name) !== name || name.includes('\\') || name.includes('\0')) {
      throw new Error(`Unsafe TaskFlow review-plan file name in ${directory}`)
    }
    const path = join(directory, name)
    const { text } = await readJsonObject(path, await lstat(path), MAX_PLAN_BYTES, 'review plan')
    const file = { name, text }
    snapshotBytes += Buffer.byteLength(JSON.stringify(file)) + (snapshot.files.length === 0 ? 0 : 1)
    if (snapshotBytes > MAX_SNAPSHOT_BYTES) {
      throw new Error(`TaskFlow review-plan snapshot exceeds ${MAX_SNAPSHOT_BYTES} bytes: ${directory}`)
    }
    snapshot.files.push(file)
  }
  const after = await lstat(directory)
  if (!after.isDirectory() || !sameFile(directoryInfo, after)) {
    throw new Error(`TaskFlow review-plan directory changed while reading: ${directory}`)
  }
  return snapshot
}
