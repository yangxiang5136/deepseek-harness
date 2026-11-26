import { describe, expect, it } from 'vitest'
import { parseTodoDestinations } from '../src/client/todo.ts'

const DEBT = '716b0208-3087-4069-9958-2fb259ba7e55'
const CODEX = 'codex://threads/019d8f2a-1111-7222-8333-444455556666'
const row = (to: string): string => `  - todo-decide · debt:${DEBT} · to:${to}`
const parse = (text: string) => parseTodoDestinations([{ name: 'DME.md', text }])

describe('todo-decide destinations', () => {
  it('skips the sample row with no destination yet', () => {
    expect(parse(`  - todo-decide · state:已问未答 · since:2026-11-23 · asked:2026-11-23 · next_ask:2026-11-25 · debt:${DEBT} · from:local_0e239041-7e50-4297-bf59-6f0033f77b70 · to:- · ans:-`))
      .toEqual(new Map())
  })

  it.each([CODEX, '新开:2026-11-27'])('preserves colons, trims values and handles reordered CRLF rows for %s', (to) => {
    expect(parse(`# Todo\r\n  - todo-decide · to: ${to}  · unknown:ignored · debt: ${DEBT}  \r\n`))
      .toEqual(new Map([[DEBT, to]]))
  })

  it.each([
    `  - todo-decide · debt:${DEBT}`,
    row(' '),
    `  - todo-decide · to:${CODEX}`,
    `  - todo-decide · debt:  · to:${CODEX}`,
    row(CODEX).slice(1),
    ` ${row(CODEX)}`,
    row(CODEX).replace('todo-decide', 'todo-decided'),
    row(CODEX).replace('todo-decide ', 'todo-decide\t'),
  ])('ignores invalid or incomplete row %j', (line) => {
    expect(parse(line)).toEqual(new Map())
  })

  it('keeps a matching destination repeated across files', () => {
    expect(parseTodoDestinations([{ name: 'DME.md', text: row(CODEX) }, { name: 'ARK.md', text: row(CODEX) }]))
      .toEqual(new Map([[DEBT, CODEX]]))
  })

  it('drops a conflict across files even if a later row repeats a destination', () => {
    expect(parseTodoDestinations([
      { name: 'DME.md', text: row(CODEX) },
      { name: 'ARK.md', text: [row('新开:2026-11-27'), row(CODEX)].join('\n') },
    ])).toEqual(new Map())
  })
})
