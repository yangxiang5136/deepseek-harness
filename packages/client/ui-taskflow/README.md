# @deepseek-ai/dsh-client-ui-taskflow

English | [中文](README.zh.md)

TaskFlow bottom status bar, the first resident of the frame-wide `shell.overlay` slot: a collapsed 30px mini strip that expands into the attention surface defined by spec §6 v3.0 — a solid low-saturation time-history strip, one row of running chips, and the title popover holding seal debts / no-heartbeat lanes / overflow. Facts come from the bus ledger through the `taskflow` Remote namespace (`@deepseek-ai/dsh-host-taskflow`) and refold every 10 s. Timeline, current, background, and lane state remain day-scoped; `needs-you` debts fold over the complete ledger and survive day/month boundaries. A v2 debt closes only through an exact schema-v2 resolver: a `dsh` audited `done` seal or a `drop` withdrawal whose note begins `Superseded`. Legacy v1 debts retain the 60-second heuristic only for legacy terminal rows, so a future ordinary v2 terminal cannot close them. The seal checkmark sends the target `event_id` when available and `dsh-ui:seal-click` as confirmation. The bar publishes its live height as `--dsh-shell-bottom-clearance` on the shell frame so ui-layout content ends above it. Type follows one five-role scale (lead 15 / item 13 / meta 12 / ctrl 12 / hint 11px, `--tf-font-*` on the banner, mirrored by `typeScale.ts`), so size tracks importance: the current task, 待你收口 and the lean verdict lead each surface. Collapsed, the mini bar also carries an amber count of the debts still shown in the tray (same filter, so the two agree inside the 撤销 window).

A project name in the needs-you tray opens that project's tree (Branch Compass inside TaskFlow): a 7-day mainline-vs-branch ratio that flags when branches take the larger share, the mainline with every unresolved branch forking where it began (running, stalled, waiting on you, or parked), and the project's bus todo items continuing the mainline past now. Settled branches are not drawn; they only feed the ratio and one summary line. The mainline is the human's pick per project (a hover-revealed 设为主线 chip on each row; stored in browser `localStorage`), defaulting to the most active task. A tray row or a waiting / parked tag opens the same debt card: status, ref, note, the latest move since it was filed, the last ledger events, a copyable continuation prompt (cause, Sean's recent closing notes on the project, and the `att` commands so any AI can resume the task and keep TaskFlow in sync), and the seal with an optional one-line note — Sean's feedback, which later AIs read before working on the project. The title popover holds only no-heartbeat lanes and overflowed chips; open debts live in the tray alone. `park` debts (parked side-branches) stay out of the tray and the running rows and appear only on the tree.

## Model Experience

None, as the bar is a human-facing surface over the bus ledger; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Measured geometry mirrors CSS by hand** — text is measured at its type role (canvas `measureText`, `estTextW` fallback) against the observed row and strip widths, but the SVG tree constants in `ProjectPanel.tsx` and the chip box model in `fold.ts` `CHIP` restate CSS values; only the type tokens (`TF_TYPE`) and the chip max-widths are locked by tests.
- **Queueing actions are out of scope** (spec §6 v3.0 action table).
