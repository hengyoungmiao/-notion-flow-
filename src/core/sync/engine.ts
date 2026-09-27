import type { ActivitySink } from '../activity'
import { listFocusRange, type DidaReader } from '../adapters/dida'
import { CliError } from '../adapters/exec'
import { queryAll, type NotionClient } from '../adapters/notion'
import { planDomains, type DomainOp, type DomainPlan, type NotionAreaPage, type NotionDomainPage } from '../mapping/domains'
import {
  buildCreateProperties,
  buildProperties,
  diffAgainstActual,
  mergeRelation,
  mergeRelationMulti,
  patchFields,
  propById,
  readActual,
  writtenFrom,
  type ActualTask,
  type TaskPatch
} from '../mapping/task'
import { plainText, toRichText } from '../mapping/text'
import { buildFocusProperties, focusPageStartKey } from '../mapping/focus'
import { BODY_TITLE, containerBlock } from '../mapping/body'
import { missingInWindow, planFocus, type FocusOp } from './focus'
import type {
  AppSettings,
  DesiredTask,
  DidaFocus,
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
import { countOps, describeOp, isInbox, planTasks, projectKey, type PlanCounts, type TaskOp } from './planner'
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
  /** 番茄钟/正计时记录 */
  focus: { creates: number; updates: number; trashes: number }
  /** 需要写入/更新同步区的任务数 */
  bodies: number
  /** 将按标签关联项目的任务数 */
  projectLinks: number
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
  /** FLO.W 项目（按标签匹配） */
  flowProjects: Array<{ pageId: string; title: string }>
}

interface FocusLoad {
  records: DidaFocus[]
  confirmations: Map<string, DidaFocus | null>
  from: Date
  to: Date
}

const FOCUS_INTERVAL_MS = 60_000
/** 每轮最多重写的同步区数量 */
const BODY_LIMIT = 40

export class NeedsInitialSyncError extends Error {
  constructor() {
    super('该工作空间还没有完成首次同步')
    this.name = 'NeedsInitialSyncError'
  }
}

export class SyncEngine {
  private structure: Structure | null = null
  private lastFocusAt = 0
  private focusWarned = false
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
    let flowProjects: Array<{ pageId: string; title: string }> = []
    if (schema.projects && this.deps.settings.syncProjects) {
      const pr = schema.projects
      flowProjects = (await queryAll(notion, pr.dataSourceId)).map((p) => ({
        pageId: p.id,
        title: plainText(propById(p, pr.props.title)?.title)
      }))
    }
    this.structure = { at: this.now().getTime(), projects, groups, preference, domains, areas, flowProjects }
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

  /** 读取专注记录（番茄钟 + 正计时），并确认窗口内缺席的记录是否已删除 */
  private async loadFocus(state: WorkspaceState, now: Date, initial: boolean, force: boolean): Promise<FocusLoad | null> {
    const { dida, settings } = this.deps
    if (!this.schema.focus || !settings.syncFocus) return null
    if (!initial && !force && state.focus.cursor && now.getTime() - this.lastFocusAt < FOCUS_INTERVAL_MS) return null
    const day = 86_400_000
    const from = state.focus.cursor
      ? new Date(Date.parse(state.focus.cursor) - day)
      : new Date(now.getTime() - Math.max(0, settings.focusImportDays) * day)
    try {
      const records =
        from < now
          ? [...(await listFocusRange(dida, from, now, 'pomodoro')), ...(await listFocusRange(dida, from, now, 'timing'))]
          : []
      const seen = new Set(records.map((r) => r.id))
      const confirmations = new Map<string, DidaFocus | null>()
      for (const link of missingInWindow(state, seen, from, now).slice(0, 30))
        confirmations.set(link.focusId, await dida.getFocus(link.focusId, link.kind))
      this.lastFocusAt = now.getTime()
      return { records, confirmations, from, to: now }
    } catch (e) {
      if (e instanceof CliError && e.kind === 'auth') throw e
      if (!this.focusWarned) {
        this.focusWarned = true
        this.log({ kind: 'warning', title: '读取滴答专注记录失败，本轮跳过番茄钟同步', detail: e instanceof Error ? e.message : String(e) })
      }
      return null
    }
  }

