/**
 * Open items from the bus todo files (`~/my-memories/todo/projects/*.md`),
 * reduced to short titles for the project tree's "after now" nodes. The todo
 * files are prose-heavy and human-curated; extraction is deliberately loose
 * and never writes back.
 */

import type { TaskflowTodoFile } from '@deepseek-ai/dsh-api-remotes/client'

/**
 * Todo file → board project. Todo keeps its own historical file names
 * (DME, dissertation); files without a board project stay off the tree.
 */
export const TODO_FILE_PROJECTS: Readonly<Record<string, string>> = {
  'ARK.md': 'ARK',
  'DME.md': 'digital-me',
  'dissertation.md': 'PhD Dissertation',
  'job.md': 'job',
  'life-admin.md': 'life-admin',
}

/** One open todo item. */
export interface TaskflowTodoItem {
  title: string
  /** `due:YYYY-MM-DD` when the item carries one. */
  due: string | null
  /** True when listed under a `## P1` heading. */
  p1: boolean
}

const OPEN_ITEM = /^- \[ \] (.+)$/
const LEADING_MARKS = /^(?:[\p{Extended_Pictographic}️\s]|【[^】]*】)+/u
const BOLD = /^\*\*(.+?)\*\*/
const CUT = / · | —— | — /
const DUE = /due:(\d{4}-\d{2}-\d{2})/
const DUE_TAG = /\s*due:\d{4}-\d{2}-\d{2}/g

/**
 * Shorten one todo line to the phrase a person would call it by: the bold
 * lead when there is one, otherwise the text before the first ` · ` / `——`.
 * @param body - the text after `- [ ] `.
 * @returns A short title.
 */
export function todoTitle(body: string): string {
  const text = body.replace(LEADING_MARKS, '')
  const bold = BOLD.exec(text)
  const lead = bold === null ? (text.split(CUT)[0] as string) : (bold[1] as string)
  return lead.replaceAll('**', '').replace(DUE_TAG, '').trim()
}

/**
 * Extract the open, non-struck items of one todo file, P1 section first.
 * @param text - raw markdown.
 * @returns Open items in file order within each priority band.
 */
export function parseTodoItems(text: string): TaskflowTodoItem[] {
  const items: TaskflowTodoItem[] = []
  let p1 = false
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      p1 = line.includes('P1')
      continue
    }
    const match = OPEN_ITEM.exec(line)
    if (match === null) continue
    const body = match[1] as string
    if (body.startsWith('~~')) continue
    const title = todoTitle(body)
    if (title === '') continue
    items.push({ title, due: DUE.exec(body)?.[1] ?? null, p1 })
  }
  return [...items.filter(i => i.p1), ...items.filter(i => !i.p1)]
}

/**
 * Open todo items of one board project across the todo files.
 * @param files - raw todo files from the host.
 * @param label - display project.
 * @returns That project's items, P1 first.
 */
export function todosForProject(files: readonly TaskflowTodoFile[], label: string): TaskflowTodoItem[] {
  return files
    .filter(file => TODO_FILE_PROJECTS[file.name] === label)
    .flatMap(file => parseTodoItems(file.text))
}
