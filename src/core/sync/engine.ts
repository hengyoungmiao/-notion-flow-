import type { ActivitySink } from '../activity'
import type { DidaReader } from '../adapters/dida'
import { CliError } from '../adapters/exec'
import { queryAll, type NotionClient } from '../adapters/notion'
import { planDomains, type DomainOp, type DomainPlan, type NotionAreaPage, type NotionDomainPage } from '../mapping/domains'
import {
  buildCreateProperties,
  buildProperties,
  diffAgainstActual,
  mergeRelation,
  patchFields,
  propById,
  readActual,
  writtenFrom,
  type ActualTask,
  type TaskPatch
} from '../mapping/task'
import { plainText, toRichText } from '../mapping/text'
import type {
  AppSettings,
  DesiredTask,
  DidaGroup,
  DidaPreference,
  DidaProject,
  DidaTask,
  FlowSchema,
  NotionPage,
  PendingApproval,
  WorkspaceProfile,
  WorkspaceState
} from '../types'
import { evaluateBreaker, safeSubset } from './guard'
import { countOps, describeOp, isInbox, planTasks, type PlanCounts, type TaskOp } from './planner'
import type { StateStore } from './state'

export interface EngineDeps {
  dida: DidaReader
  notion: NotionClient
  store: StateStore
  profile: WorkspaceProfile
  settings: AppSettings
  log?: ActivitySink
  /** 首次同步正式执行前的备份钩子 */
  backup?: (data: { pages: NotionPage[]; tasks: DidaTask[]; projects: DidaProject[] }) => Promise<string>
  now?: () => Date
}

export interface RoundOptions {
  /** 只计算计划、不写入 */
  dryRun?: boolean
  /** 首次同步（向导确认后执行） */
  initial?: boolean
  /** 用户已确认熔断 */
  approve?: boolean
  forceStructure?: boolean
  forceReconcile?: boolean
}

export interface PlanItem {
  didaId?: string
  pageId?: string
  title: string
  detail: string
}

export interface RoundSummary {
  counts: PlanCounts
  creates: PlanItem[]
  updates: PlanItem[]
  matches: PlanItem[]
  destructive: PlanItem[]
  domainCreates: PlanItem[]
  domainRows: DomainPlan['rows']
  warnings: string[]
}

export interface RoundResult {
  summary: RoundSummary
  applied: boolean
  blocked: PendingApproval | null
  /** 本轮实际写入 Notion 的次数（用于自适应轮询） */
  writes: number
  reconciled: boolean
  backupPath: string | null
  durationMs: number
}

interface Structure {
  at: number
  projects: DidaProject[]
  groups: DidaGroup[]
  preference: DidaPreference
  domains: NotionDomainPage[]
  areas: NotionAreaPage[]
}

export class NeedsInitialSyncError extends Error {
  constructor() {
    super('该工作空间还没有完成首次同步')
    this.name = 'NeedsInitialSyncError'
  }
}

export class SyncEngine {
  private structure: Structure | null = null
  private readonly now: () => Date

