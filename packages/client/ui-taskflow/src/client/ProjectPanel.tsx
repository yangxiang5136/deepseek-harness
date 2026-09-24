import { useState, type KeyboardEvent, type ReactElement } from 'react'
import { DebtCard } from './DebtCard.tsx'
import { fmtDur, type AttentionEvent, type NeedsYouItem } from './fold.ts'
import { fmtAge } from './NeedsYouTray.tsx'
import { TREE_WINDOW_MS, type ProjectTree, type TreeTask } from './projectTree.ts'
import type { TaskflowTodoItem } from './todo.ts'
import css from './ProjectPanel.module.css'

/** Branch rows drawn before the +N toggle. */
export const PANEL_BRANCH_ROWS = 8
/** Todo items listed under the tree before 还有 N 条. */
export const PANEL_TODO_ROWS = 5

const LABEL_W = 236
/** Slot spacing; busy weeks tighten so the tags and todo nodes stay in view. */
const STEP = 44
const TIGHT_STEP = 26
const TIGHT_SLOTS = 12
const MAIN_Y = 22
const ROW0_Y = 58
const ROW_H = 24
const TAG_W = 62
const PIN_W = 52
const PIN_X = LABEL_W - PIN_W - 4

const WAIT_LABEL: Readonly<Record<string, string>> = { decision: '等你决定', review: '等你审阅', merge: '等你合并' }

/** Where the todo items stand: loading, failed, or read. */
export type TodoState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; items: TaskflowTodoItem[] }

