# Agent Note: TaskFlow review plans identify conversations and retain exact debts

Status: implemented

English | [中文](2026-10-15-taskflow-review-plans.zh.md)

## Problem

The attention ledger records execution and unresolved human decisions, but it cannot express the order in which related material merits review. Step descriptions do not identify the conversation to revisit, and several steps can refer to the same conversation. Sorting debts by task name also confuses distinct review requests that share a task. A saved order becomes misleading when another conversation has new information that the plan has not incorporated.

## Decision

Project review plans are separate local JSON files read through the TaskFlow host. The client validates the files and shows actual conversation names in the saved order, including explicit ordering overrides, with parallel conversations listed separately. Steps with the same conversation ID share one row. A missing conversation name is labeled as awaiting synchronization rather than replaced by a step description. Step descriptions, reasons, conditions, and references remain plan metadata. A project with a plan is reachable through the project selector even when it has no recent activity, todo, or debt.

The browser saves the expanded or collapsed view and selected project, so a reload or new page at the same origin retains a visible review list. Closing a project or selecting no project also survives a reload. A browser without a saved view starts collapsed. Open debt cards and closure actions are not saved as view state.

Each item cites exact schema-v2 debt event IDs, and the conversation row combines their review status. The review list has no copy-entry or debt-opening buttons; the existing pending-review tray opens and seals each exact debt, including debts sharing the same task phrase. Project trees retain activity history without branch-share percentages. Review status comes from the ledger: an ordinary terminal event leaves the debt open; the existing audited human seal closes only its exact target; an exact supersede records replacement. Missing targets remain visibly unresolved. The [attention-ledger decision](2026-08-15-taskflow-attention-bar.md) continues to own execution and closure semantics.

The saved source records distinguish observed messages from reconciled messages. A pending record reports new information awaiting reconciliation; it never approves material or closes a task. Local watcher coverage and scan health appear separately from those saved source records; missing, stale, or failed observation remains visible. Plan reads refresh on the existing polling cadence. Read or validation failures retain the last valid plan and display an error, so broken metadata cannot erase the review order silently.

## Alternatives considered

**Add ordering and message fields to attention events.** The six-event protocol has separate execution and exact closure responsibilities. Encoding a plan update as task completion or a new review debt would change those meanings and create false work or acceptance records.

**Copy the plan into todo checkboxes.** That introduces another mutable completion list and loses exact debt identities, conditional order, and source freshness. The [project-access decision](../bug-fix/2026-10-07-taskflow-project-access.md) retains todo access; review guidance has its own data.

**Treat task names or new messages as acceptance.** Several review requests can share a task, and new discussion can reopen uncertainty. Only explicit debt IDs and the existing seal operation identify which pending request the user closes.

## Consequences

The panel provides a shared local review order without changing the ledger schema, generic writer, seal gesture, or historical records. It sends no plan or conversation content to a model. Producers remain responsible for saving authorized metadata and accurate source references; the panel does not intercept messages from external applications or independently prove their reconciliation.

The assembled keyless Web scenario uses synthetic full conversation names to check exact name display, same-conversation deduplication, the absence of review-list action buttons and branch percentages, reload and same-origin page restoration, explicit project closure, exact tray opening for same-task debts, plan updates while the page remains open, source freshness labels, last-valid behavior, and the existing seal round-trip. Ordering is guidance rather than a scheduler: saving, reading, discussing, or reordering an item does not establish approval, completion, or permission to perform its work.
