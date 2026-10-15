import type { AttentionEvent, NeedsYouItem } from './fold.ts'
import type { ReviewPlan, ReviewPlanItem, ReviewPlanOverride, ReviewPlanSource } from './reviewPlanTypes.ts'

export type { ReviewPlan, ReviewPlanItem, ReviewPlanOverride, ReviewPlanSource } from './reviewPlanTypes.ts'

type RecordValue = Record<string, unknown>

function object(value: unknown, fields: readonly string[]): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.keys(value).some(key => !fields.includes(key))) throw new Error('审阅计划包含无效对象或未知字段')
  return value as RecordValue
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('审阅计划缺少文字字段')
  return value
}

function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('审阅计划顺序必须为非负数字')
  return value
}

function timestamp(value: unknown): string {
  const result = text(value)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(result)
    || !Number.isFinite(Date.parse(result))) throw new Error('审阅计划时间必须为ISO时间')
  return result
}

function array<T>(value: unknown, parse: (entry: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error('审阅计划缺少列表字段')
  return value.map(parse)
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`审阅计划${label}重复`)
}

function item(value: unknown): ReviewPlanItem {
  const row = object(value, ['id', 'title', 'ref', 'threadId', 'order', 'lane', 'reason', 'after', 'debtEventIds', 'condition'])
  if (row.lane !== 'main' && row.lane !== 'parallel' && row.lane !== 'conditional') throw new Error('审阅计划lane无效')
  const result: ReviewPlanItem = {
    id: text(row.id), title: text(row.title), ref: text(row.ref), order: number(row.order),
    lane: row.lane, reason: text(row.reason), debtEventIds: array(row.debtEventIds, text),
    ...(row.threadId === undefined ? {} : { threadId: text(row.threadId) }),
    ...(row.condition === undefined ? {} : { condition: text(row.condition) }),
    ...(row.after === undefined ? {} : { after: array(row.after, text) }),
  }
  if (result.debtEventIds.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))) {
    throw new Error('审阅计划债务ID必须为规范UUID')
  }
  unique(result.debtEventIds, '债务ID')
  unique(result.after ?? [], '前项ID')
  return result
}

function override(value: unknown): ReviewPlanOverride {
  const row = object(value, ['itemId', 'order', 'ref', 'reason'])
  return { itemId: text(row.itemId), order: number(row.order), ref: text(row.ref), reason: text(row.reason) }
}

function source(value: unknown): ReviewPlanSource {
  const row = object(value, ['surface', 'threadId', 'latestMessageId', 'observedAt', 'reconciledMessageId', 'reconciledAt', 'pendingFromRef', 'pendingFromMessageId', 'reconciledRef', 'status', 'sourceRef'])
  if (row.status !== 'pending' && row.status !== 'fresh' && row.status !== 'unavailable') throw new Error('审阅计划来源状态无效')
  const result: ReviewPlanSource = {
    surface: text(row.surface), threadId: text(row.threadId), latestMessageId: text(row.latestMessageId),
    observedAt: timestamp(row.observedAt), status: row.status, sourceRef: text(row.sourceRef),
    ...(row.reconciledMessageId === undefined ? {} : { reconciledMessageId: text(row.reconciledMessageId) }),
    ...(row.reconciledAt === undefined ? {} : { reconciledAt: timestamp(row.reconciledAt) }),
    ...(row.pendingFromRef === undefined ? {} : { pendingFromRef: text(row.pendingFromRef) }),
    ...(row.pendingFromMessageId === undefined ? {} : { pendingFromMessageId: text(row.pendingFromMessageId) }),
    ...(row.reconciledRef === undefined ? {} : { reconciledRef: text(row.reconciledRef) }),
  }
  if (result.status === 'fresh' && (result.latestMessageId !== result.reconciledMessageId || result.reconciledAt === undefined)) {
    throw new Error('已核对来源必须记录同一消息及核对时间')
  }
  if (result.status === 'fresh' && (result.pendingFromRef !== undefined || result.pendingFromMessageId !== undefined)) {
    throw new Error('已核对来源不能保留待核对起点')
  }
  return result
}

/**
 * Parse a strict version-one plan and validate item references and dependency cycles.
 * @param value - Untrusted JSON value from a plan file.
 * @returns Validated metadata without derived completion state.
 */
export function parseReviewPlan(value: unknown): ReviewPlan {
  const row = object(value, ['schemaVersion', 'project', 'revision', 'updatedAt', 'basisRef', 'items', 'overrides', 'sources'])
  const revision = number(row.revision)
  if (row.schemaVersion !== 1 || !Number.isInteger(revision) || revision < 1) throw new Error('审阅计划版本无效')
  const plan: ReviewPlan = {
    schemaVersion: 1, project: text(row.project), revision,
    updatedAt: timestamp(row.updatedAt), basisRef: text(row.basisRef),
    items: array(row.items, item), overrides: array(row.overrides, override), sources: array(row.sources, source),
  }
  unique(plan.items.map(entry => entry.id), '条目ID')
  unique(plan.overrides.map(entry => entry.itemId), '覆盖项')
  unique(plan.sources.map(entry => `${entry.surface}\0${entry.threadId}`), '来源')
  const byId = new Map(plan.items.map(entry => [entry.id, entry]))
  for (const entry of plan.overrides) if (!byId.has(entry.itemId)) throw new Error('审阅计划覆盖项不存在')
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error('审阅计划前项存在循环')
    if (visited.has(id)) return
    const entry = byId.get(id)
    if (entry === undefined) throw new Error('审阅计划前项不存在')
    visiting.add(id)
    for (const previous of entry.after ?? []) visit(previous)
    visiting.delete(id)
    visited.add(id)
  }
  for (const entry of plan.items) visit(entry.id)
  return plan
}

/**
 * Apply explicit ordering overrides; `after` remains advisory, not an approval gate.
 * @param plan - Validated project plan.
 * @returns Items in effective order, with file order as the stable tie-break.
 */
export function orderedReviewItems(plan: ReviewPlan): ReviewPlanItem[] {
  const overrides = new Map(plan.overrides.map(entry => [entry.itemId, entry.order]))
  return [...plan.items].sort((a, b) => (overrides.get(a.id) ?? a.order) - (overrides.get(b.id) ?? b.order))
}

/**
 * Describe the exact ledger outcome of one referenced review event.
 * @param id - Referenced schema-v2 needs-you event ID.
 * @param events - Current complete ledger fold input.
 * @param debts - Current unresolved debts.
 * @returns Open, audited closure, explicit replacement, or missing/unresolved reference.
 */
export function reviewDebtStatus(id: string, events: readonly AttentionEvent[], debts: readonly NeedsYouItem[]): string {
  if (debts.some(debt => debt.eventId === id)) return '待审阅'
  const target = events.find(event => event.eventId === id && event.event === 'needs-you')
  if (target === undefined) return '待核对记录'
  const resolver = events.find(event => event.t >= target.t && event.project === target.project
    && event.task === target.task && event.schemaVersion === 2 && event.payload?.resolves_event_id === id
    && ((event.event === 'done' && event.surface === 'dsh' && event.payload.seal === true
      && typeof event.payload.confirmation_ref === 'string' && event.payload.confirmation_ref.trim() !== '')
      || (event.event === 'drop' && typeof event.payload.note === 'string' && /^superseded(?:\b|:)/i.test(event.payload.note))))
  return resolver?.event === 'done' ? '已收口' : resolver?.event === 'drop' ? '已替代，需核对新稿' : '待核对记录'
}
