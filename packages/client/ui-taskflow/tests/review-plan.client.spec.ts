import { describe, expect, it } from 'vitest'
import { parseReviewPlan, orderedReviewItems, reviewDebtStatus } from '../src/client/reviewPlan.ts'
import { buildModel, parseLedgerText } from '../src/client/fold.ts'

const ID = '123e4567-e89b-42d3-a456-426614174001'
const NOW = Date.parse('2026-10-15T04:00:00Z')

function fixture() {
  return {
    schemaVersion: 1, project: 'ARK', revision: 1, updatedAt: new Date(NOW).toISOString(), basisRef: '/ARK/review.md',
    items: [
      { id: 'roles', title: '核对角色', ref: '/ARK/roles.md', order: 1, lane: 'main', reason: '确认整体理解', debtEventIds: [ID] },
      { id: 'demo', title: '查看任务演示', ref: '/ARK/demo.html', order: 2, lane: 'main', reason: '检查任务过程', after: ['roles'], debtEventIds: [] },
    ], overrides: [], sources: [],
  }
}

function line(event: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ schema_version: 2, event_id: ID, event, ts: new Date(NOW - 1000).toISOString(), project: 'ARK', task: '核对', surface: 'codex', payload: { kind: 'review', ref: '/ARK/source.md' }, ...extra })
}

describe('review plan validation and ordering', () => {
  it('honors overrides without turning advisory predecessors into blocking gates', () => {
    const raw = fixture()
    const plan = parseReviewPlan({ ...raw, overrides: [{ itemId: 'demo', order: 0, ref: 'human:message', reason: '先看整体效果' }] })
    expect(orderedReviewItems(plan).map(item => item.id)).toEqual(['demo', 'roles'])
  })

  it.each([
    ['unknown field', (v: ReturnType<typeof fixture>) => ({ ...v, status: 'done' })],
    ['duplicate item', (v: ReturnType<typeof fixture>) => ({ ...v, items: [v.items[0], v.items[0]] })],
    ['cycle', (v: ReturnType<typeof fixture>) => ({ ...v, items: v.items.map(i => ({ ...i, after: [i.id === 'roles' ? 'demo' : 'roles'] })) })],
    ['missing predecessor', (v: ReturnType<typeof fixture>) => ({ ...v, items: [{ ...v.items[0], after: ['missing'] }] })],
    ['unknown override', (v: ReturnType<typeof fixture>) => ({ ...v, overrides: [{ itemId: 'missing', order: 0, reason: '用户指定', ref: 'human:message' }] })],
    ['invalid timestamp', (v: ReturnType<typeof fixture>) => ({ ...v, updatedAt: 'today' })],
    ['invalid debt id', (v: ReturnType<typeof fixture>) => ({ ...v, items: [{ ...v.items[0], debtEventIds: ['bad-id'] }] })],
    ['invalid lane', (v: ReturnType<typeof fixture>) => ({ ...v, items: [{ ...v.items[0], lane: 'blocked' }] })],
    ['false freshness', (v: ReturnType<typeof fixture>) => ({ ...v, sources: [{ surface: 'codex', threadId: 'chat', latestMessageId: 'new', observedAt: new Date(NOW).toISOString(), status: 'fresh', sourceRef: 'chat' }] })],
    ['empty title', (v: ReturnType<typeof fixture>) => ({ ...v, items: [{ ...v.items[0], title: ' ' }] })],
    ['negative order', (v: ReturnType<typeof fixture>) => ({ ...v, items: [{ ...v.items[0], order: -1 }] })],
    ['missing list', (v: ReturnType<typeof fixture>) => ({ ...v, items: null })],
    ['wrong schema version', (v: ReturnType<typeof fixture>) => ({ ...v, schemaVersion: 2 })],
    ['fractional revision', (v: ReturnType<typeof fixture>) => ({ ...v, revision: 1.5 })],
    ['zero revision', (v: ReturnType<typeof fixture>) => ({ ...v, revision: 0 })],
    ['invalid source state', (v: ReturnType<typeof fixture>) => ({ ...v, sources: [{ surface: 'codex', threadId: 'chat', latestMessageId: 'new', observedAt: new Date(NOW).toISOString(), status: 'done', sourceRef: 'chat' }] })],
    ['fresh without time', (v: ReturnType<typeof fixture>) => ({ ...v, sources: [{ surface: 'codex', threadId: 'chat', latestMessageId: 'new', observedAt: new Date(NOW).toISOString(), status: 'fresh', reconciledMessageId: 'new', sourceRef: 'chat' }] })],
    ['fresh retains pending message', (v: ReturnType<typeof fixture>) => ({ ...v, sources: [{ surface: 'codex', threadId: 'chat', latestMessageId: 'new', observedAt: new Date(NOW).toISOString(), status: 'fresh', reconciledMessageId: 'new', reconciledAt: new Date(NOW).toISOString(), pendingFromMessageId: 'new', sourceRef: 'chat' }] })],
  ])('rejects %s', (_label, change) => { expect(() => parseReviewPlan(change(fixture()))).toThrow() })

  it('keeps observation and reconciliation separate from plan save time', () => {
    const source = { surface: 'codex', threadId: 'chat', latestMessageId: 'new', observedAt: new Date(NOW).toISOString(), reconciledMessageId: 'old', reconciledAt: new Date(NOW - 1000).toISOString(), status: 'pending', sourceRef: 'chat' }
    expect(parseReviewPlan({ ...fixture(), sources: [source] }).sources[0]?.status).toBe('pending')
  })

  it('retains a pending start reference and clears it only in a reconciled source', () => {
    const pending = { surface: 'codex', threadId: 'chat', latestMessageId: 'newest', observedAt: new Date(NOW).toISOString(), status: 'pending', sourceRef: 'chat', pendingFromMessageId: 'first-new', pendingFromRef: 'chat:line-10', reconciledRef: 'chat:line-9' }
    expect(parseReviewPlan({ ...fixture(), sources: [pending] }).sources[0]?.pendingFromMessageId).toBe('first-new')
    expect(() => parseReviewPlan({ ...fixture(), sources: [{ ...pending, status: 'fresh', reconciledMessageId: 'newest', reconciledAt: new Date(NOW).toISOString() }] })).toThrow('待核对起点')
  })

  it('retains an optional chat and condition alongside a fully reconciled source', () => {
    const source = { surface: 'claude-code', threadId: 'chat', latestMessageId: 'new', observedAt: new Date(NOW).toISOString(), status: 'fresh', reconciledMessageId: 'new', reconciledAt: new Date(NOW).toISOString(), reconciledRef: 'chat:line-10', sourceRef: 'chat' }
    const plan = parseReviewPlan({ ...fixture(), items: [{ ...fixture().items[0], threadId: 'chat', condition: '选作首发演示时再看', lane: 'conditional', after: [] }], sources: [source] })
    expect(plan.items[0]).toMatchObject({ threadId: 'chat', condition: '选作首发演示时再看', lane: 'conditional' })
    expect(plan.sources[0]?.status).toBe('fresh')
  })
})

