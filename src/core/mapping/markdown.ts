/** 滴答描述（Markdown）→ Notion 块请求。只覆盖常用语法，其余按普通文字保留。 */

export type BlockRequest = Record<string, unknown>

export interface RichTextRequest {
  type: 'text' | 'mention'
  text?: { content: string; link?: { url: string } | null }
  mention?: { type: 'page'; page: { id: string } }
  annotations?: { bold?: boolean; italic?: boolean; strikethrough?: boolean; code?: boolean; color?: string }
}

const MAX_TEXT = 2000
const MAX_ITEMS = 100

type Annotations = NonNullable<RichTextRequest['annotations']>

function pushText(out: RichTextRequest[], content: string, annotations?: Annotations, url?: string): void {
  if (!content) return
  const chars = Array.from(content)
  for (let i = 0; i < chars.length; i += MAX_TEXT) {
    const piece: RichTextRequest = { type: 'text', text: { content: chars.slice(i, i + MAX_TEXT).join('') } }
    if (url) piece.text!.link = { url }
    if (annotations && Object.keys(annotations).length) piece.annotations = annotations
    out.push(piece)
  }
}

const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(~~[^~\n]+~~)|(!\[[^\]\n]*\]\([^)\s]+\))|(\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\))|(\*[^*\s][^*\n]*\*)|(https?:\/\/[^\s<>()（）\u3000-\u9fff\uff00-\uffef]+)/g

/** 只把 Notion 能接受的链接写成链接（http/https、能解析、不超过 2000 字），否则按普通文字处理 */
export function safeUrl(url: string): string | undefined {
  if (url.length > 2000) return undefined
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}

/** 行内格式：`代码`、**加粗**、*斜体*、~~删除线~~、[链接](url)、裸链接；图片显示为“[图片]” */
export function inlineRichText(text: string, base: Annotations = {}): RichTextRequest[] {
  const out: RichTextRequest[] = []
  let last = 0
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0
    pushText(out, text.slice(last, at), base)
    const [token] = m
    if (m[1]) pushText(out, token.slice(1, -1), { ...base, code: true })
    else if (m[2]) pushText(out, token.slice(2, -2), { ...base, bold: true })
    else if (m[3]) pushText(out, token.slice(2, -2), { ...base, strikethrough: true })
    else if (m[4]) pushText(out, '[图片]', { ...base, color: 'gray' })
    else if (m[5]) pushText(out, token.slice(1, token.indexOf('](')), base, safeUrl(m[6]!))
    else if (m[7]) pushText(out, token.slice(1, -1), { ...base, italic: true })
    else if (m[8]) {
      // 裸链接末尾的标点不算链接的一部分
      const url = token.replace(/[.,;:!?'"\]]+$/, '')
      pushText(out, url, base, safeUrl(url))
      pushText(out, token.slice(url.length), base)
    }
    last = at + token.length
  }
  pushText(out, text.slice(last), base)
  return out.slice(0, MAX_ITEMS)
}

function block(type: string, content: Record<string, unknown>): BlockRequest {
  return { object: 'block', type, [type]: content }
}

const CODE_LANGUAGES = new Set([
  'bash', 'c', 'c++', 'c#', 'css', 'go', 'html', 'java', 'javascript', 'json', 'kotlin', 'markdown', 'python',
  'ruby', 'rust', 'shell', 'sql', 'swift', 'typescript', 'yaml', 'xml'
])

function codeLanguage(lang: string): string {
  const l = lang.trim().toLowerCase()
  const alias: Record<string, string> = { js: 'javascript', ts: 'typescript', py: 'python', sh: 'shell', yml: 'yaml', md: 'markdown' }
  const name = alias[l] ?? l
  return CODE_LANGUAGES.has(name) ? name : 'plain text'
}

export function markdownToBlocks(markdown: string | null | undefined): BlockRequest[] {
  const lines = (markdown ?? '').replace(/\r\n?/g, '\n').split('\n')
  const blocks: BlockRequest[] = []
  let paragraph: string[] = []
  let quote: string[] = []

  const flushParagraph = () => {
    if (paragraph.length) blocks.push(block('paragraph', { rich_text: inlineRichText(paragraph.join('\n')) }))
    paragraph = []
  }
  const flushQuote = () => {
    if (quote.length) blocks.push(block('quote', { rich_text: inlineRichText(quote.join('\n')) }))
    quote = []
  }
  const flush = () => {
    flushParagraph()
    flushQuote()
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const fence = /^\s*```\s*([\w+#-]*)\s*$/.exec(line)
    if (fence) {
      flush()
      const code: string[] = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) code.push(lines[i++]!)
      blocks.push(block('code', { rich_text: inlineRichTextPlain(code.join('\n')), language: codeLanguage(fence[1] ?? '') }))
      continue
    }
    if (!line.trim()) {
      flush()
      continue
    }
    let m: RegExpExecArray | null
    if ((m = /^\s*>\s?(.*)$/.exec(line))) {
      flushParagraph()
      quote.push(m[1]!)
      continue
    }
    flushQuote()
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushParagraph()
      blocks.push(block('divider', {}))
    } else if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      flushParagraph()
      const level = Math.min(3, m[1]!.length)
      blocks.push(block(`heading_${level}`, { rich_text: inlineRichText(m[2]!) }))
    } else if ((m = /^\s*[-*+]\s+\[( |x|X)\]\s*(.*)$/.exec(line))) {
      flushParagraph()
      blocks.push(block('to_do', { rich_text: inlineRichText(m[2]!), checked: m[1] !== ' ' }))
    } else if ((m = /^\s*[-*+]\s+(.*)$/.exec(line))) {
      flushParagraph()
      blocks.push(block('bulleted_list_item', { rich_text: inlineRichText(m[1]!) }))
    } else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
      flushParagraph()
      blocks.push(block('numbered_list_item', { rich_text: inlineRichText(m[1]!) }))
    } else {
      paragraph.push(line)
    }
  }
  flush()
  return blocks
}

function inlineRichTextPlain(text: string): RichTextRequest[] {
  const out: RichTextRequest[] = []
  pushText(out, text)
  return out.slice(0, MAX_ITEMS)
}

export function paragraph(rich: RichTextRequest[]): BlockRequest {
  return block('paragraph', { rich_text: rich })
}

export function toDo(rich: RichTextRequest[], checked: boolean): BlockRequest {
  return block('to_do', { rich_text: rich, checked })
}

export function text(content: string, annotations?: Annotations): RichTextRequest[] {
  const out: RichTextRequest[] = []
  pushText(out, content, annotations)
  return out
}

export function mention(pageId: string): RichTextRequest {
  return { type: 'mention', mention: { type: 'page', page: { id: pageId } } }
}
