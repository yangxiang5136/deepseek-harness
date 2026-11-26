import { useState, type ReactElement, type ReactNode } from 'react'
import type { TaskflowMainline } from '@deepseek-ai/dsh-api-remotes/client'
import { DebtCard } from './DebtCard.tsx'
import { debtKey, shownDebts, type DeferredSeal } from './deferredSeal.ts'
import { IDLE_PAUSE_MS, type AttentionEvent, type NeedsYouItem } from './fold.ts'
import { fmtStamp } from './handoff.ts'
import { fmtAge } from './NeedsYouTray.tsx'
import type { SessionTitlesState } from './sessionTitles.ts'
import { TIER_ROWS, type MainlineView, type ProjectTiers, type TaskGroup } from './tiers.ts'
import css from './TwoPane.module.css'

/** Mainlines one project may pin (mirrors the host gate). */
export const MAINLINES_MAX = 3
/** Steps listed when a mainline is opened. */
export const MAINLINE_STEPS = 6

const KIND: Readonly<Record<string, string>> = { decision: '决定', merge: '合并', review: '审阅', park: '停放' }

/** Two-pane props: folded tiers, the seal controller, and the pin verb. */
export interface TwoPaneProps {
  /** Tiers by display project. */
  tiers: ReadonlyMap<string, ProjectTiers>
  /** Display project shown on the right; null picks the first busy one. */
  openProject: string | null
  onOpenProject: (label: string) => void
  events: readonly AttentionEvent[]
  now: number
  sealer: DeferredSeal
  /** Cached titles of the chats that debts name; the debt card shows its debt's. */
  sessionTitles: SessionTitlesState
  /** Tasks offered when pinning, by display project (most active first). */
  candidates: (label: string) => readonly string[]
  /** Replace one project's pins; resolves to a message when the host refuses. */
  onSetMainlines: (label: string, list: TaskflowMainline[]) => Promise<string | null>
  /** Count of every open debt, for the 全部待收口 entry. */
  total: number
  /** The earlier project view (review order, tree, todos), shown on demand. */
  legacy: (label: string) => ReactNode
  /** The earlier flat tray, shown on demand. */
  all: ReactNode
  /** A failed read of the shared pins, shown instead of hiding it. */
  pinsError?: string
}

function heatHeights(heat: readonly number[]): number[] {
  const max = Math.max(8, ...heat)
  return heat.map(count => count === 0 ? 2 : Math.round(3 + 11 * Math.log(1 + count) / Math.log(1 + max)))
}

function mainStatus(main: MainlineView, waiting: number, now: number): { text: string; wait: boolean } {
  if (waiting > 0) return { text: `卡在你这 ${waiting}`, wait: true }
  if (main.last === null) return { text: '还没有记录', wait: false }
  if (now - main.last <= IDLE_PAUSE_MS) return { text: '在推进', wait: false }
  return { text: `${fmtAge(now - main.last)}没动静`, wait: false }
}

/** Strip the ledger-derived view fields, keeping what the pins file stores. */
function plain(m: MainlineView): TaskflowMainline {
  return m.direction === undefined || m.directionBy === undefined
    ? { task: m.task }
    : { task: m.task, direction: m.direction, directionBy: m.directionBy }
}

function noteOf(debt: NeedsYouItem): string {
  return typeof debt.payload?.note === 'string' ? debt.payload.note : ''
}

/**
 * The expanded bar's main area (Sean, 2026-11-23): projects on the left, one
 * project on the right. The right side opens with only its pinned mainlines
 * and a row of counts; a mainline or a count unfolds in place, one at a time.
 * Folding is display only: every debt keeps its own seal with the 撤销 window.
 * @param props - tiers, clock, seal controller, pin verb and the earlier views.
 * @returns The two-pane element.
 */
