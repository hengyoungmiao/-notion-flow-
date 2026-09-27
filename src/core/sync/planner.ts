import { buildBody, type BodySpec } from '../mapping/body'
import { didaCompletedToNotion } from '../mapping/dates'
import type { DomainPlan } from '../mapping/domains'
import { describeRepeat } from '../mapping/recurrence'
import { KEEP } from '../mapping/domains'
import {
  desiredFromDida,
  diffAgainstActual,
  diffAgainstWritten,
  isEmptyPatch,
  patchFields,
  type ActualTask,
  taskDescription,
  type MapContext,
  type TaskPatch
} from '../mapping/task'
import { normalizeTitle } from '../mapping/text'
import type { AppSettings, DesiredTask, DidaTask, FlowSchema, TaskLink, WorkspaceProfile, WorkspaceState } from '../types'

export type TaskHistory = NonNullable<TaskLink['history']>

export type TaskOp =
  | { kind: 'create'; desired: DesiredTask }
  | {
      kind: 'update'
      didaId: string
      pageId: string
      desired: DesiredTask
      patch: TaskPatch
      reason: 'dida' | 'drift' | 'relink' | 'match'
      actual?: ActualTask
    }
  | { kind: 'link'; didaId: string; pageId: string; desired: DesiredTask; reason: 'relink' | 'match' | 'refresh' }
  | { kind: 'trash'; didaId: string; pageId: string; title: string }
  | { kind: 'abandon'; didaId: string; pageId: string; title: string; desired: DesiredTask | null }
  | { kind: 'unlink'; didaId: string; pageId: string; title: string; reason: 'out_of_scope' | 'deleted' }
  | { kind: 'removed'; didaId: string; pageId: string; title: string }
  | { kind: 'touch'; didaId: string; projectId: string; etag?: string }
  /** 页面顶部同步区：spec 为 null 表示删除同步区；pageId 为 null 表示本轮新建的页面 */
  | { kind: 'body'; didaId: string; pageId: string | null; title: string; spec: BodySpec | null; history?: TaskHistory }

export interface PlanInput {
  state: WorkspaceState
  profile: Pick<WorkspaceProfile, 'scope'>
  schema: FlowSchema
  settings: AppSettings
  userTimeZone: string | null
  domainPlan: DomainPlan
  /** 本轮从滴答读到的任务（未完成 + 时间窗口内完成） */
  tasks: DidaTask[]
  /** 链接任务缺席时逐条确认的结果：null = 已删除 */
  confirmations: Map<string, DidaTask | null>
  /** 校正轮：Notion 中带滴答ID的页面（didaId → 页面，可能重复） */
  linkedPages: Map<string, ActualTask[]> | null
  /** 校正轮：链接页面缺席时的逐条确认（pageId → 页面或 null） */
  pageChecks: Map<string, ActualTask | null>
  /** 首次同步：没有滴答ID的未完成页面（用于按标题配对） */
  candidates: ActualTask[] | null
  /** FLO.W 项目（用于按标签匹配） */
  projects?: Array<{ pageId: string; title: string }>
  initial: boolean
  now: Date
}

export interface PlanResult {
  ops: TaskOp[]
  warnings: string[]
}

export function isInbox(projectId: string): boolean {
  return projectId.startsWith('inbox')
}

/** 重复任务每次完成产生的记录（滴答会生成一条已完成副本）；判断规则待真实样例校准 */
export function isRecurringOccurrence(task: DidaTask, openTasks: DidaTask[]): boolean {
  return occurrenceParent(task, openTasks) !== null
}

/** 重复任务完成副本对应的原任务 ID（优先 repeatTaskId，其次同清单同标题的未完成重复任务） */
export function occurrenceParent(task: DidaTask, openTasks: DidaTask[]): string | null {
  if (task.status !== 2) return null
  if (task.repeatTaskId && task.repeatTaskId !== task.id) return task.repeatTaskId
  const title = normalizeTitle(task.title)
  const origin = openTasks.find(
    (o) => o.id !== task.id && !!o.repeatFlag && o.projectId === task.projectId && normalizeTitle(o.title) === title
  )
  return origin?.id ?? null
}

