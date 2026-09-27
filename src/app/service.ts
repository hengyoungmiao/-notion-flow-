import { appendFile, chmod, mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ActivityLog, type ActivityEntry } from '../core/activity'
import { DidaCliReader, type DidaReader } from '../core/adapters/dida'
import { CliError, redact } from '../core/adapters/exec'
import { FakeDida, FakeNotion } from '../core/adapters/fake'
import { NtnNotionClient, type NotionClient } from '../core/adapters/notion'
import { ResilientDida } from '../core/adapters/resilient-dida'
import { writeBackup } from '../core/backup'
import { ConfigStore, newWorkspace } from '../core/config'
import { createDemoDida, createDemoNotion } from '../core/demo'
import {
  bindFlowSchema,
  ensureDidaIdProperty,
  findTaskCandidates,
  resolveTaskDataSource,
  upgradeSchema,
  validateSchema,
  type TaskCandidate
} from '../core/notion/discovery'
import type { BindIssue } from '../core/notion/schema'
import { SyncEngine, type RoundResult } from '../core/sync/engine'
import { FileStateStore } from '../core/sync/state'
import type { AppSettings, DomainMapping, WorkspaceProfile } from '../core/types'
import { DidaAuth, NotionLogin, type NotionLoginInfo } from './auth'
import { didaCommand, didaScript, ntnPath } from './runtime'

export interface ServiceOptions {
  home: string
  /** 演示模式：使用内置示例数据，不连接真实账号 */
  fake?: boolean
  /** 同步记录的额外输出（常驻服务打印到标准输出，进入 journald） */
  echo?: (entry: ActivityEntry) => void
}

export interface BindOutcome {
  ok: boolean
  issues: BindIssue[]
  needsDidaIdProperty: boolean
  tasksTitle: string | null
}

/** 把 token 以 base64 存在配置文件里（配置文件权限为 600）；兼容旧格式 */
const encode = (plain: string) => `plain:${Buffer.from(plain, 'utf8').toString('base64')}`
const decode = (enc: string) => (enc.startsWith('plain:') ? Buffer.from(enc.slice(6), 'base64').toString('utf8') : enc)

/** FlowSync 后端服务：配置、工作空间、登录、识别 FLO.W、映射、首次同步（命令行和常驻服务共用） */
export class FlowSyncService {
  readonly config: ConfigStore
  readonly store: FileStateStore
  readonly activity = new ActivityLog()
  readonly rawDida: DidaReader
  readonly dida: ResilientDida
  readonly didaAuth: DidaAuth
  readonly notionLogin = new NotionLogin(() => ntnPath())
  private readonly clients = new Map<string, NotionClient>()
  private readonly demoNotion = new Map<string, FakeNotion>()
  private engineCache: { key: string; engine: SyncEngine } | null = null

  constructor(readonly opts: ServiceOptions) {
    this.config = new ConfigStore(opts.home)
    this.store = new FileStateStore(this.config.stateDir)
    this.store.onRecovered = () =>
      this.log({ kind: 'warning', title: '同步记录文件损坏，已备份并重建', detail: '下一轮会按「滴答ID」把已有的 Notion 页面重新关联，不会重复创建' })
    this.rawDida = opts.fake ? createDemoDida() : new DidaCliReader(didaCommand(60_000))
    this.dida = new ResilientDida(this.rawDida, { warn: (_ep, message) => this.log({ kind: 'warning', title: message }) })
    this.didaAuth = new DidaAuth(() => didaCommand(30_000))
    this.activity.onEntry((e) => {
      opts.echo?.(e)
      void this.appendLog(e)
    })
    this.config.onChange(() => {
      this.engineCache = null
    })
  }

  get fake(): boolean {
    return !!this.opts.fake
  }

  get demoDida(): FakeDida | null {
    return this.opts.fake ? (this.rawDida as FakeDida) : null
  }

  async init(): Promise<void> {
    await mkdir(this.config.logDir, { recursive: true })
    await this.config.load()
    if (this.config.recovered)
      this.log({
        kind: 'warning',
        title: this.config.recovered === 'backup' ? '配置文件损坏，已从最近一次保存的备份恢复' : '配置文件损坏且没有备份，已改用默认配置',
        detail: '损坏的文件已改名保留在数据目录'
      })
    await this.protectConfig()
    void this.pruneLogs()
    await this.upgradeSchemas()
  }