describe('exact review outcomes', () => {
  it('distinguishes ordinary done, human seal, replacement and missing identity', () => {
    const target = line('needs-you')
    for (const [payload, surface, status] of [
      [{}, 'codex', '待审阅'],
      [{ seal: true, resolves_event_id: ID, confirmation_ref: 'dsh-ui:seal-click' }, 'dsh', '已收口'],
      [{ note: 'superseded: revised draft', resolves_event_id: ID }, 'codex', '已替代，需核对新稿'],
    ] as const) {
      const event = 'note' in payload ? 'drop' : 'done'
      const events = parseLedgerText([target, line(event, { event_id: '123e4567-e89b-42d3-a456-426614174002', ts: new Date(NOW).toISOString(), surface, payload })].join('\n'))
      expect(reviewDebtStatus(ID, events, buildModel(events, NOW).needsYou)).toBe(status)
    }
    expect(reviewDebtStatus('missing', [], [])).toBe('待核对记录')
  })

  it('keeps a parked branch out of audited review outcomes', () => {
    const events = parseLedgerText(line('needs-you', { payload: { kind: 'park', ref: 'chat:branch' } }))
    const model = buildModel(events, NOW)
    expect(model.parked).toHaveLength(1)
    expect(reviewDebtStatus(ID, events, model.needsYou)).toBe('待核对记录')
  })
})
