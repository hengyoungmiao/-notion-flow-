import { appendFile, mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ActivityLog, type ActivityEntry } from '../core/activity'
import { DidaCliReader, type DidaReader } from '../core/adapters/dida'
import { CliError, redact } from '../core/adapters/exec'
import { FakeDida, FakeNotion } from '../core/adapters/fake'
import { NtnNotionClient, type NotionClient } from '../core/adapters/notion'
import { writeBackup } from '../core/backup'
import { ConfigStore, newWorkspace } from '../core/config'
import { collectDiagnostics } from '../core/diagnostics'
import { createDemoDida, createDemoNotion } from '../core/demo'
import {
  bindFlowSchema,
  ensureDidaIdProperty,
  findTaskCandidates,
  resolveTaskDataSource,
  upgradeSchema,
  validateSchema
} from '../core/notion/discovery'
import { Scheduler, type SchedulerSnapshot } from '../core/scheduler'
import { SyncEngine } from '../core/sync/engine'
import { FileStateStore, writeJsonAtomic } from '../core/sync/state'
import type { AppSettings, DomainMapping, WorkspaceProfile } from '../core/types'
import type { ActionResult, AppViewState, FlowSyncApi, WorkspaceView } from '../shared/ipc'
import { DidaAuth, NotionLogin } from './auth'

export interface PlatformHooks {
  appVersion: string
  electronVersion: string
  platform: string
  demo: boolean
  ntnPath: () => string
  didaCommand: (timeoutMs?: number) => import("../core/adapters/dida").DidaCommand
  toolVersions: () => Promise<{ ntn: string | null; dida: string | null }>
  encrypt: (plain: string) => string
  decrypt: (enc: string) => string
  openExternal: (url: string) => Promise<void>
  openPath: (path: string) => Promise<void>
  setLaunchAtLogin: (enabled: boolean, hidden: boolean) => void
  notify: (title: string, body: string) => void
  emit: (event: 'state' | 'activity', payload: unknown) => void
}

const ok = <T>(data?: T): ActionResult<T> => ({ ok: true, data })

function fail(e: unknown): ActionResult<never> {
  const message = e instanceof Error ? e.message : String(e)
  return { ok: false, error: redact(message) }
}

async function guard<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return ok(await fn())
  } catch (e) {
    return fail(e)
  }
}

/** 主进程服务：配置、状态、调度器、IPC 方法实现 */
export class AppController implements FlowSyncApi {
  readonly config: ConfigStore
  readonly activity = new ActivityLog()
  readonly scheduler: Scheduler
  private readonly store: FileStateStore
  private readonly notionLogin: NotionLogin
  private readonly didaAuth: DidaAuth
  private readonly clients = new Map<string, NotionClient>()
  private readonly notionAuth = new Map<string, boolean>()
  private engineCache: { key: string; engine: SyncEngine } | null = null
  private didaReader: DidaReader
  private didaState: AppViewState['dida'] = { loggedIn: null, checking: false, error: null }
  private versions: AppViewState['versions']
  private lastNotified = ''
  // 演示模式
  private demoDida: FakeDida | null = null
  private demoNotion = new Map<string, FakeNotion>()
  private demoDidaLoggedIn = false

  constructor(
    rootDir: string,
    private readonly hooks: PlatformHooks
  ) {
    this.config = new ConfigStore(rootDir)
    this.store = new FileStateStore(this.config.stateDir)
    this.store.onRecovered = () =>
      this.activity.push({
        kind: 'warning',
        title: '同步记录文件损坏，已备份并重建',
        detail: '下一轮会按「滴答ID」把已有的 Notion 页面重新关联，不会重复创建'
      })
    this.notionLogin = new NotionLogin(hooks.ntnPath)
    this.didaAuth = new DidaAuth(() => hooks.didaCommand())
    this.versions = { app: hooks.appVersion, ntn: null, dida: null, electron: hooks.electronVersion }
    if (hooks.demo) {
      this.demoDida = createDemoDida()
      this.didaReader = this.demoDida
    } else {
      this.didaReader = new DidaCliReader(hooks.didaCommand(60_000))
    }
    this.scheduler = new Scheduler({
      engine: () => this.activeEngine(),
      workspaceId: () => this.config.get().activeWorkspaceId,
      settings: () => this.config.get().settings,
      onChange: (s) => this.onScheduler(s),
      onError: (e) => this.onSyncError(e)
    })
    this.activity.onEntry((e) => {
      hooks.emit('activity', e)
      void this.appendLog(e)
    })
    this.config.onChange(() => {
      this.engineCache = null
      this.pushState()
    })
  }

