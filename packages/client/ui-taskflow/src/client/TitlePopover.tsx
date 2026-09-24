import type { ReactElement } from 'react'
import { fmtDur, noHeartbeat, type Chip, type FoldModel } from './fold.ts'
import css from './TitlePopover.module.css'

/**
 * Owner-fed props: the folded model, the clock, and the chips that overflowed
 * the row (the parent's split — one source with the +N marker).
 */
export interface TitlePopoverProps {
  model: FoldModel
  now: number
  overflow: readonly Chip[]
}

/**
 * The popover behind the TaskFlow title: no-heartbeat lanes (fail-loud,
 * never silently dropped) and running chips that overflowed the row. Open
 * debts live in the 待你收口 tray alone (2026-09-24: the popover's copy of
 * them was a duplicate entry). Zero groups renders 一切正常 rather than
 * nothing, so an empty popover still answers the click.
 */
export function TitlePopover({ model, now, overflow }: TitlePopoverProps): ReactElement {
  const dead = noHeartbeat(model)
  const empty = dead.length === 0 && overflow.length === 0

  return (
    <div className={css.pop} onClick={(e) => { e.stopPropagation() }}>
      {empty && <div className={css.allClear}>一切正常</div>}
      {dead.length > 0 && (
        <>
          <div className={`${css.group} ${css.alarm}`}>无心跳</div>
          {dead.map(item => (
            <div key={`${item.project}\u0000${item.task}\u0000${item.lastTs}`} className={css.item}>
              <span className={`${css.value} ${css.silent}`}>
                {`${item.task} · ${fmtDur(now - item.lastTs)} 无事件`}
              </span>
            </div>
          ))}
        </>
      )}
      {overflow.length > 0 && (
        <>
          <div className={css.group}>更多 running</div>
          {overflow.map(chip => (
            <div key={`${chip.project}\u0000${chip.task}\u0000${chip.start}`} className={css.item}>
              <span className={css.key}>{chip.src}</span>
              <span className={css.value}>
                {chip.task + (chip.ticks !== undefined && chip.ticks > 0 ? ` ×${chip.ticks}` : '')}
              </span>
            </div>
          ))}
        </>
      )}
    </div>
  )
}
