import { useRef, type CSSProperties, type MouseEvent, type ReactElement } from 'react'
import { displayProject, fmtDur, paletteColor, type Chip } from './fold.ts'
import type { ClickPop } from './interaction.ts'
import { PopRow } from './PopRows.tsx'
import css from './ChipRow.module.css'
import popCss from './popover.module.css'

/** The chip popover's min-width (popover.module.css .pop). */
export const CHIP_POP_MIN_W = 220

/**
 * Anchor a chip's popover on the side that keeps it inside the window: left by
 * default, right when a {@link CHIP_POP_MIN_W} box from the chip's left edge
 * would run past the viewport (the frame clips the overflow layer).
 * @param el - the chip element, if mounted.
 * @returns Inline position for the popover.
 */
export function popAnchor(el: HTMLElement | null | undefined): CSSProperties {
  if (el === null || el === undefined) return { left: 0 }
  const { left } = el.getBoundingClientRect()
  return left + CHIP_POP_MIN_W > document.documentElement.clientWidth ? { right: 0 } : { left: 0 }
}

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
 * lives in the title popover. The current task is the row's lead (tinted
 * pill, `data-kind="cur"`); an idle current task keeps its size, stops the
 * dot, and adds a 闲置 pill (`data-paused`). Deliberately a different visual
 * grammar from the strip above — continuous time band vs discrete objects.
 */
export function ChipRow({ chips, overflowCount, now, clickPop, onTogglePop }: ChipRowProps): ReactElement {
  const chipEls = useRef<Array<HTMLDivElement | null>>([])
  return (
    <div className={css.row}>
      {chips.length === 0 && <div className={css.empty}>无进行中任务</div>}
      {chips.map((chip, i) => {
        const open = clickPop?.type === 'chip' && clickPop.index === i
        const toggle = (e: MouseEvent): void => {
          e.stopPropagation()
          onTogglePop(open ? null : { type: 'chip', index: i })
        }
        const paused = chip.kind === 'cur' && chip.paused === true
        return (
          <div
            key={`${chip.project}\u0000${chip.task}\u0000${chip.start}`}
            ref={(el) => { chipEls.current[i] = el }}
            className={css.chip}
            data-kind={chip.kind}
            data-paused={paused ? '' : undefined}
            onClick={toggle}
          >
            <span className={css.dot} style={{ background: paletteColor(displayProject(chip.project)) }} />
            <span className={css.task}>{chip.task}</span>
            {paused && <span className={css.state}>闲置</span>}
            <span className={css.src}>{chip.src}</span>
            {open && (
              <div className={popCss.pop} style={popAnchor(chipEls.current[i])} onClick={(e) => { e.stopPropagation() }}>
                <PopRow k="任务" subject>{paused ? `${chip.task} · 闲置` : chip.task}</PopRow>
                <PopRow k="project">{displayProject(chip.project)}</PopRow>
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