/** 标签/项目名归一化：忽略全半角、大小写、空格、# 和常见标点 */
export function projectKey(name: string | null | undefined): string {
  return (name ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
}

function mergeHistory(prev: TaskHistory | undefined, adds: Array<{ id: string; date: string }>): TaskHistory | undefined {
  if (!adds.length) return prev
  const ids = new Set(prev?.ids ?? [])
  const fresh = adds.filter((a) => !ids.has(a.id))
  if (!fresh.length) return prev
  const dates = [...(prev?.dates ?? []), ...fresh.map((a) => a.date)].sort().slice(-20)
  return { dates, count: (prev?.count ?? 0) + fresh.length, ids: [...ids, ...fresh.map((a) => a.id)].slice(-50) }
}

function dayOfRaw(value: { start: string } | null | undefined): string | null {
  return value?.start ? value.start.slice(0, 10) : null
}

export function planTasks(input: PlanInput): PlanResult {
  const { state, domainPlan, schema, settings } = input
  const ops: TaskOp[] = []
  const warnings: string[] = []
  const handled = new Set<string>()

  const inScope = (t: DidaTask): boolean => {
    if ((t.kind ?? '').toUpperCase() === 'NOTE') return false
    if (isInbox(t.projectId)) return input.profile.scope.includeInbox
    return domainPlan.scopeProjectIds.has(t.projectId)
  }

  const taskById = new Map(input.tasks.map((t) => [t.id, t]))
  const projectIndex = new Map<string, string>()
  for (const p of input.projects ?? []) {
    const key = projectKey(p.title)
    if (key && !projectIndex.has(key)) projectIndex.set(key, p.pageId)
  }
  const tagProjects = (tags: string[] | undefined): string[] => [
    ...new Set((tags ?? []).map((t) => projectIndex.get(projectKey(t))).filter((id): id is string => !!id))
  ]
  const projectsFor = (task: DidaTask): string[] | null => {
    if (!settings.syncProjects || !schema.projects) return null
    const own = tagProjects(task.tags)
    if (own.length || !task.parentId) return own
    // 子任务没有匹配到项目时继承父任务的项目
    const parent = taskById.get(task.parentId)
    if (parent) return tagProjects(parent.tags)
    return state.tasks[task.parentId]?.written.projectPageIds ?? []
  }

  const ctxFor = (link: TaskLink | undefined): MapContext => ({
    schema,
    settings,
    userTimeZone: input.userTimeZone,
    domainFor: (projectId) => {
      if (isInbox(projectId)) return null
      const d = domainPlan.listMap.get(projectId)
      if (d === KEEP) return link?.written.domainPageId ?? null
      return d ?? null
    },
    projectsFor
  })
  const historyAdds = new Map<string, Array<{ id: string; date: string }>>()
  const processed: DidaTask[] = []

  const openTasks = input.tasks.filter((t) => (t.status ?? 0) === 0)
  const createCutoff = input.initial
    ? input.profile.scope.importCompletedDays > 0
      ? input.now.getTime() - input.profile.scope.importCompletedDays * 86_400_000
      : Number.POSITIVE_INFINITY
    : state.initializedAt
      ? new Date(state.initializedAt).getTime()
      : Number.POSITIVE_INFINITY

  // 首次同步：按标题建立配对索引
  const candidateByTitle = new Map<string, ActualTask[]>()
  for (const c of input.candidates ?? []) {
    const key = normalizeTitle(c.title)
    if (!key) continue
    candidateByTitle.set(key, [...(candidateByTitle.get(key) ?? []), c])
  }
  const usedCandidates = new Set<string>()
  const unlinkedTitleCount = new Map<string, number>()
  if (input.candidates) {
    for (const t of input.tasks) {
      if (state.tasks[t.id] || !inScope(t)) continue
      const key = normalizeTitle(t.title)
      unlinkedTitleCount.set(key, (unlinkedTitleCount.get(key) ?? 0) + 1)
    }
  }

  const pickPage = (didaId: string, preferredPageId?: string): ActualTask | undefined => {
    const pages = input.linkedPages?.get(didaId)
    if (!pages || pages.length === 0) return undefined
    if (pages.length > 1) warnings.push(`Notion 中有 ${pages.length} 个页面带有同一个滴答ID（${pages[0]!.title}），只维护其中一个`)
    return (
      pages.find((p) => p.pageId === preferredPageId) ??
      [...pages].sort((a, b) => (a.createdTime ?? '').localeCompare(b.createdTime ?? ''))[0]
    )
  }

  const handleTask = (task: DidaTask): void => {
    handled.add(task.id)
    const link = state.tasks[task.id]
    if (!inScope(task)) {
      if (link) ops.push({ kind: 'unlink', didaId: task.id, pageId: link.pageId, title: task.title ?? '', reason: 'out_of_scope' })
      return
    }
    if (state.notionRemoved[task.id]) return
    processed.push(task)
    const desired = desiredFromDida(task, ctxFor(link))

    if (link) {
      if (input.linkedPages) {
        const page = pickPage(task.id, link.pageId)
        const checked = page ?? input.pageChecks.get(link.pageId)
        if (checked === null || checked?.inTrash) {
          ops.push({ kind: 'removed', didaId: task.id, pageId: link.pageId, title: desired.title })
          return
        }
        if (checked) {
          const patch = diffAgainstActual(desired, checked, link.written.domainPageId, link.written.projectPageIds ?? [])
          if (!isEmptyPatch(patch)) {
            const fromDida = !isEmptyPatch(diffAgainstWritten(desired, link.written))
            ops.push({
              kind: 'update',
              didaId: task.id,
              pageId: checked.pageId,
              desired,
              patch,
              reason: fromDida ? 'dida' : 'drift',
              actual: checked
            })
          } else if (checked.pageId !== link.pageId || !isEmptyPatch(diffAgainstWritten(desired, link.written))) {
            ops.push({ kind: 'link', didaId: task.id, pageId: checked.pageId, desired, reason: 'refresh' })
          } else if (link.projectId !== task.projectId || link.etag !== task.etag) {
            ops.push({ kind: 'touch', didaId: task.id, projectId: task.projectId, etag: task.etag })
          }
          return
        }
      }
      const patch = diffAgainstWritten(desired, link.written)
      if (!isEmptyPatch(patch)) ops.push({ kind: 'update', didaId: task.id, pageId: link.pageId, desired, patch, reason: 'dida' })
      else if (link.projectId !== task.projectId || link.etag !== task.etag)
        ops.push({ kind: 'touch', didaId: task.id, projectId: task.projectId, etag: task.etag })
      return
    }

    // 未链接的任务：是否需要出现在 Notion
    const status = task.status ?? 0
    if (status !== 0) {
      const doneAt = task.completedTime ? Date.parse(task.completedTime.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) : NaN
      const origin = occurrenceParent(task, openTasks)
      if (origin && !settings.recurringCompletionRecords) {
        // 重复任务每完成一次产生的副本：不建页面，计入原任务的完成记录
        const date = didaCompletedToNotion(task, {
          defaultTimeZone: input.userTimeZone || settings.defaultTimeZone,
          allDayEndExclusive: settings.allDayEndExclusive
        })?.start
        if (date) historyAdds.set(origin, [...(historyAdds.get(origin) ?? []), { id: task.id, date }])
        return
      }
      if (!(doneAt >= createCutoff)) return
    }

    const existing = pickPage(task.id)
    if (existing) {
      const patch = diffAgainstActual(desired, existing, null)
      if (isEmptyPatch(patch)) ops.push({ kind: 'link', didaId: task.id, pageId: existing.pageId, desired, reason: 'relink' })
      else ops.push({ kind: 'update', didaId: task.id, pageId: existing.pageId, desired, patch, reason: 'relink', actual: existing })
      return
    }

    if (input.candidates) {
      const key = normalizeTitle(task.title)
      const pool = (candidateByTitle.get(key) ?? []).filter((c) => !usedCandidates.has(c.pageId))
      const day = dayOfRaw(desired.scheduleValue)
      const compatible = pool.filter((c) => {
        const cDay = dayOfRaw(c.scheduleRaw)
        return !day || !cDay || day === cDay
      })
      if (key && compatible.length === 1 && pool.length === 1 && (unlinkedTitleCount.get(key) ?? 0) === 1) {
        const match = compatible[0]!
        usedCandidates.add(match.pageId)
        const patch = diffAgainstActual(desired, match, null)
        ops.push({ kind: 'update', didaId: task.id, pageId: match.pageId, desired, patch, reason: 'match', actual: match })
        return
      }
    }

    ops.push({ kind: 'create', desired })
  }

  for (const task of input.tasks) handleTask(task)

  // 本轮缺席的链接任务
  for (const link of Object.values(state.tasks)) {
    if (handled.has(link.didaId)) continue
    if (!input.confirmations.has(link.didaId)) continue
    const confirmed = input.confirmations.get(link.didaId)
    if (confirmed) {
      handleTask(confirmed)
      continue
    }
    const title = link.written.title
    if (settings.deletePolicy === 'trash') ops.push({ kind: 'trash', didaId: link.didaId, pageId: link.pageId, title })
    else if (settings.deletePolicy === 'abandon') ops.push({ kind: 'abandon', didaId: link.didaId, pageId: link.pageId, title, desired: null })
    else ops.push({ kind: 'unlink', didaId: link.didaId, pageId: link.pageId, title, reason: 'deleted' })
  }

  if (settings.syncBody) ops.push(...planBodies())
  return { ops, warnings: [...new Set(warnings)] }

  /** 页面顶部“滴答同步区”：重复规则、完成记录、父任务、描述、检查事项、子任务 */
  function planBodies(): TaskOp[] {
    const out: TaskOp[] = []
    const dropped = new Set<string>()
    const opPage = new Map<string, string | null>()
    for (const op of ops) {
      if (op.kind === 'unlink' || op.kind === 'removed' || op.kind === 'trash' || op.kind === 'abandon') dropped.add(op.didaId)
      else if (op.kind === 'create') opPage.set(op.desired.didaId, null)
      else if (op.kind === 'update' || op.kind === 'link') opPage.set(op.didaId, op.pageId)
    }
    const pageOf = (id: string): string | null => state.tasks[id]?.pageId ?? opPage.get(id) ?? null
    const known = (id: string) => !dropped.has(id) && (!!state.tasks[id] || opPage.has(id))

    // 父 → 子：本轮读到的子任务 + 本地记录里的子任务
    const children = new Map<string, Array<{ id: string; title: string; done: boolean; order: number }>>()
    const seenChild = new Set<string>()
    for (const t of processed) {
      if (!t.parentId || !known(t.id)) continue
      seenChild.add(t.id)
      children.set(t.parentId, [
        ...(children.get(t.parentId) ?? []),
        { id: t.id, title: (t.title ?? '').trim(), done: (t.status ?? 0) !== 0, order: t.sortOrder ?? 0 }
      ])
    }
    for (const link of Object.values(state.tasks)) {
      if (!link.parentDidaId || seenChild.has(link.didaId) || dropped.has(link.didaId)) continue
      children.set(link.parentDidaId, [
        ...(children.get(link.parentDidaId) ?? []),
        { id: link.didaId, title: link.written.title, done: link.written.statusGroup !== 'open', order: Number.MAX_SAFE_INTEGER }
      ])
    }

    for (const t of processed) {
      if (!known(t.id)) continue
      const link = state.tasks[t.id]
      const history = mergeHistory(link?.history, historyAdds.get(t.id) ?? [])
      const parentId = t.parentId || null
      const spec = buildBody({
        repeatText: t.repeatFlag ? describeRepeat(t.repeatFlag, t.repeatFrom) : null,
        description: taskDescription(t),
        items: [...(t.items ?? [])]
          .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
          .map((i) => ({ title: (i.title ?? '').trim(), done: i.status === 1 || i.status === 2 })),
        children: (children.get(t.id) ?? [])
          .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
          .map((c) => ({ title: c.title, pageId: pageOf(c.id), done: c.done })),
        parent: parentId
          ? {
              title: (taskById.get(parentId)?.title ?? state.tasks[parentId]?.written.title ?? '父任务').trim(),
              pageId: pageOf(parentId)
            }
          : null,
        history: history ? { dates: history.dates, count: history.count } : null
      })
      const before = link?.body?.hash ?? null
      if ((spec?.hash ?? null) !== before || history !== link?.history)
        out.push({ kind: 'body', didaId: t.id, pageId: pageOf(t.id), title: (t.title ?? '').trim(), spec, history })
    }
    return out
  }
}

export interface PlanCounts {
  creates: number
  updates: number
  corrections: number
  destructive: number
  links: number
  unlinks: number
}

export function countOps(ops: TaskOp[]): PlanCounts {
  const c: PlanCounts = { creates: 0, updates: 0, corrections: 0, destructive: 0, links: 0, unlinks: 0 }
  for (const op of ops) {
    if (op.kind === 'create') c.creates++
    else if (op.kind === 'update') {
      if (op.reason === 'drift') c.corrections++
      else if (op.reason === 'dida') c.updates++
      else c.links++
    } else if (op.kind === 'trash' || op.kind === 'abandon') c.destructive++
    else if (op.kind === 'link') c.links++
    else if (op.kind === 'unlink' || op.kind === 'removed') c.unlinks++
  }
  return c
}

export function describeOp(op: TaskOp): string {
  switch (op.kind) {
    case 'create':
      return `新建「${op.desired.title}」`
    case 'update':
      return `更新「${op.desired.title}」：${patchFields(op.patch).join('、')}`
    case 'link':
      return `关联「${op.desired.title}」`
    case 'trash':
      return `移入回收站「${op.title}」`
    case 'abandon':
      return `标记放弃「${op.title}」`
    case 'unlink':
      return `解除关联「${op.title}」`
    case 'removed':
      return `Notion 中已删除「${op.title}」`
    case 'body':
      return `更新同步区「${op.title}」`
    case 'touch':
      return ''
  }
}
