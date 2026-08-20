# Agent Note: TaskFlow attention bar over the bus ledger

Status: implemented

English | [中文](2026-08-15-taskflow-attention-bar.zh.md)

## Problem

The user's attention ledger (`~/my-memories/attention/events.jsonl`, append-only JSONL written by every AI surface under the TaskFlow protocol) had no in-console rendering: what is running now, where today's time went, and which delegated results still await the human's seal (收口) were invisible while working in the web console. A twelve-iteration prototype existed only as a dynamic Cordis package (pkg-26), whose `styles.insert` strings, `harness.handle` RPC, hashed-class padding injection, and per-session approval could not ship in-tree.

## Decision

Two packages port the prototype. `@deepseek-ai/dsh-host-taskflow` is a thin file plane: a `TypertRemoteService` (`taskflow`) whose `read()` concatenates every private regular monthly ledger without rereading the rotating symlink. Corrupt, permissive, or non-ENOENT read failures reject instead of presenting an empty ledger. `seal()` accepts only the fixed UI gesture, holds the attention root's cross-language `.taskflow-ledger.lock` across read-check-month-rotation-append, pins the target by canonical `event_id` (falling back to `ts` only when the target has no ID), and appends a synced schema-v2 `done` resolver with its own UUID. The lock is never auto-broken, append paths never follow symlinks, and files are tightened to `0600`. Writes use `node:fs` directly; the bus remains the single fact source — no host cache, no storage-domain facts.

`@deepseek-ai/dsh-client-ui-taskflow` is the first `shell.overlay` resident: a pure fold engine (`fold.ts`) keeps timeline/current/background/lane views day-scoped while folding attention debt over append order across the complete ledger. V2 debt closes only through an exact schema-v2 resolver: a `dsh` audited `done` seal or a `drop` withdrawal whose note begins `Superseded`. Legacy v1 debt retains the 60-second heuristic only for legacy terminal rows; future ordinary v2 terminals cannot close it. Task identity comparisons use project+task throughout, with append ordinals separating otherwise identical legacy UI rows. Components are CSS Modules on existing `--dsw-*` aliases, and the low-saturation project palette stays a data literal.

Content avoidance is a one-property contract: the bar publishes its live height as `--dsh-shell-bottom-clearance` on the frame element (found via `[data-shell-overlay]`'s parent), and ui-layout's frame — `box-sizing: border-box` — pads its columns by that variable in a deliberately separate, single-purpose commit so future upstream rebases carry one isolated diff.

## Alternatives considered

- **Fold on the host** — rejected: the prototype's fold semantics were the hard-won artifact; re-deriving them server-side risked silent drift, and the client must refold on a clock anyway (owed durations move without new events).
- **Prototype's hashed-class padding injection** (`.pI_x6G_frame`) — rejected: the hashed class drifts on every build; the CSS-variable seam survives rebuilds and keeps the upstream diff to one rule.
- **`ctx.fs` for ledger writes** — rejected: that service is the policy fence for model tools and refuses out-of-workspace writes; a host business package writes with `node:fs` per the existing persistence precedent.
- **Task-name or elapsed-time closure for new debt** — rejected: schema-v2 debt requires an exact resolver, while the old elapsed-time rule remains confined to reading legacy v1 records.
- **A process-local seal queue** — rejected: two hosts can run concurrently, so the shared atomic directory lock is the serialization point for every runtime.
- **Publishing the clearance on `document.documentElement`** — rejected: custom properties inherit downward, so the variable is set on the exact element whose subtree consumes it, and it unpublishes with the bar.

## Consequences

- The console gains the see-it/seal-it loop: today's history strip and running chips plus cross-day schema-v2 debts whose checkmark writes one exact audited resolver.
- A month rollover cannot append through a stale `events.jsonl` link: the seal derives one wall-clock month under the shared lock, creates that monthly file, atomically replaces the symlink, then appends.
- 10 s polling is deliberate (no file-watch push channel yet); a read failure keeps the last fold and surfaces the error on the bar rather than freezing.
- Geometry keeps named approximations: the chip-width formula mirrors CSS constants (150px task cap, 9px source tag) rather than measuring rendered nodes, and hover widths still clamp in `cqw`.
- The avoidance publisher is effect-driven, not ref-driven: live acceptance showed the platform runtime attaches a swapped-in root's ref before the old root's null call, so a ref-held observer would be disconnected by its predecessor — effect cleanup→setup ordering is guaranteed either way. jsdom's runtime orders the calls the other way and cannot catch this.
- Live acceptance passed (collapsed/expanded avoidance geometry both directions, hover zero-reflow three-state, 10 s refresh with an open popover, the audited seal round-trip against the real ledger); the title popover opens upward — the prototype's downward anchor clipped past the viewport on the bottom-docked bar.

## Deferred

- An `apps/web` scenario pinning the avoidance geometry in a real composition (live acceptance covered it manually).
- Session soft-binding: lane click → jump to the owning session.
- Queueing actions (out of scope per the spec's action table).
