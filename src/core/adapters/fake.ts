import { randomUUID } from 'node:crypto'
import type {
  DidaFocus,
  DidaGroup,
  DidaPreference,
  DidaProject,
  DidaTag,
  DidaTask,
  NotionDataSource,
  NotionPage,
  NotionPropertySchema,
  NotionPropertyValue,
  NotionQueryResult
} from '../types'
import type { DidaReader, FocusKind } from './dida'
import type { NotionClient } from './notion'
import { CliError } from './exec'

// ───────────────────────── 假滴答（只读接口 + 测试用修改方法） ─────────────────────────

export class FakeDida implements DidaReader {
  projects: DidaProject[] = []
  groups: DidaGroup[] = []
  tasks = new Map<string, DidaTask>()
  focus = new Map<string, DidaFocus>()
  preference: DidaPreference = { timeZone: 'Asia/Shanghai' }
  calls: string[] = []
  failWith: CliError | null = null
  inboxInFilter = true
  /** 模拟接口对不存在的清单报错（而不是 404） */
  failGetForUnknownProject = false

  private check(name: string): void {
    this.calls.push(name)
    if (this.failWith) throw this.failWith
  }

  addTask(t: Partial<DidaTask> & { id?: string; projectId: string }): DidaTask {
    const task: DidaTask = { id: t.id ?? randomUUID().replace(/-/g, '').slice(0, 24), status: 0, etag: randomUUID().slice(0, 8), ...t }
    this.tasks.set(task.id, task)
    return task
  }

  updateTask(id: string, patch: Partial<DidaTask>): DidaTask {
    const t = this.tasks.get(id)
    if (!t) throw new Error(`no task ${id}`)
    const next = { ...t, ...patch, etag: randomUUID().slice(0, 8) }
    this.tasks.set(id, next)
    return next
  }

  deleteTask(id: string): void {
    this.tasks.delete(id)
  }

  addFocus(f: Partial<DidaFocus> & { id: string; startTime: string; endTime: string }): DidaFocus {
    const rec: DidaFocus = { type: 0, etag: randomUUID().slice(0, 8), ...f }
    this.focus.set(rec.id, rec)
    return rec
  }

  updateFocus(id: string, patch: Partial<DidaFocus>): void {
    const f = this.focus.get(id)
    if (f) this.focus.set(id, { ...f, ...patch, etag: randomUUID().slice(0, 8) })
  }

