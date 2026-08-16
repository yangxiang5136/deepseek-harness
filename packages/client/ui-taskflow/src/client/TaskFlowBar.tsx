import type { ReactElement } from 'react'
import css from './TaskFlowBar.module.css'

/**
 * S1 placeholder strip proving the shell.overlay mount and the bottom dock
 * position; S3 replaces the body with the ported pkg-26 surface (mini bar ⇄
 * time history + chip row). The overlay layer is click-through; the bar
 * itself takes pointer events.
 */
export function TaskFlowBar(): ReactElement {
  return <div className={css.bar}>TaskFlow</div>
}
