import type { DidaFocus, DidaGroup, DidaPreference, DidaProject, DidaTag, DidaTask } from '../types'
import type { DidaReader, FocusKind } from './dida'
import { CliError } from './exec'

/**
 * 滴答接口的容错层。
 * `project list / get / data`、`task get` 是滴答开放平台文档里的官方接口；
 * `preference`、`task filter`、`task completed`、`tag list`、`focus`、`project group list` 不在文档里，
 * 可能用不了——这里给每个接口准备替代方案或降级方式，不让一个接口拖垮整个同步。
 */
export type Endpoint = 'preference' | 'groups' | 'filter' | 'completed' | 'tags' | 'focus'

export const ENDPOINT_LABELS: Record<Endpoint, string> = {
  preference: '偏好设置（时区）',
  groups: '清单文件夹',
  filter: '未完成任务（task filter）',
  completed: '已完成任务（task completed）',
  tags: '标签列表',
  focus: '番茄钟/正计时记录'
}

export interface EndpointHealth {
  ok: boolean | null
  error: string | null
  /** 不可用时采用的方式 */
  fallback: string | null
  checkedAt: number | null
}

export const FALLBACKS: Record<Endpoint, string> = {
  preference: '使用设置里的默认时区',
  groups: '不绑定一级领域（文件夹名称读不到）',
  filter: '改用官方接口 project data，逐个清单读取',
  completed: '跳过；完成状态改由逐条确认（task get）发现',
  tags: '从任务的标签字段汇总',
  focus: '暂停番茄记录同步'
}

/** 这些错误说明是“接口本身用不了”，可以换替代方案；登录失效、网络问题照常抛出 */
function isEndpointProblem(e: unknown): e is CliError {
  return e instanceof CliError && (e.kind === 'not_found' || e.kind === 'validation' || e.kind === 'server' || e.kind === 'unknown')
}

const RETRY_MS = 60 * 60_000

export class ResilientDida implements DidaReader {
  private readonly health = new Map<Endpoint, EndpointHealth>()
  private readonly warned = new Set<Endpoint>()

  constructor(
    readonly base: DidaReader,
    private readonly opts: { now?: () => number; warn?: (endpoint: Endpoint, message: string) => void } = {}
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  /** 接口近期失败过：1 小时内直接用替代方案，不再调用 */
  private isDown(ep: Endpoint): boolean {
    const h = this.health.get(ep)
    return !!h && h.ok === false && h.checkedAt !== null && this.now() - h.checkedAt < RETRY_MS
  }

  private mark(ep: Endpoint, error: CliError | null): void {
    this.health.set(ep, { ok: !error, error: error ? error.message : null, fallback: error ? FALLBACKS[ep] : null, checkedAt: this.now() })
    if (error && !this.warned.has(ep)) {
      this.warned.add(ep)
      this.opts.warn?.(ep, `滴答接口「${ENDPOINT_LABELS[ep]}」不可用（${error.message}），${FALLBACKS[ep]}`)
    }
    if (!error) this.warned.delete(ep)
  }

  private async attempt<T>(ep: Endpoint, primary: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
    if (this.isDown(ep)) return fallback()
    try {
      const r = await primary()
      this.mark(ep, null)
      return r
    } catch (e) {
      if (!isEndpointProblem(e)) throw e
      this.mark(ep, e)
      return fallback()
    }
  }

  healthReport(): Record<Endpoint, EndpointHealth> {
    const out = {} as Record<Endpoint, EndpointHealth>
    for (const ep of Object.keys(ENDPOINT_LABELS) as Endpoint[])
      out[ep] = this.health.get(ep) ?? { ok: null, error: null, fallback: null, checkedAt: null }
    return out
  }

  getPreference(): Promise<DidaPreference> {
    return this.attempt('preference', () => this.base.getPreference(), async () => ({}))
  }

  listProjects(): Promise<DidaProject[]> {
    return this.base.listProjects()
  }

  listGroups(): Promise<DidaGroup[]> {
    return this.attempt('groups', () => this.base.listGroups(), async () => [])
  }

  getProject(projectId: string): Promise<DidaProject | null> {
    return this.base.getProject(projectId)
  }

  listOpenTasks(projectIds?: string[]): Promise<DidaTask[]> {
    return this.attempt(
      'filter',
      () => this.base.listOpenTasks(projectIds),
      async () => {
        const ids =
          projectIds && projectIds.length
            ? projectIds
            : (await this.base.listProjects()).filter((p) => !p.closed && (p.kind ?? 'TASK').toUpperCase() !== 'NOTE').map((p) => p.id)
        const out: DidaTask[] = []
        for (const id of ids) out.push(...(await this.base.listProjectTasks(id)))
        if (!projectIds?.length) out.push(...((await this.base.listInboxTasks()) ?? []))
        return out
      }
    )
  }

  listCompletedTasks(from: Date, to: Date, projectIds?: string[]): Promise<DidaTask[]> {
    return this.attempt('completed', () => this.base.listCompletedTasks(from, to, projectIds), async () => [])
  }

  getTask(projectId: string, taskId: string): Promise<DidaTask | null> {
    return this.base.getTask(projectId, taskId)
  }

  listInboxTasks(): Promise<DidaTask[] | null> {
    return this.base.listInboxTasks()
  }

  listProjectTasks(projectId: string): Promise<DidaTask[]> {
    return this.base.listProjectTasks(projectId)
  }

  listTags(): Promise<DidaTag[]> {
    return this.attempt(
      'tags',
      () => this.base.listTags(),
      async () => {
        const names = new Set<string>()
        for (const t of await this.listOpenTasks()) for (const tag of t.tags ?? []) names.add(tag)
        return [...names].map((name) => ({ name, label: name }))
      }
    )
  }

  /** 专注记录没有替代接口：不可用时抛错，让引擎跳过这一轮番茄同步（绝不能当成“记录已删除”） */
  private unavailable(): never {
    throw new CliError(`滴答接口「${ENDPOINT_LABELS.focus}」暂不可用`, 'dida', 'unknown')
  }

  async listFocus(from: Date, to: Date, type: FocusKind): Promise<DidaFocus[]> {
    if (this.isDown('focus')) this.unavailable()
    try {
      const r = await this.base.listFocus(from, to, type)
      this.mark('focus', null)
      return r
    } catch (e) {
      if (isEndpointProblem(e)) this.mark('focus', e)
      throw e
    }
  }

  async getFocus(focusId: string, type: FocusKind): Promise<DidaFocus | null> {
    if (this.isDown('focus')) this.unavailable()
    return this.base.getFocus(focusId, type)
  }
}
