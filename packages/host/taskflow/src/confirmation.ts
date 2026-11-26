/**
 * Authenticate an exact human confirmation in a native local AI transcript.
 * Each confirmation surface contributes one adapter that fixes its transcript
 * layout and decides which records hold human-typed text; the shared check owns
 * path safety, record bounds, quotation matching, and the confirmation reference.
 */

import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { TextDecoder } from 'node:util'
import type {
  TaskflowClaudeCodePhaseConfirmation,
  TaskflowCodexPhaseConfirmation,
  TaskflowPhaseConfirmationBase,
  TaskflowPhaseConfirmationRequest,
} from './types.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MAX_RECORD_BYTES = 1024 * 1024

/** Reads the complete JSON object record that starts at a byte offset. */
type RecordReader = (offset: number) => Promise<Record<string, unknown> | undefined>

/** Transcript rules one confirmation surface contributes to the shared check. */
interface TranscriptAdapter {
  /** `confirmation_ref` prefix naming the surface and its human author. */
  readonly prefix: string
  /**
   * Accept the transcript's directory layout below the surface root.
   * @param segments - relative path segments, file name last.
   * @returns Whether the layout can hold a main human transcript.
   */
  layout(segments: readonly string[]): boolean
  /**
   * Accept the transcript file name for the cited conversation.
   * @param name - file name of the canonical transcript path.
   * @param conversationId - validated native conversation UUID.
   * @returns Whether the file belongs to that conversation.
   */
  named(name: string, conversationId: string): boolean
  /**
   * Extract human-typed text from the record at an offset already known to start a line.
   * @param read - bounded record reader over the opened transcript.
   * @param offset - byte offset of the cited record.
   * @param conversationId - validated native conversation UUID.
   * @returns Text the person typed, or null when the record is not a genuine human message.
   */
  humanText(read: RecordReader, offset: number, conversationId: string): Promise<string | null>
}

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

async function regularTranscript(path: string, root: string, adapter: TranscriptAdapter): Promise<boolean> {
  if (!isAbsolute(path) || resolve(path) !== path || !isAbsolute(root)) return false
  const child = relative(root, path)
  const segments = child.split(sep)
  if (child.startsWith('..') || isAbsolute(child) || !adapter.layout(segments)
    || !path.endsWith('.jsonl')) return false
  let cursor = root
  for (const segment of segments) {
    const info = await lstat(cursor)
    if (info.isSymbolicLink() || !info.isDirectory()) return false
    cursor = join(cursor, segment)
  }
  return await realpath(path) === path
}