  async init(): Promise<void> {
    await this.config.load()
    await mkdir(this.config.logDir, { recursive: true })
    void this.pruneLogs()
    this.versions = { ...this.versions, ...(await this.hooks.toolVersions()) }
    const c = this.config.get()
    this.hooks.setLaunchAtLogin(c.settings.launchAtLogin, c.settings.startMinimized)
    void this.didaCheck()
    await this.upgradeSchemas()
    if (this.config.recovered)
      this.activity.push({
        kind: 'warning',
        title: this.config.recovered === 'backup' ? '配置文件损坏，已从最近一次保存的备份恢复' : '配置文件损坏且没有备份，已改用默认配置',
        detail: '损坏的文件已改名保留在数据目录'
      })
    if (c.onboarded) this.scheduler.start()
  }

  /** 旧版本识别的工作空间补充识别番茄库（失败不影响任务同步） */
  private async upgradeSchemas(): Promise<void> {
    for (const ws of this.config.get().workspaces) {
      if (!ws.schema) continue
      try {
        const schema = await upgradeSchema(this.clientFor(ws), ws.schema)
        if (schema === ws.schema) continue
        await this.config.upsertWorkspace({ ...this.workspace(ws.id), schema })
      } catch {
        /* 下次启动再试 */
      }
    }
  }

  // ───────────────────────── 内部工具 ─────────────────────────

  private workspace(id: string): WorkspaceProfile {
    const ws = this.config.get().workspaces.find((w) => w.id === id)
    if (!ws) throw new Error('工作空间不存在')
    return ws
  }

  private clientFor(ws: WorkspaceProfile): NotionClient {
    if (this.hooks.demo) {
      let n = this.demoNotion.get(ws.id)
      if (!n) {
        n = createDemoNotion(`${ws.name}（演示）`, this.demoNotion.size === 0)
        this.demoNotion.set(ws.id, n)
      }
      return n
    }
    const key = `${ws.id}:${ws.auth.type}:${ws.auth.type === 'token' ? ws.auth.tokenEnc.slice(0, 12) : ''}`
    let client = this.clients.get(key)
    if (!client) {
      client = new NtnNotionClient({
        command: this.hooks.ntnPath(),
        notionHome: this.config.notionHome(ws.id),
        token: ws.auth.type === 'token' ? this.hooks.decrypt(ws.auth.tokenEnc) : undefined
      })
      this.clients.set(key, client)
    }
    return client
  }

  private engineFor(ws: WorkspaceProfile): SyncEngine {
    const settings = this.config.get().settings
    return new SyncEngine({
      dida: this.didaReader,
      notion: this.clientFor(ws),
      store: this.store,
      profile: ws,
      settings,
      log: (e) => this.activity.push(e),
      onSchemaChange: (schema) => {
        const current = this.config.get().workspaces.find((w) => w.id === ws.id)
        if (current) void this.config.upsertWorkspace({ ...current, schema }).catch(() => undefined)
      },
      backup: (data) => writeBackup(this.config.backupDir, ws.name, data)
    })
  }

  private activeEngine(): SyncEngine | null {
    const ws = this.config.active()
    if (!ws?.schema?.tasks.props.didaId) return null
    const key = JSON.stringify([ws, this.config.get().settings])
    if (this.engineCache?.key === key) return this.engineCache.engine
    const engine = this.engineFor(ws)
    this.engineCache = { key, engine }
    return engine
  }

  private onScheduler(s: SchedulerSnapshot): void {
    this.pushState()
    if (s.status === 'auth' && s.lastError) {
      const who = s.lastError.tool === 'dida' ? '滴答清单' : 'Notion'
      this.notifyOnce(`auth:${who}`, 'FlowSync 需要重新登录', `${who}登录已失效，同步已暂停。请打开 FlowSync 重新登录。`)
      if (s.lastError.tool === 'dida') this.didaState = { loggedIn: false, checking: false, error: s.lastError.message }
      else if (s.workspaceId) this.notionAuth.set(s.workspaceId, false)
    } else if (s.status === 'blocked' && s.pending) {
      this.notifyOnce(`blocked:${s.pending.createdAt}`, 'FlowSync 检测到大批量变更', `${s.pending.reason}。请打开 FlowSync 确认后继续。`)
    } else if (s.status === 'idle') {
      this.lastNotified = ''
      if (s.workspaceId) this.notionAuth.set(s.workspaceId, true)
      if (this.didaState.loggedIn !== true) this.didaState = { loggedIn: true, checking: false, error: null }
    }
  }

