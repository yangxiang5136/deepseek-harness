/**
 * Seal (收口) semantics over raw ledger text: pure functions the gateway's
 * I/O method wraps. A debt closes only when a later resolver explicitly
 * targets that one `needs-you`: an audited `done` seal, or an exact `drop`
 * withdrawal. Ordinary task terminals never resolve human attention debt.
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
  /** Ledger schema generation; v2 debts require an exact resolver. */
  schema_version?: number
  /** Stable identity when the writer uses the current protocol. */
  event_id?: string
  /** Optional verb payload. */
  payload?: Record<string, unknown>
}

/** Legacy v1 terminal gap retained only while reading existing ledger data. */
export const LEGACY_CLOSE_MS = 60_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

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
    events.push({
      ts: record.ts,
      surface: record.surface,
      project: record.project,
      task: record.task,
      event: record.event,
      ...(typeof record.schema_version === 'number'
        ? { schema_version: record.schema_version }
        : {}),
      ...(typeof record.event_id === 'string' ? { event_id: record.event_id } : {}),
      ...(typeof record.payload === 'object' && record.payload !== null
        ? { payload: record.payload as Record<string, unknown> }
        : {}),
    })
  }
  return events
}

/**
 * Decide whether project+task still carries an open attention debt.
 * @param events - parsed ledger events in file order.
 * @param project - exact project string of the debt.
 * @param task - exact task phrase of the debt.
 * @returns True when some `needs-you` has no later exact resolver.
 */
export function isNeedsYouOpen(events: LedgerEvent[], project: string, task: string): boolean {
  const debts = events.filter(e => e.event === 'needs-you'
    && e.project === project && e.task === task)
  return debts.some(debt => !isDebtResolved(events, debt, debts))
}

/**
 * Decide whether one specific needs-you event (pinned by its `ts`) is open.
 * @param events - parsed ledger events in file order.
 * @param project - exact project string of the debt.
 * @param task - exact task phrase of the debt.
 * @param resolvesTs - the `ts` fallback for a legacy needs-you.
 * @param resolvesEventId - exact target identity when it has `event_id`.
 * @returns True when one unambiguous target exists and has no later exact resolver.
 */
export function isNeedsYouOpenAt(
  events: LedgerEvent[], project: string, task: string, resolvesTs: string,
  resolvesEventId?: string,
): boolean {
  const debts = events.filter(e => e.event === 'needs-you'
    && e.project === project && e.task === task)
  const targets = debts.filter((event) => {
    if (resolvesEventId !== undefined) return event.event_id === resolvesEventId
    return event.event_id === undefined && event.ts === resolvesTs
  })
  const target = targets[0]
  return targets.length === 1 && target !== undefined && !isDebtResolved(events, target, debts)
}

function debtKey(event: LedgerEvent): string {
  return event.event_id === undefined
    ? `legacy\u0000${event.project}\u0000${event.task}\u0000${event.ts}`
    : `id\u0000${event.project}\u0000${event.task}\u0000${event.event_id}`
}

function resolvesDebt(resolver: LedgerEvent, debt: LedgerEvent): boolean {
  if (resolver.project !== debt.project || resolver.task !== debt.task) return false
  if (resolver.schema_version !== 2 || resolver.event_id === undefined
    || !UUID.test(resolver.event_id)) return false
  const payload = resolver.payload
  if (payload === undefined) return false
  if (resolver.event === 'done') {
    if (resolver.surface !== 'dsh') return false
    if (payload.seal !== true) return false
    if (typeof payload.confirmation_ref !== 'string' || payload.confirmation_ref.trim() === '') {
      return false
    }
  } else if (resolver.event === 'drop') {
    if (typeof payload.note !== 'string' || !/^superseded(?:\b|:)/i.test(payload.note)) return false
  } else {
    return false
  }
  if (debt.event_id !== undefined) return payload.resolves_event_id === debt.event_id
  return payload.resolves_event_id === undefined && payload.resolves_ts === debt.ts
}

function referencesDebt(resolver: LedgerEvent, debt: LedgerEvent): boolean {
  if (resolver.project !== debt.project || resolver.task !== debt.task) return false
  if (resolver.event !== 'done' && resolver.event !== 'drop') return false
  if (debt.event_id !== undefined) return resolver.payload?.resolves_event_id === debt.event_id
  return resolver.payload?.resolves_event_id === undefined && resolver.payload?.resolves_ts === debt.ts
}

function isDebtResolved(
  events: LedgerEvent[], debt: LedgerEvent, siblingDebts: LedgerEvent[],
): boolean {
  const debtIndex = events.indexOf(debt)
  const later = events.slice(debtIndex + 1)
  const unambiguous = siblingDebts.filter(other => debtKey(other) === debtKey(debt)).length === 1
  const explicit = later.filter(event => referencesDebt(event, debt))
  if (unambiguous && explicit.some(event => resolvesDebt(event, debt))) return true
  if (debt.schema_version === 2) return false
  if (!unambiguous) return false
  const filed = Date.parse(debt.ts)
  if (Number.isNaN(filed)) return false
  return later.some((event) => {
    if (event.project !== debt.project || event.task !== debt.task) return false
    if (event.event !== 'done' && event.event !== 'drop') return false
    if (event.schema_version === 2) return false
    const terminal = Date.parse(event.ts)
    return !Number.isNaN(terminal) && terminal - filed >= LEGACY_CLOSE_MS
  })
}

/** Audit trail the seal line carries in its payload. */
export interface SealAudit {
  /** The `ts` of the needs-you event this done resolves. */
  resolvesTs: string
  /** The target's `event_id`; omitted only for a legacy target. */
  resolvesEventId?: string
  /** Reference to the explicit human confirmation authorizing the close. */
  confirmationRef: string
  /** Stable identity assigned to the appended seal event. */
  eventId: string
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
  const payload: Record<string, unknown> = {
    seal: true,
    confirmation_ref: audit.confirmationRef,
  }
  if (audit.resolvesEventId === undefined) payload.resolves_ts = audit.resolvesTs
  else payload.resolves_event_id = audit.resolvesEventId
  return JSON.stringify({
    schema_version: 2,
    ts,
    surface: 'dsh',
    project,
    task,
    event: 'done',
    event_id: audit.eventId,
    payload,
  })
}
