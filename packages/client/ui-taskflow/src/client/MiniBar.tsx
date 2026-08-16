import type { CSSProperties, ReactElement } from 'react'
import { buildChips, fmtDur, paletteColor, type FoldModel } from './fold.ts'
import css from './MiniBar.module.css'

/** Owner-fed props: the folded model, the clock, read state, and expand. */
export interface MiniBarProps {
  model: FoldModel
  now: number
  /** True before the first ledger read settles. */
  loading: boolean
  /** Read failure to surface on the label (fail-loud). */
  error?: string | undefined
  onExpand: () => void
}

/**
 * The collapsed 30px mini bar: the day's history segments as a background
 * strip (right edge = now), one label chip carrying the current task, its
 * minutes, and the +N parallel suffix. A read failure paints the label red
 * instead of letting the bar quietly freeze.
 */
export function MiniBar({ model, now, loading, error, onExpand }: MiniBarProps): ReactElement {
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
  const suffix = chips.length > 1 ? ` +${chips.length - 1}` : ''
  let label = '空闲'
  let labelCls = css.chip
  if (error !== undefined) {
    label = '⚠ 账本读取失败'
    labelCls = `${css.chip} ${css.error}`
  } else if (loading) {
    label = '加载账本…'
  } else if (model.current !== null) {
    if (model.current.paused) {
      label = `${model.current.task} · 闲置${suffix}`
      labelCls = `${css.chip} ${css.paused}`
    } else {
      label = `${model.current.task} ${fmtDur(now - model.current.start)}${suffix}`
    }
  } else {
    const first = chips[0]
    if (first !== undefined) label = `${first.task} ${fmtDur(now - first.start)}${suffix}`
  }

  return (
    <div className={css.mini} onClick={onExpand}>
      <div className={labelCls} style={{ left: 4 }}>{label}</div>
      <div className={css.strip}>
        {model.history.map((s, i) => (
          <div key={i} className={css.seg} style={segStyle(s)} />
        ))}
        <div className={css.now} />
      </div>
    </div>
  )
}
