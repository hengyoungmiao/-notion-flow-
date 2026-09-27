import type {
  AppSettings,
  DesiredTask,
  DidaTask,
  FlowSchema,
  NormalizedDate,
  NotionDateValue,
  NotionPage,
  NotionPropertyValue,
  StatusGroup,
  WrittenTask
} from '../types'
import { didaCompletedToNotion, didaScheduleToNotion, hasTimeOfDay, normalizeDate, sameDate } from './dates'
import { normalizeNote, plainText, toRichText } from './text'

export interface MapContext {
  schema: FlowSchema
  settings: Pick<AppSettings, 'defaultTimeZone' | 'allDayEndExclusive'>
  /** 滴答偏好设置里的时区（优先于默认时区） */
  userTimeZone?: string | null
  /** 清单 → 二级领域页（或 `pending:<projectId>`），收件箱/未映射返回 null */
  domainFor(projectId: string): string | null
  /** 任务 → 由标签匹配到的项目页；返回 null 表示不管理「关联项目」 */
  projectsFor?(task: DidaTask): string[] | null
}

export function statusGroupOf(task: DidaTask): StatusGroup {
  if (task.status === 2) return 'done'
  if (task.status === -1) return 'abandoned'
  return 'open'
}

export function desiredFromDida(task: DidaTask, ctx: MapContext): DesiredTask {
  const opts = {
    defaultTimeZone: ctx.userTimeZone || ctx.settings.defaultTimeZone,
    allDayEndExclusive: ctx.settings.allDayEndExclusive
  }
  const statusGroup = statusGroupOf(task)
  const scheduleValue = didaScheduleToNotion(task, opts)
  const completedValue = statusGroup === 'open' ? null : didaCompletedToNotion(task, opts)
  const projects = ctx.schema.tasks.props.project && ctx.projectsFor ? ctx.projectsFor(task) : null
  return {
    didaId: task.id,
    projectId: task.projectId,
    title: (task.title ?? '').trim(),
    statusGroup,
    schedule: normalizeDate(scheduleValue),
    scheduleValue,
    completedAt: normalizeDate(completedValue),
    completedValue,
    // 描述改写到页面正文同步区，「下一步做什么？」留给用户和 Claude
    note: null,
    domainPageId: ctx.schema.tasks.props.domain ? ctx.domainFor(task.projectId) : null,
    projectPageIds: projects ? [...new Set(projects)].sort() : null,
    parentDidaId: task.parentId || null,
    taskTypeOnCreate: hasTimeOfDay(scheduleValue) ? 'schedule' : 'todo'
  }
}

/** 任务描述：清单型任务用 desc，普通任务用 content */
export function taskDescription(task: DidaTask): string {
  const raw = task.kind === 'CHECKLIST' ? task.desc || task.content : task.content || task.desc
  return normalizeNote(raw)
}

export function writtenFrom(desired: DesiredTask): WrittenTask {
  return {
    title: desired.title,
    statusGroup: desired.statusGroup,
    schedule: desired.schedule,
    completedAt: desired.completedAt,
    note: desired.note,
    domainPageId: desired.domainPageId,
    projectPageIds: desired.projectPageIds ?? []
  }
}

// ───────────────────────── 读取 Notion 页面的当前值 ─────────────────────────

export interface ActualTask {
  pageId: string
  url?: string
  title: string
  statusOptionId: string | null
  statusGroup: StatusGroup | null
  scheduleRaw: NotionDateValue | null
  schedule: NormalizedDate | null
  completedAt: NormalizedDate | null
  note: string | null
  domainIds: string[]
  projectIds: string[]
  didaId: string | null
  inTrash: boolean
  createdTime?: string
  lastEditedTime?: string
}

