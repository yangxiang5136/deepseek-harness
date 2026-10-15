/** Versioned browser preference for the TaskFlow surface, independent of debts. */
export const TASKFLOW_VIEW_KEY = 'dsh.taskflow.view.v1'

/** Only viewing preferences survive a page or component remount. */
export interface TaskflowView {
  collapsed: boolean
  openProject: string | null
}

function defaultView(): TaskflowView {
  return { collapsed: true, openProject: null }
}

/**
 * Restore the last surface selection without restoring debt cards or actions.
 * @returns Valid preferences, or the original collapsed view if storage is unavailable or invalid.
 */
export function readView(): TaskflowView {
  let raw: string | null
  try {
    raw = window.localStorage.getItem(TASKFLOW_VIEW_KEY)
  } catch {
    // Blocked storage leaves the current page usable with the original default.
    return defaultView()
  }
  if (raw === null) return defaultView()
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    // A corrupt preference is not a reason to hide or block TaskFlow.
    return defaultView()
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return defaultView()
  const row = value as Record<string, unknown>
  if (row.version !== 1 || typeof row.collapsed !== 'boolean'
    || !(row.openProject === null || (typeof row.openProject === 'string' && row.openProject.trim() !== ''))) return defaultView()
  return { collapsed: row.collapsed, openProject: row.openProject }
}

/**
 * Save only the surface's viewing preference after a user gesture.
 * @param view - Current collapsed state and selected project.
 */
export function writeView(view: TaskflowView): void {
  const text = JSON.stringify({ version: 1, collapsed: view.collapsed, openProject: view.openProject })
  try {
    window.localStorage.setItem(TASKFLOW_VIEW_KEY, text)
  } catch {
    // Storage can be disabled or full; this page still keeps its in-memory view.
  }
}
