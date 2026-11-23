// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { buildModel, estTextW, parseLedgerText } from '../src/client/fold.ts'
import { HistoryStrip } from '../src/client/HistoryStrip.tsx'

const NOW = new Date(2026, 9, 7, 9, 27, 27).getTime()

function eventLine(event: 'start' | 'done', secondsAgo: number): string {
  return JSON.stringify({
    schema_version: 2,
    event_id: event === 'start'
      ? '00000000-0000-4000-8000-000000000001'
      : '00000000-0000-4000-8000-000000000002',
    ts: new Date(NOW - secondsAgo * 1000).toISOString(),
    surface: 'codex',
    project: 'digital-me',
    task: '邮件刷新修复',
    event,
  })
}

function renderHistory(lines: string[]) {
  const model = buildModel(parseLedgerText(lines.join('\n')), NOW)
  return render(
    <HistoryStrip
      model={model}
      now={NOW}
      measure={estTextW}
      stripW={900}
      clickPop={null}
      onTogglePop={() => {}}
    />,
  )
}

afterEach(cleanup)

describe('HistoryStrip recorded attention', () => {
  it('acknowledges the first start before its attention span has ended', () => {
    renderHistory([eventLine('start', 45)])

    expect(screen.getByText('当前任务已记录，切换或结束后显示时间线')).toBeTruthy()
    expect(screen.queryByText('今日暂无已结束的注意力时段')).toBeNull()
    expect(screen.queryByText('今日暂无注意力事件')).toBeNull()
  })

  it('describes an empty day as having no ended attention spans', () => {
    renderHistory([])

    expect(screen.getByText('今日暂无已结束的注意力时段')).toBeTruthy()
    expect(screen.queryByText('当前任务已记录，切换或结束后显示时间线')).toBeNull()
  })

  it('shows the recorded span once the task has ended', () => {
    renderHistory([eventLine('start', 180), eventLine('done', 45)])

    expect(screen.getByText('邮件刷新修复')).toBeTruthy()
    expect(screen.queryByText('当前任务已记录，切换或结束后显示时间线')).toBeNull()
    expect(screen.queryByText('今日暂无已结束的注意力时段')).toBeNull()
  })
})
