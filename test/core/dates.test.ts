import { describe, expect, it } from 'vitest'
import { didaCompletedToNotion, didaScheduleToNotion, normalizeDate, parseDidaTime, sameDate } from '../../src/core/mapping/dates'
import type { DidaTask } from '../../src/core/types'

const opts = { defaultTimeZone: 'Asia/Shanghai', allDayEndExclusive: true }
const task = (t: Partial<DidaTask>): DidaTask => ({ id: 't', projectId: 'p', ...t })

describe('parseDidaTime', () => {
  it('parses +0000 offsets with and without millis', () => {
    expect(parseDidaTime('2026-03-10T09:00:00+0000')?.toUTC().toISO()).toBe('2026-03-10T09:00:00.000Z')
    expect(parseDidaTime('2026-03-10T09:00:00.000+0800')?.toUTC().toISO()).toBe('2026-03-10T01:00:00.000Z')
    expect(parseDidaTime(null)).toBeNull()
    expect(parseDidaTime('garbage')).toBeNull()
  })
})

describe('didaScheduleToNotion', () => {
  it('returns null without dates', () => {
    expect(didaScheduleToNotion(task({}), opts)).toBeNull()
  })

  it('maps a single all-day task stored as UTC midnight-of-local-day', () => {
    const v = didaScheduleToNotion(
      task({ isAllDay: true, startDate: '2026-03-09T16:00:00.000+0000', dueDate: '2026-03-09T16:00:00.000+0000', timeZone: 'Asia/Shanghai' }),
      opts
    )
    expect(v).toEqual({ start: '2026-03-10', end: null })
  })

  it('collapses an all-day task whose due is the next midnight (exclusive end)', () => {
    const v = didaScheduleToNotion(
      task({ isAllDay: true, startDate: '2026-03-09T16:00:00.000+0000', dueDate: '2026-03-10T16:00:00.000+0000', timeZone: 'Asia/Shanghai' }),
      opts
    )
    expect(v).toEqual({ start: '2026-03-10', end: null })
  })

  it('maps multi-day all-day ranges with exclusive end', () => {
    const v = didaScheduleToNotion(
      task({ isAllDay: true, startDate: '2026-03-09T16:00:00.000+0000', dueDate: '2026-03-12T16:00:00.000+0000', timeZone: 'Asia/Shanghai' }),
      opts
    )
    expect(v).toEqual({ start: '2026-03-10', end: '2026-03-12' })
  })

  it('treats all-day end as inclusive when calibrated so', () => {
    const v = didaScheduleToNotion(
      task({ isAllDay: true, startDate: '2026-03-09T16:00:00.000+0000', dueDate: '2026-03-11T16:00:00.000+0000', timeZone: 'Asia/Shanghai' }),
      { ...opts, allDayEndExclusive: false }
    )
    expect(v).toEqual({ start: '2026-03-10', end: '2026-03-12' })
  })

  it('maps timed tasks with the task time zone offset', () => {
    const v = didaScheduleToNotion(task({ isAllDay: false, dueDate: '2026-03-10T07:00:00.000+0000', timeZone: 'Asia/Shanghai' }), opts)
    expect(v).toEqual({ start: '2026-03-10T15:00:00+08:00', end: null })
  })

  it('maps timed ranges', () => {
    const v = didaScheduleToNotion(
      task({ startDate: '2026-03-10T07:00:00+0000', dueDate: '2026-03-10T08:30:00+0000', timeZone: 'Asia/Shanghai' }),
      opts
    )
    expect(v).toEqual({ start: '2026-03-10T15:00:00+08:00', end: '2026-03-10T16:30:00+08:00' })
  })

  it('falls back to the default zone for unknown zones', () => {
    const v = didaScheduleToNotion(task({ dueDate: '2026-03-10T07:00:00+0000', timeZone: 'Not/AZone' }), opts)
    expect(v?.start).toBe('2026-03-10T15:00:00+08:00')
  })
})

describe('completed + normalize', () => {
  it('writes completion as local date', () => {
    expect(didaCompletedToNotion(task({ completedTime: '2026-03-10T17:30:00.000+0000', timeZone: 'Asia/Shanghai' }), opts)).toEqual({
      start: '2026-03-11',
      end: null
    })
  })

  it('normalizes equivalent datetimes to the same value', () => {
    const a = normalizeDate({ start: '2026-03-10T15:00:00+08:00' })
    const b = normalizeDate({ start: '2026-03-10T15:00:00.000+08:00', end: null })
    const c = normalizeDate({ start: '2026-03-10T07:00:00.000Z' })
    expect(sameDate(a, b)).toBe(true)
    expect(sameDate(a, c)).toBe(true)
    expect(sameDate(normalizeDate({ start: '2026-03-10' }), normalizeDate({ start: '2026-03-11' }))).toBe(false)
    expect(sameDate(null, null)).toBe(true)
  })
})
