import { createHash } from 'node:crypto'
import type { DidaReader } from './adapters/dida'
import type { DidaFocus, DidaTask } from './types'
import { parseDidaTime } from './mapping/dates'

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 10)

export interface DiagnosticsReport {
  generatedAt: string
  preferenceTimeZone: string | null
  projectCount: number
  closedProjectCount: number
  groupCount: number
  openTaskCount: number
  inboxInFilter: boolean
  inboxViaProjectData: boolean | null
  taskFieldNames: string[]
  hasModifiedTime: boolean
  samples: Record<string, unknown[]>
  focus: { pomodoro: unknown[]; timing: unknown[]; fieldNames: string[]; error: string | null }
}

export function sanitizeFocus(f: DidaFocus): Record<string, unknown> {
  return {
    id: hash(f.id),
    type: f.type ?? null,
    hasTaskId: !!f.taskId,
    taskBriefKeys: f.tasks?.[0] ? Object.keys(f.tasks[0]).sort() : null,
    startTime: f.startTime ?? null,
    endTime: f.endTime ?? null,
    duration: f.duration ?? null,
    pauseDuration: f.pauseDuration ?? null,
    status: f.status ?? null,
    noteLength: (f.note ?? '').length
  }
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
    repeatFrom: t.repeatFrom ?? null,
    tagCount: t.tags?.length ?? 0,
    childCount: t.childIds?.length ?? 0,
    itemKeys: t.items?.[0] ? Object.keys(t.items[0]).sort() : null,
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
  const focus: DiagnosticsReport['focus'] = { pomodoro: [], timing: [], fieldNames: [], error: null }
  try {
    const from = new Date(now.getTime() - 14 * 86_400_000)
    const pomodoro = await dida.listFocus(from, now, 'pomodoro')
    const timing = await dida.listFocus(from, now, 'timing')
    focus.pomodoro = pomodoro.slice(0, 4).map(sanitizeFocus)
    focus.timing = timing.slice(0, 4).map(sanitizeFocus)
    focus.fieldNames = [...new Set([...pomodoro, ...timing].flatMap((f) => Object.keys(f)))].sort()
  } catch (e) {
    focus.error = e instanceof Error ? e.message : String(e)
  }
  const all = [...open, ...completed]
  const pick = (f: (t: DidaTask) => boolean, n = 4) => all.filter(f).slice(0, n).map(sanitizeTask)
  const fieldNames = new Set<string>()
  for (const t of all) for (const k of Object.keys(t)) fieldNames.add(k)
  return {
    generatedAt: now.toISOString(),
    preferenceTimeZone: typeof pref.timeZone === 'string' ? pref.timeZone : null,
    projectCount: projects.length,
    /** 用于确认 project list 是否返回已归档清单（closed: true） */
    closedProjectCount: projects.filter((p) => p.closed).length,
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
    },
    focus
  }
}
