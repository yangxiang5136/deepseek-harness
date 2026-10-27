/** Appearance row store: snapshot-mirror action and the revision guard. */
import { describe, expect, it } from 'vitest'
import { createAppearanceRowStore } from '../src/client/settings-store.ts'

describe('createAppearanceRowStore', () => {
  it('init shape: system preference with revision at -1', () => {
    const store = createAppearanceRowStore().create()
    expect(store.getSnapshot()).toEqual({ preference: 'system', palette: 'default', revision: -1 })
  })

  it('sync mirrors the preference and advances the revision', () => {
    const store = createAppearanceRowStore().create()
    store.actions.sync('dark', 0, 'default')
    expect(store.getSnapshot()).toEqual({ preference: 'dark', palette: 'default', revision: 0 })
    store.actions.sync('light', 2, 'default')
    expect(store.getSnapshot().preference).toBe('light')
    expect(store.getSnapshot().revision).toBe(2)
  })

  it('revision guard drops stale and duplicate writes', () => {
    const store = createAppearanceRowStore().create()
    store.actions.sync('dark', 3, 'default')
    store.actions.sync('system', 2, 'default')
    store.actions.sync('system', 3, 'default')
    expect(store.getSnapshot().preference).toBe('dark')
    expect(store.getSnapshot().revision).toBe(3)
  })
})
