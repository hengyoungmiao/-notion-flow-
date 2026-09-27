import { FakeDida, FakeNotion, FLOW_IDS, createFlowWorkspace } from './adapters/fake'
import type { DidaTask } from './types'

/** 演示模式（FLOWSYNC_FAKE=1）：不连接真实账号，用内存数据展示完整流程 */

function at(daysFromNow: number, hour: number | null, base = new Date()): { dueDate: string; isAllDay: boolean } {
  const d = new Date(base)
  d.setDate(d.getDate() + daysFromNow)
  if (hour === null) {
    // 全天任务：本地 0 点（上海）= 前一天 16:00 UTC
    const local = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0) - 8 * 3600_000)
    return { dueDate: local.toISOString().replace('Z', '+0000'), isAllDay: true }
  }
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), hour - 8, 0, 0))
  return { dueDate: t.toISOString().replace('Z', '+0000'), isAllDay: false }
}

export function createDemoDida(): FakeDida {
  const dida = new FakeDida()
  dida.groups = [
    { id: 'g-work', name: '工作' },
    { id: 'g-study', name: '学习' },
    { id: 'g-life', name: '生活' }
  ]
  dida.projects = [
    { id: 'p-product', name: '产品开发', groupId: 'g-work', kind: 'TASK' },
    { id: 'p-client', name: '客户项目', groupId: 'g-work', kind: 'TASK' },
    { id: 'p-english', name: '英语', groupId: 'g-study', kind: 'TASK' },
    { id: 'p-reading', name: '阅读', groupId: 'g-study', kind: 'TASK' },
    { id: 'p-fitness', name: '健身', groupId: 'g-life', kind: 'TASK' },
    { id: 'p-home', name: '家务', groupId: 'g-life', kind: 'TASK' },
    { id: 'p-ideas', name: '灵感笔记', groupId: 'g-study', kind: 'NOTE' }
  ]
  const tz = 'Asia/Shanghai'
  const add = (
    id: string,
    projectId: string,
    title: string,
    when: ReturnType<typeof at> | null,
    content = '',
    extra: Partial<DidaTask> = {}
  ) => dida.addTask({ id, projectId, title, content, timeZone: tz, ...(when ?? {}), ...extra })
  add('d01', 'p-product', '整理 v2.3 需求清单', at(0, null), '先和设计对齐交互稿\n\n- 首页改版\n- **支付流程**优化', { tags: ['v2.3版本发布'] })
  add('d02', 'p-product', '评审埋点方案', at(1, 15), '', { tags: ['v2.3版本发布'] })
  add('d03', 'p-product', '发布前回归测试', at(3, null), '', {
    kind: 'CHECKLIST',
    desc: '按清单逐项确认',
    tags: ['v2.3版本发布'],
    items: [
      { id: 'i1', title: '跑自动化测试', status: 1, sortOrder: 1 },
      { id: 'i2', title: '检查埋点上报', status: 0, sortOrder: 2 },
      { id: 'i3', title: '更新帮助文档', status: 0, sortOrder: 3 }
    ]
  })
  add('d13', 'p-product', 'v2.3 上线', at(5, null), '', { tags: ['v2.3版本发布'] })
  add('d14', 'p-product', '写发布说明', at(4, null), '', { parentId: 'd13', sortOrder: 1 })
  add('d15', 'p-product', '灰度 10% 用户', at(5, 10), '', { parentId: 'd13', sortOrder: 2 })
  add('d16', 'p-english', '英语晨读', at(1, 7), '', { repeatFlag: 'RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,FR', repeatFrom: 0, tags: ['英语提升'] })
  add('d04', 'p-client', '客户周会', at(2, 10), '准备上周进展与风险')
  add('d05', 'p-client', '提交报价单', at(4, null))
  add('d06', 'p-english', '背 50 个单词', at(0, null), '', { tags: ['英语提升'] })
  add('d07', 'p-english', '听力精听 30 分钟', at(1, 21))
  add('d08', 'p-reading', '读完《卡片笔记写作法》第 3 章', null)
  add('d09', 'p-fitness', '跑步 5 公里', at(0, 7))
  add('d10', 'p-home', '交物业费', at(5, null))
  add('d11', 'inbox-demo', '回复房东消息', null)
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, '+0000')
  dida.addFocus({ id: 'fc1', type: 0, taskId: 'd01', startTime: ago(180), endTime: ago(155), duration: 1500 })
  dida.addFocus({ id: 'fc2', type: 0, taskId: 'd01', startTime: ago(150), endTime: ago(125), duration: 1500, note: '整理需求优先级' })
  dida.addFocus({ id: 'fc3', type: 1, taskId: 'd08', startTime: ago(600), endTime: ago(540), duration: 3600 })
  dida.addFocus({ id: 'fc4', type: 0, taskId: 'd06', startTime: ago(60), endTime: ago(35), duration: 1500 })
  // 重复任务“英语晨读”今天早上完成过一次：滴答产生一条已完成副本
  dida.addTask({ id: 'd16-done', projectId: 'p-english', title: '英语晨读', status: 2, completedTime: ago(180), timeZone: tz })
  dida.addTask({
    id: 'd12',
    projectId: 'p-reading',
    title: '整理读书笔记',
    status: 2,
    completedTime: new Date(Date.now() - 3600_000).toISOString().replace('Z', '+0000'),
    timeZone: tz
  })
  return dida
}

export function createDemoNotion(workspaceName: string, seedExisting = true): FakeNotion {
  const notion = new FakeNotion()
  notion.workspaceName = workspaceName
  createFlowWorkspace(notion)
  if (seedExisting) {
    const title = (text: string) => ({ title: [{ text: { content: text } }] })
    const work = notion.seedPage(FLOW_IDS.areas, { title: title('工作') })
    notion.seedPage(FLOW_IDS.areas, { title: title('学习') })
    notion.seedPage(FLOW_IDS.domains, { title: title('产品开发'), p_area: { relation: [{ id: work.id }] } })
    notion.seedPage(FLOW_IDS.domains, { title: title('英语') })
    notion.seedPage(FLOW_IDS.projects, { title: title('v2.3 版本发布') })
    notion.seedPage(FLOW_IDS.projects, { title: title('英语提升') })
    notion.seedPage(FLOW_IDS.tasks, {
      title: title('客户周会'),
      p_status: { status: { id: FLOW_IDS.status.doing } },
      p_project: { relation: [{ id: 'demo-project' }] }
    })
    notion.seedPage(FLOW_IDS.tasks, { title: title('年度复盘（只在 Notion）'), p_status: { status: { id: FLOW_IDS.status.todo } } })
  }
  return notion
}
