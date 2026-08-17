import type { MouseEvent, ReactElement } from 'react'
import { fmtDur, paletteColor, type Chip } from './fold.ts'
import type { ClickPop } from './interaction.ts'
import { PopRow } from './PopRows.tsx'
import css from './ChipRow.module.css'
import popCss from './popover.module.css'

/**
 * Owner-fed props: the already-split chips (the parent owns one split shared
 * with the popover), the clock, and the shared popover seat.
 */
export interface ChipRowProps {
  chips: readonly Chip[]
  /** How many chips overflowed the row (rendered as the static +N marker). */
  overflowCount: number
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
export function ChipRow({ chips, overflowCount, now, clickPop, onTogglePop }: ChipRowProps): ReactElement {
  return (
    <div className={css.row}>
      {chips.length === 0 && <div className={css.empty}>无进行中任务</div>}
      {chips.map((chip, i) => {
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
                {/* Lanes run on heartbeats (wall time is honest); cur/bg show
                    active time only — idle stretches cap at 30 min (判决⑯㉖). */}
                <PopRow k="已运行">{fmtDur(chip.activeDur ?? now - chip.start)}</PopRow>
                {chip.kind === 'bg' && chip.lastEvt !== undefined
                  && <PopRow k="最后活动">{`${fmtDur(now - chip.lastEvt)} 前`}</PopRow>}
                {chip.ticks !== undefined && chip.ticks > 0 && <PopRow k="子构建">{`×${chip.ticks}`}</PopRow>}
              </div>
            )}
          </div>
        )
      })}
      {overflowCount > 0 && <div className={css.more}>{`+${overflowCount}`}</div>}
    </div>
  )
}
