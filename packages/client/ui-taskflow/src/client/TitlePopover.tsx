import { useState, type ReactElement } from 'react'
import {
  fmtDur, interruptedLanes,
  type Chip, type FoldModel, type NeedsYouItem,
} from './fold.ts'
import type { TaskFlowFace } from './face.ts'
import { doCopy, type CopyState } from './interaction.ts'
import css from './TitlePopover.module.css'

/** Where the human confirmed a seal: the bar's own checkmark. */
const SEAL_CONFIRMATION_REF = 'dsh-ui:seal-click'

/**
 * Owner-fed props: the folded model, the clock, the chips that overflowed
 * the row (the parent's split — one source with the +N marker), and the
 * seal verb.
 */
export interface TitlePopoverProps {
  model: FoldModel
  now: number
  overflow: readonly Chip[]
  seal: TaskFlowFace['seal']
}

/** Per-debt seal progress, keyed by the needs-you `ts` pin. */
type SealState = 'busy' | 'sealed' | { failed: string }

/**
 * The single intake popover behind the TaskFlow title (v19/v20): three groups
 * — open seal debts (with the seal checkmark, the P2 headline verb, and the
 * copy-seal-command fallback), no-heartbeat lanes (fail-loud, never silently
 * dropped), and running chips that overflowed the row. Zero groups renders
 * 一切正常 rather than nothing, so an empty popover still answers the click.
 */
export function TitlePopover({ model, now, overflow, seal }: TitlePopoverProps): ReactElement {
  const [sealStates, setSealStates] = useState<Record<string, SealState>>({})
  const [copied, setCopied] = useState<CopyState | null>(null)

  const sealOne = (debt: NeedsYouItem): void => {
    setSealStates(prev => ({ ...prev, [debt.ts]: 'busy' }))
    void seal({
      project: debt.project,
      task: debt.task,
      resolvesTs: debt.ts,
      confirmationRef: SEAL_CONFIRMATION_REF,
    }).then(
      (outcome) => {
        setSealStates(prev => ({
          ...prev,
          [debt.ts]: outcome.sealed ? 'sealed' : { failed: outcome.message ?? 'seal refused' },
        }))
      },
      (reason: unknown) => {
        setSealStates(prev => ({
          ...prev,
          [debt.ts]: { failed: reason instanceof Error ? reason.message : String(reason) },
        }))
      },
    )
  }

  const dead = interruptedLanes(model)
  const empty = model.needsYou.length === 0 && dead.length === 0 && overflow.length === 0

  return (
    <div className={css.pop} onClick={(e) => { e.stopPropagation() }}>
      {empty && <div className={css.allClear}>一切正常</div>}
      {model.needsYou.length > 0 && (
        <>
          <div className={css.group}>待收口</div>
          {model.needsYou.map((debt) => {
            const state = sealStates[debt.ts]
            const ref = typeof debt.payload?.ref === 'string' ? debt.payload.ref : null
            const note = typeof debt.payload?.note === 'string' ? debt.payload.note : null
            return (
              <div key={debt.ts}>
                <div className={css.item}>
                  <span className={css.key}>{debt.kind}</span>
                  <span className={css.value}>
                    {`${debt.task} · 欠账 ${fmtDur(debt.owed)}`}
                    {ref !== null && <div className={css.ref}>{ref}</div>}
                    {note !== null && <div className={css.note}>{note}</div>}
                  </span>
                </div>
                <div className={css.actions}>
                  {state === 'sealed'
                    ? <span className={css.sealed}>已收口 ✓</span>
                    : (
                      <button
                        type="button"
                        className={css.seal}
                        disabled={state === 'busy'}
                        onClick={() => { sealOne(debt) }}
                      >
                        {state === 'busy' ? '收口中…' : '收口 ✓'}
                      </button>
                    )}
                  <button
                    type="button"
                    className={css.copy}
                    onClick={() => { doCopy(`收口 ${debt.task}`, setCopied) }}
                  >
                    {copied === 'done' ? '已复制 ✓' : copied === 'manual' ? '复制失败' : '复制收口指令'}
                  </button>
                  {typeof state === 'object' && <span className={css.error}>{state.failed}</span>}
                </div>
              </div>
            )
          })}
        </>
      )}
      {dead.length > 0 && (
        <>
          <div className={css.group}>无心跳</div>
          {dead.map(lane => (
            <div key={`${lane.delegateTask}:${lane.openTs}`} className={css.item}>
              <span className={css.key}>静默</span>
              <span className={css.value}>
                {`${lane.labelTask ?? lane.delegateTask} · ${fmtDur(now - lane.lastDshTs)} 无事件`}
              </span>
            </div>
          ))}
        </>
      )}
      {overflow.length > 0 && (
        <>
          <div className={css.group}>更多 running</div>
          {overflow.map(chip => (
            <div key={`${chip.task}:${chip.start}`} className={css.item}>
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
