import { createInterface, type Interface } from 'node:readline'

/** 终端输出（测试时可替换） */
export interface Output {
  line(text?: string): void
  error(text: string): void
}

export const consoleOutput: Output = {
  line: (text = '') => process.stdout.write(`${text}\n`),
  error: (text) => process.stderr.write(`${text}\n`)
}

/** 交互式提问（测试时用预设答案） */
export interface Prompter {
  ask(question: string, defaultValue?: string): Promise<string>
  /** 输入不回显（token 等） */
  secret(question: string): Promise<string>
  choose(question: string, options: string[], defaultIndex?: number): Promise<number>
  confirm(question: string, defaultValue?: boolean): Promise<boolean>
  close(): void
}

export class TerminalPrompter implements Prompter {
  private rl: Interface | null = null
  private muted = false
  /** 输入行先排队：粘贴或管道输入时，提问之前到达的行不会丢失 */
  private readonly queue: string[] = []
  private readonly waiters: Array<(line: string | null) => void> = []
  private ended = false

  constructor(private readonly out: Output = consoleOutput) {}

  private get iface(): Interface {
    if (!this.rl) {
      const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY })
      const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput.bind(rl)
      ;(rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
        if (!this.muted) write(s)
        else if (/[\r\n]/.test(s)) write('\n')
      }
      rl.on('line', (line) => {
        const w = this.waiters.shift()
        if (w) w(line)
        else this.queue.push(line)
      })
      rl.on('close', () => {
        this.ended = true
        for (const w of this.waiters.splice(0)) w(null)
      })
      this.rl = rl
    }
    return this.rl
  }

  private async question(q: string, mute = false): Promise<string> {
    const rl = this.iface
    rl.setPrompt(q)
    rl.prompt()
    this.muted = mute
    try {
      const line = this.queue.length ? this.queue.shift()! : this.ended ? null : await new Promise<string | null>((r) => this.waiters.push(r))
      if (line === null) throw new Error('输入已结束')
      return line
    } finally {
      this.muted = false
    }
  }

  async ask(question: string, defaultValue?: string): Promise<string> {
    const answer = (await this.question(`${question}${defaultValue ? `（默认：${defaultValue}）` : ''}：`)).trim()
    return answer || defaultValue || ''
  }

  async secret(question: string): Promise<string> {
    return (await this.question(`${question}（输入时不显示）：`, true)).trim()
  }

  async choose(question: string, options: string[], defaultIndex = 0): Promise<number> {
    this.out.line(question)
    options.forEach((o, i) => this.out.line(`  ${i + 1}. ${o}`))
    for (;;) {
      const raw = await this.ask('请输入序号', String(defaultIndex + 1))
      const n = Number(raw)
      if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1
      this.out.line(`请输入 1 到 ${options.length} 之间的数字`)
    }
  }

  async confirm(question: string, defaultValue = true): Promise<boolean> {
    for (;;) {
      const raw = (await this.question(`${question}（${defaultValue ? 'Y/n' : 'y/N'}）：`)).trim().toLowerCase()
      if (!raw) return defaultValue
      if (['y', 'yes', '是', '好', '可以'].includes(raw)) return true
      if (['n', 'no', '否', '不'].includes(raw)) return false
    }
  }

  close(): void {
    this.rl?.close()
    this.rl = null
  }
}

/** 预设答案的提问器（测试用）：按顺序取答案，空字符串表示用默认值 */
export class ScriptedPrompter implements Prompter {
  readonly asked: string[] = []
  constructor(private readonly answers: string[]) {}

  private next(q: string): string {
    this.asked.push(q)
    if (this.answers.length === 0) throw new Error(`没有预设答案：${q}`)
    return this.answers.shift()!
  }

  async ask(question: string, defaultValue?: string): Promise<string> {
    return this.next(question) || defaultValue || ''
  }
  async secret(question: string): Promise<string> {
    return this.next(question)
  }
  async choose(question: string, options: string[], defaultIndex = 0): Promise<number> {
    const raw = this.next(`${question} [${options.join(' | ')}]`)
    return raw ? Number(raw) - 1 : defaultIndex
  }
  async confirm(question: string, defaultValue = true): Promise<boolean> {
    const raw = this.next(question).toLowerCase()
    return raw ? raw === 'y' : defaultValue
  }
  close(): void {}
}

// ───────────────────────── 格式化 ─────────────────────────

/** 终端显示宽度（中日韩字符算 2） */
export function textWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    w +=
      (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6)
        ? 2
        : 1
  }
  return w
}

export function pad(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - textWidth(s)))
}

export function table(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((h, i) => Math.max(textWidth(h), ...rows.map((r) => textWidth(r[i] ?? ''))))
  const fmt = (r: string[]) => r.map((c, i) => pad(c ?? '', widths[i]!)).join('  ').trimEnd()
  return [fmt(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(fmt)]
}

export function fromNow(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—'
  const diff = Math.round((now - Date.parse(iso)) / 1000)
  const abs = Math.abs(diff)
  const suffix = diff >= 0 ? '前' : '后'
  if (abs < 60) return diff >= 0 ? '刚刚' : `${abs} 秒后`
  if (abs < 3600) return `${Math.round(abs / 60)} 分钟${suffix}`
  if (abs < 86400) return `${Math.round(abs / 3600)} 小时${suffix}`
  return `${Math.round(abs / 86400)} 天${suffix}`
}

export function localTime(iso: string | null | undefined, zone = 'Asia/Shanghai'): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('zh-CN', { timeZone: zone, hour12: false })
}

export const MARK = { ok: '✓', bad: '✗', warn: '!' }
