/**
 * TaskFlow attention-ledger data plane. The bar's renderer (fold semantics,
 * spec §6 v3.0) lives entirely in the browser half; this host service stays a
 * thin file plane over the bus ledger so the fact source remains the bus
 * JSONL, never a host-side cache.
 */

import { appendFile, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import { formatSealLine, isNeedsYouOpen, parseLedger } from './seal.ts'
import type {
  TaskflowLedgerSnapshot,
  TaskflowSealRequest,
  TaskflowSealResult,
} from './types.ts'

export type * from './types.ts'
export { CLOSE_MS, formatSealLine, isNeedsYouOpen, parseLedger } from './seal.ts'
export type { LedgerEvent } from './seal.ts'

/**
 * Absolute ledger path: the bus symlink, followed on read. The env override
 * exists for tests and non-standard bus mounts, not as a product setting.
 * @returns Path the gateway reads and seals against.
 */
export function ledgerPath(): string {
  return process.env.DSH_TASKFLOW_LEDGER
    ?? join(homedir(), 'my-memories', 'attention', 'events.jsonl')
}

/** Remote-only service exposing the attention ledger to the TaskFlow surface. */
export class TaskflowLedgerGateway extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'taskflow')
  }

  /**
   * Read the whole ledger in one shot. The client polls this and folds; a
   * missing file is a legitimate empty state, not an error.
   * @returns Ledger text with read metadata; `exists` false when unreadable.
   */
  @Remote('read')
  async read(): Promise<TaskflowLedgerSnapshot> {
    const path = ledgerPath()
    try {
      const [text, info] = await Promise.all([readFile(path, 'utf8'), stat(path)])
      return { path, exists: true, mtimeMs: info.mtimeMs, text }
    } catch {
      return { path, exists: false, mtimeMs: null, text: '' }
    }
  }

  /**
   * Seal (收口) an open debt: validate a live `needs-you` for project+task,
   * then append the human-authorized `done` line. Validation re-reads the
   * ledger at call time so a debt sealed from another surface in the last
   * poll interval is refused rather than double-closed.
   * @param request - the debt's loose ledger identity.
   * @returns Business outcome; `sealed` false carries a machine reason.
   */
  @Remote('seal')
  async seal(request: TaskflowSealRequest): Promise<TaskflowSealResult> {
    const path = ledgerPath()
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch {
      return { sealed: false, reason: 'ledger-missing', line: null }
    }
    if (!isNeedsYouOpen(parseLedger(text), request.project, request.task)) {
      return { sealed: false, reason: 'no-open-needs-you', line: null }
    }
    const line = formatSealLine(request.project, request.task, new Date())
    await appendFile(path, `${line}\n`, 'utf8')
    return { sealed: true, reason: null, line }
  }
}

export default TaskflowLedgerGateway