  private notifyOnce(key: string, title: string, body: string): void {
    if (this.lastNotified === key) return
    this.lastNotified = key
    this.hooks.notify(title, body)
  }

  private lastErrorMsg = ''
  private onSyncError(e: unknown): void {
    const msg = e instanceof Error ? e.message : String(e)
    if (e instanceof Error && e.name === 'NeedsInitialSyncError') return
    if (msg === this.lastErrorMsg) return
    this.lastErrorMsg = msg
    const tool = e instanceof CliError ? (e.tool === 'dida' ? '滴答清单' : 'Notion') : ''
    this.activity.push({ kind: 'error', title: `同步出错${tool ? `（${tool}）` : ''}`, detail: redact(msg) })
  }

  private async appendLog(e: ActivityEntry): Promise<void> {
    try {
      const file = join(this.config.logDir, `activity-${e.at.slice(0, 10)}.log`)
      await appendFile(file, `${JSON.stringify(e)}\n`, 'utf8')
    } catch {
      /* 日志失败不影响同步 */
    }
  }

  private async pruneLogs(): Promise<void> {
    try {
      const files = (await readdir(this.config.logDir)).filter((f) => f.startsWith('activity-')).sort()
      for (const f of files.slice(0, Math.max(0, files.length - 14))) await rm(join(this.config.logDir, f), { force: true })
    } catch {
      /* ignore */
    }
  }

  private pushState(): void {
    void this.getState().then((s) => this.hooks.emit('state', s))
  }

  private async workspaceView(ws: WorkspaceProfile): Promise<WorkspaceView> {
    const state = await this.store.load(ws.id)
    return {
      id: ws.id,
      name: ws.name,
      notionWorkspaceName: ws.notionWorkspaceName,
      notionUserName: ws.notionUserName,
      authType: ws.auth.type,
      loggedIn: this.notionAuth.get(ws.id) ?? !!ws.notionWorkspaceName,
      schema: ws.schema
        ? { tasks: ws.schema.tasks.title, domains: ws.schema.domains?.title ?? null, areas: ws.schema.areas?.title ?? null }
        : null,
      ready: !!ws.schema?.tasks.props.didaId,
      initialized: !!state.initializedAt,
      linkedCount: Object.keys(state.tasks).length,
      lastSuccessAt: state.lastSuccessAt,
      scope: ws.scope,
      removedCount: Object.keys(state.notionRemoved).length
    }
  }

  private async afterWorkspaceChange(): Promise<void> {
    this.engineCache = null
    await this.scheduler.reset()
  }

  // ───────────────────────── IPC：状态 ─────────────────────────

  async getState(): Promise<AppViewState> {
    const c = this.config.get()
    return {
      demo: this.hooks.demo,
      onboarded: c.onboarded,
      settings: c.settings,
      workspaces: await Promise.all(c.workspaces.map((w) => this.workspaceView(w))),
      activeWorkspaceId: c.activeWorkspaceId,
      scheduler: this.scheduler.snapshot(),
      dida: this.didaState,
      versions: this.versions,
      platform: this.hooks.platform
    }
  }

  async checkEnvironment(): Promise<AppViewState['versions']> {
    if (this.hooks.demo) this.versions = { ...this.versions, ntn: '0.23.10（演示）', dida: '0.1.14（演示）' }
    else this.versions = { ...this.versions, ...(await this.hooks.toolVersions()) }
    this.pushState()
    return this.versions
  }

  // ───────────────────────── IPC：滴答 ─────────────────────────

  async didaLoginBrowser(): Promise<ActionResult> {
    return guard(async () => {
      if (this.hooks.demo) {
        await new Promise((r) => setTimeout(r, 1200))
        this.demoDidaLoggedIn = true
      } else await this.didaAuth.loginBrowser()
      await this.didaCheck()
      if (!this.didaState.loggedIn) throw new Error('授权完成但验证失败，请重试或改用 API 口令')
      if (this.scheduler.snapshot().status === 'auth') this.scheduler.resume()
    })
  }

  async didaCancelLogin(): Promise<void> {
    this.didaAuth.cancel()
  }

