/**
 * TaskFlow attention-ledger data plane. The bar's renderer (fold semantics,
 * spec §6 v3.0) lives entirely in the browser half; this host service stays a
 * thin file plane over the bus ledger so the fact source remains the bus
 * JSONL, never a host-side cache.
 */

import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import type { TaskflowLedgerSnapshot } from './types.ts'

export type * from './types.ts'

/** Absolute path of the attention ledger (bus symlink, followed on read). */
const LEDGER_PATH = join(homedir(), 'my-memories', 'attention', 'events.jsonl')

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
    try {
      const [text, info] = await Promise.all([
        readFile(LEDGER_PATH, 'utf8'),
        stat(LEDGER_PATH),
      ])
      return { path: LEDGER_PATH, exists: true, mtimeMs: info.mtimeMs, text }
    } catch {
      return { path: LEDGER_PATH, exists: false, mtimeMs: null, text: '' }
    }
  }
}

export default TaskflowLedgerGateway