  /** 供界面展示的领域映射表（不写入） */
  async inspectStructure(force = true): Promise<{
    rows: DomainPlan['rows']
    warnings: string[]
    notionDomains: Array<{ pageId: string; title: string }>
    notionAreas: Array<{ pageId: string; title: string }>
    tagProjects: Array<{ tag: string; projectTitle: string | null }> | null
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
      notionAreas: structure.areas.map((a) => ({ pageId: a.pageId, title: a.title })),
      tagProjects: await this.tagProjectTable(structure)
    }
  }

  /** 标签 → 项目对照（界面展示用）；未启用或没有项目库时返回 null */
  private async tagProjectTable(structure: Structure): Promise<Array<{ tag: string; projectTitle: string | null }> | null> {
    if (!this.schema.projects || !this.deps.settings.syncProjects) return null
    const byKey = new Map(structure.flowProjects.map((p) => [projectKey(p.title), p.title]))
    const tags = await this.deps.dida.listTags().catch(() => [])
    return tags
      .map((t) => ({ tag: t.label || t.name, projectTitle: byKey.get(projectKey(t.name)) ?? byKey.get(projectKey(t.label)) ?? null }))
      .sort((a, b) => Number(!!b.projectTitle) - Number(!!a.projectTitle) || a.tag.localeCompare(b.tag))
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
      projects: structure.flowProjects,
      initial,
      now
    })
    const warnings = [...domainPlan.warnings, ...plan.warnings]
    const summary = summarize(plan.ops, domainPlan, warnings)
    const zone =
      (typeof structure.preference.timeZone === 'string' && structure.preference.timeZone) || settings.defaultTimeZone
    const focusLoad = await this.loadFocus(state, now, initial, !!opts.forceReconcile)

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
      if (focusLoad) {
        // 预览：本轮将新建/关联的任务也视为已同步
        const planned = new Map<string, string>()
        for (const op of plan.ops) {
          if (op.kind === 'create') planned.set(op.desired.didaId, op.desired.title)
          else if (op.kind === 'update' || op.kind === 'link') planned.set(op.didaId, op.desired.title)
        }
        const focusOps = planFocus({
          records: focusLoad.records,
          state,
          taskFor: (id) => {
            const link = state.tasks[id]
            if (link) return { pageId: link.pageId, title: link.written.title }
            return planned.has(id) ? { pageId: 'pending', title: planned.get(id)! } : null
          },
          from: focusLoad.from,
          to: focusLoad.to,
          confirmations: focusLoad.confirmations,
          zone
        })
        summary.focus = countFocus(focusOps)
      }
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
      if (focusLoad) {
        let focusOps = planFocus({
          records: focusLoad.records,
          state,
          taskFor: (id) => {
            const link = state.tasks[id]
            return link ? { pageId: link.pageId, title: link.written.title } : null
          },
          from: focusLoad.from,
          to: focusLoad.to,
          confirmations: focusLoad.confirmations,
          zone
        })
        const trashes = focusOps.filter((o) => o.kind === 'focusTrash').length
        if (!initial && !opts.approve && (blocked || trashes > settings.breaker.maxTrash)) {
          if (!blocked && trashes > 0)
            blocked = {
              createdAt: now.toISOString(),
              reason: `计划删除 ${trashes} 条番茄记录（上限 ${settings.breaker.maxTrash}）`,
              trash: trashes,
              updates: 0,
              sample: []
            }
          focusOps = focusOps.filter((o) => o.kind !== 'focusTrash')
        }
        summary.focus = countFocus(focusOps)
        await this.applyFocusOps(focusOps, state, writes)
        state.focus.cursor = focusLoad.to.toISOString()
      }
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
      lastSeenAt: nowIso,
      parentDidaId: desired.parentDidaId,
      body: prev?.pageId === pageId ? prev?.body : undefined,
      history: prev?.history
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

  private async applyTaskOps(allOps: TaskOp[], state: WorkspaceState, writes: { count: number }): Promise<void> {
    const schema = this.schema
    const { notion, settings } = this.deps
    let sinceSave = 0
    // 同步区最后写（新建的页面此时已有 ID），每轮最多 BODY_LIMIT 个，其余下一轮继续
    const ops = [...allOps.filter((o) => o.kind !== 'body'), ...allOps.filter((o) => o.kind === 'body').slice(0, BODY_LIMIT)]
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
          case 'body':
            writes.count += await this.applyBody(op, state)
            break
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

  /** 重写页面顶部的同步区：删除旧 callout，在页面最前面追加新的（超过 100 个子块时分批） */
  private async applyBody(op: Extract<TaskOp, { kind: 'body' }>, state: WorkspaceState): Promise<number> {
    const link = state.tasks[op.didaId]
    const pageId = op.pageId ?? link?.pageId
    if (!link || !pageId || link.pageId !== pageId) return 0
    const { notion } = this.deps
    let writes = 0
    if (link.body?.blockId) {
      await notion.deleteBlock(link.body.blockId)
      writes++
    } else if (!link.body) {
      // 第一次写（或本地状态丢失）：先清理页面上已有的同步区，避免出现两个
      for (const b of await notion.listBlocks(pageId)) {
        if (b.type === 'callout' && isSyncCallout(b)) {
          await notion.deleteBlock(b.id)
          writes++
        }
      }
    }
    let blockId: string | null = null
    if (op.spec) {
      const res = await notion.appendBlocks(pageId, [containerBlock(op.spec.blocks)], { type: 'page_start' })
      writes++
      blockId = res.results[0]?.id ?? null
      for (let i = 100; blockId && i < op.spec.blocks.length; i += 100) {
        await notion.appendBlocks(blockId, op.spec.blocks.slice(i, i + 100))
        writes++
      }
    }
    link.body = { blockId, hash: op.spec?.hash ?? null }
    if (op.history) link.history = op.history
    return writes
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
    let projectIds: string[] | undefined
    if (patch.domain || patch.projects) {
      const current = actual ?? (await this.pageActual(pageId))
      if (!current) {
        delete state.tasks[desired.didaId]
        state.notionRemoved[desired.didaId] = { pageId, title: desired.title, at: this.now().toISOString() }
        return
      }
      if (patch.domain)
        relationIds = mergeRelation(current.domainIds, { ...patch.domain, set: this.resolveDomainId(patch.domain.set, state) })
      if (patch.projects) projectIds = mergeRelationMulti(current.projectIds, patch.projects)
    }
    const linkedHere = state.tasks[desired.didaId]?.pageId === pageId
    if (!linkedHere && actual?.didaId !== desired.didaId) patch = { ...patch, didaId: desired.didaId }
    const properties = buildProperties(patch, schema, relationIds, projectIds)
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

  // ───────────────────────── 写入：番茄钟 ─────────────────────────

  private async applyFocusOps(ops: FocusOp[], state: WorkspaceState, writes: { count: number }): Promise<void> {
    const fs = this.schema.focus
    if (!fs || ops.length === 0) return
    const { notion } = this.deps
    const byTask = new Map<string, NotionPage[]>()
    const linkedPages = new Set(Object.values(state.focus.links).map((l) => l.pageId))
    const pagesOf = async (taskPageId: string): Promise<NotionPage[]> => {
      let pages = byTask.get(taskPageId)
      if (!pages) {
        pages = await queryAll(notion, fs.dataSourceId, { filter: { property: fs.props.task, relation: { contains: taskPageId } } })
        byTask.set(taskPageId, pages)
      }
      return pages
    }
    for (const op of ops) {
      try {
        if (op.kind === 'focusCreate') {
          const d = op.desired
          const properties = buildFocusProperties(d, fs, op.taskPageId)
          // 去重：同一任务下开始时间相同的番茄记录视为同一条
          const existing = (await pagesOf(op.taskPageId)).find(
            (p) => !linkedPages.has(p.id) && focusPageStartKey(p, fs) === d.startKey
          )
          let pageId: string
          if (existing) {
            await notion.updatePage(existing.id, { properties })
            pageId = existing.id
          } else {
            const page = await notion.createPage({ parent: { type: 'data_source_id', data_source_id: fs.dataSourceId }, properties })
            byTask.get(op.taskPageId)?.push(page)
            pageId = page.id
          }
          writes.count++
          linkedPages.add(pageId)
          state.focus.links[d.focusId] = { focusId: d.focusId, pageId, taskDidaId: d.taskDidaId, kind: d.kind, startTime: d.startKey, hash: d.hash }
          this.log({
            kind: existing ? 'relink' : 'create',
            title: `${d.title}${d.minutes !== null ? `（${d.minutes} 分钟）` : ''}`,
            didaId: d.taskDidaId,
            pageId
          })
        } else if (op.kind === 'focusUpdate') {
          const d = op.desired
          try {
            await notion.updatePage(op.pageId, { properties: buildFocusProperties(d, fs, op.taskPageId) })
          } catch (e) {
            if (e instanceof CliError && e.kind === 'not_found') {
              const link = state.focus.links[d.focusId]
              if (link) link.removed = true
              continue
            }
            throw e
          }
          writes.count++
          state.focus.links[d.focusId] = { ...state.focus.links[d.focusId]!, taskDidaId: d.taskDidaId, startTime: d.startKey, hash: d.hash }
          this.log({ kind: 'update', title: d.title, detail: '番茄记录', didaId: d.taskDidaId, pageId: op.pageId })
        } else {
          await notion.updatePage(op.pageId, { in_trash: true })
          writes.count++
          delete state.focus.links[op.focusId]
          this.log({ kind: 'trash', title: '滴答中已删除专注记录，番茄记录移入回收站', pageId: op.pageId })
        }
      } catch (e) {
        if (e instanceof CliError && (e.kind === 'validation' || e.kind === 'not_found')) {
          this.log({ kind: 'error', title: '写入番茄记录失败', detail: e.message })
          continue
        }
        throw e
      }
    }
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
    focus: { creates: 0, updates: 0, trashes: 0 },
    bodies: ops.filter((o) => o.kind === 'body').length,
    projectLinks: ops.filter(
      (o) =>
        (o.kind === 'create' && (o.desired.projectPageIds?.length ?? 0) > 0) ||
        (o.kind === 'update' && !!o.patch.projects && o.patch.projects.set.length > 0)
    ).length,
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

function countFocus(ops: FocusOp[]): RoundSummary['focus'] {
  return {
    creates: ops.filter((o) => o.kind === 'focusCreate').length,
    updates: ops.filter((o) => o.kind === 'focusUpdate').length,
    trashes: ops.filter((o) => o.kind === 'focusTrash').length
  }
}

function isSyncCallout(block: Record<string, unknown>): boolean {
  const rich = ((block.callout as { rich_text?: Array<{ plain_text?: string; text?: { content?: string } }> } | undefined)?.rich_text ?? [])
  return rich.map((r) => r.plain_text ?? r.text?.content ?? '').join('') === BODY_TITLE
}
