/**
 * TaskFlow attention-ledger data plane. The bar's renderer (fold semantics,
 * spec §6 v3.0) lives entirely in the browser half; this host service stays a
 * thin file plane over the bus ledger so the fact source remains the bus
 * JSONL, never a host-side cache.
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import {
  acquireLedgerLock,
  appendLedgerLine,
  assertSafeLedgerAlias,
  ensureMonthlyLedger,
  isCanonicalUuid,
  readLedgerFile,
  readMonthlyLedgers,
  readTodoFiles,
} from './ledger.ts'
import { formatSealLine, isNeedsYouOpenAt, parseLedger } from './seal.ts'
import { readReviewPlanFiles, readReviewWatchStatus } from './review-plans.ts'
import { phaseConfirmationRef } from './confirmation.ts'
import { readMainlines, writeMainlines } from './mainlines.ts'
import { readSessionTitles, SESSION_TITLE_IDS_MAX, type ClaudeSessionMemo } from './sessionTitles.ts'
import type {
  TaskflowLedgerSnapshot,
  TaskflowMainlines,
  TaskflowMainlinesRequest,
  TaskflowMainlinesResult,
  TaskflowPhaseConfirmationRequest,
  TaskflowReviewPlanSnapshot,
  TaskflowSealRequest,
  TaskflowSealResult,
  TaskflowSessionTitlesRequest,
  TaskflowSessionTitlesResult,
  TaskflowTodoSnapshot,
} from './types.ts'

const SEAL_CONFIRMATION_REF = 'dsh-ui:seal-click'

/** Longest closing note a seal carries (matches the attention board's Note). */
export const SEAL_NOTE_MAX = 280

function isSingleLineIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
    && !value.includes('\0') && !value.includes('\r') && !value.includes('\n')
}

export type * from './types.ts'
export { formatSealLine, isNeedsYouOpen, isNeedsYouOpenAt, LEGACY_CLOSE_MS, parseLedger } from './seal.ts'
export type { LedgerEvent, SealAudit } from './seal.ts'

/**
 * Absolute ledger path: the bus symlink, followed on read. The env override
 * exists for tests and non-standard bus mounts, not as a product setting.
 * @returns Path the gateway reads and seals against.
 */
export function ledgerPath(): string {
  return process.env.DSH_TASKFLOW_LEDGER
    ?? join(attentionDirectory(), 'events.jsonl')
}

function ledgerDirectory(): string {
  return process.env.DSH_TASKFLOW_LEDGER === undefined
    ? attentionDirectory()
    : dirname(ledgerPath())
}

function attentionDirectory(): string {
  return process.env.DSH_TASKFLOW_ATTENTION_DIR
    ?? join(homedir(), 'my-memories', 'attention')
}

/**
 * Bus todo projects directory (`todo/projects/*.md`). The env override exists
 * for tests and non-standard bus mounts, like the ledger's.
 * @returns Directory the gateway reads todo files from.
 */
export function todoDirectory(): string {
  return process.env.DSH_TASKFLOW_TODO_DIR
    ?? join(homedir(), 'my-memories', 'todo', 'projects')
}

/**
 * Fixed project review-plan directory, overridable only by host environment.
 * @returns Absolute directory used by the read-only review-plan Remote call.
 */
export function reviewPlansDirectory(): string {
  return process.env.DSH_TASKFLOW_REVIEW_PLANS_DIR
    ?? join(homedir(), 'my-memories', 'attention', 'project-plans')
}

/**
 * Public watcher status path, separate from private source offsets and transcripts.
 * @returns Absolute host-selected JSON status path.
 */
export function reviewWatchStatusPath(): string {
  return process.env.DSH_TASKFLOW_REVIEW_WATCH_STATUS
    ?? join(homedir(), 'my-memories', 'attention', 'review-watch-status.json')
}

/**
 * The human's pinned mainlines, beside the ledger on the bus.
 * @returns Absolute path of the shared pins file.
 */
export function mainlinesPath(): string {
  return process.env.DSH_TASKFLOW_MAINLINES ?? join(attentionDirectory(), 'mainlines.json')
}

