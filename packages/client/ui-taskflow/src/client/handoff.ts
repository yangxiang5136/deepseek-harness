/**
 * Handoff for one open debt (Sean 2026-09-24): the debt's story from the
 * ledger, and a self-contained prompt that lets any AI — a fresh chat
 * anywhere — pick the task up with its cause and state, and keep TaskFlow in
 * sync through `att` while it works.
 */

import { displayProject, type AttentionEvent, type NeedsYouItem } from './fold.ts'
import { fmtAge } from './NeedsYouTray.tsx'

/** Timeline rows the prompt carries before summarizing the rest. */
export const PROMPT_TIMELINE_ROWS = 12

/** Sean's latest closing notes a prompt carries for the project. */
export const PROMPT_FEEDBACK_ROWS = 5

const ATT = '~/my-memories/attention/bin/att'

const EVENT_LABEL: Readonly<Record<string, string>> = {
  'start': '开工',
  'switch': '切入',
  'delegate': '派出',
  'needs-you': '等 Sean',
  'done': '完成',
  'drop': '放下',
}

interface Ask {
  status: string
  todo: string
}

const ASKS: Readonly<Record<string, Ask>> = {
  decision: {
    status: '等 Sean 拍板',
    todo: '帮 Sean 把这个决定做出来：先读收口入口里的材料，列出可选方案和各自代价，给出你的推荐；Sean 拍板后再按决定执行。',
  },
  review: {
    status: '等 Sean 审阅',
    todo: '帮 Sean 审阅收口入口指向的产出：检查对错和遗漏，列出要改的地方；改完请 Sean 确认。',
  },
  merge: {
    status: '等 Sean 合并',
    todo: '帮 Sean 把收口入口指向的产出合进主干：确认内容和测试状态，说明合并会影响什么；Sean 同意后再合并。',
  },
  park: {
    status: '停放中（做别的事时停下的相邻方向，还没决定做不做）',
    todo: '先判断这个方向值不值得做、和项目主线是什么关系，给 Sean 一个建议；Sean 决定开做之前不要动手。',
  },
}

function askFor(kind: string): Ask {
  return ASKS[kind] ?? {
    status: `等 Sean 处理（${kind}）`,
    todo: '帮 Sean 处理这件事：先读收口入口里的材料，弄清要他做什么，再给出建议。',
  }
}

/**
 * Local `MM-DD HH:mm` stamp.
 * @param t - epoch ms.
 * @returns The stamp.
 */
