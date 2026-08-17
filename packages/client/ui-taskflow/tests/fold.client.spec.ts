/**
 * Fold-engine semantics against synthetic ledgers plus the real bus ledger
 * (2026-08 month file, copied verbatim into fixtures/). The fixture
 * expectations were hand-derived from the ledger by walking spec §6 v3.0
 * — if a port change breaks one, suspect the port, not the fixture.
 */

// The fixture's day grouping (`sameDay`) runs in the viewer's zone; pin the
// ledger's own zone so the suite folds the same "today" on every machine.
process.env.TZ = 'America/New_York'

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  activeSpan, buildChips, buildModel, buildTimeline, CHIP_ROW_W, chipW, CLOSE_MS, estTextW, fmtDur,
  IDLE_PAUSE_MS, interruptedLanes, LANE_IDLE_MS, noHeartbeat, normalizeProject, PALETTE, paletteColor,
  parseLedgerText, parseTs, splitChips, strLcp, toToken,
  type AttentionEvent, type Chip,
} from '../src/client/fold.ts'

/** Noon-anchored base instant: hour-scale offsets stay inside one local day. */
const T0 = Date.parse('2026-08-15T08:00:00-04:00')

/** Build one parsed event at an epoch-ms instant. */
function ev(event: string, atMs: number, over: Partial<AttentionEvent> = {}): AttentionEvent {
  return {
    t: atMs,
    ts: new Date(atMs).toISOString(),
    surface: 'claude-code',
    project: 'digital-me',
    task: 't',
    event,
    payload: null,
    ...over,
  }
}

describe('parseTs / parseLedgerText', () => {
  it('parses both offset spellings the real ledger contains to one instant', () => {
    expect(parseTs('2026-08-15T16:26:06-0400')).toBe(parseTs('2026-08-15T16:26:06-04:00'))
    expect(Number.isNaN(parseTs('not a date'))).toBe(true)
    expect(Number.isNaN(parseTs(42))).toBe(true)
  })

  it('skips corrupt, shapeless, and unparsable-ts lines without poisoning the rest', () => {
    const text = [
      JSON.stringify({ ts: '2026-08-15T08:00:00-04:00', surface: 's', project: 'p', task: 't', event: 'start' }),
      '{broken json',
      JSON.stringify({ ts: 'garbage', surface: 's', project: 'p', task: 't', event: 'done' }),
      JSON.stringify({ event: 'done' }),
      '"just a string"',
      '',
      JSON.stringify({ ts: '2026-08-15T08:01:00-04:00', surface: 's', project: 'p', task: 't', event: 'done', payload: { note: 'n' } }),
    ].join('\n')
    const events = parseLedgerText(text)
    expect(events).toHaveLength(2)
    expect(events[0]?.event).toBe('start')
    expect(events[1]?.payload).toEqual({ note: 'n' })
  })
})

describe('seal timing (decision ⑰, CLOSE_MS)', () => {
  it('keeps a debt open when the terminal lands within CLOSE_MS (AI wrap-up)', () => {
    const model = buildModel([
      ev('start', T0),
      ev('needs-you', T0 + 1000, { payload: { kind: 'review', ref: 'r' } }),
      ev('done', T0 + 1000 + CLOSE_MS - 1),
    ], T0 + 3_600_000)
    expect(model.needsYou).toHaveLength(1)
    expect(model.needsYou[0]).toMatchObject({ kind: 'review', task: 't', project: 'digital-me' })
    // The seal request pins this exact event by its raw ts string.
    expect(model.needsYou[0]?.ts).toBe(new Date(T0 + 1000).toISOString())
  })

  it('closes the debt when a terminal lands at least CLOSE_MS later', () => {
    for (const terminal of ['done', 'drop']) {
      const model = buildModel([
        ev('start', T0),
        ev('needs-you', T0 + 1000),
        ev(terminal, T0 + 1000 + CLOSE_MS),
      ], T0 + 3_600_000)
      expect(model.needsYou).toHaveLength(0)
    }
  })

  it('matches the sealing terminal on project+task like the host gate', () => {
    const model = buildModel([
      ev('needs-you', T0),
      ev('done', T0 + CLOSE_MS, { project: 'other' }),
    ], T0 + 3_600_000)
    expect(model.needsYou).toHaveLength(1)
  })

  it('sorts open debts longest-owed first', () => {
    const model = buildModel([
      ev('needs-you', T0, { task: 'old' }),
      ev('needs-you', T0 + 60_000, { task: 'new' }),
    ], T0 + 3_600_000)
    expect(model.needsYou.map(n => n.task)).toEqual(['old', 'new'])
  })
})

