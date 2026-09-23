# @deepseek-ai/dsh-client-ui-taskflow

English | [中文](README.zh.md)

TaskFlow bottom status bar, the first resident of the frame-wide `shell.overlay` slot: a collapsed 30px mini strip that expands into the attention surface defined by spec §6 v3.0 — a solid low-saturation time-history strip, one row of running chips, and the title popover holding seal debts / no-heartbeat lanes / overflow. Facts come from the bus ledger through the `taskflow` Remote namespace (`@deepseek-ai/dsh-host-taskflow`) and refold every 10 s. Timeline, current, background, and lane state remain day-scoped; `needs-you` debts fold over the complete ledger and survive day/month boundaries. A v2 debt closes only through an exact schema-v2 resolver: a `dsh` audited `done` seal or a `drop` withdrawal whose note begins `Superseded`. Legacy v1 debts retain the 60-second heuristic only for legacy terminal rows, so a future ordinary v2 terminal cannot close them. The seal checkmark sends the target `event_id` when available and `dsh-ui:seal-click` as confirmation. The bar publishes its live height as `--dsh-shell-bottom-clearance` on the shell frame so ui-layout content ends above it.

## Model Experience

None. A human-facing surface only; no tools, no prompt contribution.

## Known Limitations and Deferred Work

- **Label-fit tests mix scales** — text widths are real (canvas `measureText`, `estTextW` fallback) and the chip row width is observed, but the history strip's label-fit comparison still runs against the 900px proportion model, not rendered pixels.
- **Queueing actions are out of scope** (spec §6 v3.0 action table).
