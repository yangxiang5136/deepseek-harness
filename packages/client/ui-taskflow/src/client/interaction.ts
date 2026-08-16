/**
 * Shared interaction currency of the bar's surfaces: the single click-popover
 * selection (one popover at a time across strip items and chips — opening one
 * closes the other, a banner click closes all) and the clipboard helper the
 * seal-command copy buttons share.
 */

/** Which click popover is open: a strip item by index, or a chip by index. */
export type ClickPop =
  | { type: 'seg' | 'pack' | 'agg'; idx: number }
  | { type: 'chip'; index: number }

/** Copy outcome: copied, or clipboard unavailable (select the text by hand). */
export type CopyState = 'done' | 'manual'

/**
 * Copy text via the async clipboard when present; otherwise report `manual`
 * so the caller leaves the text selectable.
 * @param text - text to copy.
 * @param report - receives the outcome (possibly async).
 */
export function doCopy(text: string, report: (state: CopyState) => void): void {
  try {
    // jsdom and insecure contexts have no clipboard despite the DOM types;
    // the property read below throws or yields undefined there.
    void navigator.clipboard.writeText(text)
      .then(() => { report('done') }, () => { report('manual') })
  } catch {
    // Clipboard unavailable: leave the text selectable for a manual copy.
    report('manual')
  }
}
