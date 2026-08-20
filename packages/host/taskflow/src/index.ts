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
} from './ledger.ts'
import { formatSealLine, isNeedsYouOpenAt, parseLedger } from './seal.ts'
import type {
  TaskflowLedgerSnapshot,
  TaskflowSealRequest,
  TaskflowSealResult,
} from './types.ts'

const SEAL_CONFIRMATION_REF = 'dsh-ui:seal-click'

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

async function readLedger(): Promise<TaskflowLedgerSnapshot> {
  const override = process.env.DSH_TASKFLOW_LEDGER
  return override === undefined
    ? readMonthlyLedgers(ledgerDirectory())
    : readLedgerFile(override)
}

/** Remote-only service exposing the attention ledger to the TaskFlow surface. */
export class TaskflowLedgerGateway extends TypertRemoteService {
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
   * Seal (收口) one exact open debt, preferring its `event_id` and falling
   * back to `ts` only for a legacy target. The attention root's shared atomic
   * directory lock covers read-check-rotate-append, so concurrent processes
   * cannot append duplicate resolvers or write through a stale month alias.
   * @param request - the pinned debt identity plus the confirmation source.
   * @returns Business outcome; `sealed` false carries a machine reason.
   */
  @Remote('seal')
  async seal(request: TaskflowSealRequest): Promise<TaskflowSealResult> {
    if (!isSingleLineIdentity(request.project) || !isSingleLineIdentity(request.task)
      || typeof request.resolvesTs !== 'string' || typeof request.confirmationRef !== 'string'
      || request.task.length > 240
      || request.confirmationRef !== SEAL_CONFIRMATION_REF
      || (request.resolvesEventId === undefined && request.resolvesTs === '')
      || (request.resolvesEventId !== undefined
        && !isCanonicalUuid(request.resolvesEventId))) {
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
