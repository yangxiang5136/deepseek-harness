import { useState, type ReactElement } from 'react'
import type { AttentionEvent, NeedsYouItem } from './fold.ts'
import { buildHandoff, eventLine, fmtStamp } from './handoff.ts'
import { doCopy, type CopyState } from './interaction.ts'
import { fmtAge } from './NeedsYouTray.tsx'
import css from './ProjectPanel.module.css'

/** Story rows the card lists (the prompt carries more). */
export const CARD_TIMELINE_ROWS = 3

/** Longest closing note, matching the host gate and the attention board. */
export const SEAL_NOTE_MAX = 280

/** Card props: the open debt, its board label, the ledger, and the verbs. */
export interface DebtCardProps {
  debt: NeedsYouItem
  label: string
  events: readonly AttentionEvent[]
  now: number
  /** Seal this debt with Sean's optional closing note / feedback for AIs. */
  onSeal: (note: string) => void
  onClose: () => void
}

/**
 * The one detail card for an open debt, opened from a tray row or a tree tag:
 * what is waiting and since when, where to look, what happened since, the
 * last few ledger events, a continuation prompt for any AI (folded until
 * previewed), and the seal with a one-line note that becomes feedback future
 * AIs read before working on the project. Everything re-derives from the
 * ledger on each refold.
 * @param props - debt, label, ledger, clock, seal and close verbs.
 * @returns The card element.
 */
export function DebtCard({ debt, label, events, now, onSeal, onClose }: DebtCardProps): ReactElement {
  const [copied, setCopied] = useState<CopyState | null>(null)
  const [note, setNote] = useState('')
  const handoff = buildHandoff(debt, label, events, now)
  const ref = typeof debt.payload?.ref === 'string' ? debt.payload.ref : '（未写）'
  const why = typeof debt.payload?.note === 'string' ? debt.payload.note : '（未写）'
  const story = handoff.timeline.slice(-CARD_TIMELINE_ROWS)
  const parked = debt.kind === 'park'
  const seal = (): void => { onSeal(note) }

  return (
    <div className={css.card} role="region" aria-label={`${debt.task} 详情`}>
      <div className={css.cardHead}>
        <span className={css.cardStatus}>{handoff.status}</span>
        <span className={css.cardTask}>{debt.task}</span>
        <span className={css.spacer} />
        <button type="button" className={css.btn} onClick={onClose}>关闭</button>
      </div>
      <dl className={css.facts}>
        <dt>已等</dt>
        <dd>{`${fmtAge(now - debt.t)} · ${fmtStamp(debt.t)} 由 ${debt.surface} 提出`}</dd>
        <dt>收口入口</dt>
        <dd className={css.mono}>{ref}</dd>
        <dt>说明</dt>
        <dd>{why}</dd>
        <dt>最新动态</dt>
        <dd>{handoff.latest === null ? '提出后还没有新动作' : eventLine(handoff.latest)}</dd>
        <dt>经过</dt>
        <dd>
          <ul className={css.story}>
            {story.map((e, i) => <li key={i}>{eventLine(e)}</li>)}
          </ul>
        </dd>
      </dl>

      <div className={css.cardRow}>
        <button
          type="button"
          className={css.btn}
          onClick={() => { doCopy(handoff.prompt, setCopied) }}
        >
          {copied === 'done' ? '已复制 ✓' : '复制续接 prompt'}
        </button>
        <span className={css.muted}>贴到任意 AI 的新对话，前因后果和同步 TaskFlow 的做法都在里面</span>
      </div>
      {copied === 'manual' && <div className={css.error}>复制失败，请展开预览手动选中</div>}
      <details className={css.preview} open={copied === 'manual' ? true : undefined}>
        <summary>预览续接 prompt</summary>
        <pre className={css.prompt}>{handoff.prompt}</pre>
      </details>

      <div className={css.sealRow}>
        <input
          id="taskflow-seal-note"
          className={css.noteInput}
          type="text"
          maxLength={SEAL_NOTE_MAX}
          placeholder="收口备注 / 给 AI 的反馈（可选，一行）"
          value={note}
          onChange={(e) => { setNote(e.target.value) }}
          onKeyDown={(e) => { if (e.key === 'Enter') seal() }}
        />
        <button type="button" className={`${css.btn} ${css.btnPrimary}`} onClick={seal}>
          {parked ? '不做了，收口' : '收口'}
        </button>
      </div>
      <div className={css.muted}>留言会写进收口记录；以后接手这个项目的 AI 开工前会先读到。</div>
    </div>
  )
}
