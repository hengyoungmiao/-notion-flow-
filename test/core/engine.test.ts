import { describe, expect, it } from 'vitest'
import { FLOW_IDS } from '../../src/core/adapters/fake'
import { CliError } from '../../src/core/adapters/exec'
import { NeedsInitialSyncError } from '../../src/core/sync/engine'
import { MemoryStateStore } from '../../src/core/sync/state'
import { advance, areaPages, domainPages, makeWorld, pageByDidaId, prop, syncSection, taskPages, titleOf, type World } from './helpers'

const S = FLOW_IDS.status

describe('initial sync', () => {
  it('previews without writing anything', async () => {
    const w = await makeWorld({
      seed: (w) => {
        w.dida.addTask({ id: 't1', projectId: 'p-dev', title: '写周报' })
        w.dida.addTask({ id: 't2', projectId: 'p-read', title: '读书' })
        w.dida.addTask({ id: 't3', projectId: 'p-notes', title: '笔记', kind: 'NOTE' })
      }
    })
    const res = await w.engine().runRound({ initial: true, dryRun: true })
    expect(res.applied).toBe(false)
    expect(res.summary.creates.map((c) => c.title).sort()).toEqual(['写周报', '读书'])
    expect(res.summary.domainCreates.map((d) => d.title).sort()).toEqual(['工作', '开发', '生活', '阅读', '零散'].sort())
    expect(w.notion.writes).toBe(0)
    expect((await w.store.load(w.profile.id)).initializedAt).toBeNull()
  })

  it('refuses steady-state rounds before the initial sync', async () => {
    const w = await makeWorld()
    await expect(w.engine().runRound()).rejects.toBeInstanceOf(NeedsInitialSyncError)
  })

  it('creates pages with owned fields and domain/area bindings', async () => {
    const w = await makeWorld({
      seed: (w) => {
        w.dida.addTask({
          id: 't1',
          projectId: 'p-dev',
          title: '上线新版本',
          content: '先跑回归测试',
          isAllDay: false,
          dueDate: '2026-09-28T06:00:00.000+0000',
          timeZone: 'Asia/Shanghai'
        })
        w.dida.addTask({ id: 't2', projectId: 'p-loose', title: '买菜', isAllDay: true, dueDate: '2026-09-27T16:00:00.000+0000', timeZone: 'Asia/Shanghai' })
      }
    })
    const res = await w.engine().runRound({ initial: true })
    expect(res.applied).toBe(true)
    const p1 = pageByDidaId(w, 't1')!
    expect(titleOf(p1)).toBe('上线新版本')
    expect(prop(p1, '状态')?.status?.id).toBe(S.todo)
    expect(prop(p1, '排期')?.date).toEqual({ start: '2026-09-28T14:00:00+08:00', end: null })
    // 描述写进页面顶部同步区，「下一步做什么？」留空给用户和 Claude
    expect(titleOf(p1, '下一步做什么？')).toBe('')
    expect(syncSection(w, p1.id)).toEqual(['先跑回归测试'])
    expect(prop(p1, '任务类型')?.select?.id).toBe(FLOW_IDS.type.schedule)

    const devDomain = domainPages(w).find((d) => titleOf(d, '二级领域') === '开发')!
    const workArea = areaPages(w).find((a) => titleOf(a, '一级领域') === '工作')!
    expect(prop(p1, '二级领域')?.relation).toEqual([{ id: devDomain.id }])
    expect(prop(devDomain, 'FLOW - 一级领域')?.relation).toEqual([{ id: workArea.id }])

    const p2 = pageByDidaId(w, 't2')!
    expect(prop(p2, '排期')?.date).toEqual({ start: '2026-09-28', end: null })
    expect(prop(p2, '任务类型')?.select?.id).toBe(FLOW_IDS.type.todo)
    const loose = domainPages(w).find((d) => titleOf(d, '二级领域') === '零散')!
    expect(prop(loose, 'FLOW - 一级领域')?.relation).toEqual([])

    const state = await w.store.load(w.profile.id)
    expect(state.initializedAt).not.toBeNull()
    expect(Object.keys(state.tasks).sort()).toEqual(['t1', 't2'])
  })

  it('matches existing Notion tasks and domains by name instead of duplicating', async () => {
    const w = await makeWorld({
      seed: (w) => {
        const area = w.notion.seedPage(FLOW_IDS.areas, { title: { title: [{ text: { content: '工作' } }] } })
        w.notion.seedPage(FLOW_IDS.domains, {
          title: { title: [{ text: { content: '开发' } }] },
          p_area: { relation: [{ id: area.id }] }
        })
        w.notion.seedPage(FLOW_IDS.tasks, {
          title: { title: [{ text: { content: '写周报' } }] },
          p_status: { status: { id: S.doing } },
          p_project: { relation: [{ id: 'proj-1' }] }
        })
        w.dida.addTask({ id: 't1', projectId: 'p-dev', title: '写周报', content: '本周进展' })
      }
    })
    const res = await w.engine().runRound({ initial: true })
    expect(res.summary.matches).toHaveLength(1)
    expect(taskPages(w)).toHaveLength(1)
    const page = taskPages(w)[0]!
    expect(titleOf(page, '滴答ID')).toBe('t1')
    // 未完成组内的具体状态（执行）保留，Notion 专属字段不动
    expect(prop(page, '状态')?.status?.id).toBe(S.doing)
    expect(prop(page, '关联项目')?.relation).toEqual([{ id: 'proj-1' }])
    expect(titleOf(page, '下一步做什么？')).toBe('')
    expect(syncSection(w, page.id)).toEqual(['本周进展'])
    expect(domainPages(w).filter((d) => titleOf(d, '二级领域') === '开发')).toHaveLength(1)
    expect(areaPages(w).filter((a) => titleOf(a, '一级领域') === '工作')).toHaveLength(1)
  })

  it('binds matched tasks to domains created in the same round', async () => {
    const w = await makeWorld({
      seed: (w) => {
        w.notion.seedPage(FLOW_IDS.tasks, { title: { title: [{ text: { content: '客户周会' } }] } })
        w.dida.addTask({ id: 't1', projectId: 'p-dev', title: '客户周会' })
      }
    })
    await w.engine().runRound({ initial: true })
    const dev = domainPages(w).find((d) => titleOf(d, '二级领域') === '开发')!
    expect(prop(pageByDidaId(w, 't1')!, '二级领域')?.relation).toEqual([{ id: dev.id }])
    advance(w, 11)
    w.logs.length = 0
    const res = await w.engine().runRound()
    expect(res.summary.counts.corrections).toBe(0)
    expect(res.writes).toBe(0)
  })

  it('relinks pages that already carry a 滴答ID when local state is lost', async () => {
    const w = await makeWorld({ seed: (w) => void w.dida.addTask({ id: 't1', projectId: 'p-dev', title: 'A' }) })
    await w.engine().runRound({ initial: true })
    expect(taskPages(w)).toHaveLength(1)
    w.store = new MemoryStateStore()
    await w.engine().runRound({ initial: true })
    expect(taskPages(w)).toHaveLength(1)
    expect(Object.keys((await w.store.load(w.profile.id)).tasks)).toEqual(['t1'])
  })
})