  async didaSaveToken(token: string): Promise<ActionResult> {
    return guard(async () => {
      if (!token || token.trim().length < 10) throw new Error('口令格式不正确')
      if (this.hooks.demo) this.demoDidaLoggedIn = true
      else await this.didaAuth.saveToken(token)
      await this.didaCheck()
      if (!this.didaState.loggedIn) throw new Error('口令无效，请检查后重试')
      if (this.scheduler.snapshot().status === 'auth') this.scheduler.resume()
    })
  }

  async didaCheck(): Promise<ActionResult<boolean>> {
    this.didaState = { ...this.didaState, checking: true }
    this.pushState()
    try {
      let loggedIn: boolean
      if (this.hooks.demo) loggedIn = this.demoDidaLoggedIn || this.config.get().onboarded
      else loggedIn = await (this.didaReader as DidaCliReader).verifyAuth()
      this.didaState = { loggedIn, checking: false, error: null }
      return ok(loggedIn)
    } catch (e) {
      this.didaState = { loggedIn: null, checking: false, error: fail(e).error ?? null }
      return fail(e)
    } finally {
      this.pushState()
    }
  }

  async didaLogout(): Promise<ActionResult> {
    return guard(async () => {
      if (this.hooks.demo) this.demoDidaLoggedIn = false
      else await this.didaAuth.logout()
      this.didaState = { loggedIn: false, checking: false, error: null }
      this.scheduler.pause()
      this.pushState()
    })
  }

  // ───────────────────────── IPC：工作空间 ─────────────────────────

  async createWorkspace(name: string): Promise<ActionResult<string>> {
    return guard(async () => {
      const ws = newWorkspace(name.trim() || '我的工作空间')
      await this.config.update((c) => {
        c.workspaces.push(ws)
        if (!c.activeWorkspaceId) c.activeWorkspaceId = ws.id
      })
      if (!this.hooks.demo) await mkdir(this.config.notionHome(ws.id), { recursive: true })
      return ws.id
    })
  }

  async renameWorkspace(id: string, name: string): Promise<ActionResult> {
    return guard(async () => {
      const ws = this.workspace(id)
      await this.config.upsertWorkspace({ ...ws, name: name.trim() || ws.name })
    })
  }

  async removeWorkspace(id: string): Promise<ActionResult> {
    return guard(async () => {
      this.notionLogin.cancel(id)
      await this.config.update((c) => {
        c.workspaces = c.workspaces.filter((w) => w.id !== id)
        if (c.activeWorkspaceId === id) c.activeWorkspaceId = c.workspaces[0]?.id ?? null
      })
      await this.store.remove(id)
      if (!this.hooks.demo) await rm(this.config.notionHome(id), { recursive: true, force: true })
      this.demoNotion.delete(id)
      await this.afterWorkspaceChange()
    })
  }

  async setActiveWorkspace(id: string): Promise<ActionResult> {
    return guard(async () => {
      this.workspace(id)
      await this.config.update((c) => {
        c.activeWorkspaceId = id
      })
      this.activity.push({ kind: 'info', title: `已切换到工作空间「${this.workspace(id).name}」` })
      await this.afterWorkspaceChange()
    })
  }

  async notionLoginStart(id: string) {
    return guard(async () => {
      this.workspace(id)
      if (this.hooks.demo) return { url: 'https://www.notion.so/demo-login', code: 'DEMO-123' }
      return this.notionLogin.start(id, this.config.notionHome(id))
    })
  }

  async notionLoginPoll(id: string): Promise<ActionResult> {
    return guard(async () => {
      const ws = this.workspace(id)
      if (this.hooks.demo) await new Promise((r) => setTimeout(r, 1500))
      else await this.notionLogin.poll(id, this.config.notionHome(id))
      await this.config.upsertWorkspace({ ...ws, auth: { type: 'ntn' } })
      await this.refreshWhoami(id)
      this.resumeAfterNotionLogin(id)
    })
  }

  /** Notion 登录失效导致的暂停：重新登录后自动恢复同步（和滴答一致） */
  private resumeAfterNotionLogin(id: string): void {
    const s = this.scheduler.snapshot()
    if (s.status === 'auth' && s.lastError?.tool === 'ntn' && id === this.config.get().activeWorkspaceId) this.scheduler.resume()
  }

  async notionLoginCancel(id: string): Promise<void> {
    this.notionLogin.cancel(id)
  }

  async notionUseToken(id: string, token: string): Promise<ActionResult> {
    return guard(async () => {
      const ws = this.workspace(id)
      if (!token.trim()) throw new Error('请输入集成 token')
      await this.config.upsertWorkspace({ ...ws, auth: { type: 'token', tokenEnc: this.hooks.encrypt(token.trim()) } })
      await this.refreshWhoami(id)
      this.resumeAfterNotionLogin(id)
    })
  }