describe('lane homing (v13/v17/v18)', () => {
  const delegate = (atMs: number, task: string): AttentionEvent =>
    ev('delegate', atMs, { task, payload: { engine: 'dsh-creator' } })
  const dsh = (event: string, atMs: number, task: string): AttentionEvent =>
    ev(event, atMs, { surface: 'dsh', task })

  it('opens a lane on delegate, labels it on dsh start, closes it on the dsh done pasteback', () => {
    const events = [
      ev('start', T0, { task: 'orchestrate' }),
      delegate(T0 + 1000, 'orchestrate'),
      dsh('start', T0 + 2000, 'build v1'),
    ]
    const mid = buildModel(events, T0 + 10_000)
    expect(mid.lanes).toHaveLength(1)
    expect(mid.lanes[0]).toMatchObject({ status: 'running', labelTask: 'build v1', engine: 'dsh-creator' })

    const done = buildModel([...events, dsh('done', T0 + 60_000, 'build v1')], T0 + 70_000)
    // Lane closed and gone; the dsh build pasted back as its own history segment.
    expect(done.lanes).toHaveLength(0)
    expect(done.history.some(s => s.task === 'build v1' && s.surface === 'dsh' && s.dur === 58_000)).toBe(true)
  })

  it("closes every running lane on the orchestrator's own terminal", () => {
    const model = buildModel([
      ev('start', T0, { task: 'orchestrate' }),
      delegate(T0 + 1000, 'orchestrate'),
      ev('done', T0 + 120_000, { task: 'orchestrate' }),
    ], T0 + 200_000)
    expect(model.lanes).toHaveLength(0)
    expect(model.current).toBeNull()
  })

  it('routes dsh events to the newest lane (handover), leaving the older lane running', () => {
    const model = buildModel([
      delegate(T0, 'task a'),
      delegate(T0 + 1000, 'task b'),
      dsh('start', T0 + 2000, 'build b'),
    ], T0 + 10_000)
    const byTask = new Map(model.lanes.map(l => [l.delegateTask, l]))
    expect(byTask.get('task a')?.labelTask).toBeNull()
    expect(byTask.get('task b')?.labelTask).toBe('build b')
  })

  it('flags a silent lane as no-heartbeat after LANE_IDLE_MS instead of removing it', () => {
    const model = buildModel([delegate(T0, 'quiet')], T0 + LANE_IDLE_MS + 1000)
    expect(model.lanes).toHaveLength(1)
    expect(model.lanes[0]?.status).toBe('interrupted')
    expect(interruptedLanes(model)).toHaveLength(1)
    expect(buildChips(model)).toHaveLength(0)
  })

  it('keeps a lane alive across dsh heartbeats and counts sub-build ticks', () => {
    const half = LANE_IDLE_MS / 2
    const model = buildModel([
      delegate(T0, 'long'),
      dsh('done', T0 + half, 'probe 1'),
      dsh('done', T0 + 2 * half, 'probe 2'),
    ], T0 + 2 * half + 60_000)
    expect(model.lanes[0]).toMatchObject({ status: 'running', ticks: 2 })
  })

  it('drops a stale lane and lets the very dsh event that found it stale fall to the mainline', () => {
    const model = buildModel([
      delegate(T0, 'stale'),
      dsh('start', T0 + LANE_IDLE_MS + 1000, 'orphan build'),
    ], T0 + LANE_IDLE_MS + 2000)
    expect(model.lanes[0]?.status).toBe('interrupted')
    expect(model.current?.task).toBe('orphan build')
  })

  it("hands a lane with an open debt to the popover (status 'taken', row gone)", () => {
    const model = buildModel([
      delegate(T0, 'delegated work'),
      ev('needs-you', T0 + 1000, { task: 'delegated work', surface: 'codex' }),
    ], T0 + 10_000)
    expect(model.lanes).toHaveLength(0)
    expect(model.needsYou).toHaveLength(1)
  })
})

