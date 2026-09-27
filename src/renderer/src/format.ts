import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import 'dayjs/locale/zh-cn'

dayjs.extend(relativeTime)
dayjs.locale('zh-cn')

export function fromNow(iso: string | null | undefined): string {
  if (!iso) return '从未'
  return dayjs(iso).fromNow()
}

export function clock(iso: string | null | undefined): string {
  if (!iso) return '—'
  return dayjs(iso).format('MM-DD HH:mm:ss')
}

export function notionUrl(pageId: string): string {
  return `https://www.notion.so/${pageId.replace(/-/g, '')}`
}
