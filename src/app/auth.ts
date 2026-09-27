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

// ───────────────────────── 滴答 OAuth（服务器上没有浏览器：在自己电脑上授权，再把跳转后的链接粘回来） ─────────────────────────

export interface DidaOAuthModule {
  generatePkceChallenge(): { codeVerifier: string; codeChallenge: string }
  buildAuthorizationUrl(state: string, codeChallenge: string): string
  exchangeCodeForToken(code: string, codeVerifier: string): Promise<string>
}

export interface DidaOAuthStart {
  url: string
  state: string
  codeVerifier: string
}

/** 复用 dida-cli 自带的 OAuth 实现（client_id、回调地址与 `dida auth login` 一致） */
export async function loadDidaOAuth(didaScriptPath: string): Promise<DidaOAuthModule> {
  const { dirname, join } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  return (await import(pathToFileURL(join(dirname(didaScriptPath), 'lib', 'oauth.js')).href)) as DidaOAuthModule
}

export function startDidaOAuth(mod: DidaOAuthModule, state = randomState()): DidaOAuthStart {
  const { codeVerifier, codeChallenge } = mod.generatePkceChallenge()
  return { url: mod.buildAuthorizationUrl(state, codeChallenge), state, codeVerifier }
}

function randomState(): string {
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
}

/** 从浏览器跳转后的地址（http://localhost:…/callback?code=…&state=…）里取出授权码；也接受只粘贴授权码 */
export function parseDidaCallback(input: string, expectedState: string): string {
  const text = input.trim()
  if (!text) throw new Error('没有输入内容')
  const denied = /[?&]error=([^&#]+)/.exec(text)
  if (denied) throw new Error(`滴答拒绝了授权：${decodeURIComponent(denied[1]!)}`)
  if (!/[?&]code=/.test(text)) {
    if (/^[\w-]{4,}$/.test(text)) return text
    throw new Error('没有在链接里找到授权码（code），请复制浏览器地址栏里完整的链接')
  }
  const query = text.includes('?') ? text.slice(text.indexOf('?') + 1) : text
  const params = new URLSearchParams(query.split('#')[0])
  const error = params.get('error')
  if (error) throw new Error(`滴答拒绝了授权：${error}`)
  const state = params.get('state')
  if (state && state !== expectedState) throw new Error('链接不是这次登录生成的（state 不一致），请重新开始登录')
  const code = params.get('code')
  if (!code) throw new Error('没有在链接里找到授权码（code）')
  return code
}

export async function finishDidaOAuth(mod: DidaOAuthModule, start: DidaOAuthStart, pasted: string): Promise<string> {
  const code = parseDidaCallback(pasted, start.state)
  const token = await mod.exchangeCodeForToken(code, start.codeVerifier)
  if (!token) throw new Error('滴答没有返回 access token')
  return token
}
