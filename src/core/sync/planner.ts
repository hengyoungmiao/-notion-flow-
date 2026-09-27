import type { DomainPlan } from '../mapping/domains'
import { KEEP } from '../mapping/domains'
import {
  desiredFromDida,
  diffAgainstActual,
  diffAgainstWritten,
  isEmptyPatch,
  patchFields,
  type ActualTask,
  type MapContext,
  type TaskPatch
} from '../mapping/task'
import { normalizeTitle } from '../mapping/text'
import type { AppSettings, DesiredTask, DidaTask, FlowSchema, TaskLink, WorkspaceProfile, WorkspaceState } from '../types'

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
  if (task.status !== 2) return false
  if (task.repeatTaskId && task.repeatTaskId !== task.id) return true
  const title = normalizeTitle(task.title)
  return openTasks.some(
    (o) => o.id !== task.id && !!o.repeatFlag && o.projectId === task.projectId && normalizeTitle(o.title) === title
  )
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

  const ctxFor = (link: TaskLink | undefined): MapContext => ({
    schema,
    settings,
    userTimeZone: input.userTimeZone,
    domainFor: (projectId) => {
      if (isInbox(projectId)) return null
      const d = domainPlan.listMap.get(projectId)
      if (d === KEEP) return link?.written.domainPageId ?? null
      return d ?? null
    }
  })

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
          const patch = diffAgainstActual(desired, checked, link.written.domainPageId)
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
      if (!(doneAt >= createCutoff)) return
      if (!settings.recurringCompletionRecords && isRecurringOccurrence(task, openTasks)) return
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

  return { ops, warnings: [...new Set(warnings)] }
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
    case 'touch':
      return ''
  }
}
