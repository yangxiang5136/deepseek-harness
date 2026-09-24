import type { CSSProperties, ReactElement, ReactNode, Ref } from 'react'
import { buildChips, fmtDur, paletteColor, type FoldModel } from './fold.ts'
import barCss from './TaskFlowBar.module.css'
import css from './MiniBar.module.css'

/** Owner-fed props: the folded model, the clock, read state, and expand. */
export interface MiniBarProps {
  model: FoldModel
  now: number
  /** True before the first ledger read settles. */
  loading: boolean
  /** Read failure to surface on the label (fail-loud). */
  error?: string | undefined
  /** Open debts still shown in the tray (same filter); 0 hides the pill. */
  debtCount: number
  onExpand: () => void
  /** Parent-owned ref: the avoidance publisher observes this root. */
  rootRef: Ref<HTMLDivElement>
}

/**
 * The collapsed 30px mini bar: the day's history segments as a background
 * strip (right edge = now) under one label chip. The chip carries the current
 * task (or the first running chip when there is none) in a task span that
 * alone ellipsizes, then its minutes and the +N parallel count in a meta span;
 * an idle current task shows a 闲置 pill instead of minutes. A read failure
 * paints the label red instead of letting the bar quietly freeze; loading and
 * nothing-running read as quiet placeholders. At the right edge an amber
 * pill counts what waits in 待你收口, so the collapsed bar still says whether
 * anything needs Sean.
 */
export function MiniBar({ model, now, loading, error, debtCount, onExpand, rootRef }: MiniBarProps): ReactElement {
  const winStart = model.history.length > 0
    ? Math.min(...model.history.map(s => s.start))
    : now
  const span = Math.max(now - winStart, 1)
  const pos = (t: number): number => Math.max(0, Math.min(1, (t - winStart) / span))
  const segStyle = (s: { start: number; end: number; project: string }): CSSProperties => ({
    left: `${pos(s.start) * 100}%`,
    width: `${Math.max((pos(s.end) - pos(s.start)) * 100, 1.5)}%`,
    background: paletteColor(s.project),
  })

  const chips = buildChips(model)
  const more = chips.length - 1
  const first = chips[0]
  let label: ReactNode = '空闲'
  let modifier = css.placeholder
  if (error !== undefined) {
    label = '⚠ 账本读取失败'
    modifier = css.error
  } else if (loading) {
    label = '加载账本…'
  } else if (model.current?.paused === true) {
    label = (
      <>
        <span className={css.task}>{model.current.task}</span>
        <span className={css.state}>闲置</span>
        {more > 0 && <span className={css.meta}>{`+${more}`}</span>}
      </>
    )
    modifier = css.paused
  } else if (first !== undefined) {
    // buildChips puts a running current task first, so `first` is it when set.
    label = (
      <>
        <span className={css.task}>{first.task}</span>
        <span className={css.meta}>{`${fmtDur(first.activeDur ?? now - first.start)}${more > 0 ? ` +${more}` : ''}`}</span>
      </>
    )
    modifier = undefined
  }

  return (
    <div ref={rootRef} className={`${css.mini} ${barCss.scale}`} onClick={onExpand}>
      <div className={[css.chip, modifier].filter(Boolean).join(' ')} style={{ left: 4 }}>{label}</div>
      <div className={css.strip}>
        {model.history.map((s, i) => (
          <div key={i} className={css.seg} style={segStyle(s)} />
        ))}
        <div className={css.now} />
      </div>
      {!loading && debtCount > 0 && (
        <span className={css.debt} role="img" aria-label={`待你收口 ${debtCount}`} title={`待你收口 ${debtCount}`}>
          {debtCount}
        </span>
      )}
    </div>
  )
}