async function initialized(seed: (w: World) => void, settings = {}) {
  const w = await makeWorld({ seed, settings })
  await w.engine().runRound({ initial: true })
  w.logs.length = 0
  advance(w, 1)
  return w
}

describe('steady state (滴答 → Notion)', () => {
  it('updates changed fields and keeps the Notion open sub-status', async () => {
    const w = await initialized((w) => void w.dida.addTask({ id: 't1', projectId: 'p-dev', title: '旧标题' }))
    const page = pageByDidaId(w, 't1')!
    await w.notion.updatePage(page.id, { properties: { p_status: { status: { id: S.doing } } } })
    w.dida.updateTask('t1', { title: '新标题' })
    const e = w.engine()
    await e.runRound()
    const after = pageByDidaId(w, 't1')!
    expect(titleOf(after)).toBe('新标题')
    expect(prop(after, '状态')?.status?.id).toBe(S.doing)
    expect(w.logs.some((l) => l.kind === 'update')).toBe(true)
  })

  it('does nothing when nothing changed', async () => {
    const w = await initialized((w) => void w.dida.addTask({ id: 't1', projectId: 'p-dev', title: 'A' }))
    const e = w.engine()
    await e.runRound({ forceReconcile: true })
    w.notion.writes = 0
    advance(w, 1)
    const res = await e.runRound({ forceReconcile: true })
    expect(res.writes).toBe(0)
    expect(w.notion.writes).toBe(0)
  })

  it('syncs completion, reopening and abandonment', async () => {
    const w = await initialized((w) => void w.dida.addTask({ id: 't1', projectId: 'p-dev', title: 'A', timeZone: 'Asia/Shanghai' }))
    const e = w.engine()
    w.dida.updateTask('t1', { status: 2, completedTime: '2026-09-27T08:00:30.000+0000' })
    await e.runRound()
    let page = pageByDidaId(w, 't1')!
    expect(prop(page, '状态')?.status?.id).toBe(S.done)
    expect(prop(page, '完成日期')?.date?.start).toBe('2026-09-27')

    advance(w, 1)
    w.dida.updateTask('t1', { status: 0, completedTime: null })
    await e.runRound()
    page = pageByDidaId(w, 't1')!
    expect(prop(page, '状态')?.status?.id).toBe(S.todo)
    expect(prop(page, '完成日期')?.date).toBeNull()

    // 放弃的任务不在未完成/已完成列表里，靠逐条确认发现
    advance(w, 1)
    w.dida.updateTask('t1', { status: -1 })
    await e.runRound()
    page = pageByDidaId(w, 't1')!
    expect(prop(page, '状态')?.status?.id).toBe(S.abandoned)
  })

  it('stops re-checking tasks that are already closed in Notion', async () => {
    const w = await initialized((w) => void w.dida.addTask({ id: 't1', projectId: 'p-dev', title: 'A' }))
    const e = w.engine()
    w.dida.updateTask('t1', { status: 2, completedTime: '2026-09-27T08:00:30.000+0000' })
    await e.runRound()
    expect(prop(pageByDidaId(w, 't1')!, '状态')?.status?.id).toBe(S.done)
    // 三天后已完成任务不在时间窗口内，也不应每轮都逐条确认
    advance(w, 3 * 24 * 60)
    await e.runRound()
    advance(w, 1)
    w.dida.calls = []
    await e.runRound()
    expect(w.dida.calls.filter((c) => c === 'get')).toHaveLength(0)
    expect(pageByDidaId(w, 't1')).toBeDefined()
  })

  it('creates tasks that were added and completed between rounds', async () => {
    const w = await initialized(() => {})
    w.dida.addTask({ id: 't9', projectId: 'p-dev', title: '顺手完成', status: 2, completedTime: '2026-09-27T08:00:40.000+0000' })
    await w.engine().runRound()
    expect(prop(pageByDidaId(w, 't9')!, '状态')?.status?.id).toBe(S.done)
  })

  it('skips recurring completion records by default', async () => {
    const w = await initialized((w) =>
      void w.dida.addTask({ id: 'r1', projectId: 'p-dev', title: '每日站会', repeatFlag: 'RRULE:FREQ=DAILY' })
    )
    w.dida.addTask({ id: 'r1-done', projectId: 'p-dev', title: '每日站会', status: 2, completedTime: '2026-09-27T08:00:40.000+0000' })
    await w.engine().runRound()
    expect(pageByDidaId(w, 'r1-done')).toBeUndefined()
  })

  it('moves tasks between domains and keeps manually added relations', async () => {
    const w = await initialized((w) => void w.dida.addTask({ id: 't1', projectId: 'p-dev', title: 'A' }))
    const page = pageByDidaId(w, 't1')!
    const extra = w.notion.seedPage(FLOW_IDS.domains, { title: { title: [{ text: { content: '手动领域' } }] } })
    const current = prop(page, '二级领域')!.relation!
    await w.notion.updatePage(page.id, { properties: { p_domain: { relation: [...current, { id: extra.id }] } } })
    w.dida.updateTask('t1', { projectId: 'p-read' })
    await w.engine().runRound()
    const readDomain = domainPages(w).find((d) => titleOf(d, '二级领域') === '阅读')!
    const ids = prop(pageByDidaId(w, 't1')!, '二级领域')!.relation!.map((r) => r.id)
    expect(ids.sort()).toEqual([extra.id, readDomain.id].sort())
  })

  it('unlinks tasks moved out of scope and keeps the page', async () => {
    const w = await initialized((w) => void w.dida.addTask({ id: 't1', projectId: 'p-dev', title: 'A' }))
    w.profile.scope.excludedLists = ['p-read']
    w.dida.updateTask('t1', { projectId: 'p-read' })
    await w.engine().runRound()
    expect(pageByDidaId(w, 't1')).toBeDefined()
    expect((await w.store.load(w.profile.id)).tasks.t1).toBeUndefined()
  })

  it('handles inbox tasks without a domain', async () => {
    const w = await initialized((w) => void w.dida.addTask({ id: 't1', projectId: 'inbox123', title: '收件箱任务' }))
    expect(prop(pageByDidaId(w, 't1')!, '二级领域')?.relation).toEqual([])
  })
})