describe('active time and the unified idle window (decisions ⑯/㉖)', () => {
  it('unifies the no-heartbeat window with the 30-minute idle pause', () => {
    expect(LANE_IDLE_MS).toBe(IDLE_PAUSE_MS)
  })

  it('caps silent stretches at IDLE_PAUSE_MS: a 10-hour wall span reads as active time', () => {
    const events = [
      ev('start', T0, { task: 'long' }),
      ev('delegate', T0 + 10 * 60_000, { task: 'long' }),
      // Seven silent hours, then one revival event.
      ev('needs-you', T0 + 7 * 3_600_000, { task: 'long' }),
    ]
    const parsed = events
    // 10min real + 30min cap for the 7h hole + 5min tail = 45min, not 7h+.
    const active = activeSpan(parsed, 'digital-me', 'long', T0, T0 + 7 * 3_600_000 + 5 * 60_000)
    expect(active).toBe(10 * 60_000 + IDLE_PAUSE_MS + 5 * 60_000)
  })

  it('feeds active time to the current task and background chips', () => {
    const tenHours = 10 * 3_600_000
    const model = buildModel([
      ev('start', T0, { task: 'chat a' }),
      ev('start', T0 + tenHours, { task: 'chat b' }),
    ], T0 + tenHours + 60_000)
    // chat a: capped at 30min despite the 10h wall span before preemption —
    // and ten silent hours put it in the no-heartbeat group, not the chips.
    expect(model.background[0]?.activeDur).toBe(IDLE_PAUSE_MS)
    expect(model.current?.activeDur).toBe(60_000)
    expect(noHeartbeat(model).map(i => i.task)).toEqual(['chat a'])

    // A freshly preempted session is still a chip and carries active time.
    const fresh = buildModel([
      ev('start', T0, { task: 'chat c' }),
      ev('start', T0 + 5 * 60_000, { task: 'chat d' }),
    ], T0 + 6 * 60_000)
    const bg = buildChips(fresh).find(c => c.kind === 'bg')
    expect(bg?.activeDur).toBe(6 * 60_000)
  })
})

