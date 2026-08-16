# @deepseek-ai/dsh-client-ui-taskflow

English | [中文](README.zh.md)

TaskFlow bottom status bar, the first resident of the frame-wide `shell.overlay` slot: a collapsed 30px mini strip that expands into the attention surface defined by spec §6 v3.0 — a solid low-saturation time-history strip (packed series, fragment blocks, in-place hover lift), one row of breathing running chips, and the title popover holding seal debts / no-heartbeat lanes / overflow. Facts come from the bus ledger through the `taskflow` Remote namespace (`@deepseek-ai/dsh-host-taskflow`), refolded client-side every 10 s by the pure fold engine (`src/client/fold.ts`, unit-tested against a real ledger fixture); the bar renders the ledger and never owns data. The popover's seal checkmark drives the audited `seal()` gate with the exact needs-you pin and `dsh-ui:seal-click` as the confirmation ref. The bar publishes its live height as `--dsh-shell-bottom-clearance` on the shell frame (ResizeObserver over whichever root is mounted), and ui-layout's frame pads its columns by that variable — content ends above the bar instead of underneath it.

## Model Experience

None. A human-facing surface only; no tools, no prompt contribution.

## Known Limitations and Deferred Work

- **Label-fit tests mix scales** — text widths are real (canvas `measureText`, `estTextW` fallback) and the chip row width is observed, but the history strip's label-fit comparison still runs against the 900px proportion model, not rendered pixels.
- **Queueing actions are out of scope** (spec §6 v3.0 action table).
