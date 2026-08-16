import type { MouseEvent, ReactElement } from 'react'
import { buildChips, fmtDur, paletteColor, splitChips, type FoldModel } from './fold.ts'
import type { ClickPop } from './interaction.ts'
import { PopRow } from './PopRows.tsx'
import css from './ChipRow.module.css'
import popCss from './popover.module.css'

/** Owner-fed props: the folded model, the clock, and the shared popover seat. */
export interface ChipRowProps {
  model: FoldModel
  now: number
  clickPop: ClickPop | null
  onTogglePop: (pop: ClickPop | null) => void
}

/**
 * The running layer as one row of discrete chips (v20/v21): breathing dot +
 * task + source tag, width-driven overflow into a static +N whose detail
 * lives in the title popover. Deliberately a different visual grammar from
 * the strip above — continuous time band vs discrete objects.
 */
export function ChipRow({ model, now, clickPop, onTogglePop }: ChipRowProps): ReactElement {
  const { shown, overflow } = splitChips(buildChips(model))
  return (
    <div className={css.row}>
      {shown.length === 0 && <div className={css.empty}>无进行中任务</div>}
      {shown.map((chip, i) => {
        const open = clickPop?.type === 'chip' && clickPop.index === i
        const toggle = (e: MouseEvent): void => {
          e.stopPropagation()
          onTogglePop(open ? null : { type: 'chip', index: i })
        }
        const label = chip.task + (chip.kind === 'cur' && chip.paused === true ? ' · 闲置' : '')
        return (
          <div key={`${chip.task}:${chip.start}`} className={css.chip} onClick={toggle}>
            <span className={css.dot} style={{ background: paletteColor(chip.project) }} />
            <span className={css.task}>{label}</span>
            <span className={css.src}>{chip.src}</span>
            {open && (
              <div className={popCss.pop} style={{ left: 0 }} onClick={(e) => { e.stopPropagation() }}>
                <PopRow k="任务">{label}</PopRow>
                <PopRow k="project">{chip.project}</PopRow>
                <PopRow k="surface">{chip.src}</PopRow>
                <PopRow k="已运行">{fmtDur(now - chip.start)}</PopRow>
                {chip.ticks !== undefined && chip.ticks > 0 && <PopRow k="子构建">{`×${chip.ticks}`}</PopRow>}
              </div>
            )}
          </div>
        )
      })}
      {overflow.length > 0 && <div className={css.more}>{`+${overflow.length}`}</div>}
    </div>
  )
}
