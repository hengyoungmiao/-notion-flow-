import type { FlowSchema, NotionDataSource, NotionPropertySchema, StatusGroup } from '../types'
import { plainText } from '../mapping/text'

export const DIDA_ID_PROPERTY = '滴答ID'

export interface BindIssue {
  level: 'error' | 'warning'
  message: string
}

function props(ds: NotionDataSource): NotionPropertySchema[] {
  return Object.entries(ds.properties ?? {}).map(([name, p]) => ({ ...p, name: p.name ?? name }))
}

function pick(list: NotionPropertySchema[], type: string, names: RegExp): NotionPropertySchema | undefined {
  const ofType = list.filter((p) => p.type === type)
  return ofType.find((p) => names.test(p.name))
}

export function dataSourceTitle(ds: NotionDataSource): string {
  return plainText(ds.title) || '未命名数据库'
}

export interface TaskBinding {
  tasks: Omit<FlowSchema['tasks'], 'props'> & { props: Omit<FlowSchema['tasks']['props'], 'didaId'> & { didaId: string | null } }
  domainsDataSourceId: string | null
  issues: BindIssue[]
}

export function bindTaskSchema(ds: NotionDataSource): TaskBinding {
  const issues: BindIssue[] = []
  const list = props(ds)
  const title = list.find((p) => p.type === 'title')
  const status = pick(list, 'status', /^状态$/) ?? list.find((p) => p.type === 'status')
  const schedule = pick(list, 'date', /^排期$/)
  const completedAt = pick(list, 'date', /^完成日期$/)
  const note = pick(list, 'rich_text', /^下一步做什么[？?]?$/)
  const domain = pick(list, 'relation', /^二级领域$/)
  const didaId = pick(list, 'rich_text', new RegExp(`^${DIDA_ID_PROPERTY}$`))
  const taskType = pick(list, 'select', /^任务类型$/)

  if (!title) issues.push({ level: 'error', message: '任务库缺少标题字段' })
  if (!status) issues.push({ level: 'error', message: '任务库缺少「状态」字段（status 类型）' })
  if (!schedule) issues.push({ level: 'error', message: '任务库缺少「排期」字段（date 类型）' })
  if (!completedAt) issues.push({ level: 'warning', message: '未找到「完成日期」字段，将不同步完成日期' })
  if (!note) issues.push({ level: 'warning', message: '未找到「下一步做什么？」字段，将不同步任务描述' })
  if (!domain) issues.push({ level: 'warning', message: '未找到「二级领域」关系字段，将不绑定领域' })

  const statusBinding = status ? bindStatus(status) : null
  if (status && !statusBinding) issues.push({ level: 'error', message: '「状态」字段缺少可用的完成/未完成选项' })

  const taskTypeOptions = { schedule: null as string | null, todo: null as string | null }
  for (const o of taskType?.select?.options ?? []) {
    if (o.name === '日程') taskTypeOptions.schedule = o.id
    if (o.name === '待办') taskTypeOptions.todo = o.id
  }

  return {
    tasks: {
      dataSourceId: ds.id,
      title: dataSourceTitle(ds),
      props: {
        title: title?.id ?? '',
        status: status?.id ?? '',
        schedule: schedule?.id ?? '',
        completedAt: completedAt?.id ?? null,
        note: note?.id ?? null,
        domain: domain?.id ?? null,
        didaId: didaId?.id ?? null,
        taskType: taskType?.id ?? null
      },
      statusOptions: statusBinding?.options ?? { open: '', done: '', abandoned: '' },
      statusGroups: statusBinding?.groups ?? {},
      taskTypeOptions
    },
    domainsDataSourceId: domain?.relation?.data_source_id ?? null,
    issues
  }
}

export function bindStatus(
  status: NotionPropertySchema
): { options: FlowSchema['tasks']['statusOptions']; groups: Record<string, StatusGroup> } | null {
  const options = status.status?.options ?? []
  const groups = status.status?.groups ?? []
  if (options.length === 0) return null
  const byId = new Map(options.map((o) => [o.id, o]))
  const completeGroup =
    groups.find((g) => /complete|done|完成/i.test(g.name)) ?? (groups.length >= 2 ? groups[groups.length - 1] : undefined)
  const groupMap: Record<string, StatusGroup> = {}
  for (const g of groups) {
    for (const id of g.option_ids ?? []) {
      const name = byId.get(id)?.name ?? ''
      if (g === completeGroup) groupMap[id] = /放弃|abandon|cancel|取消|won'?t/i.test(name) ? 'abandoned' : 'done'
      else groupMap[id] = 'open'
    }
  }
  for (const o of options) if (!(o.id in groupMap)) groupMap[o.id] = 'open'

  const openIds = options.filter((o) => groupMap[o.id] === 'open')
  const doneIds = options.filter((o) => groupMap[o.id] === 'done')
  const abandonedIds = options.filter((o) => groupMap[o.id] === 'abandoned')
  const open = openIds.find((o) => o.name === '待办') ?? openIds[0]
  const done = doneIds.find((o) => o.name === '完成') ?? doneIds[0]
  const abandoned = abandonedIds.find((o) => o.name === '放弃') ?? abandonedIds[0] ?? done
  if (!open || !done || !abandoned) return null
  return { options: { open: open.id, done: done.id, abandoned: abandoned.id }, groups: groupMap }
}

export function bindDomainSchema(ds: NotionDataSource): {
  domains: NonNullable<FlowSchema['domains']>
  areasDataSourceId: string | null
  issues: BindIssue[]
} {
  const list = props(ds)
  const title = list.find((p) => p.type === 'title')
  const area = pick(list, 'relation', /一级领域/)
  const issues: BindIssue[] = []
  if (!area) issues.push({ level: 'warning', message: '二级领域库没有「一级领域」关系字段，将不绑定一级领域' })
  return {
    domains: { dataSourceId: ds.id, title: dataSourceTitle(ds), props: { title: title?.id ?? '', area: area?.id ?? null } },
    areasDataSourceId: area?.relation?.data_source_id ?? null,
    issues
  }
}

export function bindAreaSchema(ds: NotionDataSource): NonNullable<FlowSchema['areas']> {
  const title = props(ds).find((p) => p.type === 'title')
  return { dataSourceId: ds.id, title: dataSourceTitle(ds), props: { title: title?.id ?? '' } }
}

/** 任务库是否像 FLO.W「我的任务 DB」（用于搜索候选排序） */
export function looksLikeFlowTasks(ds: NotionDataSource): boolean {
  const b = bindTaskSchema(ds)
  return !b.issues.some((i) => i.level === 'error')
}
