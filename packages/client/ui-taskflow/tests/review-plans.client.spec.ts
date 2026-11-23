import { describe, expect, it, vi } from 'vitest'
import { createReviewPlans, type ReviewPlanFiles } from '../src/client/reviewPlans.ts'

const plan = (revision: number) => ({ schemaVersion: 1, project: 'ARK', revision, updatedAt: '2026-10-15T04:00:00Z', basisRef: 'ARK.md', items: [], overrides: [], sources: [] })
const snapshot = (text: string): ReviewPlanFiles => ({ dir: '/reviews', exists: true, observer: null, files: [{ name: 'ARK.json', text }] })
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

describe('review plans observable', () => {
  it('preserves good plans on read and validation failures, then accepts a new revision', async () => {
    const read = vi.fn<() => Promise<ReviewPlanFiles>>()
      .mockResolvedValueOnce(snapshot(JSON.stringify(plan(1))))
      .mockResolvedValueOnce(snapshot('{broken'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(snapshot(JSON.stringify(plan(2))))
    const source = createReviewPlans(read)
    const notify = vi.fn()
    const unsubscribe = source.subscribe(notify)
    source.refresh(); source.refresh(); await flush()
    expect(read).toHaveBeenCalledTimes(1)
    expect(source.getSnapshot().plans[0]?.revision).toBe(1)
    source.refresh(); await flush()
    expect(source.getSnapshot().error).toContain('ARK.json')
    expect(source.getSnapshot().plans[0]?.revision).toBe(1)
    source.refresh(); await flush()
    expect(source.getSnapshot().error).toBe('offline')
    source.refresh(); await flush()
    expect(source.getSnapshot().plans[0]?.revision).toBe(2)
    expect(source.getSnapshot().error).toBeUndefined()
    unsubscribe()
    expect(notify).toHaveBeenCalledTimes(4)
  })

  it('discards a late response across reset and rejects duplicate project plans', async () => {
    let answer!: (value: ReviewPlanFiles) => void
    const read = vi.fn<() => Promise<ReviewPlanFiles>>()
      .mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
      .mockResolvedValueOnce(snapshot(JSON.stringify(plan(2))))
      .mockResolvedValueOnce({ dir: '/reviews', exists: true, observer: null, files: ['a', 'b'].map(name => ({ name, text: JSON.stringify(plan(3)) })) })
    const source = createReviewPlans(read)
    source.refresh(); source.reset(); source.refresh(); await flush()
    answer(snapshot(JSON.stringify(plan(1)))); await flush()
    expect(source.getSnapshot().plans[0]?.revision).toBe(2)
    source.refresh(); await flush()
    expect(source.getSnapshot().error).toContain('多个审阅计划')
    expect(source.getSnapshot().plans[0]?.revision).toBe(2)
  })

  it('ignores a late failure after reset and presents non-Error transport failures without discarding good data', async () => {
    let fail!: (reason: unknown) => void
    const read = vi.fn<() => Promise<ReviewPlanFiles>>()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
      .mockResolvedValueOnce(snapshot(JSON.stringify(plan(2))))
      .mockRejectedValueOnce('connection lost')
    const source = createReviewPlans(read)
    source.refresh(); source.reset(); source.refresh(); await flush()
    fail(new Error('old connection failed')); await flush()
    expect(source.getSnapshot().plans[0]?.revision).toBe(2)
    expect(source.getSnapshot().error).toBeUndefined()
    source.refresh(); await flush()
    expect(source.getSnapshot().error).toBe('审阅计划读取失败')
    expect(source.getSnapshot().plans[0]?.revision).toBe(2)
  })
})
