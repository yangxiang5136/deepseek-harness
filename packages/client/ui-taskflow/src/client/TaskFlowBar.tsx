import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-layout SlotMap merge (the shell.overlay list slot).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { buildChips, buildModel, CHIP_ROW_W, displayProject, estTextW, MODEL_W, REFRESH_MS, splitChips, type TextMeasure } from './fold.ts'
import type { TaskFlowFace } from './face.ts'
import type { ClickPop } from './interaction.ts'
import { ChipRow } from './ChipRow.tsx'
import { HistoryStrip } from './HistoryStrip.tsx'
import { MiniBar } from './MiniBar.tsx'
import { NeedsYouTray } from './NeedsYouTray.tsx'
import { ProjectPanel, type TodoState } from './ProjectPanel.tsx'
import { buildProjectTree, readPins, writePins } from './projectTree.ts'
import { todosForProject } from './todo.ts'
import { shownDebts, useDeferredSeal } from './deferredSeal.ts'
import { TitlePopover } from './TitlePopover.tsx'
import css from './TaskFlowBar.module.css'

/** The CSS seam ui-layout's frame consumes for content avoidance (S4). */
const CLEARANCE_VAR = '--dsh-shell-bottom-clearance'

/** Full bar props: the shell.overlay runtime share & the injected face. */
export type TaskFlowBarProps = PropsRuntime<'shell.overlay'> & InjectFace<TaskFlowFace>

/**
 * Real text measurement over a canvas in the app font family, falling back to
 * the estTextW character heuristic where canvas 2D is unavailable (jsdom).
 * Callers pass the size and weight the text renders at; the context font is
 * reassigned only when that pair changes (the `context.font` getter returns a
 * normalized string, so the last assigned value is cached here instead).
 * @returns The text-width seat used for chip overflow and strip label fit.
 */
function createMeasure(): TextMeasure {
  try {
    const context = document.createElement('canvas').getContext('2d')
    if (context === null) return estTextW
    const family = getComputedStyle(document.body).fontFamily
    let last = ''
    return (text, px = 10, weight = 400) => {
      const font = `${weight} ${px}px ${family}`
      if (font !== last) {
        context.font = font
        last = font
      }
      return context.measureText(text).width
    }
  } catch {
    return estTextW
  }
}

/**
 * The TaskFlow bottom bar (spec §6 v3.0 final form): a collapsed 30px mini
 * strip ⇄ the expanded surface of exactly three elements — solid time-history
 * strip, width-adaptive running chip row, and the title popover as the single
 * intake for debts / no-heartbeat lanes / overflow. Data arrives through the
 * polled ledger hook and refolds every 10 s and on a 30 s clock; a read error
 * rides the header (and the mini label) instead of freezing silently.
 *
 * The bar publishes its live height as {@link CLEARANCE_VAR} on the shell
 * frame (the overlay layer's parent) so the frame's columns end above it —
 * the composer-height precedent, pointed the other way: the consumer is an
 * ancestor, so the property is set where inheritance can reach it.
 *
 * While a project tree is open the expanded banner carries `data-panel-open`;
 * NeedsYouTray.module.css keys its tighter grid height cap on that attribute
 * because the banner's class name is hashed in this module.
 */
