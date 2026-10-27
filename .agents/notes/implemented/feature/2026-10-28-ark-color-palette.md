# Agent Note: Independent ARK color palette

Status: implemented

English | [中文](2026-10-28-ark-color-palette.zh.md)

## Problem

DSH and TaskFlow need a shared ARK visual direction without changing their layout, task semantics, or existing behavior. A reversible color choice also needs to retain the person's light, dark, or system preference across reloads and avoid showing another palette while plugins load.

## Decision

The theme owner persists `ui-theme.palette` as `default` or `ark`, independently of `ui-theme.preference`. Existing settings resolve to `default`. The Appearance row exposes Original and ARK beside the existing scheme selection; selecting a palette changes colors immediately and uses the existing Host settings lifecycle. Remote browsers retain process-local choices under the same privilege rules.

ARK is a shared semantic token layer with light and dark values. It follows registered theme tokens and precedes explicit `overrideTokens()` source layers. Returning to Original removes the layer. TaskFlow consumes theme-owned history and shadow aliases while retaining its project identity palette, dark labels on that light data palette, and separate running, waiting, and error meanings. Geometry, navigation, task data, and phase confirmation are outside this color change.

The light palette draws from the local ARK UI-library candidate `MSC_AI/outputs/ark-ui-library-v1/src/vendor/collaboration/styles/ark-voice-tokens.scss`; that candidate is a source reference, not evidence of deployed ARK colors. The dark palette adapts the same visual direction for dark surfaces. Neither palette establishes a universal ARK design policy or human aesthetic acceptance.

The [pre-plugin bootstrap](../bug-fix/2026-08-10-pre-plugin-theme-bootstrap.md) embeds the selected palette and scheme before the shell renders, records its inline token names, and lets the presenter retract them when it adopts the runtime snapshot. The [Host-backed preferences lifecycle](../bug-fix/2026-08-06-host-backed-web-preferences.md) remains the durable settings owner; the palette adds no browser-storage authority.

## Alternatives considered

**Replace the base palette.** This would make the original colors unavailable as a direct comparison and rollback choice. A separate layer preserves both palettes.

**Register ARK light and dark as theme ids.** This couples color identity to scheme selection and complicates following the operating system. Independent palette and scheme choices retain that behavior.

**Recolor every TaskFlow project purple.** Project colors encode identity rather than interface chrome. Keeping that palette distinct preserves the information while shared controls and grouped history adopt ARK colors.

## Consequences

Color changes remain reversible without changing layout or task state. Built-in palette and scheme settings share one revisioned namespace and the existing write-failure recovery. Explicit override layers can intentionally differ from the selected palette, and third-party theme tokens beneath it can be superseded by ARK tokens.

The source palette and actual-browser evidence are different records. This round's screenshots and checks belong in the local QA directory `/Users/yangxiang/.local/share/dsh-ark-theme/20261028`; source inspection or a passing build alone does not establish the visible result.
