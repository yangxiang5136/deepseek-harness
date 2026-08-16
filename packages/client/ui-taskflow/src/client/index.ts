/**
 * TaskFlow bottom status bar, browser half (S1 skeleton): registers the
 * frame-wide `shell.overlay` entry that later phases grow into the full
 * time-history + chip-row surface (spec §6 v3.0). No data plane yet — the
 * `taskflow` Remote namespace arrives with S2.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the ui-layout SlotMap merge (the shell.overlay list slot).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { TaskFlowBar } from './TaskFlowBar.tsx'

/** Required services: the overlay slot registry. */
export const inject = ['slots']

/**
 * Client plugin body: mount the TaskFlow bar into the shell overlay layer.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'taskflow-bar',
    order: 100,
  }, TaskFlowBar))
}