export function TaskFlowBar({ useLedger, seal, todos }: TaskFlowBarProps): ReactElement {
  const ledger = useLedger(s => s)
  const [collapsed, setCollapsed] = useState(true)
  const [now, setNow] = useState(() => Date.now())
  const [clickPop, setClickPop] = useState<ClickPop | null>(null)
  const [titleOpen, setTitleOpen] = useState(false)
  const [openProject, setOpenProject] = useState<string | null>(null)
  const [cardTask, setCardTask] = useState<string | null>(null)
  const [pins, setPins] = useState(readPins)
  const [todoState, setTodoState] = useState<TodoState>({ status: 'loading' })

  // The walking clock: minutes-scale labels advance between ledger refreshes.
  // REFRESH_MS-driven refolds arrive through the ledger hook itself.
  useEffect(() => {
    const timer = window.setInterval(() => { setNow(Date.now()) }, 3 * REFRESH_MS)
    return () => { window.clearInterval(timer) }
  }, [])

  // Content avoidance: observe whichever root (mini or banner) is mounted and
  // publish its height on the frame element. The ref only records the mounted
  // element; observe/publish/cleanup live in an effect, because ref-callback
  // ordering across a root swap is NOT detach-before-attach in every React
  // runtime — the platform runtime attaches the new root's ref first, so a
  // ref-held observer gets disconnected by the old root's null call (live
  // S6 find). Effect cleanup→setup ordering is guaranteed, whoever attaches
  // first.
  const [rootEl, setRootEl] = useState<HTMLElement | null>(null)
  const rootRef = useCallback((el: HTMLDivElement | null): void => {
    // The null call may belong to the previous root after the new one already
    // registered — ignore it; unmount cleanup is the effect's job.
    if (el !== null) setRootEl(el)
  }, [])
  useEffect(() => {
    if (rootEl === null) return
    const frame = rootEl.closest('[data-shell-overlay]')?.parentElement ?? null
    if (frame === null) return
    const publish = (): void => {
      frame.style.setProperty(CLEARANCE_VAR, `${rootEl.offsetHeight}px`)
    }
    if (typeof ResizeObserver === 'undefined') {
      publish()
      return () => { frame.style.removeProperty(CLEARANCE_VAR) }
    }
    // ResizeObserver fires once on observe, covering the initial publish.
    const observer = new ResizeObserver(publish)
    observer.observe(rootEl)
    return () => {
      observer.disconnect()
      frame.style.removeProperty(CLEARANCE_VAR)
    }
  }, [rootEl])

  // Real measured column width replaces the CHIP_ROW_W constant for the chip
  // split (manifest §7 flagged it unverified) and gives the strip's label-fit
  // test its rendered scale. One observer on the shared .left column serves
  // both rows — they share its content width.
  const [leftW, setLeftW] = useState<number | null>(null)
  const leftObserver = useRef<ResizeObserver | null>(null)
  const leftRef = useCallback((el: HTMLDivElement | null): void => {
    leftObserver.current?.disconnect()
    leftObserver.current = null
    if (el === null || typeof ResizeObserver === 'undefined') return
    leftObserver.current = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (width !== undefined && width > 0) setLeftW(width)
    })
    leftObserver.current.observe(el)
  }, [])

  const measure = useMemo(createMeasure, [])
  const model = useMemo(() => buildModel(ledger.events, now), [ledger.events, now])
  // One split feeds both the row and the popover's 更多 running group, so the
  // +N marker and its detail can never disagree.
  const chips = useMemo(
    () => splitChips(buildChips(model), leftW ?? CHIP_ROW_W, measure),
    [model, leftW, measure],
  )
  // Opening a project reads the todo files once; a stale answer for a project
  // that was closed or switched meanwhile is discarded.
  useEffect(() => {
    if (openProject === null) return
    let live = true
    setTodoState({ status: 'loading' })
    todos().then(
      (files) => { if (live) setTodoState({ status: 'ready', items: todosForProject(files, openProject) }) },
      (error: unknown) => {
        if (live) setTodoState({ status: 'error', message: error instanceof Error ? error.message : '读取失败' })
      },
    )
    return () => { live = false }
  }, [openProject, todos])
  const tree = useMemo(
    () => openProject === null ? null : buildProjectTree(ledger.events, model, openProject, pins[openProject], now),
    [openProject, ledger.events, model, pins, now],
  )

  // Bar-owned so collapsing the tray or the whole bar never drops a seal
  // that is still inside its 撤销 window.
  const sealer = useDeferredSeal(seal)

  if (collapsed) {
    return (
      <MiniBar
        model={model}
        now={now}
        debtCount={shownDebts(model.needsYou, sealer.states).length}
        loading={!ledger.read}
        error={ledger.error}
        onExpand={() => { setCollapsed(false) }}
        rootRef={rootRef}
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
    <div ref={rootRef} className={css.banner} data-panel-open={tree === null ? undefined : ''} onClick={closeAll}>
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
      {titleOpen && <TitlePopover model={model} now={now} overflow={chips.overflow} />}
      <div className={css.body}>
        <div ref={leftRef} className={css.left}>
          <HistoryStrip
            model={model}
            now={now}
            measure={measure}
            stripW={leftW ?? MODEL_W}
            clickPop={clickPop}
            onTogglePop={setClickPop}
          />
          <ChipRow
            chips={chips.shown}
            overflowCount={chips.overflow.length}
            now={now}
            clickPop={clickPop}
            onTogglePop={setClickPop}
          />
        </div>
      </div>
      {tree !== null && (
        <ProjectPanel
          tree={tree}
          events={ledger.events}
          now={now}
          todos={todoState}
          onPin={(task) => {
            const next = { ...pins, [tree.label]: task }
            setPins(next)
            writePins(next)
          }}
          cardTask={cardTask}
          onCard={setCardTask}
          onSeal={(debt, note) => { sealer.queue(debt, note) }}
          onClose={() => {
            setOpenProject(null)
            setCardTask(null)
          }}
        />
      )}
      <NeedsYouTray
        debts={model.needsYou}
        sealer={sealer}
        openProject={openProject}
        onToggleProject={(project) => {
          setOpenProject(openProject === project ? null : project)
          setCardTask(null)
        }}
        openTask={cardTask}
        onOpenDebt={(debt) => {
          const project = displayProject(debt.project)
          const same = openProject === project && cardTask === debt.task
          setOpenProject(project)
          setCardTask(same ? null : debt.task)
        }}
      />
    </div>
  )
}
