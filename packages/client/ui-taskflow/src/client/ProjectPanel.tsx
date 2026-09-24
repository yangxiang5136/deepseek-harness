import { useState, type ReactElement } from 'react'
import { fmtDur, type NeedsYouItem } from './fold.ts'
import { fmtAge } from './NeedsYouTray.tsx'
import { TREE_WINDOW_MS, type ProjectTree, type TreeTask } from './projectTree.ts'
import type { TaskflowTodoItem } from './todo.ts'
import css from './ProjectPanel.module.css'

/** Branch rows drawn before the +N toggle. */
export const PANEL_BRANCH_ROWS = 8
/** Todo items drawn as dashed nodes after now; the list below shows more. */
export const PANEL_TODO_NODES = 3
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
const TODO_STEP = 104

const WAIT_LABEL: Readonly<Record<string, string>> = { decision: '等你决定', review: '等你审阅', merge: '等你合并' }

/** Where the todo items stand: loading, failed, or read. */
export type TodoState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; items: TaskflowTodoItem[] }

/** Panel props: the folded tree, the todo read, and the pin/close verbs. */
export interface ProjectPanelProps {
  tree: ProjectTree
  now: number
  todos: TodoState
  onPin: (task: string) => void
  onClose: () => void
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
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
 * project's todo items continuing the mainline past now. Settled branches
 * only appear as a summary line.
 * @param props - tree, clock, todo read, pin and close verbs.
 * @returns The panel element.
 */
export function ProjectPanel({ tree, now, todos, onPin, onClose }: ProjectPanelProps): ReactElement {
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
  const todoNodes = todoItems.slice(0, PANEL_TODO_NODES)
  const width = nowX + TAG_W + 24 + todoNodes.length * TODO_STEP
  const height = ROW0_Y + Math.max(0, rows.length - 1) * ROW_H + 18
  const mainStartX = tree.mainNodes.length > 0 ? xAt(tree.mainNodes[0] as number) : LABEL_W + 16
  const settledDone = tree.settled.filter(t => t.state === 'done')
  const settledDur = tree.settled.reduce((sum, t) => sum + t.activeDur, 0)
  const mainTag = tree.main === null ? { text: '近 7 天没动', cls: css.tagQuiet as string } : stateTag(tree.main, now)

  return (
    <section className={css.panel} aria-label={`${tree.label} 项目树`} onClick={(e) => { e.stopPropagation() }}>
      <div className={css.head}>
        <span className={css.name}>{tree.label}</span>
        <span className={css.muted}>近 7 天</span>
        <span className={css.meter} aria-hidden="true">
          <i className={css.meterMain} style={{ flexGrow: tree.mainDur }} />
          <i className={css.meterBranch} style={{ flexGrow: tree.branchDur }} />
        </span>
        <span>{`主线 ${fmtDur(tree.mainDur)} · 分支 ${fmtDur(tree.branchDur)}`}</span>
        {total === 0
          ? <span className={css.muted}>近 7 天没有活动记录</span>
          : leaning
            ? <span className={css.lean}>{`分支占 ${branchShare}%，重心偏到分支了`}</span>
            : <span className={css.muted}>{`主线占 ${100 - branchShare}%`}</span>}
        <span className={css.spacer} />
        {tree.candidates.length > 0 && (
          <label className={css.pin}>
            <span className={css.muted}>{tree.pinned ? '主线' : '主线（推测，选一下确认）'}</span>
            <select
              id={`taskflow-mainline-${tree.label}`}
              // Candidates exist only when a mainline was pinned or suggested.
              value={tree.mainline as string}
              onChange={(e) => { onPin(e.target.value) }}
            >
              {tree.candidates.map(task => <option key={task} value={task}>{task}</option>)}
            </select>
          </label>
        )}
        <button type="button" className={css.close} onClick={onClose}>收起</button>
      </div>

      <div className={css.graph}>
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${tree.label} 主线与未了结分支`}>
          <text x={8} y={MAIN_Y - 3} className={css.mainLabel}>{clip(tree.mainline ?? '还没有任务', 18)}</text>
          <text x={8} y={MAIN_Y + 10} className={css.sub}>{`主线 · ${fmtDur(tree.mainDur)}`}</text>
          <path d={`M${mainStartX} ${MAIN_Y} H${nowX}`} className={css.main} />
          {todoNodes.length > 0 && (
            <path d={`M${nowX + TAG_W + 8} ${MAIN_Y} H${nowX + TAG_W + 8 + todoNodes.length * TODO_STEP - 40}`} className={css.future} />
          )}
          {rows.map((branch, k) => {
            const y = ROW0_Y + k * ROW_H
            const fx = xAt(branch.start)
            const tag = stateTag(branch, now)
            return (
              <g key={branch.task}>
                <title>{`${branch.task} · ${branch.surface} · ${fmtDur(branch.activeDur)}`}</title>
                <text x={8} y={y + 4} className={css.branchLabel}>{clip(branch.task, 18)}</text>
                <path d={`M${fx} ${MAIN_Y} V${y - 5} Q${fx} ${y} ${fx + 5} ${y} H${nowX}`} className={edgeClass(branch)} />
                <circle cx={fx + 14} cy={y} r={3.5} className={css.branchNode} />
                <rect x={nowX} y={y - 9} width={TAG_W} height={18} rx={4} className={tag.cls} />
                <text x={nowX + TAG_W / 2} y={y + 4} textAnchor="middle" className={css.tagText}>{tag.text}</text>
              </g>
            )
          })}
          {tree.mainNodes.map((t, i) => <circle key={i} cx={xAt(t)} cy={MAIN_Y} r={3.5} className={css.mainNode} />)}
          <rect x={nowX} y={MAIN_Y - 9} width={TAG_W} height={18} rx={4} className={mainTag.cls} />
          <text x={nowX + TAG_W / 2} y={MAIN_Y + 4} textAnchor="middle" className={css.tagText}>{mainTag.text}</text>
          {todoNodes.map((item, j) => {
            const cx = nowX + TAG_W + 8 + (j + 1) * TODO_STEP - 52
            return (
              <g key={item.title}>
                <title>{item.title}</title>
                <circle cx={cx} cy={MAIN_Y} r={4} className={css.todoNode} />
                <text x={cx} y={MAIN_Y + 16} textAnchor="middle" className={css.sub}>{clip(item.title, 8)}</text>
              </g>
            )
          })}
        </svg>
      </div>

      <div className={css.foot}>
        {tree.branches.length > PANEL_BRANCH_ROWS && (
          <button type="button" className={css.link} onClick={() => { setAllRows(!allRows) }}>
            {allRows ? '只看前 8 条' : `还有 ${tree.branches.length - PANEL_BRANCH_ROWS} 条未了结分支`}
          </button>
        )}
        {tree.settled.length > 0 && (
          <button type="button" className={css.link} aria-expanded={showSettled} onClick={() => { setShowSettled(!showSettled) }}>
            {`已了结 ${tree.settled.length} 条（完成 ${settledDone.length}）· ${fmtDur(settledDur)}`}
          </button>
        )}
      </div>
      {showSettled && (
        <ul className={css.settled}>
          {tree.settled.map(t => (
            <li key={t.task}>{`${t.state === 'done' ? '✓' : '✕'} ${t.task} · ${fmtDur(t.activeDur)}`}</li>
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
