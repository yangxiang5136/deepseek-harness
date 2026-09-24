# @deepseek-ai/dsh-client-ui-taskflow

English | [中文](README.zh.md)

TaskFlow bottom status bar, the first resident of the frame-wide `shell.overlay` slot: a collapsed 30px mini strip that expands into the attention surface defined by spec §6 v3.0 — a solid low-saturation time-history strip, one row of running chips, and the title popover holding seal debts / no-heartbeat lanes / overflow. Facts come from the bus ledger through the `taskflow` Remote namespace (`@deepseek-ai/dsh-host-taskflow`) and refold every 10 s. Timeline, current, background, and lane state remain day-scoped; `needs-you` debts fold over the complete ledger and survive day/month boundaries. A v2 debt closes only through an exact schema-v2 resolver: a `dsh` audited `done` seal or a `drop` withdrawal whose note begins `Superseded`. Legacy v1 debts retain the 60-second heuristic only for legacy terminal rows, so a future ordinary v2 terminal cannot close them. The seal checkmark sends the target `event_id` when available and `dsh-ui:seal-click` as confirmation. The bar publishes its live height as `--dsh-shell-bottom-clearance` on the shell frame so ui-layout content ends above it.

A project name in the needs-you tray opens that project's tree (Branch Compass inside TaskFlow): a 7-day mainline-vs-branch ratio that flags when branches take the larger share, the mainline with every unresolved branch forking where it began (running, stalled, waiting on you, or parked), and the project's bus todo items continuing the mainline past now. Settled branches are not drawn; they only feed the ratio and one summary line. The mainline is the human's pick per project (stored in browser `localStorage`), defaulting to the most active task. `park` debts (parked side-branches) stay out of the tray and the running rows and appear only on the tree.

## Model Experience

None, as the bar is a human-facing surface over the bus ledger; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Label-fit tests mix scales** — text widths are real (canvas `measureText`, `estTextW` fallback) and the chip row width is observed, but the history strip's label-fit comparison still runs against the 900px proportion model, not rendered pixels.
- **Queueing actions are out of scope** (spec §6 v3.0 action table).
