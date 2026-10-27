/** Authenticate an exact human confirmation in a native local Codex transcript. */

import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { TextDecoder } from 'node:util'
import type { TaskflowPhaseConfirmationRequest } from './types.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MAX_RECORD_BYTES = 1024 * 1024

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

async function recordAt(handle: FileHandle, offset: number): Promise<Record<string, unknown> | undefined> {
  const parts: Buffer[] = []
  let length = 0
  while (true) {
    const buffer = Buffer.alloc(Math.min(8192, MAX_RECORD_BYTES + 1 - length))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset + length)
    if (bytesRead === 0) return undefined
    const newline = buffer.subarray(0, bytesRead).indexOf(10)
    const retained = newline < 0 ? bytesRead : newline
    parts.push(buffer.subarray(0, retained))
    length += retained
    if (length > MAX_RECORD_BYTES) return undefined
    if (newline >= 0) {
      try {
        return object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))))
      } catch {
        // Invalid JSON and malformed UTF-8 do not authenticate a human message.
        return undefined
      }
    }
  }
}

async function regularTranscript(path: string, root: string): Promise<boolean> {
  if (!isAbsolute(path) || resolve(path) !== path || !isAbsolute(root)) return false
  const child = relative(root, path)
  const segments = child.split(sep)
  if (child.startsWith('..') || isAbsolute(child)
    || (segments[0] !== 'sessions' && segments[0] !== 'archived_sessions')
    || segments.length < 2 || !path.endsWith('.jsonl')) return false
  let cursor = root
  for (const segment of segments) {
    const info = await lstat(cursor)
    if (info.isSymbolicLink() || !info.isDirectory()) return false
    cursor = join(cursor, segment)
  }
  return await realpath(path) === path
}

/**
 * Verify the native thread and exact literal user message without inferring task scope.
 * The caller selects the debts covered by the human's statement. The root is selected
 * by the host, never by the Remote request; unknown or injected sources return null.
 * @param request - exact transcript location and a one-line verbatim quotation.
 * @param codexRoot - absolute host-owned Codex data root.
 * @returns A durable source reference, or null when the source does not authenticate.
 */
export async function codexConfirmationRef(
  request: TaskflowPhaseConfirmationRequest,
  codexRoot: string,
): Promise<string | null> {
  if (!UUID.test(request.threadId) || !Number.isSafeInteger(request.byteOffset)
    || request.byteOffset < 0 || typeof request.sourcePath !== 'string'
    || typeof request.quote !== 'string' || request.quote.trim() !== request.quote
    || request.quote.length === 0 || request.quote.length > 280
    || /[\0\r\n]/.test(request.quote)) return null
  try {
    if (!await regularTranscript(request.sourcePath, codexRoot)) return null
    if (!basename(request.sourcePath).endsWith(`-${request.threadId}.jsonl`)) return null
    const handle = await open(request.sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const before = await handle.stat()
      if (!before.isFile() || request.byteOffset >= before.size) return null
      if (request.byteOffset > 0) {
        const preceding = Buffer.alloc(1)
        await handle.read(preceding, 0, 1, request.byteOffset - 1)
        if (preceding[0] !== 10) return null
      }
      const first = await recordAt(handle, 0)
      const meta = object(first?.payload)
      if (first?.type !== 'session_meta' || meta?.id !== request.threadId
        || !['vscode', 'cli'].includes(String(meta.source))
        || meta.thread_source !== 'user' || meta.parent_thread_id || meta.forked_from_id) return null
      const row = await recordAt(handle, request.byteOffset)
      const body = object(row?.payload)
      const metadata = object(body?.internal_chat_message_metadata_passthrough)
      const kinds = metadata?.content_item_kinds
      if (row?.type !== 'response_item' || body?.role !== 'user'
        || !Array.isArray(kinds) || !kinds.includes('user.text')
        || !Array.isArray(body.content)) return null
      const text = body.content.map((item: unknown) => {
        const entry = object(item)
        return entry?.type === 'input_text' && typeof entry.text === 'string' ? entry.text : ''
      }).join('\n')
      if (/^(?:Automation:|<environment_context>|<INSTRUCTIONS>|# AGENTS\.md)/.test(text.trimStart())
        || !text.includes(request.quote)) return null
      const current = await lstat(request.sourcePath)
      if (current.isSymbolicLink() || current.ino !== before.ino || current.dev !== before.dev
        || await realpath(request.sourcePath) !== request.sourcePath) return null
      return `codex-user:${request.threadId}#byte=${request.byteOffset}`
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error
      && ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(String(error.code))) return null
    throw error
  }
}
