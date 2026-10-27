# Agent Note: Human phase confirmation with traceable reflection

Status: implemented

English | [中文](2026-10-27-taskflow-phase-confirmation.zh.md)

## Problem

A person may end a work phase in conversation or through a TaskFlow button. Treating only the button as confirmation leaves completed work waiting, while accepting arbitrary references lets an agent invent human approval. Ending a phase also needs to preserve the material for later reflection.

## Decision

The TaskFlow host authenticates a quoted human message at an exact byte offset in a native local Codex transcript before using the same exact-debt seal transaction as the button. The transcript location, native thread, human content marker and literal quotation are checked by the host. The caller owns semantic mapping from the person's statement to the selected debt; keyword matching never closes all work in a project. Other transcript providers require their own authenticated adapter.

The detail action names the person's intent: end this phase and hand it to the historian. Audited seals retain their confirmation source. The external historian consumer derives durable, idempotent jobs from valid exact seals and records reading and reflection separately. A seal does not attest that the historian read anything or that the whole project was accepted. Original material and continuation entries remain available.

## Alternatives considered

- Treat ordinary completion records as approval: rejected because execution and the person's decision have different sources.
- Let a caller supply any confirmation reference: rejected because references need host verification.
- Close phases through broad completion-keyword matching: rejected because one statement can cover a narrow phase with unresolved related work.
- Make the seal promise completed reflection: rejected because reading can fail or remain queued after the phase ends.

## Consequences

Conversational confirmation requires a supported native transcript and a precise scope selected by the caller. The host rejects unsupported or injected sources, partial records, missing quotations and linked paths. Reflection availability belongs to the separate consumer; its receipt must state actual coverage and unresolved material. The UI undo window remains unchanged; both entry points use the same exact resolver transaction.
