import { describe, expect, it } from 'vitest'
import { buildBody, containerBlock } from '../../src/core/mapping/body'
import { inlineRichText, markdownToBlocks } from '../../src/core/mapping/markdown'

const types = (md: string) => markdownToBlocks(md).map((b) => b.type)
const plain = (b: Record<string, any>) => (b[b.type].rich_text as any[]).map((r) => r.text?.content ?? '').join('')

describe('markdownToBlocks', () => {
  it('converts common block syntax', () => {
    const md = ['# 标题', '## 小标题', '第一行', '第二行', '', '- 苹果', '* 香蕉', '1. 第一步', '- [ ] 待办', '- [x] 已办', '> 引用', '---', '```js', 'const a = 1', '```'].join('\n')
    expect(types(md)).toEqual([
      'heading_1',
      'heading_2',
      'paragraph',
      'bulleted_list_item',
      'bulleted_list_item',
      'numbered_list_item',
      'to_do',
      'to_do',
      'quote',
      'divider',
      'code'
    ])
    const blocks = markdownToBlocks(md)
    expect(plain(blocks[2]!)).toBe('第一行\n第二行')
    expect((blocks[6] as any).to_do.checked).toBe(false)
    expect((blocks[7] as any).to_do.checked).toBe(true)
    expect((blocks[10] as any).code.language).toBe('javascript')
    expect(plain(blocks[10]!)).toBe('const a = 1')
  })

  it('handles inline formatting, links and images', () => {
    const rich = inlineRichText('先 **加粗** 再 *斜体* 和 `code`，~~删~~，看 [文档](https://a.com/x) 或 https://b.com ![图](https://c.com/i.png)')
    const bold = rich.find((r) => r.annotations?.bold)
    expect(bold?.text?.content).toBe('加粗')
    expect(rich.find((r) => r.annotations?.italic)?.text?.content).toBe('斜体')
    expect(rich.find((r) => r.annotations?.code)?.text?.content).toBe('code')
    expect(rich.find((r) => r.annotations?.strikethrough)?.text?.content).toBe('删')
    expect(rich.find((r) => r.text?.content === '文档')?.text?.link?.url).toBe('https://a.com/x')
    expect(rich.find((r) => r.text?.content === 'https://b.com')?.text?.link?.url).toBe('https://b.com')
    expect(rich.some((r) => r.text?.content === '[图片]')).toBe(true)
  })

  it('only writes links Notion accepts; bare links stop at punctuation and CJK text', () => {
    const bad = inlineRichText('看[这里](https://) 和 [那里](http://a.com/x)')
    expect(bad.find((r) => r.text?.content === '这里')?.text?.link).toBeUndefined()
    expect(bad.find((r) => r.text?.content === '那里')?.text?.link).toEqual({ url: 'http://a.com/x' })

    const bare = inlineRichText('见 https://a.com/x. 然后看链接https://b.com/y然后')
    expect(bare.filter((r) => r.text?.link).map((r) => r.text!.link!.url)).toEqual(['https://a.com/x', 'https://b.com/y'])
    expect(bare.map((r) => r.text?.content).join('')).toBe('见 https://a.com/x. 然后看链接https://b.com/y然后')
  })

  it('splits long text into 2000-char pieces', () => {
    const blocks = markdownToBlocks('字'.repeat(4500))
    const rich = (blocks[0] as any).paragraph.rich_text
    expect(rich.map((r: any) => r.text.content.length)).toEqual([2000, 2000, 500])
  })

  it('returns nothing for empty input', () => {
    expect(markdownToBlocks('')).toEqual([])
    expect(markdownToBlocks(null)).toEqual([])
  })
})

describe('buildBody', () => {
  const empty = { repeatText: null, description: '', items: [], children: [], parent: null, history: null }

  it('returns null when there is nothing to show', () => {
    expect(buildBody(empty)).toBeNull()
  })

  it('orders repeat, history, parent, description, checklist and subtasks', () => {
    const body = buildBody({
      repeatText: '每周一',
      description: '准备材料',
      items: [{ title: '打印', done: true }],
      children: [{ title: '子任务', pageId: 'page-c', done: false }],
      parent: { title: '父', pageId: 'page-p' },
      history: { dates: ['2026-09-20', '2026-09-27'], count: 2 }
    })!
    const t = body.blocks.map((b) => b.type)
    expect(t).toEqual(['paragraph', 'paragraph', 'paragraph', 'paragraph', 'paragraph', 'to_do', 'paragraph', 'to_do'])
    expect(plain(body.blocks[0]!)).toBe('🔁 每周一')
    expect(plain(body.blocks[1]!)).toBe('✅ 最近完成：09-20、09-27（共 2 次）')
    expect((body.blocks[2] as any).paragraph.rich_text[1].mention.page.id).toBe('page-p')
    expect((body.blocks[5] as any).to_do.checked).toBe(true)
    expect((body.blocks[7] as any).to_do.rich_text[0].mention.page.id).toBe('page-c')
  })

  it('has a stable hash', () => {
    const a = buildBody({ ...empty, description: 'x' })!
    const b = buildBody({ ...empty, description: 'x' })!
    const c = buildBody({ ...empty, description: 'y' })!
    expect(a.hash).toBe(b.hash)
    expect(a.hash).not.toBe(c.hash)
  })

  it('wraps content in a callout with at most 100 children', () => {
    const many = Array.from({ length: 130 }, (_, i) => ({ title: `项 ${i}`, done: false }))
    const body = buildBody({ ...empty, items: many })!
    const c = containerBlock(body.blocks) as any
    expect(c.type).toBe('callout')
    expect(c.callout.children).toHaveLength(100)
  })
})
