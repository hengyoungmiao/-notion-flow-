import { DateTime } from 'luxon'
import type { DidaTask, NormalizedDate, NotionDateValue } from '../types'

/** 解析滴答时间：`2026-03-10T09:00:00.000+0000` / `2026-03-10T09:00:00+0000` / 标准 ISO */
export function parseDidaTime(value: string | null | undefined): DateTime | null {
  if (!value) return null
  const fixed = value.trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2')
  const dt = DateTime.fromISO(fixed, { setZone: true })
  return dt.isValid ? dt : null
}

function validZone(zone: string | null | undefined, fallback: string): string {
  if (zone && DateTime.now().setZone(zone).isValid) return zone
  return fallback
}

export interface ScheduleOptions {
  defaultTimeZone: string
  allDayEndExclusive: boolean
}

/** 滴答任务的开始/截止时间 → Notion 日期值（`排期`） */
export function didaScheduleToNotion(task: DidaTask, opts: ScheduleOptions): NotionDateValue | null {
  const startRaw = parseDidaTime(task.startDate)
  const dueRaw = parseDidaTime(task.dueDate)
  const start = startRaw ?? dueRaw
  const due = dueRaw ?? startRaw
  if (!start || !due) return null
  const zone = validZone(task.timeZone, opts.defaultTimeZone)

  if (task.isAllDay) {
    const s = start.setZone(zone).startOf('day')
    let e = due.setZone(zone).startOf('day')
    if (opts.allDayEndExclusive && e > s) e = e.minus({ days: 1 })
    const startDate = s.toISODate()!
    const endDate = e.toISODate()!
    return endDate > startDate ? { start: startDate, end: endDate } : { start: startDate, end: null }
  }

  const s = start.setZone(zone)
  const e = due.setZone(zone)
  const fmt = "yyyy-MM-dd'T'HH:mm:ssZZ"
  if (e.toMillis() > s.toMillis()) return { start: s.toFormat(fmt), end: e.toFormat(fmt) }
  return { start: s.toFormat(fmt), end: null }
}

/** 完成时间 → Notion `完成日期`（按任务时区取本地日期，与 FLO.W「完成」按钮一致写纯日期） */
export function didaCompletedToNotion(task: DidaTask, opts: ScheduleOptions): NotionDateValue | null {
  const done = parseDidaTime(task.completedTime)
  if (!done) return null
  const zone = validZone(task.timeZone, opts.defaultTimeZone)
  return { start: done.setZone(zone).toISODate()!, end: null }
}

function normalizePoint(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const dt = DateTime.fromISO(value, { setZone: true })
  return dt.isValid ? dt.toUTC().toISO({ suppressMilliseconds: false })! : value
}

/** 规范化日期用于比较：纯日期保留，带时间转成 UTC */
export function normalizeDate(value: NotionDateValue | null | undefined): NormalizedDate | null {
  if (!value || !value.start) return null
  const start = normalizePoint(value.start)
  const end = value.end ? normalizePoint(value.end) : null
  return { start, end: end && end !== start ? end : null }
}

export function sameDate(a: NormalizedDate | null, b: NormalizedDate | null): boolean {
  if (!a || !b) return a === b
  return a.start === b.start && (a.end ?? null) === (b.end ?? null)
}

/** 取日期的“日”部分（用于首次配对时比较） */
export function dayOf(value: NormalizedDate | null): string | null {
  if (!value) return null
  return value.start.slice(0, 10)
}

export function hasTimeOfDay(value: NotionDateValue | null): boolean {
  return !!value && value.start.includes('T')
}
