import type { ReactElement, ReactNode } from 'react'
import type { HistorySegment } from './fold.ts'
import { fmtDur } from './fold.ts'
import css from './popover.module.css'

/** One key/value line of a click popover. */
export function PopRow({ k, children }: { k: string; children: ReactNode }): ReactElement {
  return (
    <div className={css.row}>
      <span className={css.key}>{k}</span>
      <span className={css.value}>{children}</span>
    </div>
  )
}

/** One member line of a pack/零碎 drill-down: task · duration, plus its note. */
export function MemberRow({ seg }: { seg: HistorySegment }): ReactElement {
  return (
    <div className={css.member}>
      <span className={css.value}>
        {seg.task}
        {' · '}
        {fmtDur(seg.dur)}
        {seg.drop ? ' 已放弃' : ''}
      </span>
      {seg.note !== null && <span className={css.note}>{seg.note}</span>}
    </div>
  )
}
