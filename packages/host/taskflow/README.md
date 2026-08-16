# @deepseek-ai/dsh-host-taskflow

English | [中文](README.zh.md)

TaskFlow's host data plane: a Remote-only service (`taskflow` namespace) over the attention ledger at `~/my-memories/attention/events.jsonl`. `read` returns the raw JSONL text with read metadata in one shot; parsing and fold semantics (spec §6 v3.0) live entirely in the browser half (`@deepseek-ai/dsh-client-ui-taskflow`), so the bus file stays the only truth and the host never caches a second copy. A `seal` mutation (append a human-authorized `done` event) lands in a later phase.

## Model Experience

None. The service exposes no tools and contributes no prompt content; it only answers browser Remote calls.

## Known Limitations and Deferred Work

- **`read` is whole-file** — no incremental tail; acceptable at current ledger sizes (monthly rotation), revisit if a month outgrows one read.
- **`seal` is not implemented yet** — the seal checkmark (P2 S5) will append a `done` event after validating an open `needs-you` exists for the task.
- **Ledger path is fixed** to the single-Mac bus convention; multi-machine layouts are an explicit non-goal (spec §8).
