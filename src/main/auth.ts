import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import type { DidaCommand } from '../core/adapters/dida'
import { classifyDidaError, redact, runProcess, summarizeStderr } from '../core/adapters/exec'
import { ntnEnv } from '../core/adapters/notion'

export interface NotionLoginInfo {
  url: string
  code: string
}

/** 从 `ntn login`（非终端模式）的输出里解析登录链接和验证码 */
export function parseNtnLogin(stdout: string): NotionLoginInfo | null {
  const url = /(https:\/\/\S*cli-login\S*)/.exec(stdout)?.[1]
  if (!url) return null
  let code: string | null = null
  try {
    code = new URL(url).searchParams.get('verificationCode')
  } catch {
    code = null
  }
  code ??= /\b([A-Z0-9]{3,4}-[A-Z0-9]{3,4})\b/.exec(stdout)?.[1] ?? null
  return code ? { url, code } : null
}

function spawnTracked(cmd: string, args: string[], env: Record<string, string>): ChildProcess {
  const merged: Record<string, string> = {}
  for (const [k, v] of Object.entries({ ...process.env, NO_COLOR: '1', ...env })) if (v !== undefined) merged[k] = v
  return spawn(cmd, args, { env: merged, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
}

function waitExit(child: ChildProcess, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let out = ''
    let err = ''
    child.stdout?.on('data', (d: Buffer) => (out += d.toString('utf8')))
    child.stderr?.on('data', (d: Buffer) => (err += d.toString('utf8')))
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout: out, stderr: err })
    })
  })
}

/** Notion 两步登录：`ntn login` 输出链接与验证码 → `ntn login poll` 等待用户在浏览器确认 */
export class NotionLogin {
  private polls = new Map<string, ChildProcess>()

  constructor(private readonly ntn: () => string) {}

  async start(key: string, notionHome: string): Promise<NotionLoginInfo> {
    await mkdir(notionHome, { recursive: true })
    const res = await runProcess(this.ntn(), ['login', '--no-browser'], { env: ntnEnv({ notionHome }), timeoutMs: 60_000 })
    const info = parseNtnLogin(`${res.stdout}\n${res.stderr}`)
    if (!info) throw new Error(summarizeStderr(res.stderr || res.stdout || '无法开始 Notion 登录'))
    this.cancel(key)
    return info
  }

  async poll(key: string, notionHome: string, timeoutMs = 10 * 60_000): Promise<void> {
    this.cancel(key)
    const child = spawnTracked(this.ntn(), ['login', 'poll'], ntnEnv({ notionHome }))
    this.polls.set(key, child)
    try {
      const res = await waitExit(child, timeoutMs)
      if (res.code !== 0) throw new Error(summarizeStderr(res.stderr || res.stdout || 'Notion 登录未完成'))
    } finally {
      if (this.polls.get(key) === child) this.polls.delete(key)
    }
  }

  cancel(key: string): void {
    this.polls.get(key)?.kill()
    this.polls.delete(key)
  }
}

/** 滴答清单登录：token 由 dida-cli 自己保存（~/.config/dida-cli/config.json），本应用不保存 */
export class DidaAuth {
  private child: ChildProcess | null = null

  constructor(private readonly cmd: () => DidaCommand) {}

  async loginBrowser(timeoutMs = 5 * 60_000): Promise<void> {
    this.cancel()
    const c = this.cmd()
    const child = spawnTracked(c.command, [...c.baseArgs, 'auth', 'login'], c.env ?? {})
    this.child = child
    try {
      const res = await waitExit(child, timeoutMs)
      if (res.code !== 0) throw new Error(redact(summarizeStderr(res.stderr || res.stdout || '滴答清单授权未完成')))
    } finally {
      if (this.child === child) this.child = null
    }
  }

  cancel(): void {
    this.child?.kill()
    this.child = null
  }

  async saveToken(token: string): Promise<void> {
    const c = this.cmd()
    const res = await runProcess(c.command, [...c.baseArgs, 'auth', 'token', token.trim()], { env: c.env, timeoutMs: 30_000 })
    if (res.code !== 0) throw new Error(redact(summarizeStderr(res.stderr || res.stdout)))
  }

  async logout(): Promise<void> {
    const c = this.cmd()
    const res = await runProcess(c.command, [...c.baseArgs, 'auth', 'logout'], { env: c.env, timeoutMs: 30_000 })
    if (res.code !== 0) {
      const { kind } = classifyDidaError(res.stderr)
      if (kind !== 'auth') throw new Error(redact(summarizeStderr(res.stderr || res.stdout)))
    }
  }
}
