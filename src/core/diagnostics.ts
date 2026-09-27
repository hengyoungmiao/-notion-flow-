import { createHash } from 'node:crypto'
import type { DidaReader } from './adapters/dida'
import type { DidaTask } from './types'
import { parseDidaTime } from './mapping/dates'

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 10)

export interface DiagnosticsReport {
  generatedAt: string
  preferenceTimeZone: string | null
  projectCount: number
  groupCount: number
  openTaskCount: number
  inboxInFilter: boolean
  inboxViaProjectData: boolean | null
  taskFieldNames: string[]
  hasModifiedTime: boolean
  samples: Record<string, unknown[]>
}

/** 去掉标题/描述等个人内容，只保留日期与结构字段，用于校准日期换算 */
export function sanitizeTask(t: DidaTask): Record<string, unknown> {
  return {
    id: hash(t.id),
    projectId: t.projectId.startsWith('inbox') ? 'inbox*' : hash(t.projectId),
    titleLength: (t.title ?? '').length,
    contentLength: (t.content ?? '').length,
    descLength: (t.desc ?? '').length,
    startDate: t.startDate ?? null,
    dueDate: t.dueDate ?? null,
    isAllDay: t.isAllDay ?? null,
    timeZone: t.timeZone ?? null,
    status: t.status ?? null,
    completedTime: t.completedTime ?? null,
    modifiedTime: t.modifiedTime ?? null,
    kind: t.kind ?? null,
    hasParent: !!t.parentId,
    repeatFlag: t.repeatFlag ?? null,
    repeatTaskId: t.repeatTaskId ? hash(t.repeatTaskId) : null,
    itemCount: t.items?.length ?? 0,
    etag: t.etag ? 'present' : null
  }
}

function spanDays(t: DidaTask): number {
  const s = parseDidaTime(t.startDate)
  const d = parseDidaTime(t.dueDate)
  if (!s || !d) return 0
  return (d.toMillis() - s.toMillis()) / 86_400_000
}

/** 导出诊断样例（脱敏），供开发者校准全天区间、收件箱、重复任务等行为 */
export async function collectDiagnostics(dida: DidaReader, now = new Date()): Promise<DiagnosticsReport> {
  const [pref, projects, groups, open] = await Promise.all([
    dida.getPreference(),
    dida.listProjects(),
    dida.listGroups(),
    dida.listOpenTasks()
  ])
  const completed = await dida.listCompletedTasks(new Date(now.getTime() - 14 * 86_400_000), now)
  const inbox = await dida.listInboxTasks().catch(() => null)
  const all = [...open, ...completed]
  const pick = (f: (t: DidaTask) => boolean, n = 4) => all.filter(f).slice(0, n).map(sanitizeTask)
  const fieldNames = new Set<string>()
  for (const t of all) for (const k of Object.keys(t)) fieldNames.add(k)
  return {
    generatedAt: now.toISOString(),
    preferenceTimeZone: typeof pref.timeZone === 'string' ? pref.timeZone : null,
    projectCount: projects.length,
    groupCount: groups.length,
    openTaskCount: open.length,
    inboxInFilter: open.some((t) => t.projectId.startsWith('inbox')),
    inboxViaProjectData: inbox === null ? null : inbox.length > 0,
    taskFieldNames: [...fieldNames].sort(),
    hasModifiedTime: all.some((t) => !!t.modifiedTime),
    samples: {
      allDaySingle: pick((t) => !!t.isAllDay && spanDays(t) <= 1),
      allDayMultiDay: pick((t) => !!t.isAllDay && spanDays(t) > 1),
      timedSingle: pick((t) => !t.isAllDay && !!t.dueDate && spanDays(t) === 0),
      timedRange: pick((t) => !t.isAllDay && spanDays(t) > 0),
      recurring: pick((t) => !!t.repeatFlag),
      completed: pick((t) => t.status === 2, 6),
      checklist: pick((t) => t.kind === 'CHECKLIST'),
      subtask: pick((t) => !!t.parentId),
      inbox: (inbox ?? []).slice(0, 3).map(sanitizeTask)
    }
  }
}