  private async refreshWhoami(id: string): Promise<void> {
    const ws = this.workspace(id)
    const me = await this.clientFor(ws).whoami()
    const duplicate = this.config
      .get()
      .workspaces.find((w) => w.id !== id && me.workspaceName && w.notionWorkspaceName === me.workspaceName)
    if (duplicate) throw new Error(`该 Notion 空间已作为「${duplicate.name}」添加过了`)
    this.notionAuth.set(id, true)
    await this.config.upsertWorkspace({ ...this.workspace(id), notionWorkspaceName: me.workspaceName, notionUserName: me.name })
  }

  async findTaskDatabases(id: string) {
    return guard(async () => findTaskCandidates(this.clientFor(this.workspace(id))))
  }

  async bindTaskDatabase(id: string, dataSourceIdOrLink: string) {
    return guard(async () => {
      const ws = this.workspace(id)
      const client = this.clientFor(ws)
      const dsId = /^[0-9a-f-]{32,36}$/i.test(dataSourceIdOrLink) || dataSourceIdOrLink.startsWith('ds-')
        ? dataSourceIdOrLink
        : await resolveTaskDataSource(client, dataSourceIdOrLink)
      const res = await bindFlowSchema(client, dsId)
      if (res.schema) await this.config.upsertWorkspace({ ...this.workspace(id), schema: res.schema })
      return {
        ok: !!res.schema,
        issues: res.issues,
        needsDidaIdProperty: res.needsDidaIdProperty,
        schema: res.schema
          ? { tasks: res.schema.tasks.title, domains: res.schema.domains?.title ?? null, areas: res.schema.areas?.title ?? null }
          : null
      }
    })
  }

  async ensureDidaIdProperty(id: string): Promise<ActionResult> {
    return guard(async () => {
      const ws = this.workspace(id)
      if (!ws.schema) throw new Error('请先识别 FLO.W 任务库')
      const schema = await ensureDidaIdProperty(this.clientFor(ws), ws.schema)
      await this.config.upsertWorkspace({ ...this.workspace(id), schema })
    })
  }

  async updateScope(id: string, scope: Partial<WorkspaceView['scope']>): Promise<ActionResult> {
    return guard(async () => {
      const ws = this.workspace(id)
      await this.config.upsertWorkspace({ ...ws, scope: { ...ws.scope, ...scope } })
    })
  }

  // ───────────────────────── IPC：领域映射 ─────────────────────────

  async getMapping(id: string) {
    return guard(async () => {
      const ws = this.workspace(id)
      if (!ws.schema?.tasks.props.didaId) throw new Error('请先完成 FLO.W 数据库识别')
      return this.engineFor(ws).inspectStructure(true)
    })
  }

  private async setMapping(id: string, kind: 'lists' | 'groups', key: string, mapping: DomainMapping): Promise<void> {
    const ws = this.workspace(id)
    const mappings = { ...ws.mappings, [kind]: { ...ws.mappings[kind], [key]: mapping } }
    let scope = ws.scope
    if (kind === 'lists') {
      const excluded = new Set(ws.scope.excludedLists)
      if (mapping.mode === 'skip') excluded.add(key)
      else excluded.delete(key)
      scope = { ...ws.scope, excludedLists: [...excluded] }
    }
    await this.config.upsertWorkspace({ ...ws, mappings, scope })
  }

  async setListMapping(id: string, projectId: string, mapping: DomainMapping): Promise<ActionResult> {
    return guard(() => this.setMapping(id, 'lists', projectId, mapping))
  }

  async setGroupMapping(id: string, groupId: string, mapping: DomainMapping): Promise<ActionResult> {
    return guard(() => this.setMapping(id, 'groups', groupId, mapping))
  }

  // ───────────────────────── IPC：同步 ─────────────────────────

  async previewInitialSync(id: string) {
    return guard(async () => {
      const ws = this.workspace(id)
      if (!ws.schema?.tasks.props.didaId) throw new Error('请先完成 FLO.W 数据库识别')
      const issues = (await validateSchema(this.clientFor(ws), ws.schema)).filter((i) => i.level === 'error')
      if (issues.length) throw new Error(issues.map((i) => i.message).join('；'))
      const res = await this.engineFor(ws).runRound({ initial: true, dryRun: true, forceStructure: true })
      return res.summary
    })
  }