describe('deletions and safety', () => {
  const seedMany = (n: number) => (w: World) => {
    for (let i = 0; i < n; i++) w.dida.addTask({ id: `t${i}`, projectId: 'p-dev', title: `任务${i}` })
  }

  it('trashes the Notion page after confirming the dida task is gone', async () => {
    const w = await initialized(seedMany(2))
    w.dida.deleteTask('t0')
    await w.engine().runRound()
    expect(pageByDidaId(w, 't0')).toBeUndefined()
    expect(w.notion.pagesOf(FLOW_IDS.tasks).find((p) => p.in_trash)).toBeDefined()
    expect(pageByDidaId(w, 't1')).toBeDefined()
  })

  it('supports the abandon and ignore delete policies', async () => {
    const w = await initialized(seedMany(2), { deletePolicy: 'abandon' })
    w.dida.deleteTask('t0')
    await w.engine().runRound()
    expect(prop(pageByDidaId(w, 't0')!, '状态')?.status?.id).toBe(S.abandoned)

    const w2 = await initialized(seedMany(1), { deletePolicy: 'ignore' })
    w2.dida.deleteTask('t0')
    await w2.engine().runRound()
    expect(prop(pageByDidaId(w2, 't0')!, '状态')?.status?.id).toBe(S.todo)
    expect((await w2.store.load(w2.profile.id)).tasks.t0).toBeUndefined()
  })

  it('blocks mass deletions until approved', async () => {
    const w = await initialized(seedMany(8))
    for (let i = 0; i < 6; i++) w.dida.deleteTask(`t${i}`)
    const e = w.engine()
    const res = await e.runRound()
    expect(res.blocked).not.toBeNull()
    expect(taskPages(w)).toHaveLength(8)
    expect((await w.store.load(w.profile.id)).pendingApproval?.trash).toBe(6)

    advance(w, 1)
    const approved = await e.runRound({ approve: true })
    expect(approved.blocked).toBeNull()
    expect(taskPages(w)).toHaveLength(2)
    expect((await w.store.load(w.profile.id)).pendingApproval).toBeNull()
  })

  it('keeps one pending approval across blocked rounds and only counts applied ops', async () => {
    const w = await initialized(seedMany(8))
    for (let i = 0; i < 6; i++) w.dida.deleteTask(`t${i}`)
    w.dida.addTask({ id: 'n1', projectId: 'p-dev', title: '新任务' })
    const e = w.engine()
    const first = await e.runRound()
    expect(first.summary.counts.destructive).toBe(6)
    expect(first.appliedCounts.destructive).toBe(0)
    expect(first.appliedCounts.creates).toBe(1)

    advance(w, 1)
    const second = await e.runRound()
    expect(second.blocked?.createdAt).toBe(first.blocked?.createdAt)
    expect(second.appliedCounts.destructive).toBe(0)
  })

  it('corrects Notion edits to owned fields during reconciliation', async () => {
    const w = await initialized((w) => void w.dida.addTask({ id: 't1', projectId: 'p-dev', title: '正确标题' }))
    const page = pageByDidaId(w, 't1')!
    await w.notion.updatePage(page.id, {
      properties: { title: { title: [{ text: { content: '被改了' } }] }, p_project: { relation: [{ id: 'proj-9' }] } }
    })
    advance(w, 11)
    await w.engine().runRound()
    const after = pageByDidaId(w, 't1')!
    expect(titleOf(after)).toBe('正确标题')
    expect(prop(after, '关联项目')?.relation).toEqual([{ id: 'proj-9' }])
    expect(w.logs.some((l) => l.kind === 'correct')).toBe(true)
  })

  it('respects pages deleted in Notion and does not recreate them', async () => {
    const w = await initialized((w) => void w.dida.addTask({ id: 't1', projectId: 'p-dev', title: 'A' }))
    await w.notion.updatePage(pageByDidaId(w, 't1')!.id, { in_trash: true })
    advance(w, 11)
    const e = w.engine()
    await e.runRound()
    advance(w, 11)
    w.dida.updateTask('t1', { title: 'B' })
    await e.runRound()
    expect(taskPages(w)).toHaveLength(0)
    const state = await w.store.load(w.profile.id)
    expect(state.notionRemoved.t1).toBeDefined()
    expect(w.logs.some((l) => l.kind === 'removed')).toBe(true)
  })

  it('never creates a duplicate if a page with the 滴答ID already exists', async () => {
    const w = await initialized(() => {})
    w.notion.seedPage(FLOW_IDS.tasks, {
      title: { title: [{ text: { content: '别处创建' } }] },
      p_滴答ID: { rich_text: [{ text: { content: 't5' } }] }
    })
    w.dida.addTask({ id: 't5', projectId: 'p-dev', title: '别处创建' })
    await w.engine().runRound()
    expect(taskPages(w).filter((p) => titleOf(p, '滴答ID') === 't5')).toHaveLength(1)
  })

  it('propagates auth errors so the app can pause and notify', async () => {
    const w = await initialized(() => {})
    w.dida.failWith = new CliError('DIDA API 错误 401', 'dida', 'auth', 401)
    await expect(w.engine().runRound({ forceStructure: true })).rejects.toMatchObject({ kind: 'auth' })
  })
})

