import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactElement } from 'react'
import {
  buildTimeline, fmtDur, MODEL_W, paletteColor,
  type FoldModel, type TextMeasure, type TimelineItem,
} from './fold.ts'
import type { ClickPop } from './interaction.ts'
import { MemberRow, PopRow } from './PopRows.tsx'
import css from './HistoryStrip.module.css'
import popCss from './popover.module.css'

/**
 * Owner-fed props: the folded model, the clock, the text-width seat (real
 * canvas measurement with the estTextW fallback), and the shared popover seat.
 */
export interface HistoryStripProps {
  model: FoldModel
  now: number
  measure: TextMeasure
  /** Rendered strip width in px (the observed column; MODEL_W until known). */
  stripW: number
  clickPop: ClickPop | null
  onTogglePop: (pop: ClickPop | null) => void
}

/** Stable hover identity across 10 s refolds (task+start, not array index). */
function itemId(it: TimelineItem): string {
  if (it.kind === 'seg') return `s:${it.seg.task}:${it.seg.start}`
  if (it.kind === 'pack') return `p:${it.pack.prefix}:${it.idx}`
  return `a:${it.frags[0]?.start ?? 0}`
}

/**
 * The solid time-history strip: semantic-proportion widths over the model
 * base, packed series and 零碎 blocks, in-place hover lift (120 ms leave
 * grace, suppressed while any click popover is open), and per-item drill-down
 * popovers. Pure presentation over the fold — geometry math is the prototype's
 * v13/v14 form: `%` widths for layout, `cqw`-clamped absolute inners on hover.
 */