/** Panel props: the folded tree, the todo read, and the pin/close verbs. */
export interface ProjectPanelProps {
  tree: ProjectTree
  /** The whole parsed ledger: debt cards tell each task's story from it. */
  events: readonly AttentionEvent[]
  now: number
  todos: TodoState
  onPin: (task: string) => void
  /** Task whose debt card is open (owned by the bar so the tray can open it). */
  cardTask: string | null
  onCard: (task: string | null) => void
  /** Queue a seal of an open debt with Sean's optional closing note. */
  onSeal: (debt: NeedsYouItem, note: string) => void
  onClose: () => void
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * Make an SVG group behave as a button for keyboard users too.
 * @param run - the action.
 * @returns Handler for Enter / Space.
 */
function onKey(run: () => void): (e: KeyboardEvent) => void {
  return (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    run()
  }
}

function stateTag(task: TreeTask, now: number): { text: string; cls: string } {
  switch (task.state) {
    // A waiting branch always carries its debt (buildProjectTree).
    case 'waiting': return { text: WAIT_LABEL[(task.debt as NeedsYouItem).kind] ?? '等你收口', cls: css.tagWait as string }
    case 'parked': return { text: '停放', cls: css.tagPark as string }
    case 'running': return { text: '进行中', cls: css.tagLive as string }
    case 'stalled': return { text: `${fmtAge(now - task.last)}无动静`, cls: css.tagQuiet as string }
    case 'done': return { text: '已完成', cls: css.tagQuiet as string }
    case 'drop': return { text: '已放弃', cls: css.tagQuiet as string }
  }
}

function edgeClass(task: TreeTask): string {
  switch (task.state) {
    case 'waiting': return css.edgeWait as string
    case 'parked': return css.edgePark as string
    case 'running': return css.edgeLive as string
    default: return css.edgeQuiet as string
  }
}

/**
 * The project tree panel (Branch Compass inside TaskFlow): a ratio line that
 * says whether the week went to the mainline or leaked into branches, the
 * mainline with every unresolved branch forking off where it began, and the
 * project's todo list below. Settled branches only appear as a summary line;
 * an open debt's tag opens its card (seal with a note, continuation prompt).
 * @param props - tree, clock, todo read, pin and close verbs.
 * @returns The panel element.
 */
export function ProjectPanel({
  tree, events, now, todos, onPin, cardTask, onCard, onSeal, onClose,
}: ProjectPanelProps): ReactElement {
  const [allRows, setAllRows] = useState(false)
  const [showSettled, setShowSettled] = useState(false)

  const total = tree.mainDur + tree.branchDur
  const branchShare = total === 0 ? 0 : Math.round((tree.branchDur / total) * 100)
  const leaning = total > 0 && tree.branchDur > tree.mainDur

  const rows = allRows ? tree.branches : tree.branches.slice(0, PANEL_BRANCH_ROWS)
  const windowStart = now - TREE_WINDOW_MS
  const slots = [...new Set([...tree.mainNodes, ...rows.map(b => Math.max(b.start, windowStart))])].sort((a, b) => a - b)
  const step = slots.length > TIGHT_SLOTS ? TIGHT_STEP : STEP
  const xAt = (t: number): number => LABEL_W + 16 + Math.max(0, slots.indexOf(Math.max(t, windowStart))) * step
  const nowX = LABEL_W + 16 + Math.max(1, slots.length) * step + 12
  const todoItems = todos.status === 'ready' ? todos.items : []
  const width = nowX + TAG_W + 24
  const height = ROW0_Y + Math.max(0, rows.length - 1) * ROW_H + 18
  const mainStartX = tree.mainNodes.length > 0 ? xAt(tree.mainNodes[0] as number) : LABEL_W + 16
  const settledDone = tree.settled.filter(t => t.state === 'done')
  const settledDur = tree.settled.reduce((sum, t) => sum + t.activeDur, 0)
  const mainTag = tree.main === null ? { text: '近 7 天没动', cls: css.tagQuiet as string } : stateTag(tree.main, now)
  // The card follows the live fold: once Sean seals the debt it closes itself.
  const cardDebt = [tree.main, ...tree.branches].find(t => t?.task === cardTask)?.debt ?? null
  const toggleCard = (task: string): void => { onCard(cardTask === task ? null : task) }

  /** The hover-revealed 设为主线 chip at the end of a row's label. */
  const pinChip = (task: string, y: number, text: string): ReactElement => (
    <g
      className={css.pinBtn}
      role="button"
      tabIndex={0}
      aria-label={`把「${task}」设为主线`}
      onClick={() => { onPin(task) }}
      onKeyDown={onKey(() => { onPin(task) })}
    >
      <rect x={PIN_X} y={y - 9} width={PIN_W} height={18} rx={9} />
      <text x={PIN_X + PIN_W / 2} y={y + 4} textAnchor="middle">{text}</text>
    </g>
  )

  /** A state tag; tags of open debts open their card. */
  const tagAt = (x: number, y: number, task: TreeTask | null, tag: { text: string; cls: string }): ReactElement => {
    const opens = task !== null && task.debt !== null
    const body = (
      <>
        <rect x={x} y={y - 9} width={TAG_W} height={18} rx={9} className={tag.cls} />
        <text x={x + TAG_W / 2} y={y + 4} textAnchor="middle" className={css.tagText}>{tag.text}</text>
      </>
    )
    if (!opens) return body
    const open = (): void => { toggleCard(task.task) }
    return (
      <g
        className={cardTask === task.task ? `${css.tagBtn} ${css.tagOpen}` : css.tagBtn}
        role="button"
        tabIndex={0}
        aria-label={`查看「${task.task}」详情`}
        aria-expanded={cardTask === task.task}
        onClick={open}
        onKeyDown={onKey(open)}
      >
        {body}
      </g>
    )
  }

  return (
    <section className={css.panel} aria-label={`${tree.label} 项目树`} onClick={(e) => { e.stopPropagation() }}>
      <div className={css.head}>
        <span className={css.name}>{tree.label}</span>
        <span
          className={css.meter}
          role="img"
          aria-label={`近 7 天 主线 ${fmtDur(tree.mainDur)} · 分支 ${fmtDur(tree.branchDur)}`}
          title={`近 7 天 主线 ${fmtDur(tree.mainDur)} · 分支 ${fmtDur(tree.branchDur)}`}
        >
          <i className={css.meterMain} style={{ flexGrow: tree.mainDur }} />
          <i className={css.meterBranch} style={{ flexGrow: tree.branchDur }} />
        </span>
        {total === 0
          ? <span className={css.muted}>近 7 天没有活动</span>
          : leaning
            ? <span className={css.lean}>{`分支占 ${branchShare}%，重心偏到分支了`}</span>
            : <span className={css.muted}>{`主线占 ${100 - branchShare}%`}</span>}
        <span className={css.spacer} />
        <button type="button" className={css.btn} onClick={onClose}>收起</button>
      </div>

      <div className={css.graph}>
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${tree.label} 主线与未了结分支`}>
          <g className={css.row}>
            <rect x={0} y={MAIN_Y - ROW_H / 2} width={LABEL_W} height={ROW_H} className={css.hit} />
            <text x={8} y={MAIN_Y - 3} className={css.mainLabel}>{clip(tree.mainline ?? '还没有任务', 18)}</text>
            <text x={8} y={MAIN_Y + 10} className={css.sub}>{tree.pinned ? '主线' : '主线 · 推测，悬停可改'}</text>
            {tree.mainline !== null && !tree.pinned && pinChip(tree.mainline, MAIN_Y, '确认主线')}
          </g>
          <path d={`M${mainStartX} ${MAIN_Y} H${nowX}`} className={css.main} />
          {rows.map((branch, k) => {
            const y = ROW0_Y + k * ROW_H
            const fx = xAt(branch.start)
            const tag = stateTag(branch, now)
            return (
              <g key={branch.task} className={css.row}>
                <title>{`${branch.task} · ${branch.surface} · ${fmtDur(branch.activeDur)}`}</title>
                <rect x={0} y={y - ROW_H / 2} width={width} height={ROW_H} className={css.hit} />
                <text x={8} y={y + 4} className={css.branchLabel}>{clip(branch.task, 18)}</text>
                <path d={`M${fx} ${MAIN_Y} V${y - 5} Q${fx} ${y} ${fx + 5} ${y} H${nowX}`} className={edgeClass(branch)} />
                <circle cx={fx + 14} cy={y} r={3.5} className={css.branchNode} />
                {tagAt(nowX, y, branch, tag)}
                {pinChip(branch.task, y, '设为主线')}
              </g>
            )
          })}
          {tree.mainNodes.map((t, i) => <circle key={i} cx={xAt(t)} cy={MAIN_Y} r={3.5} className={css.mainNode} />)}
          {tagAt(nowX, MAIN_Y, tree.main, mainTag)}
        </svg>
      </div>

      {cardDebt !== null && (
        <DebtCard
          debt={cardDebt}
          label={tree.label}
          events={events}
          now={now}
          onSeal={(note) => {
            onSeal(cardDebt, note)
            onCard(null)
          }}
          onClose={() => { onCard(null) }}
        />
      )}

      <div className={css.foot}>
        {tree.branches.length > PANEL_BRANCH_ROWS && (
          <button type="button" className={css.btn} onClick={() => { setAllRows(!allRows) }}>
            {allRows ? '只看前 8 条' : `还有 ${tree.branches.length - PANEL_BRANCH_ROWS} 条未了结分支`}
          </button>
        )}
        {tree.settled.length > 0 && (
          <button type="button" className={css.btn} aria-expanded={showSettled} onClick={() => { setShowSettled(!showSettled) }}>
            {`已了结 ${tree.settled.length} 条（完成 ${settledDone.length}）· ${fmtDur(settledDur)}`}
          </button>
        )}
      </div>
      {showSettled && (
        <ul className={css.settled}>
          {tree.settled.map(t => (
            <li key={t.task} className={css.settledItem}>
              {`${t.state === 'done' ? '✓' : '✕'} ${t.task} · ${fmtDur(t.activeDur)}`}
              <button type="button" className={`${css.btn} ${css.pinInline}`} onClick={() => { onPin(t.task) }}>设为主线</button>
            </li>
          ))}
        </ul>
      )}

      <div className={css.todos}>
        <span className={css.muted}>接下来 · 待办</span>
        {todos.status === 'loading' && <span className={css.muted}>读取中…</span>}
        {todos.status === 'error' && <span className={css.error}>{`待办读取失败：${todos.message}`}</span>}
        {todos.status === 'ready' && todoItems.length === 0 && <span className={css.muted}>这个项目没有待办</span>}
        {todoItems.slice(0, PANEL_TODO_ROWS).map(item => (
          <span key={item.title} className={css.todo} title={item.title}>
            {item.title}
            {item.due !== null && <span className={css.muted}>{` · ${item.due.slice(5)}`}</span>}
          </span>
        ))}
        {todoItems.length > PANEL_TODO_ROWS && <span className={css.muted}>{`还有 ${todoItems.length - PANEL_TODO_ROWS} 条`}</span>}
      </div>
    </section>
  )
}
