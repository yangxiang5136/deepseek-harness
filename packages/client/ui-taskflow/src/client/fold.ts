/**
 * TaskFlow fold engine: pure functions from ledger events to the bar's render
 * model (spec §6 v3.0). Ported from prototype pkg-26 `buildModel` and its
 * render-side grouping passes; no I/O, no React, no ctx — the plugin folds a
 * parsed ledger snapshot plus a wall-clock instant and nothing else, so every
 * fold semantic (seal ≥ 60 s, lane homing, series packing, fragment
 * aggregation, idle pause, popover grouping) is unit-testable against a real
 * ledger fixture.
 */

// ---- Tunable constants (prototype pkg-26 values, manifest §4) ----

/** Idle gap that pauses the current task and breaks a pack chain. */
export const IDLE_PAUSE_MS = 30 * 60 * 1000
/** Minimum done-after-needs-you gap that counts as a human seal (decision ⑰). */
export const CLOSE_MS = 60 * 1000
/** Lane silence beyond this is a suspected interruption (no-heartbeat). */
export const LANE_IDLE_MS = 60 * 60 * 1000
/** Segments shorter than this aggregate into a 零碎 block. */
export const FRAG_MS = 60 * 1000
/** Full ledger re-read period (client poll). */
export const REFRESH_MS = 10 * 1000
/** History strip proportion model width; rendering resolves via %/cqw. */
export const MODEL_W = 900
/** Fallback chip-row width (px) while the rendered row width is unobserved. */
export const CHIP_ROW_W = 760

/** One ledger event with its timestamp parsed to epoch ms. */
export interface AttentionEvent {
  /** Epoch ms parsed from `ts` (always finite; unparsable lines are dropped). */
  t: number
  /** Raw ISO-8601 string as written — seal requests pin a needs-you by it. */
  ts: string
  surface: string
  project: string
  task: string
  event: string
  payload: Record<string, unknown> | null
}

/** One closed span of the human's attention on the history strip. */
export interface HistorySegment {
  start: number
  end: number
  task: string
  project: string
  surface: string
  dur: number
  /** True when the closing verb was `drop`. */
  drop: boolean
  /** The closing done's `payload.note` — the structured "what I did" line. */
  note: string | null
}

/** One delegated-AI lane opened by an orchestrator's `delegate`. */
export interface Lane {
  /** The orchestrator task that opened the lane (its closing boundary). */
  delegateTask: string
  project: string
  /** Engine label from `payload.engine`, falling back to the surface. */
  engine: string
  openTs: number
  /** Last dsh-side event instant; silence beyond LANE_IDLE_MS interrupts. */
  lastDshTs: number
  status: 'running' | 'interrupted' | 'closed' | 'taken'
  /** The dsh-side task currently labelling the lane (start/switch). */
  labelTask: string | null
  /** Sub-build tick count (dsh-side done/drop). */
  ticks: number
  closeTs?: number
}

/** The single current mainline task (unique, per spec's one-mainline model). */
export interface CurrentTask {
  start: number
  lastEvt: number
  task: string
  project: string
  surface: string
  /** True when idle beyond IDLE_PAUSE_MS (auto-paused, not accumulating). */
  paused: boolean
}

/** One open seal debt for the title popover's 待收口 group. */
export interface NeedsYouItem {
  t: number
  /** Raw `ts` of the needs-you event — the seal request's `resolvesTs` pin. */
  ts: string
  kind: string
  task: string
  project: string
  /** How long the debt has been open, ms. */
  owed: number
  payload: Record<string, unknown> | null
  surface: string
}

/**
 * A mainline task preempted by another start/switch but never terminated by
 * its own done/drop (decision ㉕): the session behind it is presumed still
 * working — a parallel interactive chat is running work even though the
 * human's attention moved on. It stays visible as a running chip until its
 * own terminal arrives, the task is re-started (back to current), an open
 * debt takes over, or LANE_IDLE_MS of silence turns it no-heartbeat.
 */
export interface BackgroundTask {
  task: string
  project: string
  surface: string
  /** When its mainline span began (the chip's running-since instant). */
  start: number
  /** Last event carrying the same project+task; silence is measured from here. */
  lastEvt: number
  status: 'running' | 'interrupted'
}

