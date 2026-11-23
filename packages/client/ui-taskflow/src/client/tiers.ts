/**
 * Display tiers for open debts (Sean, 2026-11-23). The tray used to list every
 * debt the same way, oldest first; this fold groups debts by task and sorts
 * each task into one of four tiers so the first glance holds only the
 * mainline and what truly waits on a decision. It changes what is shown,
 * never the ledger: every debt stays open until its exact seal.
 */

import type { TaskflowMainline } from '@deepseek-ai/dsh-api-remotes/client'
import { displayProject, type AttentionEvent, type FoldModel, type NeedsYouItem } from './fold.ts'

/** A task counts as fresh while it was heard from inside this window. */
export const FRESH_MS = 7 * 24 * 60 * 60 * 1000
/** Days drawn in a mainline's activity strip. */
export const HEAT_DAYS = 14
/** Rows a tier shows before 还有 N 件. */
export const TIER_ROWS = 5

const DAY_MS = 24 * 60 * 60 * 1000
const DECIDING = new Set(['decision', 'merge'])

/** Every open debt of one task, shown as one row. */
export interface TaskGroup {
  /** Exact ledger project (identity for seals), not the display label. */
  project: string
  task: string
  /** Open debts, newest first. */
  debts: NeedsYouItem[]
  /** Last ledger event of this task, epoch ms. */
  last: number
  /** True when any debt is a decision or a merge. */
  deciding: boolean
}

/** One pinned mainline with what the ledger knows about it. */
export interface MainlineView extends TaskflowMainline {
  /** Open debts on the mainline task, newest first; never folded by kind. */
  debts: NeedsYouItem[]
  /** Last ledger event of the task; null when the ledger has none. */
  last: number | null
  /** Events per local day, oldest first, {@link HEAT_DAYS} entries ending today. */
  heat: number[]
  /** Notes of the task's start events, oldest first: the steps taken so far. */
  steps: Array<{ t: number; note: string }>
}

/** One project's folded tiers. */
export interface ProjectTiers {
  label: string
  mainlines: MainlineView[]
  /** Fresh tasks holding a decision or merge, the human's ordering first. */
  decide: TaskGroup[]
  /** Fresh tasks holding only reviews. */
  look: TaskGroup[]
  /** Tasks silent beyond {@link FRESH_MS}. */
  old: TaskGroup[]
  /** Open `park` debts; never mixed into the tiers above. */
  parked: NeedsYouItem[]
  /** Debts waiting on the mainlines plus tasks in `decide`. */
  waiting: number
}

function dayStart(t: number): number {
  const d = new Date(t)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/**
 * Fold every project's tiers.
 * @param events - parsed ledger events.
 * @param model - the bar's fold (open debts and parked side-branches).
 * @param pins - pinned mainlines by display project.
 * @param nowMs - wall-clock instant.
 * @returns Tiers by display project, for every project with a debt or a pin.
 */
export function buildTiers(
  events: readonly AttentionEvent[],
  model: FoldModel,
  pins: Readonly<Record<string, readonly TaskflowMainline[]>>,
  nowMs: number,
): Map<string, ProjectTiers> {
  const last = new Map<string, number>()
  const key = (project: string, task: string): string => `${displayProject(project)}\0${task}`
  for (const e of events) {
    const k = key(e.project, e.task)
    if ((last.get(k) ?? 0) < e.t) last.set(k, e.t)
  }
  const out = new Map<string, ProjectTiers>()
  const tiersOf = (label: string): ProjectTiers => {
    let tiers = out.get(label)
    if (tiers === undefined) {
      tiers = { label, mainlines: [], decide: [], look: [], old: [], parked: [], waiting: 0 }
      out.set(label, tiers)
    }
    return tiers
  }
  const today = dayStart(nowMs)
  for (const [label, list] of Object.entries(pins)) {
    const tiers = tiersOf(label)
    for (const pin of list) {
      const own = events.filter(e => displayProject(e.project) === label && e.task === pin.task)
      const heat = Array.from({ length: HEAT_DAYS }, () => 0)
      for (const e of own) {
        const slot = HEAT_DAYS - 1 - Math.round((today - dayStart(e.t)) / DAY_MS)
        if (slot >= 0 && slot < HEAT_DAYS) heat[slot] = (heat[slot] ?? 0) + 1
      }
      tiers.mainlines.push({
        ...pin,
        debts: [],
        last: last.get(`${label}\0${pin.task}`) ?? null,
        heat,
        steps: own
          .filter(e => e.event === 'start' && typeof e.payload?.note === 'string' && e.payload.note.trim() !== '')
          .map(e => ({ t: e.t, note: e.payload?.note as string })),
      })
    }
  }
  const groups = new Map<string, TaskGroup>()
  for (const debt of model.needsYou) {
    const label = displayProject(debt.project)
    const main = out.get(label)?.mainlines.find(m => m.task === debt.task)
    if (main !== undefined) {
      main.debts.push(debt)
      continue
    }
    const k = key(debt.project, debt.task)
    const group = groups.get(k)
    if (group === undefined) {
      groups.set(k, {
        project: debt.project, task: debt.task, debts: [debt], last: last.get(k) ?? debt.t, deciding: DECIDING.has(debt.kind),
      })
    } else {
      group.debts.push(debt)
      group.deciding = group.deciding || DECIDING.has(debt.kind)
    }
  }
  for (const group of groups.values()) {
    group.debts.sort((a, b) => b.t - a.t)
    const tiers = tiersOf(displayProject(group.project))
    if (nowMs - group.last > FRESH_MS) tiers.old.push(group)
    else if (group.deciding) tiers.decide.push(group)
    else tiers.look.push(group)
  }
  for (const debt of model.parked) tiersOf(displayProject(debt.project)).parked.push(debt)
  for (const tiers of out.values()) {
    const newest = (a: TaskGroup, b: TaskGroup): number => b.last - a.last
    tiers.decide.sort(newest)
    tiers.look.sort(newest)
    tiers.old.sort(newest)
    for (const main of tiers.mainlines) main.debts.sort((a, b) => b.t - a.t)
    tiers.waiting = tiers.mainlines.reduce((sum, m) => sum + m.debts.length, 0) + tiers.decide.length
  }
  return out
}
