# Agent Note: TaskFlow debts name the chat they came from

Status: implemented

English | [中文](2026-11-26-taskflow-needs-you-session.zh.md)

## Problem

A needs-you debt records what waits for the human and where its material is (`ref`), but not which chat raised it. Several chats in Claude Code and Codex work on the same project at once, so a reviewer who opens a debt card cannot tell which conversation to return to for context. Chat IDs alone are opaque, and the title stores live on one Mac, while the same board also runs on a read-only server without those stores.

## Decision

Schema-v2 `needs-you` events accept one optional field, `payload.session`, holding the originating chat ID as a nonempty single line. The rest of the [attention-ledger decision](2026-08-15-taskflow-attention-bar.md) is unchanged: unknown keys are still rejected, and the field never participates in debt identity or closure.

The host resolves IDs to display titles through a path-free `taskflow.sessionTitles({ ids })` Remote call. The Claude desktop session store, then the Codex session index, then a fallback `session-titles.json` beside the ledger answer in that order, each only for IDs still unresolved. From a Claude session file the host reads only `sessionId`, `cliSessionId`, `title`, and `isArchived`, because those files also hold connector and permission settings. A desktop ID is read from its own file, a per-file memo keyed by size and modification time keeps rescans for CLI IDs cheap, and every source, file, and line is optional: failures contribute nothing and the call does not fail because of them. The fallback file lets a host without the live stores show titles that another process synchronizes.

The client looks up every open debt's session in one batched request, caches each settled answer for five minutes, and shows one fact row on the debt card: 去处 with tool and title, marked （已归档） when archived, or 来源会话 with a short ID while loading or when no title is found. The continuation prompt carries the full ID so another AI can locate the chat.

## Alternatives considered

**Put the title into the ledger event.** Titles change after the event is written, a rename would leave the ledger stale, and the append-only ledger cannot correct it.

**Reuse `ref`.** `ref` names the material to review; the chat is a separate fact. Overloading it would break existing debts whose `ref` is a path or branch.

**Scan every Claude session file on each request without a memo.** Each file holds the whole conversation; a full scan reads more than 100 MB on a typical machine.

## Consequences

Writers can add `payload.session` without changing any existing reader except this validator; the writer side and any other ledger validators must accept the field before writers emit it. Title lookups never block the board: a missing store, unreadable file, or failed Remote call shows the short ID with 标题查不到. The read-only server shows titles only when the fallback file is synchronized there. Host tests use synthetic temporary stores for all three sources, including duplicate Codex IDs, unreadable files, oversized files, and caps; client tests cover resolved, archived, unresolved, loading, and failed lookups.