/** The folded render model. */
export interface FoldModel {
  history: HistorySegment[]
  current: CurrentTask | null
  /** Live lanes only (`running` | `interrupted`); closed/taken are dropped. */
  lanes: Lane[]
  /** Preempted-but-unterminated session tasks (decision ㉕). */
  background: BackgroundTask[]
  /** Open debts, longest-owed first. */
  needsYou: NeedsYouItem[]
}

/**
 * Parse one ledger `ts`. Both `-04:00` and `-0400` offsets appear in the real
 * ledger; Safari-era Date parsing needs the colon, so it is inserted.
 * @param s - raw timestamp value.
 * @returns Epoch ms, or NaN when unparsable.
 */
export function parseTs(s: unknown): number {
  if (typeof s !== 'string') return NaN
  return new Date(s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')).getTime()
}

/**
 * Parse raw JSONL ledger text into timestamped events. Broken or shapeless
 * lines are skipped (spec §7: a corrupt line never poisons the fold), as are
 * lines whose timestamp does not parse.
 * @param text - raw ledger file content.
 * @returns Events in file order.
 */
export function parseLedgerText(text: string): AttentionEvent[] {
  const events: AttentionEvent[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let value: unknown
    try {
      value = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (typeof value !== 'object' || value === null) continue
    const record = value as Record<string, unknown>
    if (
      typeof record.ts !== 'string' || typeof record.surface !== 'string'
      || typeof record.project !== 'string' || typeof record.task !== 'string'
      || typeof record.event !== 'string'
    ) continue
    const t = parseTs(record.ts)
    if (!Number.isFinite(t)) continue
    events.push({
      t,
      ts: record.ts,
      surface: record.surface,
      project: record.project,
      task: record.task,
      event: record.event,
      payload: typeof record.payload === 'object' && record.payload !== null
        ? record.payload as Record<string, unknown>
        : null,
    })
  }
  return events
}

/**
 * Same-calendar-day test in the viewer's local zone (the strip shows today).
 * @param t - instant under test, epoch ms.
 * @param ref - reference instant, epoch ms.
 * @returns True when both fall on one local calendar day.
 */
export function sameDay(t: number, ref: number): boolean {
  const a = new Date(t)
  const b = new Date(ref)
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate()
}

/**
 * Loose project identity for pack affinity: lowercase alphanumerics, with the
 * digital-me ≈ DME alias folded (prototype v11 normalizeProject).
 * @param p - raw project string.
 * @returns Normalized identity token.
 */
export function normalizeProject(p: string): string {
  const n = p.toLowerCase().replace(/[^a-z0-9]/g, '')
  return n === 'digitalme' || n === 'dme' ? 'digitalme' : n
}

/**
 * Longest common string prefix.
 * @param a - first string.
 * @param b - second string.
 * @returns The shared prefix (possibly empty).
 */
export function strLcp(a: string, b: string): string {
  let i = 0
  const m = Math.min(a.length, b.length)
  while (i < m && a.charAt(i) === b.charAt(i)) i++
  return a.slice(0, i)
}

/**
 * Trim a prefix back to a word boundary so pack labels end on a whole token
 * (prototype v11 toToken: drop the trailing partial word and separators).
 * @param s - candidate prefix.
 * @returns The prefix cut at the last space/`·` boundary, separators stripped.
 */
export function toToken(s: string): string {
  let t = s.replace(/[\s\-_·:/。，,、]+$/g, '')
  const i = Math.max(t.lastIndexOf(' '), t.lastIndexOf('·'))
  if (i > 0) t = t.slice(0, i)
  return t.replace(/[\s\-_·:/。，,、]+$/g, '')
}

/**
 * Text width heuristic (px at 10px font): CJK ≈ 10, ASCII ≈ 5.5. The
 * fallback seat where canvas measurement is unavailable, and the pure-fold
 * default so tests stay DOM-free.
 * @param text - label text.
 * @returns Estimated pixel width.
 */
export function estTextW(text: string): number {
  let w = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    const wide = (c >= 0x1100 && c <= 0x11FF) || (c >= 0x2E80 && c <= 0x9FFF)
      || (c >= 0xAC00 && c <= 0xD7AF) || (c >= 0xF900 && c <= 0xFAFF)
      || (c >= 0xFE30 && c <= 0xFE4F) || (c >= 0xFF00 && c <= 0xFF60)
      || (c >= 0xFFE0 && c <= 0xFFE6)
    w += wide ? 10 : 5.5
  }
  return w
}

/** Low-saturation project palette (decision ㉑: color distinguishes, never shouts). */
export const PALETTE = [
  '#e8eef5', '#f4e8f0', '#e9f2ea', '#f5efe0', '#eaecf4',
  '#f3e8f5', '#f5eee3', '#e6f2f4', '#eef0f2', '#f5e9ea',
] as const

/**
 * Stable project → palette color (prototype hashColor).
 * @param s - project string.
 * @returns One palette hex.
 */
export function paletteColor(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return PALETTE[h % PALETTE.length] as string
}

/**
 * Human-scale duration: `45s`, `12m`, `2h05m`.
 * @param ms - duration in ms.
 * @returns Compact label.
 */
export function fmtDur(ms: number): string {
  if (!Number.isFinite(ms)) return '0s'
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`
  const m = Math.round(ms / 60_000)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h${m % 60}m`
}

/**
 * Fold today's ledger events into the render model. Direct port of prototype
 * pkg-26 `buildModel` (v17 past/present layering, v13 lane homing, v18
 * no-heartbeat, decision ⑰ seal timing), with one deliberate alignment: the
 * seal-closed judgment matches on project+task like the host gate
 * (`isNeedsYouOpen`), where the prototype matched task alone.
 * @param events - parsed ledger events (any order; refiltered to `now`'s day).
 * @param nowMs - wall-clock instant of the fold.
 * @returns The folded model.
 */
export function buildModel(events: readonly AttentionEvent[], nowMs: number): FoldModel {
  const today = events.filter(e => sameDay(e.t, nowMs)).sort((a, b) => a.t - b.t)
  const segments: HistorySegment[] = []
  const lanes: Lane[] = []
  let background: BackgroundTask[] = []
  let open: AttentionEvent | null = null
  let activeLane: Lane | null = null
  // v17: the dsh-side task in flight, pasted back as its own segment on done.
  let dshOpen: AttentionEvent | null = null
  const closeOpen = (boundary: AttentionEvent): void => {
    if (open !== null && boundary.t > open.t) {
      const own = boundary.task === open.task
        && (boundary.event === 'done' || boundary.event === 'drop')
      segments.push({
        start: open.t,
        end: boundary.t,
        task: open.task,
        project: open.project,
        surface: open.surface,
        dur: boundary.t - open.t,
        drop: own && boundary.event === 'drop',
        note: own && typeof boundary.payload?.note === 'string' ? boundary.payload.note : null,
      })
      // Decision ㉕: preemption (not the task's own terminal) means the
      // session behind it is presumed still working — keep it running in the
      // background layer. The attention segment above stays as-is: the strip
      // accounts attention, the chip row accounts running work.
      if (!own) {
        background.push({
          task: open.task,
          project: open.project,
          surface: open.surface,
          start: open.t,
          lastEvt: open.t,
          status: 'running',
        })
      }
      open = null
    }
  }
  for (const e of today) {
    const isDsh = e.surface === 'dsh'
    if (e.event === 'delegate' && !isDsh) {
      // v17: parallel lanes — every unsealed delegate opens its own row; the
      // newest lane takes over dsh-event routing (v13 handover).
      const lane: Lane = {
        delegateTask: e.task,
        project: e.project,
        engine: typeof e.payload?.engine === 'string' ? e.payload.engine : e.surface,
        openTs: e.t,
        lastDshTs: e.t,
        status: 'running',
        labelTask: null,
        ticks: 0,
      }
      lanes.push(lane)
      activeLane = lane
      continue
    }
    if (activeLane !== null && isDsh) {
      if (e.t - activeLane.lastDshTs > LANE_IDLE_MS) {
        // Stale lane: mark interrupted and let this event fall through to the
        // mainline rules (prototype behavior — no continue).
        activeLane.status = 'interrupted'
        activeLane = null
        dshOpen = null
      } else {
        activeLane.lastDshTs = e.t
        if (e.event === 'start' || e.event === 'switch') {
          activeLane.labelTask = e.task
          dshOpen = e
        } else if (e.event === 'done' || e.event === 'drop') {
          activeLane.ticks++
          // v17: a dsh build task closing pastes back onto the history strip
          // as an independent segment and closes the lane row.
          if (dshOpen !== null && e.task === dshOpen.task) {
            segments.push({
              start: dshOpen.t,
              end: e.t,
              task: dshOpen.task,
              project: dshOpen.project,
              surface: dshOpen.surface,
              dur: Math.max(0, e.t - dshOpen.t),
              drop: e.event === 'drop',
              note: null,
            })
            activeLane.status = 'closed'
            activeLane.closeTs = e.t
            activeLane = null
            dshOpen = null
          }
        }
        // dsh-side sub-delegates only refresh the heartbeat.
        continue
      }
    }
    // v17: a terminal closes every running lane whose delegateTask matches —
    // the orchestrator's own done/drop is the lane's closing boundary.
    if (e.event === 'done' || e.event === 'drop') {
      for (const lane of lanes) {
        if (lane.status === 'running' && lane.delegateTask === e.task) {
          lane.status = 'closed'
          lane.closeTs = e.t
          if (activeLane === lane) activeLane = null
        }
      }
      // Decision ㉕: the task's own late terminal ends its background run.
      background = background.filter(b => !(b.project === e.project && b.task === e.task))
    }
    // v17: start/switch always switches; done/drop closes current only for
    // the same task (an unrelated completion never touches the mainline).
    if (e.event === 'start' || e.event === 'switch') {
      closeOpen(e)
      open = e
      // Decision ㉕: coming back to a preempted task returns it to current —
      // never current and background at once.
      background = background.filter(b => !(b.project === e.project && b.task === e.task))
    } else if ((e.event === 'done' || e.event === 'drop') && open !== null && e.task === (open).task) {
      closeOpen(e)
    }
  }
  // v17: an unclosed task is not history — it is the current mainline entry.
  let current: CurrentTask | null = null
  if (open !== null) {
    const opened: AttentionEvent = open
    let lastEvt = opened.t
    for (const e of today) {
      if (e.task === opened.task && e.t > lastEvt) lastEvt = e.t
    }
    current = {
      start: opened.t,
      lastEvt,
      task: opened.task,
      project: opened.project,
      surface: opened.surface,
      paused: nowMs - lastEvt > IDLE_PAUSE_MS,
    }
  }
  // v18: a silent running lane turns no-heartbeat — flagged, never removed.
  for (const lane of lanes) {
    if (lane.status === 'running' && nowMs - lane.lastDshTs > LANE_IDLE_MS) lane.status = 'interrupted'
  }
  // Decision ㉕: a background task's heartbeat is any same-identity event;
  // silence beyond LANE_IDLE_MS turns it no-heartbeat (fail-loud, kept).
  for (const b of background) {
    for (const e of today) {
      if (e.project === b.project && e.task === b.task && e.t > b.lastEvt) b.lastEvt = e.t
    }
    if (nowMs - b.lastEvt > LANE_IDLE_MS) b.status = 'interrupted'
  }
  const needsYou: NeedsYouItem[] = []
  for (const e of today) {
    if (e.event !== 'needs-you') continue
    // Decision ⑰: sealed only by a terminal ≥ CLOSE_MS later — the filing
    // AI's own wrap-up seconds after never counts as the human's seal.
    const closed = today.some(d => (d.event === 'done' || d.event === 'drop')
      && d.project === e.project && d.task === e.task && d.t - e.t >= CLOSE_MS)
    if (!closed) {
      needsYou.push({
        t: e.t,
        ts: e.ts,
        kind: typeof e.payload?.kind === 'string' ? e.payload.kind : '—',
        task: e.task,
        project: e.project,
        owed: nowMs - e.t,
        payload: e.payload,
        surface: e.surface,
      })
    }
  }
  needsYou.sort((a, b) => b.owed - a.owed)
  // v17: a lane whose debt is open leaves the running row — the debt entry
  // in the title popover takes over (never shown twice).
  for (const lane of lanes) {
    if (needsYou.some(n => n.task === lane.delegateTask
      || (lane.labelTask !== null && n.task === lane.labelTask))) lane.status = 'taken'
  }
  // Decision ㉕: same single-presentation rule for background tasks.
  background = background.filter(b =>
    !needsYou.some(n => n.project === b.project && n.task === b.task))
  return {
    history: segments,
    current,
    lanes: lanes.filter(l => l.status !== 'closed' && l.status !== 'taken'),
    background,
    needsYou,
  }
}

/** One packed series of finished same-project, shared-prefix segments. */
export interface Pack {
  members: Array<{ seg: HistorySegment; idx: number }>
  /** Longest common prefix across member task names (token-trimmed). */
  lcp: string
  /** Display prefix: the lcp when meaningful, else the normalized project. */
  prefix: string
  /** Normalized project identity. */
  project: string
  totalDur: number
  /** History index of the last member (the outer loop's skip target). */
  lastIdx: number
}

/** One history-strip item: a lone segment, a 零碎 block, or a packed series. */
export type TimelineItem =
  | { kind: 'seg'; seg: HistorySegment; idx: number }
  | { kind: 'agg'; frags: HistorySegment[] }
  | { kind: 'pack'; pack: Pack; idx: number; openRight: boolean }

/**
 * Group the history into strip items: packed series (prefix affinity + gap
 * chain within one normalized project, ≥ 2 members), 零碎 aggregation
 * (segments under FRAG_MS), lone segments otherwise. Prototype v11/v12
 * packing with the v17 openRight judgment against the current task.
 * @param model - folded model.
 * @param nowMs - wall-clock instant (a just-closed segment is not packable).
 * @returns Items in history order.
 */
export function buildTimeline(model: FoldModel, nowMs: number): TimelineItem[] {
  const history = model.history
  const packStart = new Map<number, Pack>()
  const packable = (s: HistorySegment): boolean => s.end < nowMs - 1000
  interface Member { seg: HistorySegment; idx: number }
  // first/last ride along so member access never needs index arithmetic.
  interface Group { members: Member[]; first: Member; last: Member; lcp: string; project: string }
  const openGroup = (seg: HistorySegment, idx: number): Group => {
    const member: Member = { seg, idx }
    return { members: [member], first: member, last: member, lcp: seg.task, project: normalizeProject(seg.project) }
  }
  let group: Group | null = null
  const closeGroup = (): void => {
    if (group !== null && group.members.length >= 2) {
      packStart.set(group.first.idx, {
        members: group.members,
        lcp: group.lcp,
        prefix: group.lcp.length >= 3 ? group.lcp : group.project,
        project: group.project,
        totalDur: group.members.reduce((a, m) => a + m.seg.dur, 0),
        lastIdx: group.last.idx,
      })
    }
    group = null
  }
  for (const [i, s] of history.entries()) {
    if (!packable(s)) {
      closeGroup()
      continue
    }
    if (group === null) {
      group = openGroup(s, i)
      continue
    }
    const projOk = normalizeProject(s.project) === group.project
    // Idle break: a gap at or beyond IDLE_PAUSE_MS severs the chain.
    const gapOk = s.start - group.last.seg.end < IDLE_PAUSE_MS
    const newLcp = toToken(strLcp(group.lcp, s.task))
    if (projOk && gapOk && newLcp.length >= 2) {
      const member: Member = { seg: s, idx: i }
      group.members.push(member)
      group.last = member
      group.lcp = newLcp
    } else {
      closeGroup()
      group = openGroup(s, i)
    }
  }
  closeGroup()

  const items: TimelineItem[] = []
  let aggRun: HistorySegment[] | null = null
  const flushAgg = (): void => {
    if (aggRun !== null) {
      items.push({ kind: 'agg', frags: aggRun })
      aggRun = null
    }
  }
  for (let i = 0; i < history.length; i++) {
    const s = history[i]
    if (s === undefined) continue
    const pack = packStart.get(i)
    if (pack !== undefined) {
      flushAgg()
      // v17: with running segments off the strip, series continuation is
      // judged against the current task (open right edge = still growing).
      const openRight = model.current !== null
        && normalizeProject(model.current.project) === pack.project
        && toToken(strLcp(pack.lcp, model.current.task)).length >= 2
      items.push({ kind: 'pack', pack, idx: i, openRight })
      i = pack.lastIdx
    } else if (s.dur < FRAG_MS) {
      aggRun ??= []
      aggRun.push(s)
    } else {
      flushAgg()
      items.push({ kind: 'seg', seg: s, idx: i })
    }
  }
  flushAgg()
  return items
}

/** One running chip: the current mainline task or a live delegated lane. */
export interface Chip {
  kind: 'cur' | 'run' | 'bg'
  /** Source label: surface for the current task, engine for a lane. */
  src: string
  task: string
  project: string
  start: number
  /** Current-task idle flag (`cur` only). */
  paused?: boolean
  /** Lane sub-build count (`run` only). */
  ticks?: number
}

/**
 * The running chips in display order: current first, then delegated lanes
 * and preempted background sessions (decision ㉕) merged by when they began.
 * Interrupted entries of either kind are excluded — they live in the
 * popover's no-heartbeat group (see {@link noHeartbeat}).
 * @param model - folded model.
 * @returns Chips, possibly empty.
 */
export function buildChips(model: FoldModel): Chip[] {
  const chips: Chip[] = []
  if (model.current !== null) {
    chips.push({
      kind: 'cur',
      src: model.current.surface,
      task: model.current.task,
      project: model.current.project,
      start: model.current.start,
      paused: model.current.paused,
    })
  }
  const running: Chip[] = [
    ...model.lanes.filter(l => l.status !== 'interrupted').map((lane): Chip => ({
      kind: 'run',
      src: lane.engine,
      task: lane.labelTask ?? lane.delegateTask,
      project: lane.project,
      start: lane.openTs,
      ticks: lane.ticks,
    })),
    ...model.background.filter(b => b.status === 'running').map((b): Chip => ({
      kind: 'bg',
      src: b.surface,
      task: b.task,
      project: b.project,
      start: b.start,
    })),
  ]
  running.sort((a, b) => a.start - b.start)
  chips.push(...running)
  return chips
}

/**
 * No-heartbeat lanes for the popover's 无心跳 group — fail-loud, never
 * silently dropped (decision: an interrupted lane stays visible).
 * @param model - folded model.
 * @returns Interrupted lanes by open time.
 */
export function interruptedLanes(model: FoldModel): Lane[] {
  return model.lanes.filter(l => l.status === 'interrupted').sort((a, b) => a.openTs - b.openTs)
}

/** One silent entry of the popover's 无心跳 group, lane or background. */
export interface NoHeartbeatItem {
  task: string
  project: string
  /** Last sign of life; the group shows how long since. */
  lastTs: number
}

/**
 * Everything silent beyond LANE_IDLE_MS — interrupted delegate lanes plus
 * interrupted background sessions (decision ㉕), one fail-loud group.
 * @param model - folded model.
 * @returns Items, most recently alive last.
 */
export function noHeartbeat(model: FoldModel): NoHeartbeatItem[] {
  const items: NoHeartbeatItem[] = [
    ...interruptedLanes(model).map(lane => ({
      task: lane.labelTask ?? lane.delegateTask,
      project: lane.project,
      lastTs: lane.lastDshTs,
    })),
    ...model.background.filter(b => b.status === 'interrupted').map(b => ({
      task: b.task,
      project: b.project,
      lastTs: b.lastEvt,
    })),
  ]
  return items.sort((a, b) => a.lastTs - b.lastTs)
}

/** Text-width seat: real DOM measurement when available, estTextW otherwise. */
export type TextMeasure = (text: string) => number

/**
 * Estimated rendered width of one chip (dot + gaps + task + source tag +
 * padding + row gap), prototype v21 formula tightened toward the rendered
 * geometry: the task label carries the paused suffix when it renders, is
 * capped by the 150px CSS max-width, and the source tag scales to its 9px
 * font off the 10px measuring basis.
 * @param chip - the chip.
 * @param measure - text-width seat (defaults to the character heuristic).
 * @returns Estimated px width.
 */
export function chipW(chip: Chip, measure: TextMeasure = estTextW): number {
  const task = chip.kind === 'cur' && chip.paused === true ? `${chip.task} · 闲置` : chip.task
  return 7 + 5 + Math.min(measure(task), 150) + 5 + (measure(chip.src) * 0.9 + 12) + 18 + 6
}

/**
 * Width-driven chip split (v21: no count cap — the row takes what fits, the
 * rest collapses into a static +N whose detail lives in the title popover's
 * 更多 running group). The first chip always shows.
 * @param chips - chips in display order.
 * @param rowWidth - usable row width in px.
 * @param measure - text-width seat (defaults to the character heuristic).
 * @returns Shown prefix and overflowed remainder.
 */
export function splitChips(
  chips: readonly Chip[],
  rowWidth: number = CHIP_ROW_W,
  measure: TextMeasure = estTextW,
): {
  shown: Chip[]
  overflow: Chip[]
} {
  let accW = 0
  let splitIdx = 0
  for (const [i, chip] of chips.entries()) {
    const w = chipW(chip, measure)
    if (i > 0 && accW + w > rowWidth) break
    accW += w
    splitIdx++
  }
  return { shown: chips.slice(0, splitIdx), overflow: chips.slice(splitIdx) }
}
