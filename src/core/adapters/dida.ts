import { DateTime } from 'luxon'
import type { DidaFocus, DidaGroup, DidaPreference, DidaProject, DidaTask } from '../types'
import { CliError, classifyDidaError, runProcess, summarizeStderr, withRetry } from './exec'

/** 对滴答清单只读：本应用永远不会写入或删除滴答数据 */
export interface DidaReader {
  getPreference(): Promise<DidaPreference>
  listProjects(): Promise<DidaProject[]>
  listGroups(): Promise<DidaGroup[]>
  /** 未完成任务；不传 projectIds 时由服务端决定范围（是否含收件箱待样例校准） */
  listOpenTasks(projectIds?: string[]): Promise<DidaTask[]>
  listCompletedTasks(from: Date, to: Date, projectIds?: string[]): Promise<DidaTask[]>
  /** 返回 null 表示 404（任务不存在或不在该清单） */
  getTask(projectId: string, taskId: string): Promise<DidaTask | null>
  /** 收件箱未完成任务；接口不支持时返回 null */
  listInboxTasks(): Promise<DidaTask[] | null>
  /** 专注记录（接口单次最多 30 天，调用方负责分段） */
  listFocus(from: Date, to: Date, type: FocusKind): Promise<DidaFocus[]>
  /** 返回 null 表示 404（记录已删除） */
  getFocus(focusId: string, type: FocusKind): Promise<DidaFocus | null>
}

export type FocusKind = 'pomodoro' | 'timing'

const DAY = 86_400_000

/** 按不超过 30 天的窗口分段读取专注记录 */
export async function listFocusRange(dida: DidaReader, from: Date, to: Date, type: FocusKind): Promise<DidaFocus[]> {
  const out = new Map<string, DidaFocus>()
  for (let start = from.getTime(); start < to.getTime(); start += 29 * DAY) {
    const end = Math.min(to.getTime(), start + 29 * DAY)
    for (const f of await dida.listFocus(new Date(start), new Date(end), type)) out.set(f.id, f)
  }
  return [...out.values()]
}

export interface DidaCommand {
  /** 可执行文件（打包后为 Electron 自身，配合 ELECTRON_RUN_AS_NODE=1） */
  command: string
  /** 前置参数（dida-cli 入口脚本路径） */
  baseArgs: string[]
  env?: Record<string, string>
  timeoutMs?: number
}

/** dida-cli 接受的时间格式：yyyy-MM-ddTHH:mm:ssZ（例：2026-03-01T00:00:00+0000） */
export function formatDidaTime(date: Date): string {
  return DateTime.fromJSDate(date).toUTC().toFormat("yyyy-MM-dd'T'HH:mm:ssZZZ")
}

export class DidaCliReader implements DidaReader {
  constructor(private readonly cmd: DidaCommand) {}

  async run<T>(args: string[]): Promise<T> {
    return withRetry(async () => {
      const res = await runProcess(this.cmd.command, [...this.cmd.baseArgs, ...args, '--json'], {
        env: this.cmd.env,
        timeoutMs: this.cmd.timeoutMs ?? 60_000
      })
      if (res.timedOut) throw new CliError('滴答清单请求超时', 'dida', 'timeout')
      if (res.code !== 0) {
        const { kind, status } = classifyDidaError(res.stderr || res.stdout)
        throw new CliError(summarizeStderr(res.stderr || res.stdout), 'dida', kind, status, res.stderr)
      }
      const text = res.stdout.trim()
      if (!text) return undefined as T
      try {
        return JSON.parse(text) as T
      } catch {
        throw new CliError(`无法解析滴答清单输出：${text.slice(0, 120)}`, 'dida', 'unknown')
      }
    })
  }

  getPreference(): Promise<DidaPreference> {
    return this.run<DidaPreference>(['preference', 'get']).then((p) => p ?? {})
  }

  listProjects(): Promise<DidaProject[]> {
    return this.run<DidaProject[]>(['project', 'list']).then((r) => r ?? [])
  }

  listGroups(): Promise<DidaGroup[]> {
    return this.run<DidaGroup[]>(['project', 'group', 'list']).then((r) => r ?? [])
  }

  listOpenTasks(projectIds?: string[]): Promise<DidaTask[]> {
    const args = ['task', 'filter', '--status', '0']
    if (projectIds && projectIds.length > 0) args.push('--projects', projectIds.join(','))
    return this.run<DidaTask[]>(args).then((r) => r ?? [])
  }

  listCompletedTasks(from: Date, to: Date, projectIds?: string[]): Promise<DidaTask[]> {
    const args = ['task', 'completed', '--start-date', formatDidaTime(from), '--end-date', formatDidaTime(to)]
    if (projectIds && projectIds.length > 0) args.push('--projects', projectIds.join(','))
    return this.run<DidaTask[]>(args).then((r) => r ?? [])
  }

  async getTask(projectId: string, taskId: string): Promise<DidaTask | null> {
    try {
      const t = await this.run<DidaTask>(['task', 'get', projectId, taskId])
      return t && t.id ? t : null
    } catch (e) {
      if (e instanceof CliError && e.kind === 'not_found') return null
      throw e
    }
  }

  async listInboxTasks(): Promise<DidaTask[] | null> {
    try {
      const data = await this.run<{ tasks?: DidaTask[] }>(['project', 'data', 'inbox'])
      return data?.tasks ?? []
    } catch (e) {
      if (e instanceof CliError && (e.kind === 'not_found' || e.kind === 'validation')) return null
      throw e
    }
  }

  listFocus(from: Date, to: Date, type: FocusKind): Promise<DidaFocus[]> {
    return this.run<DidaFocus[]>(['focus', 'list', '--from', formatDidaTime(from), '--to', formatDidaTime(to), '--type', type]).then(
      (r) => (Array.isArray(r) ? r : [])
    )
  }

  async getFocus(focusId: string, type: FocusKind): Promise<DidaFocus | null> {
    try {
      const f = await this.run<DidaFocus>(['focus', 'get', focusId, '--type', type])
      return f && f.id ? f : null
    } catch (e) {
      if (e instanceof CliError && e.kind === 'not_found') return null
      throw e
    }
  }

  /** 用一次真实读取验证登录是否有效（`dida auth status` 只检查本地是否存在 token） */
  async verifyAuth(): Promise<boolean> {
    try {
      await this.getPreference()
      return true
    } catch (e) {
      if (e instanceof CliError && e.kind === 'auth') return false
      throw e
    }
  }
}