/**
 * Claude desktop session store read for session titles.
 * @returns `DSH_TASKFLOW_CLAUDE_SESSIONS_DIR`, or the desktop app's store under the home directory.
 */
export function claudeSessionsDirectory(): string {
  return process.env.DSH_TASKFLOW_CLAUDE_SESSIONS_DIR
    ?? join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions')
}

/**
 * Codex session index read for session titles.
 * @returns `DSH_TASKFLOW_CODEX_SESSION_INDEX`, or `~/.codex/session_index.jsonl`.
 */
export function codexSessionIndexPath(): string {
  return process.env.DSH_TASKFLOW_CODEX_SESSION_INDEX
    ?? join(homedir(), '.codex', 'session_index.jsonl')
}

/**
 * Fallback session-title file for hosts without the live chat stores.
 * @returns `DSH_TASKFLOW_SESSION_TITLES`, or `session-titles.json` beside the ledger.
 */
export function sessionTitlesPath(): string {
  return process.env.DSH_TASKFLOW_SESSION_TITLES
    ?? join(ledgerDirectory(), 'session-titles.json')
}

async function readLedger(): Promise<TaskflowLedgerSnapshot> {
  const override = process.env.DSH_TASKFLOW_LEDGER
  return override === undefined
    ? readMonthlyLedgers(ledgerDirectory())
    : readLedgerFile(override)
}

/** Remote-only service exposing the attention ledger to the TaskFlow surface. */
export class TaskflowLedgerGateway extends TypertRemoteService {
  private readonly claudeSessions: ClaudeSessionMemo = new Map()

  constructor(ctx: Context) {
    super(ctx, 'taskflow')
  }

  /**
   * Read every monthly production ledger in one shot, excluding the rotating
   * alias. `DSH_TASKFLOW_LEDGER` selects one exact file for tests and custom
   * mounts. A missing source is a legitimate empty state, not an error.
   * @returns Ledger text with read metadata; `exists` false only when missing.
   */
  @Remote('read')
  async read(): Promise<TaskflowLedgerSnapshot> {
    return readLedger()
  }

  /**
   * Read the bus todo project files raw; item extraction and the file →
   * project mapping live in the browser half with the rest of the fold.
   * @returns Todo file texts; `exists` false only when the directory is missing.
   */
  @Remote('todos')
  async todos(): Promise<TaskflowTodoSnapshot> {
    return readTodoFiles(todoDirectory())
  }

  /**
   * Read bounded JSON plan texts from the host-selected directory. The client
   * validates review-order semantics; this method has no path argument or writes.
   * @returns Raw plan texts; missing directory is explicit, other failures reject.
   */
  @Remote('reviewPlans')
  async reviewPlans(): Promise<TaskflowReviewPlanSnapshot> {
    const observer = await readReviewWatchStatus(reviewWatchStatusPath())
    return readReviewPlanFiles(reviewPlansDirectory(), observer)
  }

  /**
   * Read the pinned mainlines shared by every browser and readable by any AI.
   * @returns The validated pins; an absent file is the empty document.
   */
  @Remote('mainlines')
  async mainlines(): Promise<TaskflowMainlines> {
    return readMainlines(mainlinesPath())
  }

  /**
   * Replace one project's pinned mainlines after an explicit board gesture.
   * @param request - display project and its complete new list (at most three).
   * @returns Business outcome with the document as written.
   */
  @Remote('setMainlines')
  async setMainlines(request: TaskflowMainlinesRequest): Promise<TaskflowMainlinesResult> {
    return writeMainlines(mainlinesPath(), request)
  }

  /**
   * Look up display titles for the chat sessions that needs-you debts name in
   * `payload.session`. The host selects the sources; the caller supplies ids
   * only. Unreadable or malformed sources contribute no titles.
   * @param request - at most 500 nonempty session ids.
   * @returns Titles for the requested ids that a source names.
   */
  @Remote('sessionTitles')
  async sessionTitles(request: TaskflowSessionTitlesRequest): Promise<TaskflowSessionTitlesResult> {
    if (!Array.isArray(request.ids) || request.ids.length > SESSION_TITLE_IDS_MAX
      || !request.ids.every(id => typeof id === 'string' && id.trim() !== '')) {
      throw new Error('Invalid TaskFlow sessionTitles request')
    }
    const titles = await readSessionTitles(request.ids, {
      claudeSessionsDir: claudeSessionsDirectory(),
      codexIndexPath: codexSessionIndexPath(),
      fallbackPath: sessionTitlesPath(),
    }, this.claudeSessions)
    return { titles }
  }