  async getPreference(): Promise<DidaPreference> {
    this.check('preference')
    return this.preference
  }
  async listProjects(): Promise<DidaProject[]> {
    this.check('projects')
    return structuredClone(this.projects)
  }
  async listGroups(): Promise<DidaGroup[]> {
    this.check('groups')
    return structuredClone(this.groups)
  }
  async listOpenTasks(projectIds?: string[]): Promise<DidaTask[]> {
    this.check('open')
    return [...this.tasks.values()]
      .filter((t) => (t.status ?? 0) === 0)
      .filter((t) => (projectIds ? projectIds.includes(t.projectId) : this.inboxInFilter || !t.projectId.startsWith('inbox')))
      .map((t) => structuredClone(t))
  }
  async listCompletedTasks(from: Date, to: Date): Promise<DidaTask[]> {
    this.check('completed')
    if (to.getTime() - from.getTime() > 30 * 86_400_000) throw new CliError('DIDA API 错误 400: range > 30 days', 'dida', 'validation', 400)
    return [...this.tasks.values()]
      .filter((t) => t.status === 2 && t.completedTime)
      .filter((t) => {
        const at = Date.parse(t.completedTime!.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
        return at >= from.getTime() && at <= to.getTime()
      })
      .map((t) => structuredClone(t))
  }
  async getTask(projectId: string, taskId: string): Promise<DidaTask | null> {
    this.check('get')
    if (this.failGetForUnknownProject && !projectId.startsWith('inbox') && !this.projects.some((p) => p.id === projectId))
      throw new CliError('DIDA API 错误 400: project not found', 'dida', 'validation', 400)
    const t = this.tasks.get(taskId)
    return t && t.projectId === projectId ? structuredClone(t) : null
  }
  async listTags(): Promise<DidaTag[]> {
    this.check('tags')
    const names = new Set<string>()
    for (const t of this.tasks.values()) for (const tag of t.tags ?? []) names.add(tag)
    return [...names].map((name) => ({ name, label: name }))
  }

  async listFocus(from: Date, to: Date, type: FocusKind): Promise<DidaFocus[]> {
    this.check(`focus:${type}`)
    if (to.getTime() - from.getTime() > 30 * 86_400_000) throw new CliError('DIDA API 错误 400: range > 30 days', 'dida', 'validation', 400)
    const want = type === 'pomodoro' ? 0 : 1
    return [...this.focus.values()]
      .filter((f) => Number(f.type ?? 0) === want)
      .filter((f) => {
        const at = Date.parse(f.startTime!.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
        return at >= from.getTime() && at <= to.getTime()
      })
      .map((f) => structuredClone(f))
  }

  async getFocus(focusId: string): Promise<DidaFocus | null> {
    this.check('focus:get')
    const f = this.focus.get(focusId)
    return f ? structuredClone(f) : null
  }

  async listInboxTasks(): Promise<DidaTask[] | null> {
    this.check('inbox')
    return [...this.tasks.values()].filter((t) => t.projectId.startsWith('inbox') && (t.status ?? 0) === 0)
  }
}

// ───────────────────────── 假 Notion（内存数据源） ─────────────────────────

interface FakeDs {
  ds: NotionDataSource
  pages: Map<string, NotionPage>
}

export interface FakeBlock {
  id: string
  type: string
  content: Record<string, unknown>
  children: FakeBlock[]
}

export class FakeNotion implements NotionClient {
  readonly sources = new Map<string, FakeDs>()
  /** 页面/块 → 子块 */
  readonly blocks = new Map<string, FakeBlock[]>()
  calls: string[] = []
  writes = 0
  failWith: CliError | null = null
  /** 测试用：下一次追加子块失败 */
  failNextAppend: CliError | null = null
  /** 测试用：下一次删除块失败 */
  failNextDelete: CliError | null = null
  workspaceName = '演示工作空间'
  private clock = Date.parse('2026-09-01T00:00:00Z')

  private tick(): string {
    this.clock += 60_000
    return new Date(this.clock).toISOString()
  }

  private check(name: string): void {
    this.calls.push(name)
    if (this.failWith) throw this.failWith
  }

  addDataSource(ds: NotionDataSource): void {
    this.sources.set(ds.id, { ds, pages: new Map() })
  }

  pagesOf(dsId: string): NotionPage[] {
    return [...(this.sources.get(dsId)?.pages.values() ?? [])]
  }

  findPage(id: string): { src: FakeDs; page: NotionPage } | null {
    for (const src of this.sources.values()) {
      const page = src.pages.get(id)
      if (page) return { src, page }
    }
    return null
  }

  private propName(ds: NotionDataSource, key: string): { name: string; schema: NotionPropertySchema } | null {
    for (const [name, p] of Object.entries(ds.properties)) if (p.id === key || name === key) return { name, schema: p }
    return null
  }

  private applyProps(src: FakeDs, page: NotionPage, props: Record<string, any>): void {
    for (const [key, value] of Object.entries(props ?? {})) {
      const found = this.propName(src.ds, key)
      if (!found) throw new CliError(`validation: property ${key} not found`, 'ntn', 'validation', 400)
      const { name, schema } = found
      const v: NotionPropertyValue = { id: schema.id, type: schema.type }
      if (schema.type === 'title') v.title = (value.title ?? []).map((t: any) => ({ plain_text: t.text?.content ?? '' }))
      else if (schema.type === 'rich_text') v.rich_text = (value.rich_text ?? []).map((t: any) => ({ plain_text: t.text?.content ?? '' }))
      else if (schema.type === 'status') {
        const opt = schema.status?.options.find((o) => o.id === value.status?.id || o.name === value.status?.name)
        if (value.status && !opt) throw new CliError('validation: status option', 'ntn', 'validation', 400)
        v.status = opt ? { id: opt.id, name: opt.name } : null
      } else if (schema.type === 'select') {
        const opt = schema.select?.options.find((o) => o.id === value.select?.id || o.name === value.select?.name)
        v.select = opt ? { id: opt.id, name: opt.name } : null
      } else if (schema.type === 'date') v.date = value.date ? { start: value.date.start, end: value.date.end ?? null } : null
      else if (schema.type === 'relation') v.relation = (value.relation ?? []).map((r: any) => ({ id: r.id }))
      else if (schema.type === 'number') v.number = value.number ?? null
      page.properties[name] = v
    }
  }

  private emptyProps(ds: NotionDataSource): Record<string, NotionPropertyValue> {
    const props: Record<string, NotionPropertyValue> = {}
    for (const [name, p] of Object.entries(ds.properties)) {
      const v: NotionPropertyValue = { id: p.id, type: p.type }
      if (p.type === 'title') v.title = []
      if (p.type === 'rich_text') v.rich_text = []
      if (p.type === 'relation') v.relation = []
      if (p.type === 'date') v.date = null
      if (p.type === 'status') v.status = null
      if (p.type === 'select') v.select = null
      props[name] = v
    }
    return props
  }

  /** 测试/演示用：直接放入一个页面 */
  seedPage(dsId: string, props: Record<string, any>, extra: Partial<NotionPage> = {}): NotionPage {
    const src = this.sources.get(dsId)!
    const at = this.tick()
    const page: NotionPage = {
      object: 'page',
      id: extra.id ?? randomUUID(),
      created_time: at,
      last_edited_time: at,
      in_trash: false,
      parent: { type: 'data_source_id', data_source_id: dsId },
      properties: this.emptyProps(src.ds),
      ...extra
    }
    page.url = `https://www.notion.so/${page.id.replace(/-/g, '')}`
    this.applyProps(src, page, props)
    src.pages.set(page.id, page)
    return page
  }

  async whoami() {
    this.check('whoami')
    return { name: '演示用户', workspaceName: this.workspaceName }
  }

  async search(query: string, objectType: 'page' | 'data_source') {
    this.check('search')
    if (objectType !== 'data_source') return []
    return [...this.sources.values()]
      .filter((s) => (s.ds.title ?? []).map((t) => t.plain_text).join('').includes(query) || query === 'FLO.W')
      .map((s) => ({ object: 'data_source', id: s.ds.id }))
  }

  async getDataSource(id: string): Promise<NotionDataSource> {
    this.check('getDataSource')
    const src = this.sources.get(id)
    if (!src) throw new CliError('Could not find data source', 'ntn', 'not_found', 404)
    return structuredClone(src.ds)
  }

  async updateDataSource(id: string, body: Record<string, any>): Promise<NotionDataSource> {
    this.check('updateDataSource')
    const src = this.sources.get(id)
    if (!src) throw new CliError('Could not find data source', 'ntn', 'not_found', 404)
    for (const [name, def] of Object.entries(body.properties ?? {})) {
      const type = Object.keys(def as object)[0] ?? 'rich_text'
      src.ds.properties[name] = { id: `p_${name}`, name, type }
      for (const page of src.pages.values()) page.properties[name] = { id: `p_${name}`, type, rich_text: [] }
    }
    this.writes++
    return structuredClone(src.ds)
  }

  async resolveDataSources(databaseId: string): Promise<string[]> {
    this.check('resolve')
    return this.sources.has(databaseId) ? [databaseId] : []
  }

  private matches(page: NotionPage, ds: NotionDataSource, filter: any): boolean {
    if (!filter) return true
    if (filter.and) return filter.and.every((f: any) => this.matches(page, ds, f))
    if (filter.or) return filter.or.some((f: any) => this.matches(page, ds, f))
    const found = this.propName(ds, filter.property)
    if (!found) return false
    const value = page.properties[found.name]
    if (filter.relation) {
      const ids = (value?.relation ?? []).map((r) => r.id)
      if ('contains' in filter.relation) return ids.includes(filter.relation.contains)
    }
    if (filter.rich_text) {
      const text = (value?.rich_text ?? []).map((t) => t.plain_text).join('')
      if (filter.rich_text.is_not_empty) return text.length > 0
      if (filter.rich_text.is_empty) return text.length === 0
      if ('equals' in filter.rich_text) return text === filter.rich_text.equals
    }
    return true
  }

  async queryDataSource(
    id: string,
    body: { filter?: unknown; start_cursor?: string; page_size?: number }
  ): Promise<NotionQueryResult<NotionPage>> {
    this.check('query')
    const src = this.sources.get(id)
    if (!src) throw new CliError('Could not find data source', 'ntn', 'not_found', 404)
    const all = [...src.pages.values()].filter((p) => !p.in_trash && this.matches(p, src.ds, body.filter))
    const start = body.start_cursor ? Number(body.start_cursor) : 0
    const size = body.page_size ?? 100
    const results = all.slice(start, start + size).map((p) => structuredClone(p))
    const next = start + size < all.length ? String(start + size) : null
    return { results, next_cursor: next, has_more: next !== null }
  }

  async getPage(id: string): Promise<NotionPage | null> {
    this.check('getPage')
    const found = this.findPage(id)
    return found ? structuredClone(found.page) : null
  }

  async createPage(body: Record<string, any>): Promise<NotionPage> {
    this.check('createPage')
    this.writes++
    const dsId = body.parent?.data_source_id as string
    if (!this.sources.has(dsId)) throw new CliError('Could not find data source', 'ntn', 'not_found', 404)
    return structuredClone(this.seedPage(dsId, body.properties ?? {}))
  }

  private toBlock(req: any): FakeBlock {
    const type = req.type as string
    const { children, ...content } = req[type] ?? {}
    const block: FakeBlock = { id: randomUUID(), type, content, children: [] }
    if (Array.isArray(children)) {
      block.children = children.map((c: any) => this.toBlock(c))
      this.blocks.set(block.id, block.children)
    }
    return block
  }

  async appendBlocks(parentId: string, children: unknown[], position?: { type: string; after_block?: { id: string } }) {
    this.check('appendBlocks')
    if (this.failNextAppend) {
      const e = this.failNextAppend
      this.failNextAppend = null
      throw e
    }
    if (children.length > 100) throw new CliError('validation: children > 100', 'ntn', 'validation', 400)
    if (this.findPage(parentId)?.page.in_trash)
      throw new CliError("Can't edit block that is archived. You must unarchive the block before editing.", 'ntn', 'validation', 400)
    this.writes++
    const list = this.blocks.get(parentId) ?? []
    const created = children.map((c) => this.toBlock(c))
    if (position?.type === 'page_start') list.unshift(...created)
    else if (position?.type === 'after_block') {
      const at = list.findIndex((b) => b.id === position.after_block?.id)
      list.splice(at + 1, 0, ...created)
    } else list.push(...created)
    this.blocks.set(parentId, list)
    return { results: created.map((b) => ({ id: b.id, type: b.type })) }
  }

  async deleteBlock(id: string): Promise<void> {
    this.check('deleteBlock')
    if (this.failNextDelete) {
      const e = this.failNextDelete
      this.failNextDelete = null
      throw e
    }
    this.writes++
    for (const [parent, list] of this.blocks) {
      const i = list.findIndex((b) => b.id === id)
      if (i >= 0) {
        list.splice(i, 1)
        this.blocks.set(parent, list)
      }
    }
  }

  async listBlocks(id: string) {
    this.check('listBlocks')
    return (this.blocks.get(id) ?? []).map((b) => ({ id: b.id, type: b.type, has_children: b.children.length > 0, [b.type]: b.content }))
  }

  /** 测试用：页面正文的块树 */
  blockTree(id: string): FakeBlock[] {
    return this.blocks.get(id) ?? []
  }

  async updatePage(id: string, body: Record<string, any>): Promise<NotionPage> {
    this.check('updatePage')
    this.writes++
    const found = this.findPage(id)
    if (!found) throw new CliError('Could not find page', 'ntn', 'not_found', 404)
    if (found.page.in_trash && body.properties && body.in_trash === undefined)
      throw new CliError("Can't edit block that is archived. You must unarchive the block before editing.", 'ntn', 'validation', 400)
    if (body.in_trash !== undefined) found.page.in_trash = !!body.in_trash
    if (body.properties) this.applyProps(found.src, found.page, body.properties)
    found.page.last_edited_time = this.tick()
    return structuredClone(found.page)
  }
}

// ───────────────────────── FLO.W 结构样板（测试 + 演示） ─────────────────────────

export const FLOW_IDS = {
  tasks: 'ds-tasks-0000-0000-0000-000000000001',
  focus: 'ds-focus-0000-0000-0000-000000000004',
  projects: 'ds-projects-00-0000-0000-000000000005',
  domains: 'ds-domains-000-0000-0000-000000000002',
  areas: 'ds-areas-0000-0000-0000-000000000003',
  status: { collect: 'st-collect', shelve: 'st-shelve', todo: 'st-todo', doing: 'st-doing', done: 'st-done', abandoned: 'st-abandoned' },
  type: { schedule: 'ty-schedule', todo: 'ty-todo' }
}

export function createFlowWorkspace(notion: FakeNotion, opts: { withDidaId?: boolean } = {}): void {
  const s = FLOW_IDS.status
  const taskProps: Record<string, NotionPropertySchema> = {
    任务: { id: 'title', name: '任务', type: 'title' },
    状态: {
      id: 'p_status',
      name: '状态',
      type: 'status',
      status: {
        options: [
          { id: s.collect, name: '收集' },
          { id: s.shelve, name: '搁置' },
          { id: s.todo, name: '待办' },
          { id: s.doing, name: '执行' },
          { id: s.done, name: '完成' },
          { id: s.abandoned, name: '放弃' }
        ],
        groups: [
          { id: 'g1', name: 'To-do', option_ids: [s.shelve, s.collect, s.todo] },
          { id: 'g2', name: 'In progress', option_ids: [s.doing] },
          { id: 'g3', name: 'Complete', option_ids: [s.done, s.abandoned] }
        ]
      }
    },
    任务类型: {
      id: 'p_type',
      name: '任务类型',
      type: 'select',
      select: { options: [{ id: FLOW_IDS.type.schedule, name: '日程' }, { id: FLOW_IDS.type.todo, name: '待办' }] }
    },
    排期: { id: 'p_sched', name: '排期', type: 'date' },
    完成日期: { id: 'p_done', name: '完成日期', type: 'date' },
    '下一步做什么？': { id: 'p_note', name: '下一步做什么？', type: 'rich_text' },
    二级领域: { id: 'p_domain', name: '二级领域', type: 'relation', relation: { data_source_id: FLOW_IDS.domains } },
    关联项目: { id: 'p_project', name: '关联项目', type: 'relation', relation: { data_source_id: FLOW_IDS.projects } },
    关联番茄: { id: 'p_pomo', name: '关联番茄', type: 'relation', relation: { data_source_id: FLOW_IDS.focus } }
  }
  if (opts.withDidaId) taskProps['滴答ID'] = { id: 'p_滴答ID', name: '滴答ID', type: 'rich_text' }
  notion.addDataSource({ id: FLOW_IDS.tasks, title: [{ plain_text: 'FLO.W - 我的任务 DB · Max' }], properties: taskProps })
  notion.addDataSource({
    id: FLOW_IDS.domains,
    title: [{ plain_text: 'FLO.W - 二级领域 DB · Max' }],
    properties: {
      二级领域: { id: 'title', name: '二级领域', type: 'title' },
      'FLOW - 一级领域': { id: 'p_area', name: 'FLOW - 一级领域', type: 'relation', relation: { data_source_id: FLOW_IDS.areas } }
    }
  })
  notion.addDataSource({
    id: FLOW_IDS.projects,
    title: [{ plain_text: 'FLO.W - 我的项目 DB · Max' }],
    properties: {
      Name: { id: 'title', name: 'Name', type: 'title' },
      关联任务: { id: 'pr_tasks', name: '关联任务', type: 'relation', relation: { data_source_id: FLOW_IDS.tasks } }
    }
  })
  notion.addDataSource({
    id: FLOW_IDS.focus,
    title: [{ plain_text: '任务番茄数据库' }],
    properties: {
      名称: { id: 'title', name: '名称', type: 'title' },
      关联任务: { id: 'f_task', name: '关联任务', type: 'relation', relation: { data_source_id: FLOW_IDS.tasks } },
      开始时间: { id: 'f_start', name: '开始时间', type: 'date' },
      结束时间: { id: 'f_end', name: '结束时间', type: 'date' },
      番茄默认时长: { id: 'f_minutes', name: '番茄默认时长', type: 'number' },
      番茄提醒: { id: 'f_remind', name: '番茄提醒', type: 'date' }
    }
  })
  notion.addDataSource({
    id: FLOW_IDS.areas,
    title: [{ plain_text: 'FLO.W - 一级领域 DB · Max' }],
    properties: { 一级领域: { id: 'title', name: '一级领域', type: 'title' } }
  })
}
