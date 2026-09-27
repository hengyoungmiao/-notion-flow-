import type { NotionClient } from '../adapters/notion'
import { CliError } from '../adapters/exec'
import type { FlowSchema, NotionDataSource } from '../types'
import {
  DIDA_ID_PROPERTY,
  bindAreaSchema,
  bindDomainSchema,
  bindFocusSchema,
  bindTaskSchema,
  dataSourceTitle,
  looksLikeFlowTasks,
  type BindIssue
} from './schema'

export interface TaskCandidate {
  dataSourceId: string
  title: string
  looksLikeFlow: boolean
}

/** 从 Notion 链接或 ID 中提取 32 位 ID */
export function extractNotionId(input: string): string | null {
  const trimmed = input.trim()
  const collection = /collection:\/\/([0-9a-f-]{32,36})/i.exec(trimmed)
  if (collection) return collection[1]!.replace(/-/g, '')
  const matches = trimmed.replace(/-/g, '').match(/[0-9a-f]{32}/gi)
  return matches ? matches[matches.length - 1]!.toLowerCase() : null
}

export function toUuid(id: string): string {
  const s = id.replace(/-/g, '')
  if (s.length !== 32) return id
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`
}

/** 搜索工作空间里的 FLO.W 任务库候选 */
export async function findTaskCandidates(client: NotionClient): Promise<TaskCandidate[]> {
  const seen = new Map<string, TaskCandidate>()
  for (const q of ['我的任务', '任务', 'FLO.W']) {
    const results = await client.search(q, 'data_source')
    for (const r of results) {
      const id = String(r.id ?? '')
      if (!id || seen.has(id)) continue
      try {
        const ds = await client.getDataSource(id)
        seen.set(id, { dataSourceId: ds.id, title: dataSourceTitle(ds), looksLikeFlow: looksLikeFlowTasks(ds) })
      } catch (e) {
        if (!(e instanceof CliError) || e.kind === 'auth') throw e
      }
    }
    if ([...seen.values()].some((c) => c.looksLikeFlow)) break
  }
  return [...seen.values()].sort((a, b) => Number(b.looksLikeFlow) - Number(a.looksLikeFlow))
}

/** 根据粘贴的链接/ID 定位数据源（可以是数据库或数据源 ID） */
export async function resolveTaskDataSource(client: NotionClient, input: string): Promise<string> {
  const id = extractNotionId(input)
  if (!id) throw new Error('无法从链接中识别 Notion ID')
  const uuid = toUuid(id)
  try {
    const ds = await client.getDataSource(uuid)
    return ds.id
  } catch (e) {
    if (e instanceof CliError && e.kind === 'auth') throw e
  }
  const ids = await client.resolveDataSources(uuid)
  if (ids.length === 0) throw new Error('该链接不是数据库，或当前账号没有访问权限')
  return ids[0]!
}

export interface BindResult {
  schema: FlowSchema | null
  issues: BindIssue[]
  /** 任务库是否还没有「滴答ID」字段（需要创建） */
  needsDidaIdProperty: boolean
}

/** 从任务库出发，顺着关系字段找到二级领域库、一级领域库，并按 ID 绑定字段 */
export async function bindFlowSchema(client: NotionClient, taskDataSourceId: string): Promise<BindResult> {
  const taskDs = await client.getDataSource(taskDataSourceId)
  const task = bindTaskSchema(taskDs)
  const issues: BindIssue[] = [...task.issues]
  if (issues.some((i) => i.level === 'error')) return { schema: null, issues, needsDidaIdProperty: false }

  let domains: FlowSchema['domains'] = null
  let areas: FlowSchema['areas'] = null
  if (task.domainsDataSourceId) {
    try {
      const domainDs = await client.getDataSource(task.domainsDataSourceId)
      const bound = bindDomainSchema(domainDs)
      domains = bound.domains
      issues.push(...bound.issues)
      if (bound.areasDataSourceId) {
        const areaDs = await client.getDataSource(bound.areasDataSourceId)
        areas = bindAreaSchema(areaDs)
      }
    } catch (e) {
      if (e instanceof CliError && e.kind === 'auth') throw e
      issues.push({ level: 'warning', message: '无法读取领域库，领域绑定将暂不可用' })
    }
  }

  const focus = await loadFocusSchema(client, task.focusDataSourceId, taskDs.id, issues)
  const schema: FlowSchema = {
    tasks: { ...task.tasks, props: { ...task.tasks.props, didaId: task.tasks.props.didaId ?? '' } },
    domains,
    areas,
    focus
  }
  return { schema, issues, needsDidaIdProperty: !task.tasks.props.didaId }
}

async function loadFocusSchema(
  client: NotionClient,
  focusDataSourceId: string | null,
  tasksDataSourceId: string,
  issues: BindIssue[]
): Promise<FlowSchema['focus']> {
  if (!focusDataSourceId) {
    issues.push({ level: 'warning', message: '未找到「关联番茄」字段，将不同步番茄钟记录' })
    return null
  }
  try {
    const bound = bindFocusSchema(await client.getDataSource(focusDataSourceId), tasksDataSourceId)
    if (!bound) issues.push({ level: 'warning', message: '番茄数据库缺少「开始时间」或「关联任务」字段，将不同步番茄钟记录' })
    return bound
  } catch (e) {
    if (e instanceof CliError && e.kind === 'auth') throw e
    issues.push({ level: 'warning', message: '无法读取番茄数据库，将不同步番茄钟记录' })
    return null
  }
}

/** 旧版本识别的配置没有番茄库：补充识别（不改动其它绑定） */
export async function upgradeFocusSchema(client: NotionClient, schema: FlowSchema): Promise<FlowSchema> {
  if (schema.focus !== undefined) return schema
  const taskDs = await client.getDataSource(schema.tasks.dataSourceId)
  const task = bindTaskSchema(taskDs)
  const focus = await loadFocusSchema(client, task.focusDataSourceId, taskDs.id, [])
  return { ...schema, focus }
}

/** 在任务库中新增「滴答ID」文本字段（只新增，不改动模板原有字段） */
export async function ensureDidaIdProperty(client: NotionClient, schema: FlowSchema): Promise<FlowSchema> {
  if (schema.tasks.props.didaId) return schema
  const updated: NotionDataSource = await client.updateDataSource(schema.tasks.dataSourceId, {
    properties: { [DIDA_ID_PROPERTY]: { rich_text: {} } }
  })
  const ds = updated?.properties ? updated : await client.getDataSource(schema.tasks.dataSourceId)
  const bound = bindTaskSchema(ds)
  if (!bound.tasks.props.didaId) throw new Error('新增「滴答ID」字段失败')
  return { ...schema, tasks: { ...schema.tasks, props: { ...schema.tasks.props, didaId: bound.tasks.props.didaId } } }
}

/** 重新校验已绑定的字段是否仍然存在（用户改名不影响，删除字段会报错） */
export async function validateSchema(client: NotionClient, schema: FlowSchema): Promise<BindIssue[]> {
  const ds = await client.getDataSource(schema.tasks.dataSourceId)
  const ids = new Set(Object.values(ds.properties ?? {}).map((p) => p.id))
  const issues: BindIssue[] = []
  const required: Array<[string, string | null]> = [
    ['标题', schema.tasks.props.title],
    ['状态', schema.tasks.props.status],
    ['排期', schema.tasks.props.schedule],
    ['滴答ID', schema.tasks.props.didaId]
  ]
  for (const [name, id] of required) if (id && !ids.has(id)) issues.push({ level: 'error', message: `任务库的「${name}」字段已被删除` })
  const status = Object.values(ds.properties ?? {}).find((p) => p.id === schema.tasks.props.status)
  const optionIds = new Set((status?.status?.options ?? []).map((o) => o.id))
  for (const [group, id] of Object.entries(schema.tasks.statusOptions))
    if (!optionIds.has(id)) issues.push({ level: 'error', message: `「状态」字段中用于「${group}」的选项已被删除` })
  return issues
}
