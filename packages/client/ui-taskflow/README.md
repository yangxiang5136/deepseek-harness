# @deepseek-ai/dsh-client-ui-taskflow

English | [中文](README.zh.md)

TaskFlow bottom status bar, the first resident of the frame-wide `shell.overlay` slot: a collapsed 30px mini strip that expands into the attention surface defined by spec §6 v3.0 — a solid low-saturation time-history strip (packed series, fragment blocks, in-place hover lift), one row of breathing running chips, and the title popover holding seal debts / no-heartbeat lanes / overflow. Facts come from the bus ledger through the `taskflow` Remote namespace (`@deepseek-ai/dsh-host-taskflow`), refolded client-side every 10 s; the bar renders the ledger and never owns data. S1 ships the mount skeleton; the ported surface lands in S3–S5.

## Model Experience

None. A human-facing surface only; no tools, no prompt contribution.

## Known Limitations and Deferred Work

- **S1 placeholder body** — the full pkg-26 surface (fold engine, chips, popover, seal checkmark) is ported in P2 S3–S5.
- **Content avoidance needs one upstream line** — publishing `--dsh-shell-bottom-clearance` works only once ui-layout's frame consumes it (P2 S4); until then the bar floats over content.
- **Queueing actions are out of scope** (spec §6 v3.0 action table).
