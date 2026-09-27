import { createHash } from 'node:crypto'
import { markdownToBlocks, mention, paragraph, text, toDo, type BlockRequest, type RichTextRequest } from './markdown'

/** 任务页面顶部由 FlowSync 管理的“滴答同步区”（callout） */

export const BODY_TITLE = '来自滴答清单 · 请在滴答中修改'
export const BODY_ICON = '🔄'

export interface BodyInput {
  repeatText: string | null
  description: string
  items: Array<{ title: string; done: boolean }>
  children: Array<{ title: string; pageId: string | null; done: boolean }>
  parent: { title: string; pageId: string | null } | null
  history: { dates: string[]; count: number } | null
}

export interface BodySpec {
  blocks: BlockRequest[]
  hash: string
}

function label(content: string): BlockRequest {
  return paragraph(text(content, { bold: true }))
}

function titleOrLink(title: string, pageId: string | null): RichTextRequest[] {
  return pageId ? [mention(pageId)] : text(title || '（无标题）')
}

function shortDate(iso: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(iso)
  return m ? `${m[1]}-${m[2]}` : iso
}

/** 生成同步区内容；没有任何内容时返回 null（不建同步区） */
export function buildBody(input: BodyInput): BodySpec | null {
  const blocks: BlockRequest[] = []
  if (input.repeatText) blocks.push(paragraph(text(`🔁 ${input.repeatText}`)))
  if (input.history && input.history.count > 0) {
    const recent = input.history.dates.slice(-8).map(shortDate).join('、')
    blocks.push(paragraph(text(`✅ 最近完成：${recent}（共 ${input.history.count} 次）`, { color: 'gray' })))
  }
  if (input.parent) blocks.push(paragraph([...text('↖ 父任务：'), ...titleOrLink(input.parent.title, input.parent.pageId)]))

  const description = markdownToBlocks(input.description)
  blocks.push(...description)

  if (input.items.length) {
    if (description.length || blocks.length) blocks.push(label('检查事项'))
    for (const item of input.items) blocks.push(toDo(text(item.title || '（空）'), item.done))
  }
  if (input.children.length) {
    blocks.push(label('子任务'))
    for (const child of input.children) blocks.push(toDo(titleOrLink(child.title, child.pageId), child.done))
  }
  if (blocks.length === 0) return null
  const hash = createHash('sha1').update(JSON.stringify(blocks)).digest('hex')
  return { blocks, hash }
}

/** 同步区容器：callout，最多先放 100 个子块，其余由调用方分批追加 */
export function containerBlock(children: BlockRequest[]): BlockRequest {
  return {
    object: 'block',
    type: 'callout',
    callout: {
      rich_text: text(BODY_TITLE, { color: 'gray' }),
      icon: { type: 'emoji', emoji: BODY_ICON },
      color: 'gray_background',
      children: children.slice(0, 100)
    }
  }
}
