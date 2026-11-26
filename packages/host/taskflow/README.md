# @deepseek-ai/dsh-host-taskflow

English | [中文](README.zh.md)

TaskFlow's host data plane: a Remote-only service (`taskflow` namespace) over the monthly attention ledgers in `~/my-memories/attention/`. `read` concatenates private regular `events-YYYY-MM.jsonl` files in filename order and excludes the rotating `events.jsonl` symlink; corrupt, permissive, or non-ENOENT I/O failures reject the call so the client keeps its last good fold. `seal` accepts only the fixed `dsh-ui:seal-click` gesture, plus an optional one-line closing note (≤280 characters, trimmed) written as the seal's `payload.note`, and holds the shared `.taskflow-ledger.lock` owner lease across read-check-month-rotation-append. Existing locks are never auto-broken; a five-second timeout fails busy for manual review. The writer rejects symlink append targets, resolves one exact `needs-you` by canonical `event_id` (or `ts` only for a legacy target), and appends a schema-v2 `done` resolver with its own UUID. The append is synced before release and tightens the ledger file to mode `0600`, matching the Python writer. The bus files remain the only fact source; the host keeps no ledger cache. `todos` reads the regular `*.md` files of `~/my-memories/todo/projects/` raw (symlinks skipped) for the client's project tree. The ledger validator accepts `park` as a fourth `needs-you` kind (a parked side-branch, protocol v2.1).

## Session titles

Schema-v2 `needs-you` events may carry an optional nonempty single-line `payload.session`: the ID of the chat the debt came from, such as a Claude Code desktop `local_<uuid>` session, a Claude Code CLI session UUID, or a Codex thread ID. Other `needs-you` payload rules are unchanged. `sessionTitles({ ids })` resolves at most 500 nonempty IDs to `{ tool, title, archived? }` and rejects any other request; IDs that no source names are absent from `titles`. Three host-selected sources answer in order, each only for IDs still unresolved, and the Remote caller cannot choose a path. The Claude desktop store (`DSH_TASKFLOW_CLAUDE_SESSIONS_DIR`, default `~/Library/Application Support/Claude/claude-code-sessions`) maps `sessionId` and `cliSessionId` from `<a>/<b>/local_<uuid>.json` files, reading only those two fields plus `title` and `isArchived`. A desktop ID is read from its own file; any other unresolved ID scans at most 2,000 files of at most 2 MiB each, and the gateway memoizes those four fields per file until its size or modification time changes. The Codex index (`DSH_TASKFLOW_CODEX_SESSION_INDEX`, default `~/.codex/session_index.jsonl`, at most 20 MiB) keeps each ID's line with the latest `updated_at`, falling back to the later line. The fallback file (`DSH_TASKFLOW_SESSION_TITLES`, default `session-titles.json` beside the ledger, at most 4 MiB) serves hosts without those stores, such as a read-only server, as `{"schemaVersion":1,"titles":{"<id>":{"tool":"claude-code"|"codex","title":"...","archived":false}}}`; a file that deviates from that schema contributes nothing, and invalid entries are ignored. Missing, oversized, unreadable, or malformed sources, files, lines, and entries contribute no titles without failing the call. Titles collapse whitespace to single spaces and keep at most 200 characters.

## Human phase confirmations

`confirmPhase(request)` accepts one exact debt and a citation of one human message in a native local transcript: absolute `sourcePath`, the `byteOffset` where the record starts, and a verbatim one-line `quote` of at most 280 characters. `surface` names the AI tool that wrote the transcript and selects its adapter; each adapter fixes its root below the host user's home directory, so a Remote caller never chooses where the host reads. Every adapter rejects symlinked roots, directories, or files, non-regular files, offsets that do not start a line, partial or oversized records (1 MiB each), malformed JSON or UTF-8, files replaced during the read, and quotations absent from the human-typed text. A rejected request writes nothing. The calling interactive AI determines which exact debt the statement covers; this method does not classify arbitrary conversation or close similarly named tasks.

| `surface` | Conversation field | Accepted transcript | Human message | `confirmation_ref` |
|---|---|---|---|---|
| `codex`, or omitted | `threadId` | Under `~/.codex/sessions/` or `archived_sessions/`, file name ending `-<threadId>.jsonl`; the first record is an interactive `vscode` or `cli` session without a parent thread or fork | `response_item` with role `user` and `user.text` content that does not start with an automation or injected-context wrapper | `codex-user:<threadId>#byte=<offset>` |
| `claude-code` | `sessionId` | `~/.claude/projects/<project-slug>/<sessionId>.jsonl`; subagent transcripts nest deeper and are rejected | `user` record of that session from the `claude-desktop` entry point with `origin` exactly `{"kind":"human"}`, `turnOrigin: "human"`, `isSidechain: false`, and no meta, compact-summary, or transcript-only flag | `claude-code-user:<sessionId>#byte=<offset>` |

A Claude Code quotation must lie in a text block after any leading `<system-reminder>` elements. Blocks that then start with markup or contain injected wrappers (further reminders, pasted content, shell input or output, CI, task, scheduled, side-session, cross-session, or command events) do not count; images and documents are skipped, and a tool result or unfamiliar block rejects the record.

Click confirmation and authenticated natural-language confirmation share the ledger lock and exact seal transaction. A natural confirmation records the adapter's reference as `confirmation_ref` and only the original quotation as `payload.note`. The seal timestamp records confirmation, not an inferred real-world completion date. Repeated requests write no second resolver. Source transcripts and debt references remain untouched. Historian phase-review consumers can use any audited seal as the start of a review; this service does not claim the historian has read or reflected on the material.

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
- **Claude Code confirmations cover typed desktop-app records only.** Terminal, IDE, and SDK entry points fail closed until a native record from them is sampled. A message typed while a turn is running is stored as a queued attachment, not a `user` record, so the person repeats the confirmation after the turn ends.
- **Resumed or forked Claude Code transcripts can hold copies of earlier human records** carrying the new session ID. Such a copy authenticates because its text is the person's, but its reference names the copy, not the session where the message was first typed.
- **Transcript authentication trusts the local account.** The checks reject misattributed, injected, and relocated text; a process that can write the transcript files can still forge a record.
