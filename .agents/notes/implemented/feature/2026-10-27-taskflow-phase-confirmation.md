# Agent Note: Human phase confirmation with traceable reflection

Status: implemented

English | [中文](2026-10-27-taskflow-phase-confirmation.zh.md)

## Problem

A person may end a work phase in conversation or through a TaskFlow button. Treating only the button as confirmation leaves completed work waiting, while accepting arbitrary references lets an agent invent human approval. Ending a phase also needs to preserve the material for later reflection.

## Decision

The TaskFlow host authenticates a quoted human message at an exact byte offset in a native local transcript before using the same exact-debt seal transaction as the button. The request's `surface` selects one adapter per AI tool; Codex is the default for requests without it, and Claude Code is the second adapter. Shared code checks the host-owned root, path canonicality, regular-file identity, line boundary, record size and literal quotation; each adapter fixes its directory layout, file naming and the record fields that mark human-typed text, and contributes its own `confirmation_ref` prefix. The caller owns semantic mapping from the person's statement to the selected debt; keyword matching never closes all work in a project. Another AI tool joins only through its own adapter built from sampled native records.

A Claude Code record counts only when the app labels it as typed by the person in both `origin` (exactly `{kind: "human"}`) and `turnOrigin`, it belongs to the cited session in a main transcript, and it comes from the sampled `claude-desktop` entry point. Both labels are required: compaction summaries carry a human `turnOrigin` without an origin, while CI, scheduled-task, shell and pasted-content records carry a human origin with wrapped text. The quotation must sit in a text block after the app's leading reminders and outside any injected wrapper; tool results reject the record.

The detail action names the person's intent: end this phase and hand it to the historian. Audited seals retain their confirmation source. The external historian consumer derives durable, idempotent jobs from valid exact seals and records reading and reflection separately. A seal does not attest that the historian read anything or that the whole project was accepted. Original material and continuation entries remain available.

## Alternatives considered

- Treat ordinary completion records as approval: rejected because execution and the person's decision have different sources.
- Let a caller supply any confirmation reference: rejected because references need host verification.
- Close phases through broad completion-keyword matching: rejected because one statement can cover a narrow phase with unresolved related work.
- Make the seal promise completed reflection: rejected because reading can fail or remain queued after the phase ends.
- Authenticate Claude Code messages by text wrappers alone: rejected because a side session's first message, peer-session messages and compaction summaries contain plain text without wrappers; only the app's origin labels distinguish them.
- Accept every Claude Code entry point: rejected because terminal, IDE and SDK records were not sampled; headless SDK runs carry programmatic prompts. They fail closed until sampled.
- Reject resumed or forked Claude Code transcripts as Codex rejects forked threads: rejected because Claude Code marks continuation inconsistently and side sessions that the person types into are also derived; copies of human records keep the person's text, and the reference names the copy.
- Reuse `threadId` for every tool's conversation: rejected because each tool names its own identifier, and per-variant fields let the generated wire schema reject mixed requests.

## Consequences

Conversational confirmation requires a supported native transcript and a precise scope selected by the caller. Claude Code messages typed while a turn runs are queued attachments and cannot be cited, so the person repeats the confirmation after the turn. Authentication trusts the local account: it rejects misattributed, injected and relocated text, not records forged by a process that can write the transcript files. The host rejects unsupported or injected sources, partial records, missing quotations and linked paths. Reflection availability belongs to the separate consumer; its receipt must state actual coverage and unresolved material. The UI undo window remains unchanged; both entry points use the same exact resolver transaction.