export function TwoPane({
  tiers, openProject, onOpenProject, events, now, sealer, sessionTitles, candidates, onSetMainlines, total, legacy, all,
  pinsError,
}: TwoPaneProps): ReactElement {
  const [open, setOpen] = useState<string | null>(null)
  const [more, setMore] = useState(false)
  const [quiet, setQuiet] = useState(false)
  const [cardKey, setCardKey] = useState<string | null>(null)
  const [groupKey, setGroupKey] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [pinError, setPinError] = useState<string | null>(null)

  const visible = (debts: readonly NeedsYouItem[]): NeedsYouItem[] => shownDebts(debts, sealer.states)
  const liveGroups = (groups: readonly TaskGroup[]): TaskGroup[] =>
    groups.map(group => ({ ...group, debts: visible(group.debts) })).filter(group => group.debts.length > 0)

  const all$ = [...tiers.values()].sort((a, b) => b.waiting - a.waiting || a.label.localeCompare(b.label))
  const busy = all$.filter(t => t.mainlines.length + t.decide.length + t.look.length > 0)
  const rest = all$.filter(t => !busy.includes(t))
  const label = openProject ?? busy[0]?.label ?? rest[0]?.label ?? null
  const current = label === null ? undefined : tiers.get(label)

  const toggle = (key: string): void => {
    setOpen(open === key ? null : key)
    setMore(false)
    setCardKey(null)
    setGroupKey(null)
    setDraft('')
  }
  const pick = (next: string): void => {
    onOpenProject(next)
    setOpen(null)
    setMore(false)
    setCardKey(null)
    setGroupKey(null)
    setPinError(null)
  }
  const save = (list: TaskflowMainline[]): void => {
    if (label === null) return
    setPinError(null)
    onSetMainlines(label, list).then(setPinError, (error: unknown) => {
      setPinError(error instanceof Error ? error.message : '保存失败')
    })
  }

  const debtRow = (debt: NeedsYouItem, title: string): ReactElement => {
    const key = debtKey(debt)
    const state = sealer.states[key]
    return (
      <div key={key} className={css.row}>
        <span className={debt.kind === 'decision' ? css.kindDecision : css.kind}>{KIND[debt.kind] ?? debt.kind}</span>
        <span className={css.rowTitle} title={title}>{title}</span>
        <span className={css.rowNote} title={noteOf(debt)}>{noteOf(debt) === title ? '' : noteOf(debt)}</span>
        <span className={css.rowAge}>{fmtAge(debt.owed)}</span>
        <span className={css.rowActs}>
          <button type="button" className={css.btn} aria-expanded={cardKey === key} onClick={() => { setCardKey(cardKey === key ? null : key) }}>看</button>
          {debt.kind !== 'park' && (
            <button
              type="button" className={css.btn} aria-label={`收口 ${debt.task}`}
              title="本阶段结束，交史官复盘；原始材料与续接入口保留" onClick={() => { sealer.queue(debt) }}
            >✓
            </button>
          )}
        </span>
        {typeof state === 'object' && <span className={css.error}>{`收口失败：${state.failed}`}</span>}
      </div>
    )
  }

  const groupRows = (groups: readonly TaskGroup[]): ReactElement => {
    const live = liveGroups(groups)
    const shown = more ? live : live.slice(0, TIER_ROWS)
    return (
      <div className={css.rows}>
        {live.length === 0 && <div className={css.muted}>这里没有条目</div>}
        {shown.map((group) => {
          const first = group.debts[0] as NeedsYouItem
          if (group.debts.length === 1) return debtRow(first, group.task)
          const key = `${group.project}\0${group.task}`
          const lead = group.debts.find(debt => debt.kind === 'decision') ?? group.debts.find(debt => debt.kind === 'merge') ?? first
          return (
            <div key={key} className={css.group}>
              <div className={css.row}>
                <span className={lead.kind === 'decision' ? css.kindDecision : css.kind}>{KIND[lead.kind] ?? lead.kind}</span>
                <span className={css.rowTitle} title={group.task}>{group.task}<span className={css.times}>{` ×${group.debts.length}`}</span></span>
                <span className={css.rowNote} title={noteOf(lead)}>{noteOf(lead)}</span>
                <span className={css.rowAge}>{`${fmtAge(now - group.last)}前有动静`}</span>
                <span className={css.rowActs}>
                  <button type="button" className={css.btn} aria-expanded={groupKey === key} onClick={() => { setGroupKey(groupKey === key ? null : key) }}>
                    {groupKey === key ? '收起' : `展开 ${group.debts.length} 条`}
                  </button>
                </span>
              </div>
              {groupKey === key && <div className={css.nested}>{group.debts.map(debt => debtRow(debt, noteOf(debt) || debt.task))}</div>}
            </div>
          )
        })}
        {live.length > TIER_ROWS && (
          <button type="button" className={css.moreBtn} onClick={() => { setMore(!more) }}>
            {more ? '收起' : `还有 ${live.length - TIER_ROWS} 件`}
          </button>
        )}
      </div>
    )
  }

  const cardDebt = current === undefined || cardKey === null ? null
    : [...current.mainlines.flatMap(m => m.debts), ...current.decide.flatMap(g => g.debts), ...current.look.flatMap(g => g.debts),
      ...current.old.flatMap(g => g.debts), ...current.parked].find(debt => debtKey(debt) === cardKey) ?? null

  const chip = (key: string, text: string, count: number, wait = false): ReactElement => (
    <button
      type="button" className={wait && count > 0 ? css.chipWait : css.chip} aria-expanded={open === key}
      onClick={() => { toggle(key) }}
    >
      {text}<b>{count}</b>
    </button>
  )

  return (
    <div className={css.two} onClick={(e) => { e.stopPropagation() }}>
      <nav className={css.rail} aria-label="项目">
        {busy.map(t => (
          <button key={t.label} type="button" className={css.proj} aria-pressed={t.label === label} onClick={() => { pick(t.label) }}>
            <span className={css.projName}>{t.label}</span>
            <span className={t.mainlines.length === 0 ? css.projNone : css.projMain}>
              {t.mainlines.length === 0 ? '主线未定' : t.mainlines.map(m => m.task).join('、')}
            </span>
            {t.waiting > 0 && <span className={css.projCount}>{`等你 ${t.waiting}`}</span>}
          </button>
        ))}
        {rest.length > 0 && (
          <button type="button" className={css.fold} aria-expanded={quiet} onClick={() => { setQuiet(!quiet) }}>
            {`其余 ${rest.length} 个项目 · ${rest.reduce((sum, t) => sum + t.old.reduce((n, g) => n + g.debts.length, 0), 0)} 条旧账`}
          </button>
        )}
        {quiet && rest.map(t => (
          <button key={t.label} type="button" className={css.proj} aria-pressed={t.label === label} onClick={() => { pick(t.label) }}>
            <span className={css.projName}>{t.label}</span>
            <span className={css.projNone}>{`${t.old.length} 件旧账`}</span>
          </button>
        ))}
        <button type="button" className={css.allBtn} aria-expanded={open === 'all'} onClick={() => { toggle('all') }}>
          {`全部待收口 ${total}`}
        </button>
      </nav>

      <section className={css.pane} aria-label={label === null ? '项目' : `${label} 主线与支线`}>
        {pinsError !== undefined && <div className={css.error}>{`主线读取失败：${pinsError}`}</div>}
        {open === 'all' && all}
        {open !== 'all' && current === undefined && <div className={css.muted}>没有待你收口的事，也还没有钉主线</div>}
        {open !== 'all' && current !== undefined && label !== null && (
          <>
            <div className={css.paneHead}>
              <span className={css.paneName}>{label}</span>
              <span className={css.spacer} />
              <button type="button" className={css.btn} aria-expanded={open === 'legacy'} onClick={() => { if (openProject !== label) onOpenProject(label); toggle('legacy') }}>原有视图</button>
            </div>

            {current.mainlines.length === 0 && <div className={css.muted}>主线未定。页面不替你推测，从下面选一条钉上。</div>}
            {current.mainlines.map((main) => {
              const key = `main:${main.task}`
              const debts = visible(main.debts)
              const status = mainStatus(main, debts.length, now)
              const heights = heatHeights(main.heat)
              return (
                <div key={main.task} className={open === key ? css.lineOpen : css.line}>
                  <button type="button" className={css.lineHead} aria-expanded={open === key} onClick={() => { toggle(key) }}>
                    <span className={css.lineTop}>
                      <span className={css.label}>主线</span>
                      <span className={css.lineName}>{main.task}</span>
                      <span className={css.spacer} />
                      <span className={status.wait ? css.statusWait : css.status}>{status.text}</span>
                    </span>
                    <span className={css.track}>
                      <span className={css.heat} aria-label="近 14 天每天的动静">
                        {heights.map((h, i) => <i key={i} className={h === 2 ? css.heatZero : undefined} style={{ height: `${h}px` }} />)}
                      </span>
                      <span className={status.wait ? css.nowWait : css.now} />
                      <span className={css.dash} />
                      <span className={css.tip} />
                      <span className={main.direction === undefined ? css.dirNone : css.dir}>{main.direction ?? '往哪走还没写'}</span>
                      {main.directionBy === 'ai' && <span className={css.by}>AI 起草</span>}
                    </span>
                  </button>
                  {open === key && (
                    <div className={css.lineBody}>
                      {main.steps.length === 0
                        ? <div className={css.muted}>账本里还没有这条主线的开工说明</div>
                        : (
                          <dl className={css.steps}>
                            {main.steps.slice(-MAINLINE_STEPS).map(step => (
                              <div key={step.t} className={css.step}><dt>{fmtStamp(step.t)}</dt><dd>{step.note}</dd></div>
                            ))}
                          </dl>
                        )}
                      {debts.length > 0 && <div className={css.rows}>{debts.map(debt => debtRow(debt, noteOf(debt) || debt.task))}</div>}
                      <div className={css.edit}>
                        <input
                          id={`taskflow-direction-${main.task}`} className={css.input} type="text" maxLength={280}
                          aria-label="往哪走" placeholder={main.direction ?? '往哪走，一句话'} value={draft}
                          onChange={(e) => { setDraft(e.target.value) }}
                        />
                        <button
                          type="button" className={css.btn} disabled={draft.trim() === ''}
                          onClick={() => {
                            save(current.mainlines.map(m => m.task === main.task
                              ? { task: m.task, direction: draft.trim(), directionBy: 'human' as const }
                              : plain(m)))
                            setDraft('')
                          }}
                        >保存方向
                        </button>
                        <button
                          type="button" className={css.btn}
                          onClick={() => {
                            save(current.mainlines.filter(m => m.task !== main.task).map(m => plain(m)))
                            setOpen(null)
                          }}
                        >不再当主线
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
            {current.mainlines.length < MAINLINES_MAX && (
              <select
                className={css.pin} aria-label="钉一条主线" value=""
                onChange={(e) => {
                  if (e.target.value === '') return
                  save([...current.mainlines.map(m => plain(m)), { task: e.target.value }])
                }}
              >
                <option value="">{`＋ 钉一条主线（最多 ${MAINLINES_MAX} 条）`}</option>
                {candidates(label)
                  .filter(task => !current.mainlines.some(m => m.task === task))
                  .map(task => <option key={task} value={task}>{task}</option>)}
              </select>
            )}
            {pinError !== null && <div className={css.error}>{`主线没有保存：${pinError}`}</div>}

            <div className={css.chips}>
              <span className={css.label}>支线</span>
              {chip('decide', '要你拍板', liveGroups(current.decide).length, true)}
              {chip('look', '看一眼', liveGroups(current.look).length)}
              {chip('old', '旧账', liveGroups(current.old).length)}
              {chip('parked', '停放', current.parked.length)}
            </div>
            {open === 'decide' && groupRows(current.decide)}
            {open === 'look' && groupRows(current.look)}
            {open === 'old' && groupRows(current.old)}
            {open === 'parked' && (
              <div className={css.rows}>
                {current.parked.length === 0 && <div className={css.muted}>这里没有条目</div>}
                {current.parked.map(debt => debtRow(debt, debt.task))}
              </div>
            )}
            {open === 'legacy' && legacy(label)}
            {cardDebt !== null && (
              <DebtCard
                key={debtKey(cardDebt)} debt={cardDebt} label={label} events={events} now={now}
                sessionTitles={sessionTitles}
                onSeal={(note) => { sealer.queue(cardDebt, note); setCardKey(null) }}
                onClose={() => { setCardKey(null) }}
              />
            )}
          </>
        )}
      </section>
    </div>
  )
}