describe('background sessions (decision ㉕)', () => {
  it('keeps a preempted, unterminated task as a running background chip', () => {
    const model = buildModel([
      ev('start', T0, { task: 'chat a' }),
      ev('start', T0 + 600_000, { task: 'chat b' }),
    ], T0 + 1_200_000)
    expect(model.current?.task).toBe('chat b')
    expect(model.background).toHaveLength(1)
    expect(model.background[0]).toMatchObject({ task: 'chat a', status: 'running' })
    // The attention segment still closed — strip accounts attention,
    // chips account running work.
    expect(model.history[0]).toMatchObject({ task: 'chat a', dur: 600_000 })
    expect(buildChips(model).map(c => [c.kind, c.task])).toEqual([
      ['cur', 'chat b'], ['bg', 'chat a'],
    ])
  })

  it("ends the background run on the task's own late terminal (project+task)", () => {
    const events = [
      ev('start', T0, { task: 'chat a' }),
      ev('start', T0 + 600_000, { task: 'chat b' }),
    ]
    const otherProject = buildModel([
      ...events,
      ev('done', T0 + 900_000, { task: 'chat a', project: 'other' }),
    ], T0 + 1_200_000)
    expect(otherProject.background).toHaveLength(1)
    const own = buildModel([
      ...events,
      ev('done', T0 + 900_000, { task: 'chat a' }),
    ], T0 + 1_200_000)
    expect(own.background).toHaveLength(0)
  })

  it('returns a re-started task to current — never current and background at once', () => {
    const model = buildModel([
      ev('start', T0, { task: 'chat a' }),
      ev('start', T0 + 600_000, { task: 'chat b' }),
      ev('start', T0 + 900_000, { task: 'chat a' }),
    ], T0 + 1_200_000)
    expect(model.current?.task).toBe('chat a')
    expect(model.background.map(b => b.task)).toEqual(['chat b'])
  })

  it('turns a silent background task no-heartbeat: out of chips, into the popover group', () => {
    const model = buildModel([
      ev('start', T0, { task: 'chat a' }),
      ev('start', T0 + 60_000, { task: 'chat b' }),
    ], T0 + 60_000 + LANE_IDLE_MS + 1000)
    expect(model.background[0]?.status).toBe('interrupted')
    expect(buildChips(model).some(c => c.kind === 'bg')).toBe(false)
    expect(noHeartbeat(model)).toEqual([
      { task: 'chat a', project: 'digital-me', lastTs: T0 },
    ])
  })

  it('hands a background task with an open debt to the popover (single presentation)', () => {
    const model = buildModel([
      ev('start', T0, { task: 'chat a' }),
      ev('start', T0 + 600_000, { task: 'chat b' }),
      ev('needs-you', T0 + 900_000, { task: 'chat a', payload: { kind: 'review', ref: 'r' } }),
    ], T0 + 1_200_000)
    expect(model.background).toHaveLength(0)
    expect(model.needsYou.map(n => n.task)).toEqual(['chat a'])
  })

  it('same-identity events are the background heartbeat', () => {
    const half = LANE_IDLE_MS / 2
    const model = buildModel([
      ev('start', T0, { task: 'chat a' }),
      ev('start', T0 + 1000, { task: 'chat b' }),
      ev('delegate', T0 + half, { task: 'chat a' }),
    ], T0 + half + half / 2)
    // The delegate at T0+half refreshed chat a's lastEvt: still running.
    expect(model.background.find(b => b.task === 'chat a')?.status).toBe('running')
  })
})

describe('mainline current and idle pause', () => {
  it('keeps the unclosed task as current, never as history', () => {
    const model = buildModel([ev('start', T0, { task: 'work' })], T0 + 60_000)
    expect(model.history).toHaveLength(0)
    expect(model.current).toMatchObject({ task: 'work', paused: false })
  })

  it('auto-pauses current after IDLE_PAUSE_MS of silence (strictly beyond)', () => {
    const events = [ev('start', T0, { task: 'work' })]
    expect(buildModel(events, T0 + IDLE_PAUSE_MS).current?.paused).toBe(false)
    expect(buildModel(events, T0 + IDLE_PAUSE_MS + 1).current?.paused).toBe(true)
  })

  it('switch closes the previous span; an unrelated done never touches current', () => {
    const model = buildModel([
      ev('start', T0, { task: 'a' }),
      ev('switch', T0 + 120_000, { task: 'b' }),
      ev('done', T0 + 180_000, { task: 'unrelated' }),
    ], T0 + 240_000)
    expect(model.history).toHaveLength(1)
    expect(model.history[0]).toMatchObject({ task: 'a', dur: 120_000, drop: false })
    expect(model.current?.task).toBe('b')
  })

  it("records the closing done's note and the drop flag on the segment", () => {
    const model = buildModel([
      ev('start', T0, { task: 'a' }),
      ev('done', T0 + 120_000, { task: 'a', payload: { note: 'what I did' } }),
      ev('start', T0 + 180_000, { task: 'b' }),
      ev('drop', T0 + 240_000, { task: 'b' }),
    ], T0 + 300_000)
    expect(model.history[0]?.note).toBe('what I did')
    expect(model.history[1]).toMatchObject({ drop: true, note: null })
  })
})