describe('domain structure', () => {
  it('propagates list renames and folder moves', async () => {
    const w = await initialized((w) => void w.dida.addTask({ id: 't1', projectId: 'p-dev', title: 'A' }))
    w.dida.projects = w.dida.projects.map((p) => (p.id === 'p-dev' ? { ...p, name: '研发', groupId: 'g-life' } : p))
    await w.engine().runRound({ forceStructure: true })
    const domain = domainPages(w).find((d) => titleOf(d, '二级领域') === '研发')
    expect(domain).toBeDefined()
    const life = areaPages(w).find((a) => titleOf(a, '一级领域') === '生活')!
    expect(prop(domain!, 'FLOW - 一级领域')?.relation).toEqual([{ id: life.id }])
  })

  it('keeps task domains when the Notion domain page was deleted', async () => {
    const w = await initialized((w) => void w.dida.addTask({ id: 't1', projectId: 'p-dev', title: 'A' }))
    const dev = domainPages(w).find((d) => titleOf(d, '二级领域') === '开发')!
    await w.notion.updatePage(dev.id, { in_trash: true })
    w.dida.updateTask('t1', { title: 'B' })
    const res = await w.engine().runRound({ forceStructure: true })
    expect(res.summary.warnings.some((m) => m.includes('已被删除'))).toBe(true)
    expect(prop(pageByDidaId(w, 't1')!, '二级领域')?.relation).toEqual([{ id: dev.id }])
    expect(titleOf(pageByDidaId(w, 't1')!)).toBe('B')
  })

  it('honours manual mappings', async () => {
    const w = await makeWorld({
      seed: (w) => {
        const custom = w.notion.seedPage(FLOW_IDS.domains, { title: { title: [{ text: { content: '软件开发' } }] } })
        w.profile.mappings.lists['p-dev'] = { mode: 'map', pageId: custom.id }
        w.dida.addTask({ id: 't1', projectId: 'p-dev', title: 'A' })
      }
    })
    await w.engine().runRound({ initial: true })
    const custom = domainPages(w).find((d) => titleOf(d, '二级领域') === '软件开发')!
    expect(prop(pageByDidaId(w, 't1')!, '二级领域')?.relation).toEqual([{ id: custom.id }])
    expect(domainPages(w).find((d) => titleOf(d, '二级领域') === '开发')).toBeUndefined()
  })
})
