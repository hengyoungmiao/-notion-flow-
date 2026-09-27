import { DateTime } from 'luxon'
import type { DidaFocus, FlowSchema, NotionDateValue, NotionPage } from '../types'
import { parseDidaTime } from './dates'
import { propById } from './task'
import { toRichText } from './text'

export type FocusKindName = 'pomodoro' | 'timing'

export function focusKind(f: DidaFocus): FocusKindName {
  return f.type === 1 || f.type === '1' || f.type === 'timing' ? 'timing' : 'pomodoro'
}

/** 专注记录关联的滴答任务 ID（`taskId` 或 `tasks[0]`，待真实样例校准） */
export function focusTaskId(f: DidaFocus): string | null {
  return f.taskId || f.tasks?.[0]?.taskId || f.tasks?.[0]?.id || null
}

export interface DesiredFocus {
  focusId: string
  kind: FocusKindName
  taskDidaId: string
  title: string
  start: NotionDateValue
  end: NotionDateValue | null
  minutes: number | null
  /** 开始时间（UTC ISO，毫秒精度），用于去重 */
  startKey: string
  hash: string
}

const FMT = "yyyy-MM-dd'T'HH:mm:ssZZ"

export function focusStartKey(value: string | null | undefined): string | null {
  if (!value) return null
  const dt = value.includes('T') ? DateTime.fromISO(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'), { setZone: true }) : null
  return dt && dt.isValid ? dt.toUTC().startOf('second').toISO()! : null
}

export function desiredFocus(f: DidaFocus, taskTitle: string, zone: string): DesiredFocus | null {
  const taskDidaId = focusTaskId(f)
  const start = parseDidaTime(f.startTime)
  if (!taskDidaId || !start) return null
  const end = parseDidaTime(f.endTime)
  const kind = focusKind(f)
  const seconds = typeof f.duration === 'number' ? f.duration : end ? (end.toMillis() - start.toMillis()) / 1000 : null
  const minutes = seconds !== null ? Math.max(0, Math.round(seconds / 60)) : null
  const note = (f.note ?? '').replace(/\s+/g, ' ').trim()
  const title = `${kind === 'pomodoro' ? '番茄钟' : '正计时'} · ${taskTitle || '（无标题任务）'}${note ? ` — ${note.slice(0, 60)}` : ''}`
  const startValue = { start: start.setZone(zone).toFormat(FMT), end: null }
  const endValue = end ? { start: end.setZone(zone).toFormat(FMT), end: null } : null
  const startKey = start.toUTC().startOf('second').toISO()!
  const hash = JSON.stringify([title, startKey, end?.toUTC().toISO() ?? null, minutes, taskDidaId])
  return { focusId: f.id, kind, taskDidaId, title, start: startValue, end: endValue, minutes, startKey, hash }
}

export function buildFocusProperties(
  d: DesiredFocus,
  schema: NonNullable<FlowSchema['focus']>,
  taskPageId: string
): Record<string, unknown> {
  const p = schema.props
  const props: Record<string, unknown> = {
    [p.title]: { title: toRichText(d.title) },
    [p.task]: { relation: [{ id: taskPageId }] },
    [p.start]: { date: d.start }
  }
  if (p.end) props[p.end] = { date: d.end }
  if (p.minutes) props[p.minutes] = { number: d.minutes }
  return props
}

/** 读取番茄页面的开始时间（用于按“关联任务 + 开始时间”去重） */
export function focusPageStartKey(page: NotionPage, schema: NonNullable<FlowSchema['focus']>): string | null {
  return focusStartKey(propById(page, schema.props.start)?.date?.start ?? null)
}
