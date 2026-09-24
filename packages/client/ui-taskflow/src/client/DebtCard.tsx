import { useState, type ReactElement } from 'react'
import type { AttentionEvent, NeedsYouItem } from './fold.ts'
import { buildHandoff, eventLine, fmtStamp } from './handoff.ts'
import { doCopy, type CopyState } from './interaction.ts'
import { fmtAge } from './NeedsYouTray.tsx'
import css from './ProjectPanel.module.css'

/** Story rows the card lists (the prompt carries more). */
export const CARD_TIMELINE_ROWS = 6

/** Card props: the open debt, its board label, the ledger, and close. */
export interface DebtCardProps {
  debt: NeedsYouItem
  label: string
  events: readonly AttentionEvent[]
  now: number
  onClose: () => void
}

/**
 * The detail card behind a tree tag (等你决定 / 审阅 / 合并 / 停放): what is
 * waiting and since when, where to look, what happened after it was filed,
 * the task's recent story, and a continuation prompt to paste into any AI.
 * Everything re-derives from the ledger on each refold, so a pickup by
 * another AI shows up here without reopening the card.
 * @param props - debt, label, ledger, clock, close.
 * @returns The card element.
 */
export function DebtCard({ debt, label, events, now, onClose }: DebtCardProps): ReactElement {
  const [copied, setCopied] = useState<CopyState | null>(null)
  const handoff = buildHandoff(debt, label, events, now)
  const ref = typeof debt.payload?.ref === 'string' ? debt.payload.ref : '（未写）'
  const note = typeof debt.payload?.note === 'string' ? debt.payload.note : '（未写）'
  const story = handoff.timeline.slice(-CARD_TIMELINE_ROWS)

  return (
    <div className={css.card} role="region" aria-label={`${debt.task} 详情`}>
      <div className={css.cardHead}>
        <span className={css.cardStatus}>{handoff.status}</span>
        <span className={css.cardTask}>{debt.task}</span>
        <span className={css.spacer} />
        <button type="button" className={css.close} onClick={onClose}>关闭</button>
      </div>
      <dl className={css.facts}>
        <dt>已等</dt>
        <dd>{`${fmtAge(now - debt.t)} · ${fmtStamp(debt.t)} 由 ${debt.surface} 提出`}</dd>
        <dt>收口入口</dt>
        <dd className={css.mono}>{ref}</dd>
        <dt>说明</dt>
        <dd>{note}</dd>
        <dt>最新动态</dt>
        <dd>{handoff.latest === null ? '提出后还没有新动作' : eventLine(handoff.latest)}</dd>
        <dt>经过</dt>
        <dd>
          <ul className={css.story}>
            {story.map((e, i) => <li key={i}>{eventLine(e)}</li>)}
          </ul>
        </dd>
      </dl>
      <div className={css.promptHead}>
        <span>续接 prompt：复制到任意 AI 的新对话，前因后果和同步 TaskFlow 的做法都在里面</span>
        <span className={css.spacer} />
        {copied === 'manual' && <span className={css.error}>复制失败，请手动选中下面的文字</span>}
        <button
          type="button"
          className={css.copy}
          onClick={() => { doCopy(handoff.prompt, setCopied) }}
        >
          {copied === 'done' ? '已复制 ✓' : '复制 prompt'}
        </button>
      </div>
      <pre className={css.prompt}>{handoff.prompt}</pre>
    </div>
  )
}
