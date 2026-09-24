import { useMemo, useState, type ReactElement } from 'react'
import { displayProject, groupDebtsByProject, paletteColor, type NeedsYouItem } from './fold.ts'
import { debtKey, shownDebts, type DeferredSeal } from './deferredSeal.ts'
import css from './NeedsYouTray.module.css'

/** Rows shown per project column before 还有 N 条 (Sean, 2026-09-23). */
export const TRAY_ROWS_PER_PROJECT = 3

/** localStorage key for the tray's remembered fold state. */
export const TRAY_COLLAPSED_KEY = 'dsh.taskflow.trayCollapsed'

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(TRAY_COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

function writeCollapsed(value: boolean): void {
  try {
    window.localStorage.setItem(TRAY_COLLAPSED_KEY, value ? '1' : '0')
  } catch {
    // Storage can be unavailable (private window, blocked site data); the
    // fold still works for this session.
  }
}

/**
 * How long a debt has waited, at the scale a person reads it: days past two
 * days, hours past an hour, minutes below.
 * @param ms - owed duration.
 * @returns A short label such as 28天, 5小时, 12分钟.
 */
export function fmtAge(ms: number): string {
  const hours = ms / 3_600_000
  if (hours >= 48) return `${Math.floor(hours / 24)}天`
  if (hours >= 1) return `${Math.floor(hours)}小时`
  return `${Math.max(1, Math.floor(ms / 60_000))}分钟`
}

const KIND_LABEL: Readonly<Record<string, string>> = { decision: '决定', review: '审阅', merge: '合并' }

/** Tray props: the open debts and the bar-owned deferred seal controller. */
export interface NeedsYouTrayProps {
  debts: readonly NeedsYouItem[]
  sealer: DeferredSeal
  /** Display project whose tree is open, if any (its name shows pressed). */
  openProject: string | null
  /** Toggle a project's tree from its column head. */
  onToggleProject: (project: string) => void
  /** Task whose card is open in that project's tree, if any (its row shows pressed). */
  openTask: string | null
  /** Open a debt's card: its project's tree unfolds with the card open. */
  onOpenDebt: (debt: NeedsYouItem) => void
}

/**
 * The needs-you tray: every open debt laid out at the bottom of the expanded
 * bar, one column per project (busiest first, longest-owed first inside), so
 * sealing no longer hides behind the title popover. Each column shows
 * {@link TRAY_ROWS_PER_PROJECT} rows until expanded; a row's title opens its
 * card in that project's tree; the checkmark queues a bare deferred seal with
 * a 撤销 window; a project name opens that project's tree. The tray folds to its header and
 * remembers that choice.
 * @param props - debts plus the deferred seal controller.
 * @returns The tray element.
 */
export function NeedsYouTray({
  debts, sealer, openProject, onToggleProject, openTask, onOpenDebt,
}: NeedsYouTrayProps): ReactElement {
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [openProjects, setOpenProjects] = useState<Record<string, boolean>>({})

  const visible = useMemo(
    () => shownDebts(debts, sealer.states),
    [debts, sealer.states],
  )
  const groups = useMemo(() => groupDebtsByProject(visible), [visible])
  const lastPending = sealer.lastPending

  const toggle = (): void => {
    const next = !collapsed
    setCollapsed(next)
    writeCollapsed(next)
  }

  return (
    <section className={css.tray} aria-label="待你收口">
      <button type="button" className={css.head} aria-expanded={!collapsed} onClick={toggle}>
        <span className={css.title}>待你收口</span>
        <span className={css.count}>{visible.length}</span>
        <span className={css.spacer} />
        <span className={css.hint}>{collapsed ? '展开' : '折叠'}</span>
      </button>
      {!collapsed && (
        groups.length === 0
          ? <div className={css.empty}>没有待你收口的事</div>
          : (
            <div className={css.grid}>
              {groups.map((group) => {
                const expanded = openProjects[group.project] === true
                const rows = expanded ? group.items : group.items.slice(0, TRAY_ROWS_PER_PROJECT)
                return (
                  <div key={group.project} className={css.col}>
                    <div className={css.colHead}>
                      <span className={css.dot} style={{ background: paletteColor(group.project) }} />
                      <button
                        type="button"
                        className={css.project}
                        title="铺开这个项目的主线与分支"
                        aria-pressed={openProject === group.project}
                        onClick={() => { onToggleProject(group.project) }}
                      >
                        {group.project}
                      </button>
                      <span className={css.colCount}>{group.items.length}</span>
                    </div>
                    {rows.map((debt) => {
                      const key = debtKey(debt)
                      const state = sealer.states[key]
                      const focused = openProject === displayProject(debt.project) && openTask === debt.task
                      const isDecision = debt.kind === 'decision'
                      return (
                        <div key={key} className={css.row}>
                          <div className={css.line}>
                            <span className={isDecision ? css.kindDecision : css.kind}>
                              {KIND_LABEL[debt.kind] ?? debt.kind}
                            </span>
                            <button
                              type="button"
                              className={css.task}
                              title={debt.task}
                              aria-expanded={focused}
                              onClick={() => { onOpenDebt(debt) }}
                            >
                              {debt.task}
                            </button>
                            <span className={css.age}>{fmtAge(debt.owed)}</span>
                            <button
                              type="button"
                              className={css.ok}
                              aria-label={`收口 ${debt.task}`}
                              onClick={() => { sealer.queue(debt) }}
                            >
                              ✓
                            </button>
                          </div>
                          {typeof state === 'object' && <div className={css.error}>{`收口失败：${state.failed}`}</div>}
                        </div>
                      )
                    })}
                    {group.items.length > TRAY_ROWS_PER_PROJECT && (
                      <button
                        type="button"
                        className={css.more}
                        onClick={() => { setOpenProjects({ ...openProjects, [group.project]: !expanded }) }}
                      >
                        {expanded ? '收起' : `还有 ${group.items.length - TRAY_ROWS_PER_PROJECT} 条`}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )
      )}
      {lastPending !== null && (
        <div className={css.undo} role="status">
          <span className={css.undoText}>
            {sealer.pendingCount > 1
              ? `已收口 ${sealer.pendingCount} 条，最近：${lastPending.task}`
              : `已收口：${lastPending.task}`}
          </span>
          <button type="button" className={css.undoBtn} onClick={() => { sealer.undo(lastPending) }}>撤销</button>
          <span className={css.undoHint}>5 秒后写入账本</span>
        </div>
      )}
    </section>
  )
}
