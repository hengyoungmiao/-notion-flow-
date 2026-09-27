import type { NotionRichText } from '../types'

/** 标题归一化（用于首次配对）：全半角统一、去首尾空白、合并空白、忽略大小写 */
export function normalizeTitle(title: string | null | undefined): string {
  return (title ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
}

export function plainText(rich: NotionRichText[] | undefined | null): string {
  if (!rich) return ''
  return rich.map((r) => r.plain_text ?? r.text?.content ?? '').join('')
}

/** Notion 单个 rich_text 最多 2000 字，单个属性最多 100 段 */
export function toRichText(text: string): Array<{ type: 'text'; text: { content: string } }> {
  if (!text) return []
  const chunks: Array<{ type: 'text'; text: { content: string } }> = []
  const chars = Array.from(text)
  for (let i = 0; i < chars.length && chunks.length < 100; i += 2000) {
    chunks.push({ type: 'text', text: { content: chars.slice(i, i + 2000).join('') } })
  }
  return chunks
}

/** 比较前统一换行和首尾空白，避免 Notion 与滴答的换行差异导致反复写入 */
export function normalizeNote(text: string | null | undefined): string {
  return (text ?? '').replace(/\r\n?/g, '\n').trim()
}