  /** 重新读取配置文件（命令行修改配置后，常驻服务据此生效） */
  async reloadConfig(): Promise<void> {
    await this.config.load()
    this.engineCache = null
  }

  log(e: Omit<ActivityEntry, 'id' | 'at'>): void {
    this.activity.push(e)
  }

  // ───────────────────────── 工作空间 ─────────────────────────

  workspaces(): WorkspaceProfile[] {
    return this.config.get().workspaces
  }

  workspace(idOrName: string): WorkspaceProfile {
    const all = this.workspaces()
    const ws = all.find((w) => w.id === idOrName) ?? all.find((w) => w.name === idOrName)
    if (!ws) throw new Error(`找不到工作空间「${idOrName}」`)
    return ws
  }

  active(): WorkspaceProfile | null {
    return this.config.active()
  }

  async createWorkspace(name: string): Promise<WorkspaceProfile> {
    const clean = name.trim() || '我的工作空间'
    if (this.workspaces().some((w) => w.name === clean)) throw new Error(`已经有名为「${clean}」的工作空间`)
    const ws = newWorkspace(clean)
    await this.config.update((c) => {
      c.workspaces.push(ws)
      if (!c.activeWorkspaceId) c.activeWorkspaceId = ws.id
    })
    await this.protectConfig()
    if (!this.fake) await mkdir(this.config.notionHome(ws.id), { recursive: true })
    return ws
  }

  async removeWorkspace(idOrName: string): Promise<void> {
    const ws = this.workspace(idOrName)
    this.notionLogin.cancel(ws.id)
    await this.config.update((c) => {
      c.workspaces = c.workspaces.filter((w) => w.id !== ws.id)
      if (c.activeWorkspaceId === ws.id) c.activeWorkspaceId = c.workspaces[0]?.id ?? null
    })
    await this.store.remove(ws.id)
    if (!this.fake) await rm(this.config.notionHome(ws.id), { recursive: true, force: true })
    this.demoNotion.delete(ws.id)
  }

  async setActive(idOrName: string): Promise<WorkspaceProfile> {
    const ws = this.workspace(idOrName)
    const state = await this.store.load(ws.id)
    if (!state.initializedAt) throw new Error(`工作空间「${ws.name}」还没有完成首次同步，请先运行 flowsync setup`)
    await this.config.update((c) => {
      c.activeWorkspaceId = ws.id
    })
    this.log({ kind: 'info', title: `已切换到工作空间「${ws.name}」` })
    return ws
  }

  // ───────────────────────── Notion ─────────────────────────

  clientFor(ws: WorkspaceProfile): NotionClient {
    if (this.fake) {
      let n = this.demoNotion.get(ws.id)
      if (!n) {
        n = createDemoNotion(`${ws.name}（演示）`, this.demoNotion.size === 0)
        this.demoNotion.set(ws.id, n)
      }
      return n
    }
    const key = `${ws.id}:${ws.auth.type}:${ws.auth.type === 'token' ? ws.auth.tokenEnc.slice(-12) : ''}`
    let client = this.clients.get(key)
    if (!client) {
      client = new NtnNotionClient({
        command: ntnPath(),
        notionHome: this.config.notionHome(ws.id),
        token: ws.auth.type === 'token' ? decode(ws.auth.tokenEnc) : undefined
      })
      this.clients.set(key, client)
    }
    return client
  }

  /** 使用 Notion 内部集成 token（服务器推荐） */
  async notionUseToken(idOrName: string, token: string): Promise<{ workspaceName: string | null }> {
    const ws = this.workspace(idOrName)
    const clean = token.trim()
    if (clean.length < 20) throw new Error('集成 token 格式不对（一般以 ntn_ 或 secret_ 开头）')
    const next: WorkspaceProfile = { ...ws, auth: { type: 'token', tokenEnc: encode(clean) } }
    const me = await this.clientFor(next).whoami()
    await this.config.upsertWorkspace({ ...next, notionWorkspaceName: me.workspaceName, notionUserName: me.name })
    await this.protectConfig()
    return { workspaceName: me.workspaceName }
  }

