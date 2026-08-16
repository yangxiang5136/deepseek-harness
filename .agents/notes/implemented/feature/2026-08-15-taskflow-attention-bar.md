# Agent Note: TaskFlow attention bar over the bus ledger

Status: implemented

English | [中文](2026-08-15-taskflow-attention-bar.zh.md)

## Problem

The user's attention ledger (`~/my-memories/attention/events.jsonl`, append-only JSONL written by every AI surface under the TaskFlow protocol) had no in-console rendering: what is running now, where today's time went, and which delegated results still await the human's seal (收口) were invisible while working in the web console. A twelve-iteration prototype existed only as a dynamic Cordis package (pkg-26), whose `styles.insert` strings, `harness.handle` RPC, hashed-class padding injection, and per-session approval could not ship in-tree.

## Decision

Two packages port the prototype. `@deepseek-ai/dsh-host-taskflow` is a thin file plane: a `TypertRemoteService` (`taskflow`) whose `read()` returns the whole ledger text and whose `seal()` appends one audited `done` line — the request pins the exact `needs-you` event by its `ts` (`resolvesTs`) and names the human confirmation source (`confirmationRef`), and the gate re-reads the ledger at call time so a debt sealed from another surface is refused. Writes use `node:fs` directly (the session-persistence-jsonl precedent); the bus file stays the single fact source — no host cache, no storage-domain facts.

`@deepseek-ai/dsh-client-ui-taskflow` is the first `shell.overlay` resident: a pure fold engine (`fold.ts` — seal ≥ 60 s, lane homing, series packing, fragment aggregation, idle pause) refolds a 10 s-polled `HostObservable` of the parsed ledger; components are CSS Modules on `--dsw-*` aliases, and the low-saturation project palette stays a data literal. Text widths use canvas `measureText` with the `estTextW` character heuristic as fallback and pure-fold default; one ResizeObserver on the shared column feeds both the chip split and the strip's label-fit scale.

Content avoidance is a one-property contract: the bar publishes its live height as `--dsh-shell-bottom-clearance` on the frame element (found via `[data-shell-overlay]`'s parent), and ui-layout's frame — `box-sizing: border-box` — pads its columns by that variable in a deliberately separate, single-purpose commit so future upstream rebases carry one isolated diff.

## Alternatives considered

- **Fold on the host** — rejected: the prototype's fold semantics were the hard-won artifact; re-deriving them server-side risked silent drift, and the client must refold on a clock anyway (owed durations move without new events).
- **Prototype's hashed-class padding injection** (`.pI_x6G_frame`) — rejected: the hashed class drifts on every build; the CSS-variable seam survives rebuilds and keeps the upstream diff to one rule.
- **`ctx.fs` for ledger writes** — rejected: that service is the policy fence for model tools and refuses out-of-workspace writes; a host business package writes with `node:fs` per the existing persistence precedent.
- **Loose task-name seal matching** — rejected in cross-review: a same-named debt must never close by accident, so the request pins the event timestamp and records what authorized the close.
- **Publishing the clearance on `document.documentElement`** — rejected: custom properties inherit downward, so the variable is set on the exact element whose subtree consumes it, and it unpublishes with the bar.

## Consequences

- The console gains the see-it/seal-it loop: today's history strip, running chips, and the debts popover whose checkmark writes the audited `done` — while the ledger stays a bus file other surfaces keep appending to with no schema change.
- 10 s polling is deliberate (no file-watch push channel yet); a read failure keeps the last fold and surfaces the error on the bar rather than freezing.
- Geometry keeps named approximations: the chip-width formula mirrors CSS constants (150px task cap, 9px source tag) rather than measuring rendered nodes, and hover widths still clamp in `cqw`.
- Real-composition verification (collapsed/expanded avoidance geometry, hover zero-reflow) is deferred to the live-console acceptance pass; jsdom covers wiring and fold semantics, with the real ledger's month file as a fixture.

## Deferred

- Live-console acceptance against spec §6 v3.0 (P2 S6), including an `apps/web` scenario for avoidance geometry.
- Session soft-binding: lane click → jump to the owning session.
- Queueing actions (out of scope per the spec's action table).
