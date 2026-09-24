import type { ReactElement, ReactNode } from 'react'
import type { HistorySegment } from './fold.ts'
import { fmtDur } from './fold.ts'
import css from './popover.module.css'

/**
 * One key/value line of a click popover. `subject` marks the row naming what
 * the popover is about (a task, a series, a 零碎 block): its value renders at
 * the item role instead of meta.
 */
export function PopRow({ k, subject = false, children }: {
  k: string
  subject?: boolean
  children: ReactNode
}): ReactElement {
  return (
    <div className={css.row}>
      <span className={css.key}>{k}</span>
      <span className={subject ? `${css.value} ${css.subject}` : css.value}>{children}</span>
    </div>
  )
}

/**
 * One member line of a pack/零碎 drill-down: task · duration, plus its note.
 * A dropped member fades and carries an 已放弃 tag.
 */
export function MemberRow({ seg }: { seg: HistorySegment }): ReactElement {
  return (
    <div className={css.member}>
      <span className={seg.drop ? `${css.value} ${css.dropped}` : css.value}>
        {seg.task}
        {' · '}
        {fmtDur(seg.dur)}
        {seg.drop && <span className={css.state}>{' 已放弃'}</span>}
      </span>
      {seg.note !== null && <span className={css.note}>{seg.note}</span>}
    </div>
  )
}