describe('series packing and fragment aggregation (buildTimeline)', () => {
  /** One finished segment via start+done, minutes-scale. */
  function span(fromMin: number, toMin: number, task: string, project = 'digital-me'): AttentionEvent[] {
    return [
      ev('start', T0 + fromMin * 60_000, { task, project }),
      ev('done', T0 + toMin * 60_000, { task, project }),
    ]
  }
  const NOW = T0 + 12 * 3_600_000

  it('packs adjacent finished segments sharing a token prefix within one project', () => {
    const model = buildModel([
      ...span(0, 10, 'TaskFlow v1 shell'),
      ...span(10, 20, 'TaskFlow v2 polish'),
      ...span(20, 30, 'TaskFlow v3 ship'),
    ], NOW)
    const items = buildTimeline(model, NOW)
    expect(items).toHaveLength(1)
    const item = items[0]
    if (item?.kind !== 'pack') throw new Error('expected a pack')
    expect(item.pack.members).toHaveLength(3)
    expect(item.pack.prefix).toBe('TaskFlow')
    expect(item.pack.totalDur).toBe(30 * 60_000)
    expect(item.openRight).toBe(false)
  })

  it('folds the digital-me ≈ DME alias into one pack but splits a real project change', () => {
    const packed = buildModel([
      ...span(0, 10, 'TaskFlow v1 shell', 'digital-me'),
      ...span(10, 20, 'TaskFlow v2 polish', 'DME'),
    ], NOW)
    expect(buildTimeline(packed, NOW).filter(i => i.kind === 'pack')).toHaveLength(1)

    const split = buildModel([
      ...span(0, 10, 'TaskFlow v1 shell', 'digital-me'),
      ...span(10, 20, 'TaskFlow v2 polish', 'other'),
    ], NOW)
    expect(buildTimeline(split, NOW).filter(i => i.kind === 'pack')).toHaveLength(0)
  })

  it('severs the pack chain at an idle gap (IDLE_PAUSE_MS)', () => {
    const gapMin = IDLE_PAUSE_MS / 60_000
    const model = buildModel([
      ...span(0, 10, 'TaskFlow v1 shell'),
      ...span(10 + gapMin, 20 + gapMin, 'TaskFlow v2 polish'),
    ], NOW)
    // Two singles: a lone segment never packs (≥ 2 members required).
    expect(buildTimeline(model, NOW).map(i => i.kind)).toEqual(['seg', 'seg'])
  })

  it('opens the pack right edge while the current task continues the series', () => {
    const model = buildModel([
      ...span(0, 10, 'TaskFlow v1 shell'),
      ...span(10, 20, 'TaskFlow v2 polish'),
      ev('start', T0 + 20 * 60_000, { task: 'TaskFlow v3 ship' }),
    ], NOW)
    const item = buildTimeline(model, NOW)[0]
    if (item?.kind !== 'pack') throw new Error('expected a pack')
    expect(item.openRight).toBe(true)
  })

  it('aggregates sub-minute segments into one 零碎 block between full items', () => {
    const model = buildModel([
      ...span(0, 10, 'alpha main work'),
      // Unrelated names: fragments sharing a token prefix would pack instead.
      ev('start', T0 + 11 * 60_000, { task: '记一条' }),
      ev('done', T0 + 11 * 60_000 + 20_000, { task: '记一条' }),
      ev('start', T0 + 12 * 60_000, { task: 'ping' }),
      ev('done', T0 + 12 * 60_000 + 30_000, { task: 'ping' }),
      ...span(13, 25, 'beta main work'),
    ], NOW)
    const items = buildTimeline(model, NOW)
    expect(items.map(i => i.kind)).toEqual(['seg', 'agg', 'seg'])
    const agg = items[1]
    if (agg?.kind !== 'agg') throw new Error('expected an agg')
    expect(agg.frags.map(f => f.task)).toEqual(['记一条', 'ping'])
  })
})

