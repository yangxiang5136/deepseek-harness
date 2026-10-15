import type { ReactElement } from 'react'
import { displayProject, type AttentionEvent, type NeedsYouItem } from './fold.ts'
import { reviewChats, reviewDebtStatus, type ReviewPlan as Plan, type ReviewChat } from './reviewPlan.ts'
import type { ReviewPlansState } from './reviewPlans.ts'
import css from './ProjectPanel.module.css'

const SOURCES = { pending: '有新信息待核对', fresh: '已核对到该消息', unavailable: '来源暂不可读' } as const

function sourceLabel(value: string): string {
  const label = value.toLowerCase()
  if (label.includes('codex')) return 'Codex'
  if (label.includes('cowork')) return 'Cowork'
  if (label.includes('claude') && (label.includes('code') || label.includes('local'))) return 'Claude Code'
  if (label.includes('cloud') || label.includes('云')) return '云聊天'
  return '其他来源'
}

/** Read-only chat order over exact ledger identities. */
export interface ReviewPlanProps {
  project: string
  state: ReviewPlansState
  events: readonly AttentionEvent[]
  debts: readonly NeedsYouItem[]
}

type PlanRowsProps = Omit<ReviewPlanProps, 'project'> & { plan: Plan }

function chatStatus(chat: ReviewChat, events: readonly AttentionEvent[], debts: readonly NeedsYouItem[]): string | null {
  if (chat.debtEventIds.length === 0) return null
  const states = chat.debtEventIds.map(id => reviewDebtStatus(id, events, debts))
  if (states.includes('待审阅')) return '待审阅'
  if (states.includes('已替代，需核对新稿')) return '待核对新稿'
  if (states.includes('待核对记录')) return '待核对记录'
  return '相关待审已收口'
}

function ChatRow({ chat, events, debts }: Pick<ReviewPlanProps, 'events' | 'debts'> & { chat: ReviewChat }): ReactElement {
  const status = chatStatus(chat, events, debts)
  return (
    <li data-review-chat={chat.key} data-review-thread={chat.threadId} aria-label={`审阅聊天 ${chat.title}`} className={css.reviewItem}>
      <span className={css.name}>{chat.title}</span>
      {status !== null && <span className={css.reviewStatus}>{status}</span>}
    </li>
  )
}

function observerHealth(state: ReviewPlansState): string {
  if (state.observer === null) return '信息监听未接入'
  if (state.observer.lastErrorCount !== null && state.observer.lastErrorCount > 0) return '来源检查出错'
  if (state.observer.lastScanAt === null || !Number.isFinite(Date.parse(state.observer.lastScanAt))
    || Date.now() - Date.parse(state.observer.lastScanAt) > 30_000) return '监听可能中断'
  return `本机 ${[...new Set(state.observer.coverage.map(sourceLabel))].join(' / ')} · 3秒检查`
}

function PlanRows({ plan, state, events, debts }: PlanRowsProps): ReactElement {
  const chats = reviewChats(plan)
  const main = chats.filter(chat => chat.lane !== 'parallel')
  const parallel = chats.filter(chat => chat.lane === 'parallel')
  const health = observerHealth(state)
  const unhealthy = health === '来源检查出错' || health === '监听可能中断'
  const freshness = plan.sources.some(source => source.status === 'pending') ? '有新信息待核对'
    : plan.sources.length === 0 ? '未接入' : '查看核对范围'
  return (
    <>
      <ol className={css.reviewList} aria-label="建议顺序">
        {main.map(chat => <ChatRow key={chat.key} chat={chat} events={events} debts={debts} />)}
      </ol>
      {parallel.length > 0 && <>
        <div className={css.section}>可并行</div>
        <ul className={css.reviewList} aria-label="可并行审阅">
          {parallel.map(chat => <ChatRow key={chat.key} chat={chat} events={events} debts={debts} />)}
        </ul>
      </>}
      <details className={css.reviewSource}>
        <summary>{`信息来源 · ${freshness}${unhealthy ? ` · ${health}` : ''}`}</summary>
        <div className={css.muted}>{health}</div>
        {(state.observer === null || state.observer.excluded.length > 0) && <div className={css.muted}>{state.observer === null ? '云聊天 / Cowork 未接入' : `${[...new Set(state.observer.excluded.map(sourceLabel))].join(' / ')} 未接入`}</div>}
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
 * Render one project as a compact list of native chat names; source details stay folded.
 * @param props - Current plan read and complete ledger with exact unresolved debts.
 * @returns Read-only chat order; review actions remain in the existing debt tray.
 */
export function ReviewPlan({ project, state, events, debts }: ReviewPlanProps): ReactElement {
  const plan = state.plans.find(entry => displayProject(entry.project) === project)
  return (
    <section className={css.reviewPlan} aria-label={`${project} 审阅顺序`}>
      <div className={css.section}>建议审阅顺序</div>
      {state.error !== undefined && <div role="status" className={css.error}>{`审阅计划读取失败：${state.error}`}</div>}
      {!state.read && state.error === undefined && <div className={css.muted}>读取中…</div>}
      {state.read && plan === undefined && <div className={css.muted}>尚未设置审阅顺序</div>}
      {plan !== undefined && <PlanRows plan={plan} state={state} events={events} debts={debts} />}
    </section>
  )
}
