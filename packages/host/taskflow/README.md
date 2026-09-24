# @deepseek-ai/dsh-host-taskflow

English | [中文](README.zh.md)

TaskFlow's host data plane: a Remote-only service (`taskflow` namespace) over the monthly attention ledgers in `~/my-memories/attention/`. `read` concatenates private regular `events-YYYY-MM.jsonl` files in filename order and excludes the rotating `events.jsonl` symlink; corrupt, permissive, or non-ENOENT I/O failures reject the call so the client keeps its last good fold. `seal` accepts only the fixed `dsh-ui:seal-click` gesture, plus an optional one-line closing note (≤280 characters, trimmed) written as the seal's `payload.note`, and holds the shared `.taskflow-ledger.lock` owner lease across read-check-month-rotation-append. Existing locks are never auto-broken; a five-second timeout fails busy for manual review. The writer rejects symlink append targets, resolves one exact `needs-you` by canonical `event_id` (or `ts` only for a legacy target), and appends a schema-v2 `done` resolver with its own UUID. The append is synced before release and tightens the ledger file to mode `0600`, matching the Python writer. The bus files remain the only fact source; the host keeps no cache. `todos` reads the regular `*.md` files of `~/my-memories/todo/projects/` raw (symlinks skipped) for the client's project tree. The ledger validator accepts `park` as a fourth `needs-you` kind (a parked side-branch, protocol v2.1).

## Model Experience

None, as the service only answers browser Remote calls over the bus files; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **`read` is whole-history** — no incremental tail or month cursor; acceptable at current ledger sizes, but total retained history determines every poll's cost.
- **Ledger path is fixed** to the single-Mac bus convention; multi-machine layouts are an explicit non-goal (spec §8).
