import { describe, expect, it } from 'vitest'
import { describeRepeat } from '../../src/core/mapping/recurrence'

describe('describeRepeat', () => {
  const cases: Array<[string, string]> = [
    ['RRULE:FREQ=DAILY;INTERVAL=1', '每天'],
    ['RRULE:FREQ=DAILY;INTERVAL=3', '每 3 天'],
    ['RRULE:FREQ=DAILY;INTERVAL=1;TT_SKIP=HOLIDAY,WEEKEND', '每个法定工作日'],
    ['RRULE:FREQ=DAILY;INTERVAL=1;TT_SKIP=HOLIDAY', '每天（跳过法定节假日）'],
    ['RRULE:FREQ=DAILY;INTERVAL=1;TT_SKIP=WEEKEND', '每天（跳过周末）'],
    ['RRULE:FREQ=WEEKLY;INTERVAL=1', '每周'],
    ['RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=WE,MO', '每周一、周三'],
    ['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=FR', '每 2 周的周五'],
    ['RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', '每个工作日（周一至周五）'],
    ['RRULE:FREQ=WEEKLY;BYDAY=SA,SU', '每周末'],
    ['RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=15', '每月 15 日'],
    ['RRULE:FREQ=MONTHLY;BYMONTHDAY=1,15', '每月 1、15 日'],
    ['RRULE:FREQ=MONTHLY;BYMONTHDAY=-1', '每月最后一天'],
    ['RRULE:FREQ=MONTHLY;BYDAY=1MO', '每月第 1 个周一'],
    ['RRULE:FREQ=MONTHLY;BYDAY=-1FR', '每月最后一个周五'],
    ['RRULE:FREQ=MONTHLY;BYDAY=MO;BYSETPOS=2', '每月第 2 个周一'],
    ['RRULE:FREQ=MONTHLY;INTERVAL=3', '每 3 个月'],
    ['RRULE:FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=8', '每年 3 月 8 日'],
    ['RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10', '每周一，共 10 次'],
    ['RRULE:FREQ=DAILY;UNTIL=20261231T000000Z', '每天，到 2026-12-31 为止'],
    ['ERULE:NAME=CUSTOM;BYDATE=20260325,20260330', '自定义日期：3 月 25 日、3 月 30 日'],
    ['ERULE:NAME=FORGETTINGCURVE;CYCLE=0', '按艾宾浩斯记忆曲线重复']
  ]
  for (const [rule, expected] of cases) {
    it(rule, () => expect(describeRepeat(rule)).toBe(expected))
  }

  it('adds the repeat-from hint', () => {
    expect(describeRepeat('RRULE:FREQ=DAILY', 0)).toBe('每天 · 按截止日期重复')
    expect(describeRepeat('RRULE:FREQ=DAILY', 1)).toBe('每天 · 按完成日期重复')
    expect(describeRepeat('RRULE:FREQ=DAILY', 2)).toBe('每天')
  })

  it('keeps unknown rules instead of failing', () => {
    expect(describeRepeat('RRULE:FREQ=HOURLY')).toBe('重复规则：RRULE:FREQ=HOURLY')
    expect(describeRepeat('WEIRD')).toBe('重复规则：WEIRD')
    expect(describeRepeat('')).toBeNull()
    expect(describeRepeat(null)).toBeNull()
  })

  it('summarizes many custom dates', () => {
    const dates = Array.from({ length: 9 }, (_, i) => `202604${String(i + 1).padStart(2, '0')}`).join(',')
    expect(describeRepeat(`ERULE:NAME=CUSTOM;BYDATE=${dates}`)).toBe('自定义日期：4 月 1 日、4 月 2 日、4 月 3 日、4 月 4 日、4 月 5 日、4 月 6 日 等 9 天')
  })
})