export function fmtStamp(t: number): string {
  const d = new Date(t)
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

/**
 * Quote one shell argument so a task name survives copy-paste into zsh/bash.
 * @param value - raw argument.
 * @returns A single-quoted argument.
 */
export function shellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * Every ledger event of one exact task identity, oldest first.
 * @param events - parsed ledger.
 * @param project - exact (raw) project.
 * @param task - exact task phrase.
 * @returns The task's events.
 */
export function taskEvents(events: readonly AttentionEvent[], project: string, task: string): AttentionEvent[] {
  return events.filter(e => e.project === project && e.task === task).sort((a, b) => a.t - b.t)
}

/**
 * One timeline row: when, where, what, and the payload a reader needs.
 * @param e - ledger event.
 * @returns A one-line description.
 */
export function eventLine(e: AttentionEvent): string {
  const p = e.payload ?? {}
  const parts = [`${fmtStamp(e.t)} ${e.surface} ${EVENT_LABEL[e.event] ?? e.event}`]
  for (const key of ['kind', 'engine', 'ref', 'note'] as const) {
    if (typeof p[key] === 'string') parts.push(`${key}: ${p[key]}`)
  }
  if (p.seal === true) parts.push('Sean 已收口')
  return parts.join(' · ')
}

/**
 * Sean's closing notes on one board project, newest first: the audited seals
 * that carry a note. These are his feedback to AIs about how the project
 * should be handled.
 * @param events - parsed ledger.
 * @param label - display project (aliases folded).
 * @returns Seal events with a note, newest first.
 */
export function projectFeedback(events: readonly AttentionEvent[], label: string): AttentionEvent[] {
  return events
    .filter(e => e.event === 'done' && e.payload?.seal === true && typeof e.payload.note === 'string'
      && displayProject(e.project) === label)
    .sort((a, b) => b.t - a.t)
}

/** What a debt card shows and copies. */
export interface Handoff {
  /** Status phrase for the card head (e.g. 等 Sean 拍板). */
  status: string
  /** The task's full ledger story, oldest first. */
  timeline: AttentionEvent[]
  /** The latest event after the debt was filed, if anyone picked it up. */
  latest: AttentionEvent | null
  /** The copyable continuation prompt. */
  prompt: string
}

/**
 * Build the handoff for one open debt.
 * @param debt - the open needs-you (any kind, park included).
 * @param label - display project (aliases folded).
 * @param events - parsed ledger.
 * @param now - wall-clock instant.
 * @returns Card content and the continuation prompt.
 */
export function buildHandoff(
  debt: NeedsYouItem, label: string, events: readonly AttentionEvent[], now: number,
): Handoff {
  const ask = askFor(debt.kind)
  const timeline = taskEvents(events, debt.project, debt.task)
  const after = timeline.filter(e => e.t > debt.t)
  const latest = after[after.length - 1] ?? null
  const ref = typeof debt.payload?.ref === 'string' ? debt.payload.ref : '（未写）'
  const note = typeof debt.payload?.note === 'string' ? debt.payload.note : '（未写）'
  const task = shellArg(debt.task)
  const project = shellArg(debt.project)
  const shown = timeline.slice(-PROMPT_TIMELINE_ROWS)
  const feedback = projectFeedback(events, label).slice(0, PROMPT_FEEDBACK_ROWS)
  const resolver = debt.eventId === undefined
    ? `--resolves-ts ${shellArg(debt.ts)}`
    : `--resolves-event-id ${debt.eventId}`

  const lines = [
    `# 续接任务：${debt.task}`,
    '',
    '你接手的是一件正在等 Sean 处理的工作。下面是从 TaskFlow（Sean 在 dsh 控制台里的注意力看板，数据来自本机账本 ~/my-memories/attention/）导出的前因后果，请先读完再动手。',
    '',
    '## 现状',
    `- 项目：${label}${label === debt.project ? '' : `（账本里写作 ${debt.project}）`}`,
    `- 任务：${debt.task}`,
    `- 状态：${ask.status}，已等 ${fmtAge(now - debt.t)}（${fmtStamp(debt.t)} 由 ${debt.surface} 提出）`,
    `- 收口入口：${ref}`,
    `- 说明：${note}`,
    ...(latest === null ? [] : [`- 交接后最新动态：${eventLine(latest)}`]),
    '',
    '## 经过（账本记录，按时间）',
    ...(timeline.length > shown.length ? [`- …更早还有 ${timeline.length - shown.length} 条`] : []),
    ...shown.map(e => `- ${eventLine(e)}`),
    '',
    ...(feedback.length === 0
      ? []
      : [
        '## Sean 在这个项目上最近的收口反馈（请照着调整做法）',
        ...feedback.map(e => `- ${fmtStamp(e.t)} · ${e.task}：${String(e.payload?.note)}`),
        '',
      ]),
    '## 这次要做的',
    ask.todo,
    '收口入口是本机路径就直接读；是会话 id、分支名或链接，先在本机查找，找不到就请 Sean 提供内容。',
    '',
    '## 让 TaskFlow 同步状态',
    '能在本机跑命令时（Claude Code / Codex / Cowork / dsh），用账本写入工具记录进展，-s 填你自己所在的表面（claude-code / codex / cowork / dsh 之一）：',
    `- 开工前先看 Sean 在这个项目上的全部收口反馈：~/my-memories/attention/bin/feedback -p ${project}`,
    `- 开工：${ATT} start ${task} -p ${project} -s <你的表面>`,
    `- 又产生了要 Sean 处理的东西：${ATT} needs-you ${task} -p ${project} -s <你的表面> -k <merge|decision|review> -r <收口入口> -n '<一句话>'`,
    `- 做完：${ATT} done ${task} -p ${project} -s <你的表面>`,
    ...(debt.kind === 'park'
      ? [`- Sean 决定开做时，先撤回这条停放：${ATT} drop ${task} -p ${project} -s <你的表面> ${resolver} -n 'superseded: 升级为任务'，再对新任务名写 start。`]
      : []),
    '这张卡只能由 Sean 在 TaskFlow 里点 ✓ 收口；done 只表示你这边做完了，不会关掉它。',
    '不能跑命令（网页版 AI 等）：结束时在答复末尾写一行「未记账：<本该执行的命令>」，Sean 会补记。',
  ]
  return { status: ask.status, timeline, latest, prompt: lines.join('\n') }
}