  /** ntn 设备登录第一步：返回链接和验证码 */
  async notionLoginStart(idOrName: string): Promise<NotionLoginInfo> {
    const ws = this.workspace(idOrName)
    if (this.fake) return { url: 'https://www.notion.so/demo-login', code: 'DEMO-123' }
    return this.notionLogin.start(ws.id, this.config.notionHome(ws.id))
  }

  /** ntn 设备登录第二步：等待用户在浏览器确认 */
  async notionLoginPoll(idOrName: string): Promise<{ workspaceName: string | null }> {
    const ws = this.workspace(idOrName)
    if (!this.fake) await this.notionLogin.poll(ws.id, this.config.notionHome(ws.id))
    const next: WorkspaceProfile = { ...ws, auth: { type: 'ntn' } }
    const me = await this.clientFor(next).whoami()
    await this.config.upsertWorkspace({ ...next, notionWorkspaceName: me.workspaceName, notionUserName: me.name })
    return { workspaceName: me.workspaceName }
  }

  async notionWhoami(idOrName: string): Promise<{ name: string | null; workspaceName: string | null } | null> {
    try {
      return await this.clientFor(this.workspace(idOrName)).whoami()
    } catch (e) {
      if (e instanceof CliError && e.kind === 'auth') return null
      throw e
    }
  }

  // ───────────────────────── 滴答 ─────────────────────────

  /** 保存滴答 access token（由 dida-cli 自己保存在 ~/.config/dida-cli/config.json），并立即验证 */
  async didaSaveToken(token: string): Promise<number> {
    const clean = token.trim()
    if (clean.length < 10) throw new Error('token 太短，请检查是否复制完整')
    if (!this.fake) await this.didaAuth.saveToken(clean)
    const lists = await this.didaVerify()
    if (lists === null) throw new Error('滴答拒绝了这个 token（登录无效或已过期），请重新获取')
    return lists
  }

  /** 验证滴答登录：返回清单数量；未登录返回 null */
  async didaVerify(): Promise<number | null> {
    try {
      return (await this.rawDida.listProjects()).length
    } catch (e) {
      if (e instanceof CliError && e.kind === 'auth') return null
      throw e
    }
  }

  didaScriptPath(): string {
    return didaScript()
  }

  // ───────────────────────── FLO.W 数据库 ─────────────────────────

  async findTaskDatabases(idOrName: string): Promise<TaskCandidate[]> {
    return findTaskCandidates(this.clientFor(this.workspace(idOrName)))
  }

  async bindTaskDatabase(idOrName: string, dataSourceIdOrLink: string): Promise<BindOutcome> {
    const ws = this.workspace(idOrName)
    const client = this.clientFor(ws)
    const dsId =
      /^[0-9a-f-]{32,36}$/i.test(dataSourceIdOrLink) || dataSourceIdOrLink.startsWith('ds-')
        ? dataSourceIdOrLink
        : await resolveTaskDataSource(client, dataSourceIdOrLink)
    const res = await bindFlowSchema(client, dsId)
    if (res.schema) await this.config.upsertWorkspace({ ...this.workspace(ws.id), schema: res.schema })
    return { ok: !!res.schema, issues: res.issues, needsDidaIdProperty: res.needsDidaIdProperty, tasksTitle: res.schema?.tasks.title ?? null }
  }

  async ensureDidaIdProperty(idOrName: string): Promise<void> {
    const ws = this.workspace(idOrName)
    if (!ws.schema) throw new Error('请先识别 FLO.W 任务库')
    const schema = await ensureDidaIdProperty(this.clientFor(ws), ws.schema)
    await this.config.upsertWorkspace({ ...this.workspace(ws.id), schema })
  }

  /** 旧配置补充识别番茄库、项目库（失败不影响任务同步） */
  private async upgradeSchemas(): Promise<void> {
    for (const ws of this.workspaces()) {
      if (!ws.schema) continue
      try {
        const schema = await upgradeSchema(this.clientFor(ws), ws.schema)
        if (schema !== ws.schema) await this.config.upsertWorkspace({ ...this.workspace(ws.id), schema })
      } catch {
        /* 下次启动再试 */
      }
    }
  }

