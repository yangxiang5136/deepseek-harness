/**
 * Seal (收口) semantics over raw ledger text: pure functions the gateway's
 * I/O method wraps. A debt is open while a `needs-you` event has no terminal
 * `done`/`drop` for the same project+task at least {@link CLOSE_MS} later —
 * an AI's own wrap-up `done` seconds after filing the debt never counts as
 * the human's seal (spec §6 v3.0, decision ⑰).
 */

/** One parsed ledger line; unknown shapes are dropped by {@link parseLedger}. */
export interface LedgerEvent {
  /** ISO-8601 timestamp with offset (both `-04:00` and `-0400` appear). */
  ts: string
  /** Writing surface (claude-code | cowork | codex | dsh | …). */
  surface: string
  /** Loose task identity, half one: project name. */
  project: string
  /** Loose task identity, half two: task phrase. */
  task: string
  /** Protocol verb. */
  event: string
  /** Optional verb payload. */
  payload?: Record<string, unknown>
}

/** Minimum done-after-needs-you gap that counts as a human seal. */
export const CLOSE_MS = 60_000

/**
 * Parse JSONL ledger text, skipping broken or shapeless lines (spec §7: a
 * corrupt line never poisons the fold).
 * @param text - raw ledger file content.
 * @returns Parsed events in file order.
 */
export function parseLedger(text: string): LedgerEvent[] {
  const events: LedgerEvent[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let value: unknown
    try {
      value = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (typeof value !== 'object' || value === null) continue
    const record = value as Record<string, unknown>
    if (
      typeof record.ts !== 'string' || typeof record.surface !== 'string'
      || typeof record.project !== 'string' || typeof record.task !== 'string'
      || typeof record.event !== 'string'
    ) continue
    events.push(record as unknown as LedgerEvent)
  }
  return events
}

/**
 * Decide whether project+task still carries an open seal debt.
 * @param events - parsed ledger events in file order.
 * @param project - exact project string of the debt.
 * @param task - exact task phrase of the debt.
 * @returns True when some `needs-you` has no terminal event ≥ CLOSE_MS later.
 */
export function isNeedsYouOpen(events: LedgerEvent[], project: string, task: string): boolean {
  const mine = events.filter(e => e.project === project && e.task === task)
  const terminals = mine
    .filter(e => e.event === 'done' || e.event === 'drop')
    .map(e => Date.parse(e.ts))
    .filter(t => !Number.isNaN(t))
  return mine.some((e) => {
    if (e.event !== 'needs-you') return false
    const filed = Date.parse(e.ts)
    if (Number.isNaN(filed)) return false
    return !terminals.some(t => t - filed >= CLOSE_MS)
  })
}

/**
 * Decide whether one specific needs-you event (pinned by its `ts`) is open.
 * @param events - parsed ledger events in file order.
 * @param project - exact project string of the debt.
 * @param task - exact task phrase of the debt.
 * @param resolvesTs - the `ts` of the needs-you being resolved.
 * @returns True when that event exists and no terminal lands ≥ CLOSE_MS after it.
 */
export function isNeedsYouOpenAt(
  events: LedgerEvent[], project: string, task: string, resolvesTs: string,
): boolean {
  const mine = events.filter(e => e.project === project && e.task === task)
  const filedEvent = mine.find(e => e.event === 'needs-you' && e.ts === resolvesTs)
  if (filedEvent === undefined) return false
  const filed = Date.parse(filedEvent.ts)
  if (Number.isNaN(filed)) return false
  return !mine.some((e) => {
    if (e.event !== 'done' && e.event !== 'drop') return false
    const t = Date.parse(e.ts)
    return !Number.isNaN(t) && t - filed >= CLOSE_MS
  })
}

/** Audit trail the seal line carries in its payload. */
export interface SealAudit {
  /** The `ts` of the needs-you event this done resolves. */
  resolvesTs: string
  /** Reference to the explicit human confirmation authorizing the close. */
  confirmationRef: string
}

/**
 * Build the seal line to append: an att-compatible `done` event written by
 * the console surface with the seal audit trail in the payload.
 * @param project - project string copied from the debt.
 * @param task - task phrase copied from the debt.
 * @param now - wall-clock time of the human's seal action.
 * @param audit - what this done resolves and who confirmed it.
 * @returns One JSON line without trailing newline.
 */
export function formatSealLine(project: string, task: string, now: Date, audit: SealAudit): string {
  const offsetMinutes = -now.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const pad = (n: number): string => String(Math.trunc(Math.abs(n))).padStart(2, '0')
  const offset = `${sign}${pad(offsetMinutes / 60)}:${pad(offsetMinutes % 60)}`
  const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    + `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${offset}`
  return JSON.stringify({
    ts,
    surface: 'dsh',
    project,
    task,
    event: 'done',
    payload: { seal: true, resolves_ts: audit.resolvesTs, confirmation_ref: audit.confirmationRef },
  })
}
