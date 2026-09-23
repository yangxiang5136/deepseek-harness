/** Independent-process TaskFlow seal worker used by the lock integration test. */

import { Context } from '@deepseek-ai/cordis'
import TaskflowLedgerGateway from '../../src/index.ts'

const [path, project, task, resolvesTs, resolvesEventId] = process.argv.slice(2)
if (path === undefined || project === undefined || task === undefined
  || resolvesTs === undefined || resolvesEventId === undefined) {
  throw new Error('seal-worker requires path, project, task, resolvesTs, resolvesEventId')
}

process.env.DSH_TASKFLOW_LEDGER = path
const ctx = new Context()
await ctx.plugin(TaskflowLedgerGateway)
try {
  const gateway = ctx.get('taskflow') as TaskflowLedgerGateway
  const result = await gateway.seal({
    project,
    task,
    resolvesTs,
    resolvesEventId,
    confirmationRef: 'dsh-ui:seal-click',
  })
  process.stdout.write(`TASKFLOW_RESULT:${JSON.stringify(result)}\n`)
} finally {
  await ctx.fiber.dispose()
}