  async startInitialSync(id: string) {
    return guard(async () => {
      const ws = this.workspace(id)
      const wasPaused = this.scheduler.isPaused
      this.scheduler.pause()
      // 等正在进行的一轮结束，避免和首次同步同时写入
      await this.scheduler.waitIdle()
      try {
        const res = await this.engineFor(ws).runRound({ initial: true, forceStructure: true })
        this.scheduler.record(res)
        this.activity.push({
          kind: 'info',
          title: `首次同步完成：新建 ${res.summary.counts.creates} 个、关联 ${res.summary.matches.length} 个任务${res.summary.focus.creates ? `，导入 ${res.summary.focus.creates} 条番茄记录` : ''}`,
          detail: res.backupPath ? `备份：${res.backupPath}` : undefined
        })
        await this.config.update((c) => {
          c.activeWorkspaceId = id
        })
        return { backupPath: res.backupPath, summary: res.summary }
      } finally {
        this.engineCache = null
        if (!wasPaused) this.scheduler.resume()
        this.scheduler.start()
      }
    })
  }

  async syncNow(): Promise<ActionResult> {
    return guard(async () => {
      if (this.scheduler.isPaused) this.scheduler.resume()
      await this.scheduler.syncNow({ forceStructure: true, forceReconcile: true })
      const s = this.scheduler.snapshot()
      if (s.status === 'error' || s.status === 'auth') throw new Error(s.lastError?.message ?? '同步失败')
    })
  }

  async pause(): Promise<void> {
    this.scheduler.pause()
    this.activity.push({ kind: 'info', title: '已暂停自动同步' })
  }

  async resume(): Promise<void> {
    this.scheduler.resume()
    this.activity.push({ kind: 'info', title: '已继续自动同步' })
  }

  async approvePending(): Promise<ActionResult> {
    return guard(async () => {
      await this.scheduler.approvePending()
    })
  }

  async getActivity(limit = 500): Promise<ActivityEntry[]> {
    return this.activity.list(limit)
  }

  async getRemoved(id: string) {
    const state = await this.store.load(id)
    return Object.entries(state.notionRemoved).map(([didaId, v]) => ({ didaId, ...v }))
  }

  async restoreRemoved(id: string, didaId: string): Promise<ActionResult> {
    return guard(async () => {
      await this.engineFor(this.workspace(id)).restore(didaId)
      if (id === this.config.get().activeWorkspaceId) await this.scheduler.syncNow({ forceReconcile: true })
      this.pushState()
    })
  }

  // ───────────────────────── IPC：设置与工具 ─────────────────────────

  async updateSettings(patch: Partial<AppSettings>): Promise<ActionResult> {
    return guard(async () => {
      const next = await this.config.update((c) => {
        c.settings = { ...c.settings, ...patch, breaker: { ...c.settings.breaker, ...(patch.breaker ?? {}) } }
      })
      this.hooks.setLaunchAtLogin(next.settings.launchAtLogin, next.settings.startMinimized)
      this.engineCache = null
    })
  }

  async finishOnboarding(): Promise<void> {
    await this.config.update((c) => {
      c.onboarded = true
    })
    this.scheduler.start()
  }

  async exportDiagnostics(): Promise<ActionResult<string>> {
    return guard(async () => {
      const report = await collectDiagnostics(this.didaReader)
      const path = join(this.config.rootDir, 'diagnostics', `diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
      await writeJsonAtomic(path, { ...report, app: this.versions })
      await this.hooks.openPath(join(this.config.rootDir, 'diagnostics'))
      return path
    })
  }

  async openExternal(url: string): Promise<void> {
    if (!/^https:\/\//i.test(url)) return
    if (this.hooks.demo) {
      // 演示数据里的链接都是假的，不启动浏览器
      this.activity.push({ kind: 'info', title: '演示模式：不会打开外部链接', detail: url })
      return
    }
    await this.hooks.openExternal(url)
  }

  async openPath(kind: 'logs' | 'backups' | 'data'): Promise<void> {
    const dir = kind === 'logs' ? this.config.logDir : kind === 'backups' ? this.config.backupDir : this.config.rootDir
    await mkdir(dir, { recursive: true })
    await this.hooks.openPath(dir)
  }

  /** 演示模式：模拟滴答中的变化 */
  demoMutate(fn: (dida: FakeDida) => void): void {
    if (this.demoDida) fn(this.demoDida)
  }

  shutdown(): void {
    this.scheduler.stop()
    this.didaAuth.cancel()
  }
}
