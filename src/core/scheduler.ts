import { CliError } from './adapters/exec'
import { NeedsInitialSyncError, type RoundOptions, type RoundResult, type SyncEngine } from './sync/engine'
import type { AppSettings, PendingApproval } from './types'

export type SyncStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'error'
  | 'auth'
  | 'blocked'
  | 'needs_setup'
  | 'needs_initial'

export interface TodayStats {
  date: string
  created: number
  updated: number
  corrected: number
  removed: number
}

export interface SchedulerSnapshot {
  status: SyncStatus
  workspaceId: string | null
  lastRunAt: string | null
  lastSuccessAt: string | null
  nextRunAt: string | null
  intervalSec: number
  lastError: { message: string; kind: string; tool?: string } | null
  pending: PendingApproval | null
  warnings: string[]
  today: TodayStats
}

export interface SchedulerDeps {
  /** 当前活动工作空间的引擎；未配置时返回 null */
  engine: () => SyncEngine | null
  workspaceId: () => string | null
  settings: () => AppSettings
  onChange?: (s: SchedulerSnapshot) => void
  onError?: (e: unknown) => void
  /** 每一轮结束后（成功或失败）调用 */
  afterRound?: (result: RoundResult | null) => void
  now?: () => Date
}

function localDay(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 自适应轮询：有变化时用最短间隔，空闲时逐步放宽到最长间隔；出错指数退避；认证失效暂停 */
export class Scheduler {
  private timer: ReturnType<typeof setTimeout> | null = null
  private running: Promise<RoundResult | null> | null = null
  private started = false
  private paused = false
  private backoffSec = 0
  private queued: RoundOptions | null = null
  private snap: SchedulerSnapshot
  private readonly now: () => Date

  constructor(private readonly deps: SchedulerDeps) {
    this.now = deps.now ?? (() => new Date())
    this.snap = {
      status: 'idle',
      workspaceId: deps.workspaceId(),
      lastRunAt: null,
      lastSuccessAt: null,
      nextRunAt: null,
      intervalSec: deps.settings().pollMinSec,
      lastError: null,
      pending: null,
      warnings: [],
      today: { date: localDay(this.now()), created: 0, updated: 0, corrected: 0, removed: 0 }
    }
  }

  snapshot(): SchedulerSnapshot {
    return structuredClone(this.snap)
  }

  private set(patch: Partial<SchedulerSnapshot>): void {
    this.snap = { ...this.snap, ...patch }
    this.deps.onChange?.(this.snapshot())
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.schedule(0)
  }

  stop(): void {
    this.started = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  pause(): void {
    this.paused = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.set({ status: 'paused', nextRunAt: null })
  }

  resume(): void {
    this.paused = false
    this.backoffSec = 0
    this.set({ status: 'idle' })
    this.schedule(0)
  }

  get isPaused(): boolean {
    return this.paused
  }

  /** 工作空间或设置变化后：等当前轮结束，再立即跑一轮 */
  async reset(): Promise<void> {
    await this.running
    this.backoffSec = 0
    this.set({ workspaceId: this.deps.workspaceId(), pending: null, lastError: null, warnings: [] })
    if (!this.paused) this.schedule(0)
  }

  /** 立即同步（界面按钮、睡眠唤醒、网络恢复） */
  async syncNow(opts: RoundOptions = {}): Promise<RoundResult | null> {
    return this.tick(opts)
  }

  /** 等当前这一轮结束（没有在跑时立即返回） */
  async waitIdle(): Promise<void> {
    await this.running?.catch(() => null)
  }

  /** 记录在调度器之外执行的一轮（例如首次同步），计入今日统计 */
  record(result: RoundResult): void {
    this.bumpToday(result)
    this.set({ lastSuccessAt: this.now().toISOString() })
  }

  async approvePending(): Promise<RoundResult | null> {
    return this.syncNow({ approve: true, forceReconcile: true })
  }

  private schedule(delaySec: number): void {
    if (!this.started || this.paused) return
    if (this.timer) clearTimeout(this.timer)
    const at = new Date(this.now().getTime() + delaySec * 1000)
    this.set({ nextRunAt: at.toISOString() })
    this.timer = setTimeout(() => void this.tick({}), delaySec * 1000)
  }

  private bumpToday(result: RoundResult): void {
    const day = localDay(this.now())
    const t = this.snap.today.date === day ? { ...this.snap.today } : { date: day, created: 0, updated: 0, corrected: 0, removed: 0 }
    if (result.applied) {
      // 只统计实际执行的操作（熔断时被暂缓的修改不计入）
      const c = result.appliedCounts ?? result.summary.counts
      t.created += c.creates
      t.updated += c.updates
      t.corrected += c.corrections
      t.removed += c.destructive
    }
    this.snap.today = t
  }

  private async tick(opts: RoundOptions): Promise<RoundResult | null> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    // 同一时间只跑一轮：正在跑时把参数合并进队列，这一轮结束后立即再跑
    if (this.running) {
      this.queued = { ...(this.queued ?? {}), ...opts }
      return this.running
    }
    const settings = this.deps.settings()
    const engine = this.deps.engine()
    if (!engine) {
      this.set({ status: 'needs_setup', nextRunAt: null })
      return null
    }
    this.set({ status: 'running', lastRunAt: this.now().toISOString() })
    const run = (async (): Promise<RoundResult | null> => {
      try {
        const result = await engine.runRound(opts)
        this.backoffSec = 0
        this.bumpToday(result)
        const interval =
          result.writes > 0 ? settings.pollMinSec : Math.min(settings.pollMaxSec, Math.round(this.snap.intervalSec * 1.5))
        this.set({
          // 这一轮进行中被暂停：保持“已暂停”，不要显示成正常
          status: this.paused ? 'paused' : result.blocked ? 'blocked' : 'idle',
          lastSuccessAt: this.now().toISOString(),
          lastError: null,
          pending: result.blocked,
          warnings: result.summary.warnings,
          intervalSec: Math.max(settings.pollMinSec, interval)
        })
        this.schedule(this.snap.intervalSec)
        return result
      } catch (e) {
        this.deps.onError?.(e)
        if (e instanceof NeedsInitialSyncError) {
          this.set({ status: 'needs_initial', nextRunAt: null, lastError: null })
          return null
        }
        const err = e instanceof CliError ? { message: e.message, kind: e.kind, tool: e.tool } : { message: String((e as Error)?.message ?? e), kind: 'unknown' }
        if (e instanceof CliError && e.kind === 'auth') {
          // 认证失效：暂停自动同步，等待重新登录
          this.set({ status: 'auth', lastError: err, nextRunAt: null })
          return null
        }
        this.backoffSec = Math.min(900, this.backoffSec ? this.backoffSec * 2 : Math.max(30, settings.pollMaxSec))
        this.set({ status: this.paused ? 'paused' : 'error', lastError: err })
        this.schedule(this.backoffSec)
        return null
      }
    })()
    this.running = run
    let outcome: RoundResult | null = null
    try {
      outcome = await run
      return outcome
    } finally {
      this.running = null
      this.deps.afterRound?.(outcome)
      if (this.queued) {
        const next = this.queued
        this.queued = null
        if (!this.paused || next.approve || next.forceReconcile || next.forceStructure) void this.tick(next)
      }
    }
  }
}
