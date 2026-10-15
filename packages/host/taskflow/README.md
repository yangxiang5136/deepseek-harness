# @deepseek-ai/dsh-host-taskflow

English | [中文](README.zh.md)

TaskFlow's host data plane: a Remote-only service (`taskflow` namespace) over the monthly attention ledgers in `~/my-memories/attention/`. `read` concatenates private regular `events-YYYY-MM.jsonl` files in filename order and excludes the rotating `events.jsonl` symlink; corrupt, permissive, or non-ENOENT I/O failures reject the call so the client keeps its last good fold. `seal` accepts only the fixed `dsh-ui:seal-click` gesture, plus an optional one-line closing note (≤280 characters, trimmed) written as the seal's `payload.note`, and holds the shared `.taskflow-ledger.lock` owner lease across read-check-month-rotation-append. Existing locks are never auto-broken; a five-second timeout fails busy for manual review. The writer rejects symlink append targets, resolves one exact `needs-you` by canonical `event_id` (or `ts` only for a legacy target), and appends a schema-v2 `done` resolver with its own UUID. The append is synced before release and tightens the ledger file to mode `0600`, matching the Python writer. The bus files remain the only fact source; the host keeps no cache. `todos` reads the regular `*.md` files of `~/my-memories/todo/projects/` raw (symlinks skipped) for the client's project tree. The ledger validator accepts `park` as a fourth `needs-you` kind (a parked side-branch, protocol v2.1).

## Review plans

`reviewPlans()` reads only top-level `*.json` files from `~/my-memories/attention/project-plans/`, or the absolute `DSH_TASKFLOW_REVIEW_PLANS_DIR` host override. The Remote call accepts no path. It preserves UTF-8 JSON object text in filename order; the client owns review-order schema validation. Missing directories return `exists: false`; symlink or non-regular roots and matching files, malformed JSON, changing files, and other I/O failures reject the complete read. Limits are 64 files, 256 KiB per file, and 2 MiB for the complete serialized snapshot, including escaped text and metadata. Reading plans does not write ledger events or change human acceptance.

The snapshot's `observer` exposes only `lastScanAt`, `lastErrorCount`, `coverage`, and `excluded` from `~/my-memories/attention/review-watch-status.json` (`DSH_TASKFLOW_REVIEW_WATCH_STATUS` override). A missing status file yields null; unsafe files, invalid health fields, or files over 4 KiB reject the read. Private source cursors and other fields are excluded. Clients use the scan timestamp to detect a stalled observer independently of plan-save time.

## Model Experience

None, as the service only answers browser Remote calls over the bus files; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **`read` is whole-history** — no incremental tail or month cursor; acceptable at current ledger sizes, but total retained history determines every poll's cost.
- **Ledger path is fixed** to the single-Mac bus convention; multi-machine layouts are an explicit non-goal (spec §8).
