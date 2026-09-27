/** 滴答重复规则（RRULE / ERULE）→ 通俗中文描述 */

const WEEKDAY: Record<string, string> = { MO: '周一', TU: '周二', WE: '周三', TH: '周四', FR: '周五', SA: '周六', SU: '周日' }
const WEEK_ORDER = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']

function parseParts(rule: string): Map<string, string> {
  const parts = new Map<string, string>()
  for (const seg of rule.split(';')) {
    const i = seg.indexOf('=')
    if (i > 0) parts.set(seg.slice(0, i).trim().toUpperCase(), seg.slice(i + 1).trim())
  }
  return parts
}

function ordinal(n: number): string {
  return n === -1 ? '最后一个' : n < 0 ? `倒数第 ${-n} 个` : `第 ${n} 个`
}

function joinDays(codes: string[]): string {
  const sorted = [...codes].sort((a, b) => WEEK_ORDER.indexOf(a) - WEEK_ORDER.indexOf(b))
  return sorted.map((c) => WEEKDAY[c] ?? c).join('、')
}

function formatUntil(value: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(value)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}

function formatBydate(value: string): string {
  const dates = value
    .split(',')
    .map((d) => /^(\d{4})(\d{2})(\d{2})$/.exec(d.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => `${Number(m[2])} 月 ${Number(m[3])} 日`)
  if (dates.length === 0) return '自定义日期'
  const shown = dates.slice(0, 6).join('、')
  return `自定义日期：${shown}${dates.length > 6 ? ` 等 ${dates.length} 天` : ''}`
}

function describeRrule(parts: Map<string, string>): string | null {
  const freq = parts.get('FREQ')
  const interval = Math.max(1, Number(parts.get('INTERVAL') ?? '1') || 1)
  const byday = (parts.get('BYDAY') ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
  const bymonthday = (parts.get('BYMONTHDAY') ?? '').split(',').map((s) => Number(s)).filter((n) => !Number.isNaN(n) && n !== 0)
  const bymonth = (parts.get('BYMONTH') ?? '').split(',').map((s) => Number(s)).filter((n) => n >= 1 && n <= 12)
  const setpos = Number(parts.get('BYSETPOS') ?? '0') || 0
  const skip = (parts.get('TT_SKIP') ?? '').toUpperCase().split(',').filter(Boolean)
  const plainDays = byday.filter((d) => /^[A-Z]{2}$/.test(d))
  const isWorkdays = plainDays.length === 5 && ['MO', 'TU', 'WE', 'TH', 'FR'].every((d) => plainDays.includes(d))
  const isWeekend = plainDays.length === 2 && plainDays.includes('SA') && plainDays.includes('SU')

  let text: string
  switch (freq) {
    case 'DAILY':
      if (skip.includes('HOLIDAY') && skip.includes('WEEKEND')) text = interval === 1 ? '每个法定工作日' : `每 ${interval} 个法定工作日`
      else if (isWorkdays) text = '每个工作日（周一至周五）'
      else text = interval === 1 ? '每天' : `每 ${interval} 天`
      break
    case 'WEEKLY': {
      const every = interval === 1 ? '每周' : `每 ${interval} 周`
      if (isWorkdays && interval === 1) text = '每个工作日（周一至周五）'
      else if (isWeekend && interval === 1) text = '每周末'
      else if (plainDays.length) text = interval === 1 ? `每${joinDays(plainDays)}` : `${every}的${joinDays(plainDays)}`
      else text = every
      break
    }
    case 'MONTHLY': {
      const every = interval === 1 ? '每月' : `每 ${interval} 个月`
      const ordinalDay = byday.map((d) => /^([+-]?\d+)([A-Z]{2})$/.exec(d)).find((m): m is RegExpExecArray => !!m)
      if (ordinalDay) text = `${every}${ordinal(Number(ordinalDay[1]))}${WEEKDAY[ordinalDay[2]!] ?? ordinalDay[2]}`
      else if (plainDays.length && setpos) text = `${every}${ordinal(setpos)}${joinDays(plainDays)}`
      else if (bymonthday.length) {
        const nums = bymonthday.filter((d) => d > 0)
        const specials = bymonthday.filter((d) => d < 0).map((d) => (d === -1 ? '最后一天' : `倒数第 ${-d} 天`))
        text = every + (nums.length ? ` ${nums.join('、')} 日` : '') + (specials.length ? (nums.length ? '、' : '') + specials.join('、') : '')
      } else text = every
      break
    }
    case 'YEARLY': {
      const every = interval === 1 ? '每年' : `每 ${interval} 年`
      if (bymonth.length && bymonthday.length) text = `${every} ${bymonth[0]} 月 ${bymonthday[0]} 日`
      else if (bymonth.length) text = `${every} ${bymonth.join('、')} 月`
      else text = every
      break
    }
    default:
      return null
  }

  const skipHoliday = skip.includes('HOLIDAY')
  const skipWeekend = skip.includes('WEEKEND')
  const workdayRule = freq === 'DAILY' && skipHoliday && skipWeekend
  if (!workdayRule) {
    if (skipHoliday && skipWeekend) text += '（跳过周末和法定节假日）'
    else if (skipHoliday) text += '（跳过法定节假日）'
    else if (skipWeekend) text += '（跳过周末）'
  }

  const count = Number(parts.get('COUNT') ?? '0')
  if (count > 0) text += `，共 ${count} 次`
  const until = parts.get('UNTIL')
  if (until) {
    const date = formatUntil(until)
    if (date) text += `，到 ${date} 为止`
  }
  return text
}

/**
 * 把 repeatFlag 翻译成中文，例如 `RRULE:FREQ=WEEKLY;BYDAY=MO,WE` → `每周一、周三`。
 * 无法识别的规则原样返回，保证不丢信息。
 */
export function describeRepeat(repeatFlag: string | null | undefined, repeatFrom?: number | string | null): string | null {
  const raw = (repeatFlag ?? '').trim()
  if (!raw) return null
  let text: string | null = null
  const [kind, ...rest] = raw.split(':')
  const body = rest.join(':')
  const upper = (kind ?? '').toUpperCase()
  if (upper === 'RRULE') text = describeRrule(parseParts(body))
  else if (upper === 'ERULE') {
    const parts = parseParts(body)
    const name = (parts.get('NAME') ?? '').toUpperCase()
    if (name === 'CUSTOM' && parts.get('BYDATE')) text = formatBydate(parts.get('BYDATE')!)
    else if (name === 'FORGETTINGCURVE') text = '按艾宾浩斯记忆曲线重复'
  } else if (/FREQ=/i.test(raw)) text = describeRrule(parseParts(raw))

  if (!text) return `重复规则：${raw}`
  const from = Number(repeatFrom)
  if (from === 0) text += ' · 按截止日期重复'
  else if (from === 1) text += ' · 按完成日期重复'
  return text
}