describe('chips and width-driven overflow (v21)', () => {
  it('orders chips current-first, then running lanes by open time', () => {
    const model = buildModel([
      ev('delegate', T0, { task: 'lane early', payload: { engine: 'codex' } }),
      ev('delegate', T0 + 1000, { task: 'lane late' }),
      ev('start', T0 + 2000, { task: 'main work' }),
    ], T0 + 10_000)
    const chips = buildChips(model)
    expect(chips.map(c => [c.kind, c.task])).toEqual([
      ['cur', 'main work'], ['run', 'lane early'], ['run', 'lane late'],
    ])
    // Engine label falls back to the writing surface when payload has none.
    expect(chips.map(c => c.src)).toEqual(['claude-code', 'codex', 'claude-code'])
  })

  it('always shows the first chip and splits the rest by the row width', () => {
    const chip = (task: string): Chip => ({ kind: 'run', src: 'dsh', task, project: 'p', start: T0 })
    const wide = chip('宽'.repeat(200))
    // The 150px CSS max-width caps even a huge task label…
    expect(chipW(wide)).toBeLessThan(300)
    // …so overflow is the row's doing, not the label's: a narrow row keeps
    // only the always-shown first chip.
    const { shown, overflow } = splitChips([wide, chip('a'), chip('b')], 100)
    expect(shown).toEqual([wide])
    expect(overflow).toHaveLength(2)

    const narrow = [chip('aa'), chip('bb'), chip('cc')]
    expect(splitChips(narrow, CHIP_ROW_W).overflow).toHaveLength(0)
    expect(chipW(narrow[0]!)).toBeGreaterThan(0)
  })

  it('mirrors rendered chip geometry: paused suffix in, task capped, source scaled', () => {
    const base: Chip = { kind: 'cur', src: 's', task: '任务', project: 'p', start: T0 }
    // The paused suffix renders on the chip, so it must be measured.
    expect(chipW({ ...base, paused: true })).toBeGreaterThan(chipW(base))
    const huge = (): number => 5_000
    // Task side capped at 150 (CSS max-width); source tag scaled 9px/10px.
    expect(chipW(base, huge)).toBe(7 + 5 + 150 + 5 + (5_000 * 0.9 + 12) + 18 + 6)
  })

  it('threads a custom text measure through splitChips (S4 canvas seat)', () => {
    const chip = (task: string): Chip => ({ kind: 'run', src: 'dsh', task, project: 'p', start: T0 })
    const chips = [chip('aaaa'), chip('bbbb'), chip('cccc')]
    expect(splitChips(chips, 10_000).overflow).toHaveLength(0)
    const huge = (): number => 5_000
    const { shown, overflow } = splitChips(chips, 5_000, huge)
    expect(shown).toHaveLength(1)
    expect(overflow).toHaveLength(2)
  })
})

describe('label helpers', () => {
  it('normalizeProject folds the digital-me family and strips punctuation', () => {
    expect(normalizeProject('digital-me')).toBe('digitalme')
    expect(normalizeProject('DME')).toBe('digitalme')
    expect(normalizeProject('PhD Dissertation')).toBe('phddissertation')
  })

  it('strLcp/toToken trim a shared prefix back to a whole token', () => {
    expect(strLcp('TaskFlow v13 泳道', 'TaskFlow v14 hover')).toBe('TaskFlow v1')
    expect(toToken('TaskFlow v1')).toBe('TaskFlow')
    expect(toToken('TaskFlow ·')).toBe('TaskFlow')
    expect(toToken('单词')).toBe('单词')
  })

  it('estTextW weighs CJK double and drives fmtDur-style labels', () => {
    expect(estTextW('中文')).toBe(20)
    expect(estTextW('ab')).toBe(11)
    expect(fmtDur(45_000)).toBe('45s')
    expect(fmtDur(12 * 60_000)).toBe('12m')
    expect(fmtDur(125 * 60_000)).toBe('2h5m')
    expect(fmtDur(Number.NaN)).toBe('0s')
  })

  it('paletteColor is stable and stays inside the low-saturation palette', () => {
    expect(paletteColor('digital-me')).toBe(paletteColor('digital-me'))
    expect(PALETTE).toContain(paletteColor('anything'))
  })
})

