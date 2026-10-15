# Agent Note: TaskFlow review plans retain separate debt and source identities

Status: implemented

English | [中文](2026-10-15-taskflow-review-plans.zh.md)

## Problem

The attention ledger records execution and unresolved human decisions, but it cannot express the order in which related material merits review. Sorting debts by task name confuses distinct review requests that share a task. A saved order also becomes misleading when another conversation has new information that the plan has not incorporated.

## Decision

Project review plans are separate local JSON files read through the TaskFlow host. The client validates the files, shows the saved order with explicit ordering overrides, and labels main, parallel, and conditional items. Item references and advisory predecessors explain where to continue without imposing approval gates. A project with a plan is reachable through the project selector even when it has no recent activity, todo, or debt.

Each item cites exact schema-v2 debt event IDs. Opening an item selects that debt identity even when several debts share the same task phrase. Review status comes from the ledger: an ordinary terminal event leaves the debt open; the existing audited human seal closes only its exact target; an exact supersede records replacement. Missing targets remain visibly unresolved. The [attention-ledger decision](2026-08-15-taskflow-attention-bar.md) continues to own execution and closure semantics.

The saved source records distinguish observed messages from reconciled messages. A pending record reports new information awaiting reconciliation; it never approves material or closes a task. Local watcher coverage and scan health appear separately from those saved source records; missing, stale, or failed observation remains visible. Plan reads refresh on the existing polling cadence. Read or validation failures retain the last valid plan and display an error, so broken metadata cannot erase the review order silently.

## Alternatives considered

**Add ordering and message fields to attention events.** The six-event protocol has separate execution and exact closure responsibilities. Encoding a plan update as task completion or a new review debt would change those meanings and create false work or acceptance records.

**Copy the plan into todo checkboxes.** That introduces another mutable completion list and loses exact debt identities, conditional order, and source freshness. The [project-access decision](../bug-fix/2026-10-07-taskflow-project-access.md) retains todo access; review guidance has its own data.

**Treat task names or new messages as acceptance.** Several review requests can share a task, and new discussion can reopen uncertainty. Only explicit debt IDs and the existing seal operation identify which pending request the user closes.

## Consequences

The panel provides a shared local review order without changing the ledger schema, generic writer, seal gesture, or historical records. It sends no plan or conversation content to a model. Producers remain responsible for saving authorized metadata and accurate source references; the panel does not intercept messages from external applications or independently prove their reconciliation.

The assembled keyless Web scenario checks exact opening for same-task debts, plan updates while the page remains open, source freshness labels, last-valid behavior, and the existing seal round-trip. Ordering is guidance rather than a scheduler: saving, reading, discussing, or reordering an item does not establish approval, completion, or permission to perform its work.
