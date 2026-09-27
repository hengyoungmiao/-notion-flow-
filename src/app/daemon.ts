import { stat } from 'node:fs/promises'
import { CliError } from '../core/adapters/exec'
import { Scheduler, type SchedulerSnapshot } from '../core/scheduler'
import { NeedsInitialSyncError } from '../core/sync/engine'
import { acquireLock, isPausedFlag, releaseLock, setPausedFlag, takeRequests, writeStatus } from './control'
import type { HomePaths } from './paths'
import { APP_VERSION } from './runtime'
import type { FlowSyncService } from './service'

export interface DaemonOptions {
  /** 跑完这么多轮后自动退出（冒烟测试用） */
  rounds?: number
  /** 检查请求文件、配置变化的间隔 */
  controlIntervalMs?: number
}

/** 常驻同步服务：自适应轮询，处理命令行发来的请求，配置文件变化后自动生效 */
export class Daemon {
  readonly scheduler: Scheduler
  private timer: ReturnType<typeof setInterval> | null = null
  private configMtime = 0
  private roundsDone = 0
  private stopping: Promise<void> | null = null
  private finished!: () => void
  readonly done = new Promise<void>((resolve) => (this.finished = resolve))
  private readonly startedAt = new Date().toISOString()
  private lastError = ''
  private lastBlocked = ''
  private busy = false

  constructor(
    private readonly service: FlowSyncService,
    private readonly paths: HomePaths,
    private readonly opts: DaemonOptions = {}
  ) {
    this.scheduler = new Scheduler({
      engine: () => service.activeEngine(),
      workspaceId: () => service.config.get().activeWorkspaceId,
      settings: () => service.config.get().settings,
      onChange: (s) => this.onChange(s),
      onError: (e) => this.onError(e),
      afterRound: () => {
        this.roundsDone++
        if (this.opts.rounds && this.roundsDone >= this.opts.rounds) void this.stop()
      }
    })
  }

  async start(): Promise<void> {
    const owner = await acquireLock(this.paths)
    if (owner !== null) throw new Error(`FlowSync 后台服务已经在运行（进程 ${owner}）`)
    this.configMtime = await this.mtime()
    const ws = this.service.active()
    this.service.log({ kind: 'info', title: `FlowSync ${APP_VERSION} 后台服务启动${ws ? `，工作空间「${ws.name}」` : ''}` })
    if (await isPausedFlag(this.paths)) {
      this.scheduler.start()
      this.scheduler.pause()
      this.service.log({ kind: 'info', title: '同步处于暂停状态（运行 flowsync resume 继续）' })
    } else this.scheduler.start()
    this.timer = setInterval(() => void this.tick(), this.opts.controlIntervalMs ?? 2000)
    await this.saveStatus(this.scheduler.snapshot())
  }

  /** 停止：等当前这一轮结束再退出 */
  stop(): Promise<void> {
    this.stopping ??= (async () => {
      if (this.timer) clearInterval(this.timer)
      this.timer = null
      this.scheduler.stop()
      await this.scheduler.waitIdle()
      await this.saveStatus({ ...this.scheduler.snapshot(), nextRunAt: null })
      await releaseLock(this.paths)
      this.service.log({ kind: 'info', title: 'FlowSync 后台服务已停止' })
      this.finished()
    })()
    return this.stopping
  }

  private async mtime(): Promise<number> {
    try {
      return (await stat(this.service.config.path)).mtimeMs
    } catch {
      return 0
    }
  }

  private async tick(): Promise<void> {
    if (this.busy || this.stopping) return
    this.busy = true
    try {
      const m = await this.mtime()
      let reload = m !== this.configMtime
      const requests = await takeRequests(this.paths)
      if (requests.includes('reload')) reload = true
      if (reload) {
        this.configMtime = m
        await this.service.reloadConfig()
        void this.scheduler.reset()
      }
      for (const r of requests) {
        if (r === 'pause') {
          await setPausedFlag(this.paths, true)
          this.scheduler.pause()
          this.service.log({ kind: 'info', title: '已暂停自动同步' })
        } else if (r === 'resume') {
          await setPausedFlag(this.paths, false)
          this.scheduler.resume()
          this.service.log({ kind: 'info', title: '已继续自动同步' })
        } else if (r === 'approve') {
          void this.scheduler.approvePending()
        } else if (r === 'sync') {
          // 重新登录后：从“需要重新登录”的暂停里恢复
          if (this.scheduler.snapshot().status === 'auth' || (this.scheduler.isPaused && !(await isPausedFlag(this.paths))))
            this.scheduler.resume()
          else void this.scheduler.syncNow({ forceStructure: true, forceReconcile: true })
        }
      }
    } catch (e) {
      this.service.log({ kind: 'error', title: '处理控制请求失败', detail: e instanceof Error ? e.message : String(e) })
    } finally {
      this.busy = false
    }
  }

  private onChange(s: SchedulerSnapshot): void {
    if (s.status === 'blocked' && s.pending && s.pending.createdAt !== this.lastBlocked) {
      this.lastBlocked = s.pending.createdAt
      this.service.log({ kind: 'warning', title: `检测到大批量变更，已暂停等待确认：${s.pending.reason}`, detail: '运行 flowsync status 查看明细，flowsync approve 确认执行' })
    }
    if (s.status === 'idle') this.lastError = ''
    void this.saveStatus(s)
  }

  private onError(e: unknown): void {
    if (e instanceof NeedsInitialSyncError) {
      this.service.log({ kind: 'warning', title: '当前工作空间还没有完成首次同步，请运行 flowsync setup' })
      return
    }
    const msg = e instanceof Error ? e.message : String(e)
    if (msg === this.lastError) return
    this.lastError = msg
    if (e instanceof CliError && e.kind === 'auth') {
      const tool = e.tool === 'dida' ? '滴答清单' : 'Notion'
      const fix = e.tool === 'dida' ? 'flowsync login dida' : 'flowsync login notion'
      this.service.log({ kind: 'error', title: `${tool}登录已失效，自动同步已暂停`, detail: `运行 ${fix} 重新登录后会自动继续` })
      return
    }
    const tool = e instanceof CliError ? (e.tool === 'dida' ? '（滴答清单）' : '（Notion）') : ''
    this.service.log({ kind: 'error', title: `同步出错${tool}，稍后自动重试`, detail: msg })
  }

  private statusChain: Promise<void> = Promise.resolve()

  /** 状态写入排队进行，保证文件里总是最新、完整的一份 */
  private saveStatus(s: SchedulerSnapshot): Promise<void> {
    this.statusChain = this.statusChain.then(() => this.writeStatusNow(s))
    return this.statusChain
  }

  private async writeStatusNow(s: SchedulerSnapshot): Promise<void> {
    try {
      await writeStatus(this.paths, {
        pid: process.pid,
        version: APP_VERSION,
        startedAt: this.startedAt,
        updatedAt: new Date().toISOString(),
        workspace: this.service.active()?.name ?? null,
        scheduler: s,
        dida: this.service.dida.healthReport()
      })
    } catch {
      /* 状态文件写不了不影响同步 */
    }
  }
}
