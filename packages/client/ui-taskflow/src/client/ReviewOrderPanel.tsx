import { useState, type ReactElement } from 'react'
import { displayProject, type AttentionEvent, type NeedsYouItem } from './fold.ts'
import { orderedReviewItems, reviewDebtStatus, type ReviewPlan as Plan, type ReviewPlanItem } from './reviewPlan.ts'
import type { ReviewPlansState } from './reviewPlans.ts'
import { doCopy, type CopyState } from './interaction.ts'
import css from './ProjectPanel.module.css'

const LANES = { main: '主线', parallel: '可并行', conditional: '按需' } as const
const SOURCES = { pending: '有新信息待核对', fresh: '已核对到该消息', unavailable: '来源暂不可读' } as const

function sourceLabel(value: string): string {
  const label = value.toLowerCase()
  if (label.includes('codex')) return 'Codex'
  if (label.includes('cowork')) return 'Cowork'
  if (label.includes('claude') && (label.includes('code') || label.includes('local'))) return 'Claude Code'
  if (label.includes('cloud') || label.includes('云')) return '云聊天'
  return '其他来源'
}

/** Review order over exact ledger identities, independent of the project's task aggregation. */
export interface ReviewPlanProps {
  project: string
  state: ReviewPlansState
  events: readonly AttentionEvent[]
  debts: readonly NeedsYouItem[]
  onOpenDebt: (debt: NeedsYouItem) => void
}

type PlanRowsProps = Omit<ReviewPlanProps, 'project' | 'state'> & { plan: Plan }

function ReviewItem({ plan, item, events, debts, onOpenDebt }: PlanRowsProps & { item: ReviewPlanItem }): ReactElement {
  const [copied, setCopied] = useState<CopyState | null>(null)
  const override = plan.overrides.find(entry => entry.itemId === item.id)
  const after = item.after
  const titlesById = new Map(plan.items.map(entry => [entry.id, entry.title]))
  return (
    <li data-review-item={item.id} aria-label={`审阅事项 ${item.title}`} className={css.reviewItem}>
      <div className={css.name}>{item.title}<span className={css.reviewLane}>{LANES[item.lane]}</span></div>
      <div className={css.muted}>{override?.reason ?? item.reason}</div>
      {after !== undefined && after.length > 0 && <div className={css.muted}>{`建议先看：${after.map(id => titlesById.get(id)).join('、')}`}</div>}
      {item.condition !== undefined && <div className={css.muted}>{item.condition}</div>}
      <div className={css.reviewAction}>
        <button type="button" className={css.btn} onClick={() => { doCopy(item.ref, setCopied) }}>{copied === 'done' ? '已复制入口' : '复制审阅入口'}</button>
        {item.debtEventIds.length === 0 && <span className={css.muted}>尚未关联待审记录</span>}
      </div>
      {item.debtEventIds.map((id) => {
        const debt = debts.find(entry => entry.eventId === id)
        const status = reviewDebtStatus(id, events, debts)
        return (
          <div key={id} className={css.reviewAction}>
            <span className={css.muted}>{status === '已收口' ? '相关待审已收口' : status}</span>
            {debt !== undefined && <button type="button" className={css.btn} aria-label={`查看待审记录 ${item.title} ${id}`} onClick={() => { onOpenDebt(debt) }}>查看待审记录</button>}
          </div>
        )
      })}
      <details className={css.reviewSource} open={copied === 'manual' ? true : undefined}>
        <summary>查看依据与入口</summary>
        <div className={css.reviewRef}>{item.ref}</div>
        {override !== undefined && <div className={css.reviewRef}>{`排序依据：${override.ref}`}</div>}
        {copied === 'manual' && <div className={css.error}>复制失败，请手动选中入口</div>}
      </details>
    </li>
  )
}