describe('real ledger fixture (2026-08, folded at 2026-08-15T23:30-04:00)', () => {
  const text = readFileSync(new URL('./fixtures/events-2026-08.jsonl', import.meta.url), 'utf8')
  const NOW = Date.parse('2026-08-15T23:30:00-04:00')
  const events = parseLedgerText(text)
  const model = buildModel(events, NOW)

  it('parses every line of the real ledger (both offset spellings included)', () => {
    expect(events).toHaveLength(209)
  })

  it('folds the mainline to the S3 porting task, running unpaused', () => {
    expect(model.current).toMatchObject({
      task: 'TaskFlow P2 · S3 client 移植',
      surface: 'claude-code',
      project: 'digital-me',
      paused: false,
    })
  })

  it('keeps exactly the nine debts that were open at 23:30, longest-owed first', () => {
    expect(model.needsYou.map(n => n.task)).toEqual([
      '评审多 AI TaskFlow 接入',
      '互审 TaskFlow 实施顺序',
      'Chapter 3 Figure 7 helmet-background candidate',
      'Figure 7 calibration-grade top-down helmet photo',
      '验证移动端核心项目与可删 SDK',
      '核验 GitHub Safety App 备份',
      '审计 PhD Dissertation Git 与备份方案',
      '清理垃圾分支并归档旧资料',
      'Figure 7 calibrated motor/reference-ray candidate',
    ])
    // Every debt carries the raw ts pin the seal request needs.
    for (const debt of model.needsYou) expect(parseTs(debt.ts)).toBe(debt.t)
  })

  it('leaves only the five silent audit lanes, all flagged no-heartbeat', () => {
    expect(model.lanes.map(l => [l.delegateTask, l.status]).sort()).toEqual([
      ['Figure 7 code and review-output audit', 'interrupted'],
      ['Figure 7 helmet source asset audit', 'interrupted'],
      ['Figure 7 photo metrology audit', 'interrupted'],
      ['审计 Dissertation Git 拓扑', 'interrupted'],
      ['审计移动硬盘备份适配性', 'interrupted'],
    ])
    // No-heartbeat lanes leave the chip row; only the current task chips.
    expect(buildChips(model).map(c => c.kind)).toEqual(['cur'])
  })

  it('keeps the two preempted, never-terminated sessions as no-heartbeat background', () => {
    // Each was preempted by a later start and wrote no terminal that day;
    // by 23:30 both are silent beyond LANE_IDLE_MS (decision ㉕).
    expect(model.background.map(b => [b.task, b.status]).sort()).toEqual([
      ['Chapter 3 Figure 7 direction visual review candidate', 'interrupted'],
      ['TaskFlow 陪跑（续窗）', 'interrupted'],
    ])
    // One fail-loud group: five silent lanes + two silent sessions.
    expect(noHeartbeat(model)).toHaveLength(7)
  })

  it('packs the TaskFlow build series on the strip', () => {
    const packs = buildTimeline(model, NOW).filter(i => i.kind === 'pack')
    expect(packs.length).toBeGreaterThan(0)
    expect(packs.some(p => p.kind === 'pack' && p.pack.prefix.startsWith('TaskFlow'))).toBe(true)
  })

  it('filters the fold to the reference day (no 08-14 events leak in)', () => {
    const dayStart = Date.parse('2026-08-15T00:00:00-04:00')
    for (const s of model.history) expect(s.start).toBeGreaterThanOrEqual(dayStart)
  })
})