export function HistoryStrip({ model, now, measure, stripW, clickPop, onTogglePop }: HistoryStripProps): ReactElement {
  const [hoverId, setHoverId] = useState<string | null>(null)
  const leaveTimer = useRef<number | null>(null)
  useEffect(() => () => {
    if (leaveTimer.current !== null) window.clearTimeout(leaveTimer.current)
  }, [])
  const enter = (id: string): void => {
    if (leaveTimer.current !== null) {
      window.clearTimeout(leaveTimer.current)
      leaveTimer.current = null
    }
    setHoverId(id)
  }
  const leave = (): void => {
    if (leaveTimer.current !== null) window.clearTimeout(leaveTimer.current)
    leaveTimer.current = window.setTimeout(() => { setHoverId(null) }, 120)
  }

  const items = buildTimeline(model, now)
  if (items.length === 0) {
    return (
      <div className={css.mainline}>
        <div className={css.empty}>今日暂无注意力事件</div>
      </div>
    )
  }

  // Relative shares: the model base only sets proportions — rendering resolves
  // through % / cqw against the container's real width (no DOM measurement).
  const totalTask = model.history.reduce((a, s) => a + s.dur, 0)
  const modelW = MODEL_W - Math.max(0, items.length - 1) * 2
  const minSum = items.reduce((a, it) => a + (it.kind === 'seg' ? 24 : 26), 0)
  const free = Math.max(0, modelW - minSum)
  const growOf = (it: TimelineItem): number => it.kind === 'seg'
    ? it.seg.dur
    : it.kind === 'agg' ? it.frags.reduce((a, f) => a + f.dur, 0) : it.pack.totalDur
  const itemWPct = (it: TimelineItem): number =>
    ((it.kind === 'seg' ? 24 : 26) + (totalTask > 0 ? (growOf(it) / totalTask) * free : 0)) / MODEL_W * 100
  const cumPct: number[] = []
  let acc = 0
  for (const it of items) {
    cumPct.push(acc)
    acc += itemWPct(it)
  }

  const rendered = items.map((it, idx) => {
    const id = itemId(it)
    const popOpen = clickPop !== null && clickPop.type !== 'chip' && clickPop.idx === idx
    const toggle = (e: MouseEvent): void => {
      e.stopPropagation()
      onTogglePop(popOpen ? null : { type: it.kind, idx })
    }
    const expanded = hoverId === id && clickPop === null
    const wPct = itemWPct(it)

    let baseLabel: string
    let fullLabel: string
    let kindCls = ''
    if (it.kind === 'agg') {
      const total = it.frags.reduce((a, f) => a + f.dur, 0)
      fullLabel = `零碎 ×${it.frags.length} · ${fmtDur(total)}`
      baseLabel = wPct * stripW / 100 < measure(fullLabel) + 14 ? `零碎 ×${it.frags.length}` : fullLabel
      kindCls = css.agg ?? ''
    } else if (it.kind === 'pack') {
      const p = it.pack
      fullLabel = `${p.prefix} ×${p.members.length} · ${fmtDur(p.totalDur)}`
      baseLabel = wPct * stripW / 100 < measure(fullLabel) + 14 ? `${p.prefix} ×${p.members.length}` : fullLabel
      kindCls = css.pack ?? ''
    } else {
      fullLabel = `${it.seg.task} · ${fmtDur(it.seg.dur)}`
      baseLabel = it.seg.task
      kindCls = css.seg ?? ''
    }

    // Hover width: at least the item's own share, at most content/60cqw/room
    // toward the free edge (v14 lower bound; v8 clamp).
    const contentPx = measure(fullLabel) + 10
    const leftPct = cumPct[idx] ?? 0
    const extendLeft = leftPct + 60 > 100
    const avail = extendLeft ? leftPct + wPct : 100 - leftPct
    const wCss = `max(${wPct.toFixed(2)}cqw, min(${contentPx}px, 60cqw, ${avail.toFixed(1)}cqw))`

    const outerStyle: CSSProperties = { width: `${wPct.toFixed(2)}%` }
    const innerStyle: CSSProperties = expanded
      ? { width: wCss, ...extendLeft ? { left: 'auto', right: 0 } : {} }
      : {}
    if (it.kind === 'seg') innerStyle.background = paletteColor(it.seg.project)

    // v17 paste-back: a segment closed within the last minute arrives visibly.
    const fresh = it.kind === 'seg'
      ? now - it.seg.end < 60_000
      : it.kind === 'agg'
        ? it.frags.some(f => now - f.end < 60_000)
        : it.pack.members.some(m => now - m.seg.end < 60_000)
    const innerCls = [
      css.inner, kindCls,
      expanded ? css.lifted : '',
      it.kind === 'pack' && it.openRight ? css.open : '',
      fresh ? css.arrive : '',
    ].filter(Boolean).join(' ')

    let popEl: ReactElement | null = null
    if (popOpen) {
      let content: ReactElement[]
      if (it.kind === 'seg') {
        const seg = it.seg
        const sameTask = model.history.filter(s => s.task === seg.task)
        const totalDur = sameTask.reduce((a, s) => a + s.dur, 0)
        content = [
          <PopRow key="task" k="任务">{seg.task}</PopRow>,
          <PopRow key="project" k="project">{seg.project}</PopRow>,
          <PopRow key="total" k="累计">{fmtDur(totalDur)}</PopRow>,
          <PopRow key="count" k="段数">{`${sameTask.length} 段`}</PopRow>,
          <PopRow key="surface" k="surface">{seg.surface}</PopRow>,
        ]
      } else if (it.kind === 'pack') {
        const p = it.pack
        content = [
          <PopRow key="series" k="系列">{`${p.prefix} ×${p.members.length} · ${fmtDur(p.totalDur)}`}</PopRow>,
          ...p.members.map((m, j) => <MemberRow key={j} seg={m.seg} />),
        ]
      } else {
        const total = it.frags.reduce((a, f) => a + f.dur, 0)
        content = [
          <PopRow key="agg" k="零碎">{`${it.frags.length} 段 · ${fmtDur(total)}`}</PopRow>,
          ...it.frags.map((f, j) => <MemberRow key={j} seg={f} />),
        ]
      }
      const lastItem = idx === items.length - 1
      popEl = (
        <div
          className={popCss.pop}
          style={lastItem ? { right: 0 } : { left: 0 }}
          onClick={(e) => { e.stopPropagation() }}
        >
          {content}
        </div>
      )
    }

    return (
      <div
        key={id}
        className={css.outer}
        style={outerStyle}
        onMouseEnter={() => { enter(id) }}
        onMouseLeave={leave}
        onClick={toggle}
      >
        <div className={innerCls} style={innerStyle}>
          <span className={css.label}>{expanded ? fullLabel : baseLabel}</span>
        </div>
        {popEl}
      </div>
    )
  })

  return <div className={css.mainline}>{rendered}</div>
}
