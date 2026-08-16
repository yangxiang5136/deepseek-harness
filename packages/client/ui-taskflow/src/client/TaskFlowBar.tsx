import { useEffect, useMemo, useState, type ReactElement } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-layout SlotMap merge (the shell.overlay list slot).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { buildModel, REFRESH_MS } from './fold.ts'
import type { TaskFlowFace } from './face.ts'
import type { ClickPop } from './interaction.ts'
import { ChipRow } from './ChipRow.tsx'
import { HistoryStrip } from './HistoryStrip.tsx'
import { MiniBar } from './MiniBar.tsx'
import { TitlePopover } from './TitlePopover.tsx'
import css from './TaskFlowBar.module.css'

/** Full bar props: the shell.overlay runtime share & the injected face. */
export type TaskFlowBarProps = PropsRuntime<'shell.overlay'> & InjectFace<TaskFlowFace>

/**
 * The TaskFlow bottom bar (spec §6 v3.0 final form): a collapsed 30px mini
 * strip ⇄ the expanded surface of exactly three elements — solid time-history
 * strip, width-adaptive running chip row, and the title popover as the single
 * intake for debts / no-heartbeat lanes / overflow. Data arrives through the
 * polled ledger hook and refolds every 10 s and on a 30 s clock; a read error
 * rides the header (and the mini label) instead of freezing silently.
 */
export function TaskFlowBar({ useLedger, seal }: TaskFlowBarProps): ReactElement {
  const ledger = useLedger(s => s)
  const [collapsed, setCollapsed] = useState(true)
  const [now, setNow] = useState(() => Date.now())
  const [clickPop, setClickPop] = useState<ClickPop | null>(null)
  const [titleOpen, setTitleOpen] = useState(false)

  // The walking clock: minutes-scale labels advance between ledger refreshes.
  // REFRESH_MS-driven refolds arrive through the ledger hook itself.
  useEffect(() => {
    const timer = window.setInterval(() => { setNow(Date.now()) }, 3 * REFRESH_MS)
    return () => { window.clearInterval(timer) }
  }, [])

  const model = useMemo(() => buildModel(ledger.events, now), [ledger.events, now])

  if (collapsed) {
    return (
      <MiniBar
        model={model}
        now={now}
        loading={!ledger.read}
        error={ledger.error}
        onExpand={() => { setCollapsed(false) }}
      />
    )
  }

  const closeAll = (): void => {
    setClickPop(null)
    setTitleOpen(false)
  }
  const collapse = (): void => {
    setCollapsed(true)
    closeAll()
  }

  return (
    <div className={css.banner} onClick={closeAll}>
      <div className={css.head} onClick={collapse}>
        <span
          className={css.title}
          onClick={(e) => {
            e.stopPropagation()
            setTitleOpen(prev => !prev)
          }}
        >
          TaskFlow
        </span>
        {ledger.error !== undefined && <span className={css.error}>{`账本读取失败：${ledger.error}`}</span>}
        <span className={css.spacer} />
        <button
          type="button"
          className={css.collapse}
          onClick={(e) => {
            e.stopPropagation()
            collapse()
          }}
        >
          ▾
        </button>
      </div>
      {titleOpen && <TitlePopover model={model} now={now} seal={seal} />}
      <div className={css.body}>
        <div className={css.left}>
          <HistoryStrip model={model} now={now} clickPop={clickPop} onTogglePop={setClickPop} />
          <ChipRow model={model} now={now} clickPop={clickPop} onTogglePop={setClickPop} />
        </div>
      </div>
    </div>
  )
}
