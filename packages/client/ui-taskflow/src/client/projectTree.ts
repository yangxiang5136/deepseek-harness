/**
 * Project tree (Branch Compass inside TaskFlow, Sean 2026-09-24): one
 * project's last week folded into a mainline and its unresolved side
 * branches, so a glance says whether the week went to the mainline or leaked
 * into branches. Settled branches (done / drop) are not drawn — they only
 * count toward the mainline-vs-branch ratio and one summary line.
 */

import { displayProject, IDLE_PAUSE_MS, LANE_IDLE_MS, PARK_KIND, type AttentionEvent, type FoldModel, type NeedsYouItem } from './fold.ts'

/** How far back the tree and its ratio look. */
export const TREE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Why a branch is still open: running (heard from inside the idle window),
 * stalled (silent beyond it, never settled), waiting on the human (a
 * merge/decision/review debt), or parked (a `park` debt).
 */
export type BranchState = 'running' | 'stalled' | 'waiting' | 'parked'

/** One task of the project inside the window. */
export interface TreeTask {
  task: string
  /** Surface of the task's first event in the window. */
  surface: string
  /** First event instant (the fork point). */
  start: number
  /** Last event instant. */
  last: number
  /** Event-chained active time; each silent gap counts at most IDLE_PAUSE_MS. */
  activeDur: number
  /** Open state, or how it settled. */
  state: BranchState | 'done' | 'drop'
  /** The open debt behind `waiting` / `parked`; null otherwise. */
  debt: NeedsYouItem | null
}

/** The folded tree of one project. */
export interface ProjectTree {
  /** Display project the tree covers (aliases folded, e.g. MSC_AI → ARK). */
  label: string
  /** The mainline task, pinned or suggested; null when the project is empty. */
  mainline: string | null
  /** True when `mainline` came from the human's pin. */
  pinned: boolean
  /** The mainline's own events in the window (its nodes), oldest first. */
  mainNodes: number[]
  /** The mainline's fold; null when it had no activity or debt in the window. */
  main: TreeTask | null
  /** Active time on the mainline inside the window. */
  mainDur: number
  /** Active time on every other task inside the window. */
  branchDur: number
  /** Unresolved branches, oldest fork first. */
  branches: TreeTask[]
  /** Branches settled inside the window (done / drop), latest first. */
  settled: TreeTask[]
  /** Pin candidates: every task seen, most active first. */
  candidates: string[]
}

function chainedActive(times: readonly number[]): number {
  let acc = 0
  for (let i = 1; i < times.length; i++) {
    acc += Math.min((times[i] as number) - (times[i - 1] as number), IDLE_PAUSE_MS)
  }
  return acc
}

/**
 * Fold one project's tree from the ledger and the already-folded debts.
 * @param events - every parsed ledger event.
 * @param model - the bar's fold (its open debts and parked side-branches).
 * @param label - display project to fold.
 * @param pin - the human's pinned mainline task for this project, if any.
 * @param nowMs - wall-clock instant.
 * @returns The project tree.
 */
export function buildProjectTree(
  events: readonly AttentionEvent[],
  model: FoldModel,
  label: string,
  pin: string | undefined,
  nowMs: number,
): ProjectTree {
  const from = nowMs - TREE_WINDOW_MS
  const byTask = new Map<string, AttentionEvent[]>()
  for (const e of events) {
    if (displayProject(e.project) !== label || e.t < from || e.t > nowMs) continue
    const list = byTask.get(e.task)
    if (list === undefined) byTask.set(e.task, [e])
    else list.push(e)
  }
  // Open debts of this project, latest per task; debts older than the window
  // still belong on the tree — they are exactly the unresolved branches.
  const debtOf = new Map<string, NeedsYouItem>()
  for (const debt of [...model.needsYou, ...model.parked].sort((a, b) => a.t - b.t)) {
    if (displayProject(debt.project) === label) debtOf.set(debt.task, debt)
  }

  const tasks: TreeTask[] = []
  for (const [task, list] of byTask) {
    const sorted = [...list].sort((a, b) => a.t - b.t)
    const first = sorted[0] as AttentionEvent
    const lastEvent = sorted[sorted.length - 1] as AttentionEvent
    const debt = debtOf.get(task) ?? null
    let state: TreeTask['state']
    if (debt !== null) state = debt.kind === PARK_KIND ? 'parked' : 'waiting'
    else if (lastEvent.event === 'done' || lastEvent.event === 'drop') state = lastEvent.event
    else state = nowMs - lastEvent.t <= LANE_IDLE_MS ? 'running' : 'stalled'
    tasks.push({
      task,
      surface: first.surface,
      start: first.t,
      last: lastEvent.t,
      activeDur: chainedActive(sorted.map(e => e.t)),
      state,
      debt,
    })
  }
  for (const [task, debt] of debtOf) {
    if (byTask.has(task)) continue
    tasks.push({
      task,
      surface: debt.surface,
      start: debt.t,
      last: debt.t,
      activeDur: 0,
      state: debt.kind === PARK_KIND ? 'parked' : 'waiting',
      debt,
    })
  }

  const ranked = [...tasks]
    .sort((a, b) => b.activeDur - a.activeDur || b.last - a.last)
    .map(t => t.task)
  // A pin that went quiet this week still names the mainline and stays pickable.
  const candidates = pin === undefined || ranked.includes(pin) ? ranked : [pin, ...ranked]
  const pinned = pin !== undefined
  const mainline = pin ?? candidates[0] ?? null
  const main = tasks.find(t => t.task === mainline) ?? null
  const others = tasks.filter(t => t !== main)
  const open = (t: TreeTask): boolean => t.state !== 'done' && t.state !== 'drop'
  return {
    label,
    mainline,
    pinned,
    mainNodes: (mainline === null ? [] : byTask.get(mainline) ?? []).map(e => e.t).sort((a, b) => a - b),
    main,
    mainDur: main?.activeDur ?? 0,
    branchDur: others.reduce((sum, t) => sum + t.activeDur, 0),
    branches: others.filter(open).sort((a, b) => a.start - b.start),
    settled: others.filter(t => !open(t)).sort((a, b) => b.last - a.last),
    candidates,
  }
}

/** localStorage key holding `{ [display project]: pinned mainline task }`. */
export const MAINLINE_PINS_KEY = 'dsh.taskflow.mainlines'

/**
 * Read the pinned mainlines. Storage can be missing or blocked; the tree
 * then falls back to its suggestion.
 * @returns Pins by display project.
 */
export function readPins(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(MAINLINE_PINS_KEY) ?? '{}')
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] =>
      typeof entry[1] === 'string'))
  } catch {
    // Unreadable or corrupt storage: no pins, the suggestion stands in.
    return {}
  }
}

/**
 * Persist the pinned mainlines.
 * @param pins - pins by display project.
 */
export function writePins(pins: Record<string, string>): void {
  try {
    window.localStorage.setItem(MAINLINE_PINS_KEY, JSON.stringify(pins))
  } catch {
    // Storage unavailable: the pin still holds for this session in memory.
  }
}
