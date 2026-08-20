# @deepseek-ai/dsh-host-taskflow

English | [中文](README.zh.md)

TaskFlow's host data plane: a Remote-only service (`taskflow` namespace) over the monthly attention ledgers in `~/my-memories/attention/`. `read` concatenates private regular `events-YYYY-MM.jsonl` files in filename order and excludes the rotating `events.jsonl` symlink; corrupt, permissive, or non-ENOENT I/O failures reject the call so the client keeps its last good fold. `seal` accepts only the fixed `dsh-ui:seal-click` gesture and holds the shared `.taskflow-ledger.lock` owner lease across read-check-month-rotation-append. Existing locks are never auto-broken; a five-second timeout fails busy for manual review. The writer rejects symlink append targets, resolves one exact `needs-you` by canonical `event_id` (or `ts` only for a legacy target), and appends a schema-v2 `done` resolver with its own UUID. The append is synced before release and tightens the ledger file to mode `0600`, matching the Python writer. The bus files remain the only fact source; the host keeps no cache.

## Model Experience

None. The service exposes no tools and contributes no prompt content; it only answers browser Remote calls.

## Known Limitations and Deferred Work

- **`read` is whole-history** — no incremental tail or month cursor; acceptable at current ledger sizes, but total retained history determines every poll's cost.
- **Ledger path is fixed** to the single-Mac bus convention; multi-machine layouts are an explicit non-goal (spec §8).