function PlanRows(props: PlanRowsProps): ReactElement {
  const { plan } = props
  const ordered = orderedReviewItems(plan)
  const main = ordered.filter(item => item.lane !== 'parallel')
  const parallel = ordered.filter(item => item.lane === 'parallel')
  return (
    <>
      <ol className={css.reviewList} aria-label="建议顺序">
        {main.map(item => <ReviewItem key={item.id} {...props} item={item} />)}
      </ol>
      {parallel.length > 0 && <>
        <div className={css.section}>可并行</div>
        <ul className={css.reviewList} aria-label="可并行审阅">
          {parallel.map(item => <ReviewItem key={item.id} {...props} item={item} />)}
        </ul>
      </>}
      <details className={css.reviewSource}>
        <summary>{`信息来源 · ${plan.sources.some(source => source.status === 'pending') ? '有新信息待核对' : plan.sources.length === 0 ? '未接入' : '查看核对范围'}`}</summary>
        <div className={css.reviewRef}>{`第 ${plan.revision} 版 · 保存于 ${plan.updatedAt}`}</div>
        <div className={css.reviewRef}>{`依据：${plan.basisRef}`}</div>
        {plan.sources.length === 0 && <div className={css.muted}>未接入信息来源</div>}
        {plan.sources.map(source => (
          <details key={`${source.surface}\0${source.threadId}`} className={css.reviewSource}>
            <summary>{`${sourceLabel(source.surface)} · ${SOURCES[source.status]}`}</summary>
            <div className={css.reviewRef}>{`来源：${source.sourceRef}`}</div>
            {source.pendingFromRef !== undefined && <div className={css.reviewRef}>{`待核对起点：${source.pendingFromRef}`}</div>}
            {source.reconciledRef !== undefined && <div className={css.reviewRef}>{`核对依据：${source.reconciledRef}`}</div>}
            <div className={css.reviewRef}>{`观察到：${source.latestMessageId} · ${source.observedAt}`}</div>
            {source.reconciledMessageId !== undefined && <div className={css.reviewRef}>{`已核对：${source.reconciledMessageId} · ${source.reconciledAt ?? '未记录时间'}`}</div>}
          </details>
        ))}
      </details>
    </>
  )
}

/**
 * Render the selected project's saved plan and explicitly observed source freshness.
 * @param props - Current plan read, complete ledger and exact debt opener.
 * @returns Ordering guidance; reviews close only through the exact debt card.
 */
export function ReviewPlan({ project, state, events, debts, onOpenDebt }: ReviewPlanProps): ReactElement {
  const plan = state.plans.find(entry => displayProject(entry.project) === project)
  return (
    <section className={css.reviewPlan} aria-label={`${project} 审阅顺序`}>
      <div className={css.section}>建议审阅顺序</div>
      <div className={css.muted}>{state.observer === null
        ? '信息监听未接入'
        : state.observer.lastErrorCount !== null && state.observer.lastErrorCount > 0
          ? '来源检查出错'
          : state.observer.lastScanAt === null || !Number.isFinite(Date.parse(state.observer.lastScanAt))
            || Date.now() - Date.parse(state.observer.lastScanAt) > 30_000
            ? '监听可能中断'
            : `本机 ${[...new Set(state.observer.coverage.map(sourceLabel))].join(' / ')} · 3秒检查`}</div>
      {(state.observer === null || state.observer.excluded.length > 0) && <div className={css.muted}>{state.observer === null ? '云聊天 / Cowork 未接入' : `${[...new Set(state.observer.excluded.map(sourceLabel))].join(' / ')} 未接入`}</div>}
      {state.error !== undefined && <div role="status" className={css.error}>{`审阅计划读取失败：${state.error}`}</div>}
      {!state.read && state.error === undefined && <div className={css.muted}>读取中…</div>}
      {state.read && plan === undefined && <div className={css.muted}>尚未设置审阅顺序</div>}
      {plan !== undefined && <PlanRows plan={plan} events={events} debts={debts} onOpenDebt={onOpenDebt} />}
    </section>
  )
}
