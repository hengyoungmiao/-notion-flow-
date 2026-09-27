import { FLOW_IDS } from '../core/adapters/fake'
import type { AppController } from './controller'

/** 演示模式预设：直接进入“已配置”状态，便于展示概览页等界面 */
export async function seedReadyPreset(c: AppController): Promise<void> {
  await c.didaSaveToken('demo-token-000000')
  const personal = (await c.createWorkspace('个人空间')).data!
  await c.notionLoginPoll(personal)
  await c.bindTaskDatabase(personal, FLOW_IDS.tasks)
  await c.ensureDidaIdProperty(personal)
  await c.startInitialSync(personal)
  const company = (await c.createWorkspace('公司空间')).data!
  await c.notionLoginPoll(company)
  await c.bindTaskDatabase(company, FLOW_IDS.tasks)
  await c.ensureDidaIdProperty(company)
  await c.setActiveWorkspace(personal)
  await c.finishOnboarding()
}

/** 演示模式预设：制造一次“大批量删除”，展示熔断确认 */
export async function seedBlockedPreset(c: AppController): Promise<void> {
  await seedReadyPreset(c)
  c.demoMutate((dida) => {
    for (const id of ['d01', 'd02', 'd03', 'd05', 'd06', 'd07']) dida.deleteTask(id)
  })
  await c.syncNow()
}