export function propById(page: NotionPage, id: string | null): NotionPropertyValue | undefined {
  if (!id) return undefined
  for (const value of Object.values(page.properties ?? {})) {
    if (value && value.id === id) return value
  }
  // 容错：部分接口返回的 id 可能是 URL 编码形式
  const decoded = safeDecode(id)
  for (const value of Object.values(page.properties ?? {})) {
    if (value && safeDecode(value.id) === decoded) return value
  }
  return undefined
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

export function readActual(page: NotionPage, schema: FlowSchema): ActualTask {
  const p = schema.tasks.props
  const status = propById(page, p.status)?.status ?? null
  const scheduleRaw = propById(page, p.schedule)?.date ?? null
  const completedRaw = p.completedAt ? (propById(page, p.completedAt)?.date ?? null) : null
  const didaRaw = plainText(propById(page, p.didaId)?.rich_text).trim()
  return {
    pageId: page.id,
    url: page.url,
    title: plainText(propById(page, p.title)?.title),
    statusOptionId: status?.id ?? null,
    statusGroup: status ? (schema.tasks.statusGroups[status.id] ?? null) : null,
    scheduleRaw,
    schedule: normalizeDate(scheduleRaw),
    completedAt: normalizeDate(completedRaw),
    note: p.note ? normalizeNote(plainText(propById(page, p.note)?.rich_text)) : null,
    domainIds: p.domain ? (propById(page, p.domain)?.relation ?? []).map((r) => r.id) : [],
    projectIds: p.project ? (propById(page, p.project)?.relation ?? []).map((r) => r.id) : [],
    didaId: didaRaw || null,
    inTrash: !!(page.in_trash || page.archived),
    createdTime: page.created_time,
    lastEditedTime: page.last_edited_time
  }
}

// ───────────────────────── 计算需要写入的差异 ─────────────────────────

export interface DomainChange {
  /** 期望加入的二级领域（null 表示不设置） */
  set: string | null
  /** 上次同步写入、需要移除的值 */
  remove: string | null
}

export interface TaskPatch {
  title?: string
  status?: StatusGroup
  schedule?: NotionDateValue | null
  completedAt?: NotionDateValue | null
  note?: string
  domain?: DomainChange
  /** 同步写入的项目：set 为期望值，remove 为上次写入、现在不再需要的值 */
  projects?: { set: string[]; remove: string[] }
  didaId?: string
}

export function isEmptyPatch(p: TaskPatch): boolean {
  return Object.keys(p).length === 0
}

export function patchFields(p: TaskPatch): string[] {
  const names: Record<keyof TaskPatch, string> = {
    title: '任务',
    status: '状态',
    schedule: '排期',
    completedAt: '完成日期',
    note: '下一步做什么？',
    domain: '二级领域',
    projects: '关联项目',
    didaId: '滴答ID'
  }
  return (Object.keys(p) as Array<keyof TaskPatch>).map((k) => names[k])
}

/** 滴答侧有变化：和“上次写入值”比较 */
export function diffAgainstWritten(desired: DesiredTask, written: WrittenTask): TaskPatch {
  const patch: TaskPatch = {}
  if (desired.title !== written.title) patch.title = desired.title
  if (desired.statusGroup !== written.statusGroup) patch.status = desired.statusGroup
  if (!sameDate(desired.schedule, written.schedule)) patch.schedule = desired.scheduleValue
  if (!sameDate(desired.completedAt, written.completedAt)) patch.completedAt = desired.completedValue
  if (desired.note !== null && desired.note !== (written.note ?? '')) patch.note = desired.note
  if (desired.domainPageId !== written.domainPageId) {
    patch.domain = { set: desired.domainPageId, remove: written.domainPageId }
  }
  if (desired.projectPageIds) {
    const before = written.projectPageIds ?? []
    if (before.join('|') !== desired.projectPageIds.join('|'))
      patch.projects = { set: desired.projectPageIds, remove: before.filter((id) => !desired.projectPageIds!.includes(id)) }
  }
  return patch
}

/** Notion 侧校正：和页面实际值比较（未完成组内的具体状态不管） */
export function diffAgainstActual(
  desired: DesiredTask,
  actual: ActualTask,
  writtenDomain: string | null,
  writtenProjects: string[] | null = null
): TaskPatch {
  const patch: TaskPatch = {}
  if (desired.title !== actual.title.trim()) patch.title = desired.title
  if (actual.statusGroup !== desired.statusGroup) patch.status = desired.statusGroup
  if (!sameDate(desired.schedule, actual.schedule)) patch.schedule = desired.scheduleValue
  if (!sameDate(desired.completedAt, actual.completedAt)) patch.completedAt = desired.completedValue
  if (desired.note !== null && actual.note !== null && desired.note !== actual.note) patch.note = desired.note
  const wantDomain = desired.domainPageId
  if (wantDomain?.startsWith('pending:')) {
    // 本轮才新建的二级领域，页面上一定还没有，写入时再解析成真实 ID
    patch.domain = { set: wantDomain, remove: writtenDomain && actual.domainIds.includes(writtenDomain) ? writtenDomain : null }
  } else {
    const staleWritten = writtenDomain && writtenDomain !== wantDomain && actual.domainIds.includes(writtenDomain)
    if ((wantDomain && !actual.domainIds.includes(wantDomain)) || staleWritten) {
      patch.domain = { set: wantDomain, remove: writtenDomain && writtenDomain !== wantDomain ? writtenDomain : null }
    }
  }
  if (desired.projectPageIds) {
    const missing = desired.projectPageIds.filter((id) => !actual.projectIds.includes(id))
    const stale = (writtenProjects ?? []).filter((id) => !desired.projectPageIds!.includes(id) && actual.projectIds.includes(id))
    if (missing.length || stale.length) patch.projects = { set: desired.projectPageIds, remove: stale }
  }
  if (actual.didaId !== desired.didaId) patch.didaId = desired.didaId
  return patch
}

/** 多值关系：去掉同步不再需要的值，补上期望值，保留手动添加的其它值 */
export function mergeRelationMulti(current: string[], change: { set: string[]; remove: string[] }): string[] {
  const next = current.filter((id) => !change.remove.includes(id))
  for (const id of change.set) if (!next.includes(id)) next.push(id)
  return next
}

/** 合并关系字段：只替换同步写入的那一个值，保留其它值 */
export function mergeRelation(current: string[], change: DomainChange): string[] {
  const next = current.filter((id) => id !== change.remove)
  if (change.set && !next.includes(change.set)) next.push(change.set)
  return next
}

export function statusOptionFor(schema: FlowSchema, group: StatusGroup): string {
  return schema.tasks.statusOptions[group]
}

/** 把差异转换成 Notion properties（以属性 ID 为键） */
export function buildProperties(
  patch: TaskPatch,
  schema: FlowSchema,
  relationIds?: string[],
  projectIds?: string[]
): Record<string, unknown> {
  const p = schema.tasks.props
  const props: Record<string, unknown> = {}
  if (patch.title !== undefined) props[p.title] = { title: toRichText(patch.title) }
  if (patch.status !== undefined) props[p.status] = { status: { id: statusOptionFor(schema, patch.status) } }
  if (patch.schedule !== undefined) props[p.schedule] = { date: patch.schedule }
  if (patch.completedAt !== undefined && p.completedAt) props[p.completedAt] = { date: patch.completedAt }
  if (patch.note !== undefined && p.note) props[p.note] = { rich_text: toRichText(patch.note) }
  if (patch.domain !== undefined && p.domain && relationIds) props[p.domain] = { relation: relationIds.map((id) => ({ id })) }
  if (patch.projects !== undefined && p.project && projectIds) props[p.project] = { relation: projectIds.map((id) => ({ id })) }
  if (patch.didaId !== undefined) props[p.didaId] = { rich_text: toRichText(patch.didaId) }
  return props
}

export function buildCreateProperties(desired: DesiredTask, schema: FlowSchema, domainId: string | null): Record<string, unknown> {
  const p = schema.tasks.props
  const props = buildProperties(
    {
      title: desired.title,
      status: desired.statusGroup,
      schedule: desired.scheduleValue,
      completedAt: desired.completedValue,
      note: desired.note ?? undefined,
      didaId: desired.didaId,
      domain: domainId ? { set: domainId, remove: null } : undefined,
      projects: desired.projectPageIds?.length ? { set: desired.projectPageIds, remove: [] } : undefined
    },
    schema,
    domainId ? [domainId] : undefined,
    desired.projectPageIds ?? undefined
  )
  if (desired.scheduleValue === null) delete props[p.schedule]
  if (desired.completedValue === null && p.completedAt) delete props[p.completedAt]
  const typeOption =
    desired.taskTypeOnCreate === 'schedule' ? schema.tasks.taskTypeOptions.schedule : schema.tasks.taskTypeOptions.todo
  if (p.taskType && typeOption) props[p.taskType] = { select: { id: typeOption } }
  return props
}