  /**
   * Seal (收口) one exact open debt, preferring its `event_id` and falling
   * back to `ts` only for a legacy target. The attention root's shared atomic
   * directory lock covers read-check-rotate-append, so concurrent processes
   * cannot append duplicate resolvers or write through a stale month alias.
   * @param request - the pinned debt identity plus the confirmation source.
   * @returns Business outcome; `sealed` false carries a machine reason.
   */
  @Remote('seal')
  async seal(request: TaskflowSealRequest): Promise<TaskflowSealResult> {
    if (request.confirmationRef !== SEAL_CONFIRMATION_REF) {
      return { sealed: false, reason: 'invalid-request', line: null }
    }
    return this.sealExact(request)
  }

  /**
   * End one selected phase using a literal human message in a native Codex or Claude Code
   * transcript. Authentication checks the local source; callers interpret the statement's scope.
   * Both this entry and the click entry append through the same exact seal transaction.
   * @param request - exact debt plus native transcript location and human quotation.
   * @returns Seal outcome; invalid or injected confirmation sources write nothing.
   */
  @Remote('confirmPhase')
  async confirmPhase(request: TaskflowPhaseConfirmationRequest): Promise<TaskflowSealResult> {
    const confirmationRef = await phaseConfirmationRef(request, homedir())
    if (confirmationRef === null) return { sealed: false, reason: 'invalid-request', line: null }
    return this.sealExact({
      project: request.project,
      task: request.task,
      resolvesTs: request.resolvesTs,
      ...(request.resolvesEventId === undefined ? {} : { resolvesEventId: request.resolvesEventId }),
      confirmationRef,
      note: request.quote,
    })
  }

  private async sealExact(request: TaskflowSealRequest): Promise<TaskflowSealResult> {
    if (!isSingleLineIdentity(request.project) || !isSingleLineIdentity(request.task)
      || typeof request.resolvesTs !== 'string' || typeof request.confirmationRef !== 'string'
      || request.task.length > 240
      || (request.resolvesEventId === undefined && request.resolvesTs === '')
      || (request.resolvesEventId !== undefined
        && !isCanonicalUuid(request.resolvesEventId))
      || (request.note !== undefined && (!isSingleLineIdentity(request.note)
        || request.note.trim().length > SEAL_NOTE_MAX))) {
      return { sealed: false, reason: 'invalid-request', line: null }
    }
    const directory = ledgerDirectory()
    const release = await acquireLedgerLock(directory)
    if (release === null) return { sealed: false, reason: 'ledger-busy', line: null }
    try {
      await assertSafeLedgerAlias(directory)
      const now = new Date()
      const snapshot = await readLedger()
      if (!snapshot.exists) {
        return { sealed: false, reason: 'ledger-missing', line: null }
      }
      const open = isNeedsYouOpenAt(
        parseLedger(snapshot.text), request.project, request.task, request.resolvesTs,
        request.resolvesEventId,
      )
      if (!open) return { sealed: false, reason: 'no-open-needs-you', line: null }
      const line = formatSealLine(request.project, request.task, now, {
        resolvesTs: request.resolvesTs,
        ...(request.resolvesEventId === undefined
          ? {}
          : { resolvesEventId: request.resolvesEventId }),
        confirmationRef: request.confirmationRef,
        eventId: randomUUID(),
        ...(request.note === undefined ? {} : { note: request.note.trim() }),
      })
      const path = process.env.DSH_TASKFLOW_LEDGER
        ?? await ensureMonthlyLedger(directory, now)
      await appendLedgerLine(path, line)
      return { sealed: true, reason: null, line }
    } finally {
      await release()
    }
  }
}

export default TaskflowLedgerGateway
