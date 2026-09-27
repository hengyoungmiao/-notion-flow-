import { spawn } from 'node:child_process'

export type ErrorKind =
  | 'auth'
  | 'not_found'
  | 'rate_limit'
  | 'network'
  | 'server'
  | 'validation'
  | 'timeout'
  | 'unknown'

export type Tool = 'dida' | 'ntn'

export class CliError extends Error {
  constructor(
    message: string,
    readonly tool: Tool,
    readonly kind: ErrorKind,
    readonly status?: number,
    readonly stderr?: string
  ) {
    super(message)
    this.name = 'CliError'
  }

  get retryable(): boolean {
    return this.kind === 'rate_limit' || this.kind === 'network' || this.kind === 'server' || this.kind === 'timeout'
  }
}

export interface ExecOptions {
  env?: Record<string, string | undefined>
  input?: string
  timeoutMs?: number
  cwd?: string
}

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
}

/** 以参数数组方式启动子进程（不经过 shell，避免 Windows 转义问题），stdin/stdout 统一 UTF-8 */
export function runProcess(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries({ ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...options.env })) {
      if (v !== undefined) env[k] = v
    }
    const child = spawn(command, args, {
      cwd: options.cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let timedOut = false
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          child.kill()
        }, options.timeoutMs)
      : null
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d: Buffer) => err.push(d))
    child.on('error', (e) => {
      if (timer) clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut
      })
    })
    if (options.input !== undefined) child.stdin.end(Buffer.from(options.input, 'utf8'))
    else child.stdin.end()
  })
}

const NETWORK_PATTERNS = [
  /fetch failed/i,
  /ENOTFOUND/,
  /ECONNRESET/,
  /ECONNREFUSED/,
  /ETIMEDOUT/,
  /EAI_AGAIN/,
  /network/i,
  /error sending request/i,
  /dns error/i,
  /connection (refused|reset|closed)/i,
  /timed out/i
]

function kindFromStatus(status: number): ErrorKind {
  if (status === 401 || status === 403) return 'auth'
  if (status === 404) return 'not_found'
  if (status === 429) return 'rate_limit'
  if (status === 400 || status === 409 || status === 422) return 'validation'
  if (status >= 500) return 'server'
  return 'unknown'
}

/** 解析 dida-cli 的错误输出：`DIDA API 错误 401: {...}` / `未找到 access token…` */
export function classifyDidaError(stderr: string): { kind: ErrorKind; status?: number } {
  const m = /DIDA API 错误 (\d{3})/.exec(stderr)
  if (m) {
    const status = Number(m[1])
    return { kind: kindFromStatus(status), status }
  }
  if (/access token|dida auth login|未登录/.test(stderr)) return { kind: 'auth' }
  if (NETWORK_PATTERNS.some((p) => p.test(stderr))) return { kind: 'network' }
  return { kind: 'unknown' }
}

/** 解析 ntn 的错误输出（纯文本，退出码 4） */
export function classifyNtnError(stderr: string): { kind: ErrorKind; status?: number } {
  const statusMatch = /\b(?:status(?: code)?|HTTP)\s*:?\s*(\d{3})\b/i.exec(stderr)
  if (statusMatch) {
    const status = Number(statusMatch[1])
    const kind = kindFromStatus(status)
    if (kind !== 'unknown') return { kind, status }
  }
  if (/token is invalid|unauthorized|No workspace selected|ntn login|restricted_resource|not authorized/i.test(stderr))
    return { kind: 'auth' }
  if (/rate.?limit/i.test(stderr)) return { kind: 'rate_limit' }
  if (/could not find|object_not_found|not found/i.test(stderr)) return { kind: 'not_found' }
  if (/validation|invalid_request|body failed validation|conflict_error/i.test(stderr)) return { kind: 'validation' }
  if (/internal_server_error|service_unavailable|bad gateway|gateway_timeout/i.test(stderr)) return { kind: 'server' }
  if (NETWORK_PATTERNS.some((p) => p.test(stderr))) return { kind: 'network' }
  return { kind: 'unknown' }
}

/** 从 stderr 中提取适合展示的一行错误信息（不含 token） */
export function summarizeStderr(stderr: string): string {
  const line =
    stderr
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? '未知错误'
  return redact(line).slice(0, 300)
}

/** 去掉可能出现的 token */
export function redact(text: string): string {
  return text
    .replace(/(dp_|ntn_|secret_)[A-Za-z0-9_-]{6,}/g, '$1***')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1***')
    .replace(/(Invalid access token:\s*)\S+/g, '$1***')
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * 对可重试错误做指数退避重试。
 * `onlyRateLimit`：不幂等的请求（新建页面、追加块）只在限流时重试——超时或网络错误时请求可能已经成功，重试会产生重复。
 */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 4, baseMs = 1000, onlyRateLimit = false): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      const retry = e instanceof CliError && (onlyRateLimit ? e.kind === 'rate_limit' : e.retryable)
      if (!retry || i === attempts - 1) throw e
      const wait = e.kind === 'rate_limit' ? baseMs * 2 ** (i + 1) : baseMs * 2 ** i
      await sleep(wait)
    }
  }
  throw lastErr
}

/** 简单的最小间隔限速器（Notion 平均 ≤3 次/秒） */
export class RateLimiter {
  private next = 0
  constructor(private readonly minIntervalMs: number) {}
  async wait(): Promise<void> {
    const now = Date.now()
    const at = Math.max(now, this.next)
    this.next = at + this.minIntervalMs
    if (at > now) await sleep(at - now)
  }
}
