/**
 * TaskFlow type scale, TypeScript side (2026-09-24). The CSS side lives on
 * `.banner, .scale` in TaskFlowBar.module.css as --tf-font-*; a lock test
 * keeps the two equal. Measurement (chip widths, strip label fit, SVG label
 * clipping) must pass the role it renders at — the 10px default of estTextW
 * exists only for pinned tests.
 */

/** One type role: font size, line height (px) and weight. */
export interface TypeRole {
  readonly px: number
  readonly lh: number
  readonly weight: number
}

/** The five roles, most to least important. */
export const TF_TYPE = {
  /** The one answer per surface. */
  lead: { px: 15, lh: 20, weight: 600 },
  /** Names of things. */
  item: { px: 13, lh: 18, weight: 500 },
  /** Supporting data. */
  meta: { px: 12, lh: 18, weight: 400 },
  /** Verbs and chrome labels. */
  ctrl: { px: 12, lh: 16, weight: 500 },
  /** The floor: keys, empty states, instructions. */
  hint: { px: 11, lh: 16, weight: 400 },
} as const satisfies Record<string, TypeRole>