  // ───────────────────────── 映射、范围、设置 ─────────────────────────

  async setMapping(idOrName: string, kind: 'lists' | 'groups', key: string, mapping: DomainMapping): Promise<void> {
    const ws = this.workspace(idOrName)
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

  async updateScope(idOrName: string, patch: Partial<WorkspaceProfile['scope']>): Promise<void> {
    const ws = this.workspace(idOrName)
    await this.config.upsertWorkspace({ ...ws, scope: { ...ws.scope, ...patch } })
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    const next = await this.config.update((c) => {
      c.settings = { ...c.settings, ...patch, breaker: { ...c.settings.breaker, ...(patch.breaker ?? {}) } }
    })
    return next.settings
  }

  // ───────────────────────── 同步 ─────────────────────────

  engineFor(ws: WorkspaceProfile): SyncEngine {
    return new SyncEngine({
      dida: this.dida,
      notion: this.clientFor(ws),
      store: this.store,
      profile: ws,
      settings: this.config.get().settings,
      log: (e) => this.log(e),
      onSchemaChange: (schema) => {
        const current = this.workspaces().find((w) => w.id === ws.id)
        if (current) void this.config.upsertWorkspace({ ...current, schema }).catch(() => undefined)
      },
      backup: (data) => writeBackup(this.config.backupDir, ws.name, data)
    })
  }

  /** 当前活动工作空间的引擎（配置不变时复用，保留结构缓存和失败记录） */
  activeEngine(): SyncEngine | null {
    const ws = this.active()
    if (!ws?.schema?.tasks.props.didaId) return null
    const key = JSON.stringify([ws, this.config.get().settings])
    if (this.engineCache?.key === key) return this.engineCache.engine
    const engine = this.engineFor(ws)
    this.engineCache = { key, engine }
    return engine
  }

  async previewInitial(idOrName: string): Promise<RoundResult> {
    const ws = this.workspace(idOrName)
    if (!ws.schema?.tasks.props.didaId) throw new Error('请先完成 FLO.W 数据库识别')
    const issues = (await validateSchema(this.clientFor(ws), ws.schema)).filter((i) => i.level === 'error')
    if (issues.length) throw new Error(issues.map((i) => i.message).join('；'))
    return this.engineFor(ws).runRound({ initial: true, dryRun: true, forceStructure: true })
  }

  async startInitial(idOrName: string): Promise<RoundResult> {
    const ws = this.workspace(idOrName)
    const res = await this.engineFor(ws).runRound({ initial: true, forceStructure: true })
    await this.config.update((c) => {
      c.activeWorkspaceId = ws.id
      c.onboarded = true
    })
    this.log({
      kind: 'info',
      title: `首次同步完成：新建 ${res.summary.counts.creates} 个、关联 ${res.summary.matches.length} 个任务${res.summary.focus.creates ? `，导入 ${res.summary.focus.creates} 条番茄记录` : ''}`,
      detail: res.backupPath ? `备份：${res.backupPath}` : undefined
    })
    return res
  }

  async removed(idOrName: string) {
    const state = await this.store.load(this.workspace(idOrName).id)
    return Object.entries(state.notionRemoved).map(([didaId, v]) => ({ didaId, ...v }))
  }

  async restore(idOrName: string, didaId: string): Promise<void> {
    const ws = this.workspace(idOrName)
    const state = await this.store.load(ws.id)
    if (!state.notionRemoved[didaId]) throw new Error(`没有找到滴答ID为 ${didaId} 的已删除记录`)
    delete state.notionRemoved[didaId]
    await this.store.save(state)
  }

  // ───────────────────────── 日志与文件 ─────────────────────────

  private async appendLog(e: ActivityEntry): Promise<void> {
    try {
      const file = join(this.config.logDir, `activity-${e.at.slice(0, 10)}.log`)
      await appendFile(file, `${JSON.stringify({ ...e, detail: e.detail ? redact(e.detail) : undefined })}\n`, 'utf8')
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

  /** 配置文件里可能有 Notion 集成 token：只允许本人读写 */
  private async protectConfig(): Promise<void> {
    for (const p of [this.config.path, this.config.backupPath]) await chmod(p, 0o600).catch(() => undefined)
  }
}