  constructor(private readonly deps: EngineDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  get schema(): FlowSchema {
    const s = this.deps.profile.schema
    if (!s || !s.tasks.props.didaId) throw new Error('工作空间尚未完成 FLO.W 数据库识别')
    return s
  }

  private log(e: Parameters<ActivitySink>[0]): void {
    this.deps.log?.(e)
  }

  invalidateStructure(): void {
    this.structure = null
  }

  // ───────────────────────── 读取 ─────────────────────────

  private async loadStructure(force: boolean): Promise<Structure> {
    const ttl = this.deps.settings.structureMinutes * 60_000
    if (!force && this.structure && this.now().getTime() - this.structure.at < ttl) return this.structure
    const { dida, notion } = this.deps
    const schema = this.schema
    const [projects, groups, preference] = await Promise.all([dida.listProjects(), dida.listGroups(), dida.getPreference()])
    let domains: NotionDomainPage[] = []
    let areas: NotionAreaPage[] = []
    if (schema.domains) {
      const d = schema.domains
      domains = (await queryAll(notion, d.dataSourceId)).map((p) => ({
        pageId: p.id,
        title: plainText(propById(p, d.props.title)?.title),
        areaIds: d.props.area ? (propById(p, d.props.area)?.relation ?? []).map((r) => r.id) : []
      }))
    }
    if (schema.areas) {
      const a = schema.areas
      areas = (await queryAll(notion, a.dataSourceId)).map((p) => ({
        pageId: p.id,
        title: plainText(propById(p, a.props.title)?.title)
      }))
    }
    this.structure = { at: this.now().getTime(), projects, groups, preference, domains, areas }
    return this.structure
  }

  private async loadTasks(state: WorkspaceState, initial: boolean, now: Date, scope: Set<string>): Promise<DidaTask[]> {
    const { dida, profile } = this.deps
    // 明确传入参与同步的清单，不依赖接口“不带参数时返回什么”
    const open = scope.size > 0 ? await dida.listOpenTasks([...scope]) : []
    if (profile.scope.includeInbox) {
      let inbox = await dida.listInboxTasks()
      if (inbox === null) inbox = (await dida.listOpenTasks()).filter((t) => isInbox(t.projectId))
      open.push(...inbox.filter((t) => !open.some((o) => o.id === t.id)))
    }
    const day = 86_400_000
    let from: number
    if (initial) from = now.getTime() - Math.max(1, profile.scope.importCompletedDays) * day
    else from = (state.lastSuccessAt ? Date.parse(state.lastSuccessAt) : now.getTime()) - day
    const completed = await dida.listCompletedTasks(new Date(from), now)
    const byId = new Map<string, DidaTask>()
    for (const t of completed) byId.set(t.id, t)
    for (const t of open) byId.set(t.id, t)
    return [...byId.values()]
  }

  /** 链接任务缺席时逐条确认（先查原清单，再查不参与同步的清单） */
  private async confirmMissing(
    state: WorkspaceState,
    seen: Set<string>,
    structure: Structure,
    scope: Set<string>
  ): Promise<Map<string, DidaTask | null>> {
    const result = new Map<string, DidaTask | null>()
    // 已经以“完成/放弃”写入 Notion 的任务不再逐条确认（重新打开时会出现在未完成列表里）
    const missing = Object.values(state.tasks).filter((l) => !seen.has(l.didaId) && l.written.statusGroup === 'open')
    const others = structure.projects.filter((p) => !scope.has(p.id)).map((p) => p.id)
    for (const link of missing.slice(0, 60)) {
      let found = await this.deps.dida.getTask(link.projectId, link.didaId)
      if (!found) {
        for (const pid of others.filter((p) => p !== link.projectId).slice(0, 10)) {
          found = await this.deps.dida.getTask(pid, link.didaId)
          if (found) break
        }
      }
      result.set(link.didaId, found)
    }
    return result
  }

  private async loadLinkedPages(): Promise<{ map: Map<string, ActualTask[]>; pages: NotionPage[] }> {
    const schema = this.schema
    const pages = await queryAll(this.deps.notion, schema.tasks.dataSourceId, {
      filter: { property: schema.tasks.props.didaId, rich_text: { is_not_empty: true } }
    })
    const map = new Map<string, ActualTask[]>()
    for (const page of pages) {
      const a = readActual(page, schema)
      if (!a.didaId || a.inTrash) continue
      map.set(a.didaId, [...(map.get(a.didaId) ?? []), a])
    }
    return { map, pages }
  }

  private async loadCandidates(): Promise<{ candidates: ActualTask[]; pages: NotionPage[] }> {
    const schema = this.schema
    const pages = await queryAll(this.deps.notion, schema.tasks.dataSourceId, {
      filter: { property: schema.tasks.props.didaId, rich_text: { is_empty: true } }
    })
    const candidates = pages
      .map((p) => readActual(p, schema))
      .filter((a) => !a.inTrash && (a.statusGroup === 'open' || a.statusGroup === null))
    return { candidates, pages }
  }

  /** 供界面展示的领域映射表（不写入） */
  async inspectStructure(force = true): Promise<{
    rows: DomainPlan['rows']
    warnings: string[]
    notionDomains: Array<{ pageId: string; title: string }>
    notionAreas: Array<{ pageId: string; title: string }>
  }> {
    const schema = this.schema
    const state = await this.deps.store.load(this.deps.profile.id)
    const structure = await this.loadStructure(force)
    const plan = planDomains({
      projects: structure.projects,
      groups: structure.groups,
      notionDomains: structure.domains,
      notionAreas: structure.areas,
      profile: this.deps.profile,
      state,
      autoCreate: this.deps.settings.autoCreateDomains,
      domainsAvailable: !!schema.domains && !!schema.tasks.props.domain,
      areasAvailable: !!schema.areas && !!schema.domains?.props.area
    })
    return {
      rows: plan.rows,
      warnings: plan.warnings,
      notionDomains: structure.domains.map((d) => ({ pageId: d.pageId, title: d.title })),
      notionAreas: structure.areas.map((a) => ({ pageId: a.pageId, title: a.title }))
    }
  }

  // ───────────────────────── 一轮同步 ─────────────────────────

  async runRound(opts: RoundOptions = {}): Promise<RoundResult> {
    const started = Date.now()
    const now = this.now()
    const { store, profile, settings } = this.deps
    const schema = this.schema
    const state = await store.load(profile.id)
    const initial = !!opts.initial && !state.initializedAt
    if (!state.initializedAt && !initial) throw new NeedsInitialSyncError()

    const structure = await this.loadStructure(!!opts.forceStructure || initial)
    const domainPlan = planDomains({
      projects: structure.projects,
      groups: structure.groups,
      notionDomains: structure.domains,
      notionAreas: structure.areas,
      profile,
      state,
      autoCreate: settings.autoCreateDomains,
      domainsAvailable: !!schema.domains && !!schema.tasks.props.domain,
      areasAvailable: !!schema.areas && !!schema.domains?.props.area
    })

    const tasks = await this.loadTasks(state, initial, now, domainPlan.scopeProjectIds)
    const seen = new Set(tasks.map((t) => t.id))
    const confirmations = await this.confirmMissing(state, seen, structure, domainPlan.scopeProjectIds)

    const reconcileDue =
      initial ||
      !!opts.forceReconcile ||
      !state.lastReconcileAt ||
      now.getTime() - Date.parse(state.lastReconcileAt) >= settings.reconcileMinutes * 60_000
    const linkedLoad = reconcileDue ? await this.loadLinkedPages() : null
    const linkedPages = linkedLoad?.map ?? null
    const pageChecks = new Map<string, ActualTask | null>()
    if (linkedPages) {
      const present = new Set([...linkedPages.values()].flat().map((a) => a.pageId))
      for (const link of Object.values(state.tasks)) {
        if (present.has(link.pageId) || !seen.has(link.didaId)) continue
        const page = await this.deps.notion.getPage(link.pageId)
        pageChecks.set(link.pageId, page ? readActual(page, schema) : null)
      }
    }
    let candidatePages: NotionPage[] = []
    let candidates: ActualTask[] | null = null
    if (initial) {
      const loaded = await this.loadCandidates()
      candidates = loaded.candidates
      candidatePages = loaded.pages
    }

    const plan = planTasks({
      state,
      profile,
      schema,
      settings,
      userTimeZone: typeof structure.preference.timeZone === 'string' ? structure.preference.timeZone : null,
      domainPlan,
      tasks,
      confirmations,
      linkedPages,
      pageChecks,
      candidates,
      initial,
      now
    })
    const warnings = [...domainPlan.warnings, ...plan.warnings]
    const summary = summarize(plan.ops, domainPlan, warnings)

    let ops = plan.ops
    let blocked: PendingApproval | null = null
    if (!initial && !opts.approve) {
      const verdict = evaluateBreaker(ops, Object.keys(state.tasks).length, settings.breaker, now)
      if (verdict.blocked) {
        blocked = verdict.pending
        ops = safeSubset(ops)
      }
    }

    if (opts.dryRun) {
      return { summary, applied: false, blocked, writes: 0, reconciled: reconcileDue, backupPath: null, durationMs: Date.now() - started }
    }

    let backupPath: string | null = null
    if (initial && this.deps.backup) {
      backupPath = await this.deps.backup({
        pages: [...candidatePages, ...(linkedLoad?.pages ?? [])],
        tasks,
        projects: structure.projects
      })
    }

    const writes = { count: 0 }
    try {
      await this.applyDomainOps(domainPlan.ops, state, writes)
      if (domainPlan.ops.some((o) => o.kind === 'createDomain' || o.kind === 'createArea' || o.kind === 'setDomainArea'))
        this.invalidateStructure()
      await this.applyTaskOps(ops, state, writes)
    } finally {
      state.pendingApproval = blocked
      if (!blocked && opts.approve) state.pendingApproval = null
      await store.save(state)
    }

    if (blocked) {
      this.log({ kind: 'warning', title: '检测到大批量变更，已暂停等待确认', detail: blocked.reason })
    }
    state.lastSuccessAt = now.toISOString()
    if (reconcileDue) state.lastReconcileAt = now.toISOString()
    if (initial) state.initializedAt = now.toISOString()
    await store.save(state)

    return { summary, applied: true, blocked, writes: writes.count, reconciled: reconcileDue, backupPath, durationMs: Date.now() - started }
  }

  // ───────────────────────── 写入：领域结构 ─────────────────────────

  private titleProps(propId: string, name: string): Record<string, unknown> {
    return { [propId]: { title: toRichText(name) } }
  }

  private resolveAreaRef(ref: string | null, state: WorkspaceState): string | null {
    if (!ref) return null
    if (ref.startsWith('pending:group:')) return state.domains.groups[ref.slice('pending:group:'.length)]?.pageId ?? null
    return ref
  }

  private async applyDomainOps(ops: DomainOp[], state: WorkspaceState, writes: { count: number }): Promise<void> {
    const schema = this.schema
    const { notion } = this.deps
    for (const op of ops) {
      try {
        switch (op.kind) {
          case 'createArea': {
            if (!schema.areas) break
            const page = await notion.createPage({
              parent: { type: 'data_source_id', data_source_id: schema.areas.dataSourceId },
              properties: this.titleProps(schema.areas.props.title, op.name)
            })
            writes.count++
            state.domains.groups[op.groupId] = { didaId: op.groupId, pageId: page.id, mode: 'created', lastName: op.name, writtenAreaPageId: null }
            this.log({ kind: 'domain', title: `新建一级领域「${op.name}」`, pageId: page.id })
            break
          }
          case 'renameArea':
            await notion.updatePage(op.pageId, { properties: this.titleProps(schema.areas!.props.title, op.name) })
            writes.count++
            this.log({ kind: 'domain', title: `一级领域改名为「${op.name}」`, pageId: op.pageId })
            break
          case 'linkArea':
            state.domains.groups[op.groupId] = op.link
            break
          case 'createDomain': {
            if (!schema.domains) break
            const area = this.resolveAreaRef(op.areaRef, state)
            const properties = this.titleProps(schema.domains.props.title, op.name)
            if (area && schema.domains.props.area) properties[schema.domains.props.area] = { relation: [{ id: area }] }
            const page = await notion.createPage({
              parent: { type: 'data_source_id', data_source_id: schema.domains.dataSourceId },
              properties
            })
            writes.count++
            state.domains.lists[op.projectId] = { didaId: op.projectId, pageId: page.id, mode: 'created', lastName: op.name, writtenAreaPageId: area }
            this.log({ kind: 'domain', title: `新建二级领域「${op.name}」`, pageId: page.id })
            break
          }
          case 'renameDomain':
            await notion.updatePage(op.pageId, { properties: this.titleProps(schema.domains!.props.title, op.name) })
            writes.count++
            this.log({ kind: 'domain', title: `二级领域改名为「${op.name}」`, pageId: op.pageId })
            break
          case 'setDomainArea': {
            if (!schema.domains?.props.area) break
            const add = this.resolveAreaRef(op.add, state)
            const next = mergeRelation(op.current, { set: add, remove: op.remove })
            await notion.updatePage(op.pageId, { properties: { [schema.domains.props.area]: { relation: next.map((id) => ({ id })) } } })
            writes.count++
            const link = state.domains.lists[op.projectId]
            if (link) link.writtenAreaPageId = add ?? (op.remove ? null : link.writtenAreaPageId)
            break
          }
          case 'linkDomain':
            state.domains.lists[op.projectId] = { ...op.link, writtenAreaPageId: op.link.writtenAreaPageId ?? state.domains.lists[op.projectId]?.writtenAreaPageId ?? null }
            break
        }
      } catch (e) {
        if (e instanceof CliError && (e.kind === 'validation' || e.kind === 'not_found')) {
          this.log({ kind: 'error', title: '更新领域结构失败', detail: e.message })
          continue
        }
        throw e
      }
    }
  }

  // ───────────────────────── 写入：任务 ─────────────────────────

  private resolveDomain(desired: DesiredTask, state: WorkspaceState): string | null {
    const d = desired.domainPageId
    if (d && d.startsWith('pending:')) return state.domains.lists[d.slice('pending:'.length)]?.pageId ?? null
    return d
  }

  private resolved(desired: DesiredTask, state: WorkspaceState): DesiredTask {
    return { ...desired, domainPageId: this.resolveDomain(desired, state) }
  }

  private setLink(state: WorkspaceState, desired: DesiredTask, pageId: string, createdBySync: boolean, etag?: string): void {
    const prev = state.tasks[desired.didaId]
    const nowIso = this.now().toISOString()
    state.tasks[desired.didaId] = {
      didaId: desired.didaId,
      pageId,
      projectId: desired.projectId,
      written: writtenFrom(desired),
      etag: etag ?? prev?.etag,
      createdBySync: prev?.createdBySync ?? createdBySync,
      linkedAt: prev?.linkedAt ?? nowIso,
      lastSeenAt: nowIso
    }
  }

  private async findByDidaId(didaId: string): Promise<ActualTask | null> {
    const schema = this.schema
    const res = await this.deps.notion.queryDataSource(schema.tasks.dataSourceId, {
      filter: { property: schema.tasks.props.didaId, rich_text: { equals: didaId } },
      page_size: 5
    })
    const found = res.results.map((p) => readActual(p, schema)).filter((a) => !a.inTrash && a.didaId === didaId)
    return found[0] ?? null
  }

  private async applyTaskOps(ops: TaskOp[], state: WorkspaceState, writes: { count: number }): Promise<void> {
    const schema = this.schema
    const { notion, settings } = this.deps
    let sinceSave = 0
    for (const op of ops) {
      try {
        switch (op.kind) {
          case 'create': {
            const desired = this.resolved(op.desired, state)
            // 创建前按滴答ID查重，防止崩溃重启或多台电脑导致重复
            const existing = await this.findByDidaId(desired.didaId)
            if (existing) {
              state.foreignSightings++
              await this.applyUpdate(desired, existing.pageId, existing, state, writes, diffAgainstActual(desired, existing, null))
              this.log({ kind: 'relink', title: `重新关联「${desired.title}」`, didaId: desired.didaId, pageId: existing.pageId })
              break
            }
            const body: Record<string, unknown> = {
              parent: { type: 'data_source_id', data_source_id: schema.tasks.dataSourceId },
              properties: buildCreateProperties(desired, schema, desired.domainPageId)
            }
            if (settings.applyTemplate) body.template = { type: 'default' }
            const page = await notion.createPage(body)
            writes.count++
            this.setLink(state, desired, page.id, true)
            this.log({ kind: 'create', title: desired.title || '（无标题）', didaId: desired.didaId, pageId: page.id })
            break
          }
          case 'update': {
            const desired = this.resolved(op.desired, state)
            await this.applyUpdate(desired, op.pageId, op.actual ?? null, state, writes, op.patch)
            const kind = op.reason === 'drift' ? 'correct' : op.reason === 'dida' ? 'update' : 'relink'
            const title = op.reason === 'drift' ? `已按滴答校正「${desired.title}」` : desired.title
            this.log({ kind, title, detail: patchFields(op.patch).join('、'), didaId: desired.didaId, pageId: op.pageId })
            break
          }
          case 'link':
            this.setLink(state, this.resolved(op.desired, state), op.pageId, false)
            if (op.reason !== 'refresh') this.log({ kind: 'relink', title: `关联「${op.desired.title}」`, didaId: op.didaId, pageId: op.pageId })
            break
          case 'trash':
            await notion.updatePage(op.pageId, { in_trash: true })
            writes.count++
            delete state.tasks[op.didaId]
            this.log({ kind: 'trash', title: `滴答中已删除，Notion 页面移入回收站「${op.title}」`, didaId: op.didaId, pageId: op.pageId })
            break
          case 'abandon':
            await notion.updatePage(op.pageId, { properties: buildProperties({ status: 'abandoned' }, schema) })
            writes.count++
            delete state.tasks[op.didaId]
            this.log({ kind: 'abandon', title: `滴答中已删除，标记为放弃「${op.title}」`, didaId: op.didaId, pageId: op.pageId })
            break
          case 'unlink':
            delete state.tasks[op.didaId]
            this.log({
              kind: 'unlink',
              title: op.reason === 'out_of_scope' ? `任务移出同步范围，已解除关联「${op.title}」` : `滴答中已删除，已解除关联「${op.title}」`,
              didaId: op.didaId,
              pageId: op.pageId
            })
            break
          case 'removed':
            delete state.tasks[op.didaId]
            state.notionRemoved[op.didaId] = { pageId: op.pageId, title: op.title, at: this.now().toISOString() }
            this.log({ kind: 'removed', title: `Notion 中已删除，不再同步「${op.title}」`, didaId: op.didaId, pageId: op.pageId })
            break
          case 'touch': {
            const link = state.tasks[op.didaId]
            if (link) {
              link.projectId = op.projectId
              link.etag = op.etag
              link.lastSeenAt = this.now().toISOString()
            }
            break
          }
        }
      } catch (e) {
        if (e instanceof CliError && (e.kind === 'validation' || e.kind === 'not_found')) {
          this.log({ kind: 'error', title: `写入失败：${describeOp(op)}`, detail: e.message })
          continue
        }
        throw e
      }
      if (++sinceSave >= 25) {
        await this.deps.store.save(state)
        sinceSave = 0
      }
    }
  }

  private async applyUpdate(
    desired: DesiredTask,
    pageId: string,
    actual: ActualTask | null,
    state: WorkspaceState,
    writes: { count: number },
    patchIn: TaskPatch
  ): Promise<void> {
    const schema = this.schema
    let patch = patchIn
    // 领域变化时先读取当前关系，只替换同步写入的值
    let relationIds: string[] | undefined
    if (patch.domain) {
      const current = actual ?? (await this.pageActual(pageId))
      if (!current) {
        delete state.tasks[desired.didaId]
        state.notionRemoved[desired.didaId] = { pageId, title: desired.title, at: this.now().toISOString() }
        return
      }
      relationIds = mergeRelation(current.domainIds, { ...patch.domain, set: this.resolveDomainId(patch.domain.set, state) })
    }
    const linkedHere = state.tasks[desired.didaId]?.pageId === pageId
    if (!linkedHere && actual?.didaId !== desired.didaId) patch = { ...patch, didaId: desired.didaId }
    const properties = buildProperties(patch, schema, relationIds)
    if (Object.keys(properties).length > 0) {
      await this.deps.notion.updatePage(pageId, { properties })
      writes.count++
    }
    this.setLink(state, desired, pageId, false)
  }

  private resolveDomainId(id: string | null, state: WorkspaceState): string | null {
    if (id && id.startsWith('pending:')) return state.domains.lists[id.slice('pending:'.length)]?.pageId ?? null
    return id
  }

  private async pageActual(pageId: string): Promise<ActualTask | null> {
    const page = await this.deps.notion.getPage(pageId)
    if (!page || page.in_trash || page.archived) return null
    return readActual(page, this.schema)
  }

  /** 重新创建一个在 Notion 中被删除的任务（界面「重新创建」按钮） */
  async restore(didaId: string): Promise<void> {
    const state = await this.deps.store.load(this.deps.profile.id)
    delete state.notionRemoved[didaId]
    await this.deps.store.save(state)
  }
}

function summarize(ops: TaskOp[], domainPlan: DomainPlan, warnings: string[]): RoundSummary {
  const s: RoundSummary = {
    counts: countOps(ops),
    creates: [],
    updates: [],
    matches: [],
    destructive: [],
    domainCreates: [],
    domainRows: domainPlan.rows,
    warnings
  }
  for (const op of ops) {
    if (op.kind === 'create') s.creates.push({ didaId: op.desired.didaId, title: op.desired.title, detail: '' })
    else if (op.kind === 'update') {
      const item = { didaId: op.didaId, pageId: op.pageId, title: op.desired.title, detail: patchFields(op.patch).join('、') }
      if (op.reason === 'match' || op.reason === 'relink') s.matches.push(item)
      else s.updates.push(item)
    } else if (op.kind === 'link' && op.reason !== 'refresh')
      s.matches.push({ didaId: op.didaId, pageId: op.pageId, title: op.desired.title, detail: '无需修改' })
    else if (op.kind === 'trash' || op.kind === 'abandon')
      s.destructive.push({ didaId: op.didaId, pageId: op.pageId, title: op.title, detail: op.kind === 'trash' ? '移入回收站' : '标记放弃' })
  }
  for (const op of domainPlan.ops) {
    if (op.kind === 'createArea') s.domainCreates.push({ title: op.name, detail: '一级领域' })
    if (op.kind === 'createDomain') s.domainCreates.push({ title: op.name, detail: '二级领域' })
  }
  return s
}