/** Native Codex rollouts below `sessions/` or `archived_sessions/`, one interactive thread per file. */
const CODEX: TranscriptAdapter = {
  prefix: 'codex-user',
  layout: segments => segments.length >= 2
    && (segments[0] === 'sessions' || segments[0] === 'archived_sessions'),
  named: (name, threadId) => name.endsWith(`-${threadId}.jsonl`),
  async humanText(read, offset, threadId) {
    const first = await read(0)
    const meta = object(first?.payload)
    if (first?.type !== 'session_meta' || meta?.id !== threadId
      || !['vscode', 'cli'].includes(String(meta.source))
      || meta.thread_source !== 'user' || meta.parent_thread_id || meta.forked_from_id) return null
    const row = await read(offset)
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
    return /^(?:Automation:|<environment_context>|<INSTRUCTIONS>|# AGENTS\.md)/.test(text.trimStart())
      ? null
      : text
  },
}

/** Claude Code entry points whose native human records have been sampled; others fail closed. */
const CLAUDE_CODE_ENTRYPOINTS = new Set(['claude-desktop'])
/** Host-injected reminders the app places before the typed text of a human record. */
const LEADING_REMINDERS = /^\s*(?:<system-reminder>[\s\S]*?<\/system-reminder>\s*)+/
/** Wrappers for injected context, pasted material, shell runs, events, and command output. */
const INJECTED_TAGS = [
  'system-reminder', 'pasted_content', 'bash-input', 'bash-stdout', 'bash-stderr',
  'ci-monitor-event', 'task-notification', 'scheduled-task', 'side-sessions-event', 'cross-session-message',
  'command-name', 'command-message', 'command-args',
  'local-command-stdout', 'local-command-stderr', 'local-command-caveat',
]
const INJECTED_MARKUP = new RegExp(`</?(?:${INJECTED_TAGS.join('|')})\\b`)

function claudeCodeTypedText(text: string): string | null {
  const typed = text.replace(LEADING_REMINDERS, '')
  return /^\s*<[A-Za-z]/.test(typed) || INJECTED_MARKUP.test(typed) ? null : typed
}

function claudeCodeHumanRecord(row: Record<string, unknown>, sessionId: string): boolean {
  const origin = object(row.origin)
  return row.type === 'user' && row.sessionId === sessionId && row.isSidechain === false
    && origin?.kind === 'human' && Object.keys(origin).length === 1 && row.turnOrigin === 'human'
    && CLAUDE_CODE_ENTRYPOINTS.has(String(row.entrypoint))
    && [row.isMeta, row.isCompactSummary, row.isVisibleInTranscriptOnly]
      .every(flag => flag === undefined || flag === false)
}

/** Main Claude Code session transcripts at `<project-slug>/<sessionId>.jsonl`; subagent files nest deeper. */
const CLAUDE_CODE: TranscriptAdapter = {
  prefix: 'claude-code-user',
  layout: segments => segments.length === 2,
  named: (name, sessionId) => name === `${sessionId}.jsonl`,
  async humanText(read, offset, sessionId) {
    const row = await read(offset)
    if (row === undefined || !claudeCodeHumanRecord(row, sessionId)) return null
    const message = object(row.message)
    const content = message?.content
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content
    if (message?.role !== 'user' || !Array.isArray(blocks)) return null
    const typed: string[] = []
    for (const item of blocks) {
      const block = object(item)
      if (block?.type === 'text' && typeof block.text === 'string') {
        const text = claudeCodeTypedText(block.text)
        if (text !== null) typed.push(text)
      } else if (block?.type !== 'image' && block?.type !== 'document') {
        // Tool results and unfamiliar blocks mean the record is not a typed message.
        return null
      }
    }
    return typed.join('\n')
  },
}

async function confirmationRef(
  adapter: TranscriptAdapter,
  root: string,
  conversationId: string,
  request: TaskflowPhaseConfirmationBase,
): Promise<string | null> {
  if (!UUID.test(conversationId) || !Number.isSafeInteger(request.byteOffset)
    || request.byteOffset < 0 || typeof request.sourcePath !== 'string'
    || typeof request.quote !== 'string' || request.quote.trim() !== request.quote
    || request.quote.length === 0 || request.quote.length > 280
    || /[\0\r\n]/.test(request.quote)) return null
  try {
    if (!await regularTranscript(request.sourcePath, root, adapter)) return null
    if (!adapter.named(basename(request.sourcePath), conversationId)) return null
    const handle = await open(request.sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const before = await handle.stat()
      if (!before.isFile() || request.byteOffset >= before.size) return null
      if (request.byteOffset > 0) {
        const preceding = Buffer.alloc(1)
        await handle.read(preceding, 0, 1, request.byteOffset - 1)
        if (preceding[0] !== 10) return null
      }
      const text = await adapter.humanText(offset => recordAt(handle, offset), request.byteOffset, conversationId)
      if (text === null || !text.includes(request.quote)) return null
      const current = await lstat(request.sourcePath)
      if (current.isSymbolicLink() || current.ino !== before.ino || current.dev !== before.dev
        || await realpath(request.sourcePath) !== request.sourcePath) return null
      return `${adapter.prefix}:${conversationId}#byte=${request.byteOffset}`
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error
      && ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(String(error.code))) return null
    throw error
  }
}

/**
 * Verify the native Codex thread and exact literal user message without inferring task scope.
 * @param request - exact transcript location and a one-line verbatim quotation.
 * @param codexRoot - absolute host-owned Codex data root.
 * @returns `codex-user:<threadId>#byte=<offset>`, or null when the source does not authenticate.
 */
export async function codexConfirmationRef(
  request: TaskflowCodexPhaseConfirmation,
  codexRoot: string,
): Promise<string | null> {
  return confirmationRef(CODEX, codexRoot, request.threadId, request)
}

/**
 * Verify one human-typed record in a main Claude Code session transcript without inferring task scope.
 * @param request - exact transcript location and a one-line verbatim quotation.
 * @param projectsRoot - absolute host-owned Claude Code `projects` directory.
 * @returns `claude-code-user:<sessionId>#byte=<offset>`, or null when the source does not authenticate.
 */
export async function claudeCodeConfirmationRef(
  request: TaskflowClaudeCodePhaseConfirmation,
  projectsRoot: string,
): Promise<string | null> {
  return confirmationRef(CLAUDE_CODE, projectsRoot, request.sessionId, request)
}

/**
 * Authenticate a phase confirmation against the fixed transcript root of its surface.
 * The caller selects the debts covered by the human's statement. Roots derive from the
 * host's home directory, never from the Remote request; unknown or injected sources return null.
 * @param request - surface-specific transcript citation; an omitted surface is Codex.
 * @param home - absolute home directory of the host user.
 * @returns A durable source reference, or null when the source does not authenticate.
 */
export async function phaseConfirmationRef(
  request: TaskflowPhaseConfirmationRequest,
  home: string,
): Promise<string | null> {
  switch (request.surface) {
    case undefined:
    case 'codex':
      return codexConfirmationRef(request, join(home, '.codex'))
    case 'claude-code':
      return claudeCodeConfirmationRef(request, join(home, '.claude', 'projects'))
    default:
      // Wire input that bypasses the generated schema can name a surface without an adapter.
      return null
  }
}
