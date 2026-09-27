import { describe, expect, it } from 'vitest'
import { CliError } from '../../src/core/adapters/exec'
import { FLOW_IDS } from '../../src/core/adapters/fake'
import { probeCandidates, trackLists } from '../../src/core/sync/lists'
import { advance, domainPages, makeWorld, pageByDidaId, prop, taskPages, titleOf, type World } from './helpers'

const S = FLOW_IDS.status

async function initialized(seed: (w: World) => void, settings = {}) {
  const w = await makeWorld({ seed, settings })
  await w.engine().runRound({ initial: true })
  w.logs.length = 0
  advance(w, 1)
  return w
}

const setProject = (w: World, id: string, patch: Record<string, unknown>) => {
  w.dida.projects = w.dida.projects.map((p) => (p.id === id ? { ...p, ...patch } : p))
}
const removeProject = (w: World, id: string) => {
  w.dida.projects = w.dida.projects.filter((p) => p.id !== id)
}
const status = (w: World, didaId: string) => prop(pageByDidaId(w, didaId)!, '状态')?.status?.id
const logTitles = (w: World) => w.logs.map((l) => l.title)

describe('清单归档：不触发任何同步动作', () => {
  const seed = (w: World) => {
    w.dida.addTask({ id: 't1', projectId: 'p-dev', title: '写接口', content: '接口说明' })
    w.dida.addTask({ id: 't2', projectId: 'p-dev', title: '写文档' })
    w.dida.addTask({ id: 't3', projectId: 'p-read', title: '读书' })
  }
  const callouts = (w: World, didaId: string) => w.notion.blockTree(pageByDidaId(w, didaId)!.id).filter((b) => b.type === 'callout')

  it('归档后对 Notion 零写入：不改状态、不删页面、不查滴答，链接保留', async () => {
    const w = await initialized(seed)
    setProject(w, 'p-dev', { closed: true })
    // 归档清单里的变化（刚完成的、被删除的、新的番茄记录）都不处理
    w.dida.updateTask('t2', { status: 2, completedTime: '2026-09-27T08:00:30.000+0000' })
    w.dida.deleteTask('t1')
    w.dida.addFocus({ id: 'f1', type: 0, taskId: 't2', startTime: '2026-09-27T07:30:00+0000', endTime: '2026-09-27T07:55:00+0000', duration: 1500 })
    w.dida.calls.length = 0
    w.notion.writes = 0
    await w.engine().runRound()

    expect(w.notion.writes).toBe(0)
    expect(w.notion.pagesOf(FLOW_IDS.focus)).toHaveLength(0)
    expect(status(w, 't1')).toBe(S.todo)
    expect(status(w, 't2')).toBe(S.todo)
    expect(callouts(w, 't1')).toHaveLength(1)
    expect(w.dida.calls).not.toContain('get')
    const state = await w.store.load(w.profile.id)
    expect(Object.keys(state.tasks).sort()).toEqual(['t1', 't2', 't3'])
    expect(logTitles(w)).toContain('清单「开发」已归档，其中的任务不再同步（Notion 保持原样）')

    advance(w, 11)
    await w.engine().runRound({ forceReconcile: true })
    expect(w.notion.writes).toBe(0)
  })

  it('重新打开后恢复同步', async () => {
    const w = await initialized(seed)
    setProject(w, 'p-dev', { closed: true })
    await w.engine().runRound()
    advance(w, 10)
    setProject(w, 'p-dev', { closed: false })
    w.dida.updateTask('t2', { title: '写文档（第二版）' })
    w.logs.length = 0
    await w.engine().runRound()
    expect(titleOf(pageByDidaId(w, 't2')!)).toBe('写文档（第二版）')
    expect(logTitles(w)).toContain('清单「开发」已重新打开，恢复同步')
  })

  it('滴答的清单列表不返回已归档清单时：向滴答确认后按归档处理，不会误删', async () => {
    const w = await initialized(seed)
    const dev = w.dida.projects.find((p) => p.id === 'p-dev')!
    removeProject(w, 'p-dev')
    w.dida.hiddenProjects = [{ ...dev, closed: true }]
    w.dida.failGetForUnknownProject = true
    w.notion.writes = 0
    const res = await w.engine().runRound()
    expect(res.blocked).toBeNull()
    expect(w.notion.writes).toBe(0)
    expect(taskPages(w)).toHaveLength(3)
    expect(logTitles(w)).toContain('清单「开发」已归档，其中的任务不再同步（Notion 保持原样）')
    const view = await w.engine().inspectStructure(true)
    expect(view.rows.find((r) => r.didaId === 'p-dev')).toMatchObject({ status: 'archived' })
  })

  it('关闭同步区开关时，不清理归档清单里任务的同步区', async () => {
    const w = await initialized(seed)
    setProject(w, 'p-dev', { closed: true })
    w.settings = { ...w.settings, syncBody: false }
    await w.engine().runRound()
    expect(callouts(w, 't1')).toHaveLength(1)
  })

  it('映射页显示为已归档，没有警告', async () => {
    const w = await initialized(seed)
    setProject(w, 'p-dev', { closed: true })
    const view = await w.engine().inspectStructure(true)
    expect(view.warnings).toEqual([])
    expect(view.rows.find((r) => r.didaId === 'p-dev')).toMatchObject({ status: 'archived', notionTitle: '开发' })
  })
})

describe('清单被删除', () => {
  const seed = (w: World) => {
    w.dida.addTask({ id: 't1', projectId: 'p-dev', title: '写接口' })
    w.dida.addTask({ id: 't2', projectId: 'p-dev', title: '写文档' })
    w.dida.addTask({ id: 't3', projectId: 'p-read', title: '读书' })
  }
  const deleteList = (w: World, id: string) => {
    removeProject(w, id)
    for (const t of [...w.dida.tasks.values()]) if (t.projectId === id) w.dida.deleteTask(t.id)
  }

  it('按「删除任务」设置移入回收站，不向已删除的清单查询（接口报错也不影响）', async () => {
    const w = await initialized(seed)
    deleteList(w, 'p-dev')
    w.dida.failGetForUnknownProject = true
    const res = await w.engine().runRound()
    expect(res.blocked).toBeNull()
    expect(pageByDidaId(w, 't1')).toBeUndefined()
    expect(pageByDidaId(w, 't2')).toBeUndefined()
    expect(pageByDidaId(w, 't3')).toBeDefined()
    expect(logTitles(w)).toContain('清单「开发」已在滴答删除')
    expect(logTitles(w)).toContain('清单已在滴答删除，Notion 页面移入回收站「写接口」')
  })

  it('向滴答确认清单时出错：这一轮不删除，下一轮确认后再处理；每个清单只确认一次', async () => {
    const w = await initialized(seed)
    deleteList(w, 'p-dev')
    w.dida.projectErrors.set('p-dev', new CliError('DIDA API 错误 502: bad gateway', 'dida', 'server', 502))
    await w.engine().runRound()
    expect(taskPages(w)).toHaveLength(3)

    w.dida.projectErrors.clear()
    advance(w, 1)
    await w.engine().runRound()
    expect(pageByDidaId(w, 't1')).toBeUndefined()

    w.dida.calls.length = 0
    advance(w, 1)
    await w.engine().runRound()
    expect(w.dida.calls).not.toContain('getProject')
  })

  it('先归档、后删除：24 小时内不重复确认，之后确认已删除再按删除设置处理', async () => {
    const w = await initialized(seed)
    const dev = w.dida.projects.find((p) => p.id === 'p-dev')!
    removeProject(w, 'p-dev')
    w.dida.hiddenProjects = [{ ...dev, closed: true }]
    await w.engine().runRound()
    expect(taskPages(w)).toHaveLength(3)

    // 归档的清单在滴答里被删除
    w.dida.hiddenProjects = []
    for (const t of [...w.dida.tasks.values()]) if (t.projectId === 'p-dev') w.dida.deleteTask(t.id)
    advance(w, 60)
    w.dida.calls.length = 0
    await w.engine().runRound()
    expect(w.dida.calls).not.toContain('getProject')
    expect(taskPages(w)).toHaveLength(3)

    advance(w, 60 * 24)
    await w.engine().runRound()
    expect(pageByDidaId(w, 't1')).toBeUndefined()
    expect(pageByDidaId(w, 't3')).toBeDefined()
    expect(logTitles(w)).toContain('清单「开发」已在滴答删除')
  })

  it('「标记放弃」策略下标记放弃', async () => {
    const w = await initialized(seed, { deletePolicy: 'abandon' })
    deleteList(w, 'p-dev')
    await w.engine().runRound()
    expect(status(w, 't1')).toBe(S.abandoned)
  })

  it('一次删除超过 5 个仍会暂停等待确认', async () => {
    const w = await initialized((w) => {
      for (let i = 0; i < 7; i++) w.dida.addTask({ id: `t${i}`, projectId: 'p-dev', title: `任务${i}` })
    })
    deleteList(w, 'p-dev')
    const res = await w.engine().runRound()
    expect(res.blocked?.trash).toBe(7)
    expect(taskPages(w)).toHaveLength(7)
  })

  it('滴答返回空的清单列表时跳过这一轮，不删除、不解除关联', async () => {
    const w = await initialized(seed)
    w.dida.projects = []
    await expect(w.engine().runRound()).rejects.toThrow('清单列表为空')
    expect(taskPages(w)).toHaveLength(3)
    expect(Object.keys((await w.store.load(w.profile.id)).tasks).sort()).toEqual(['t1', 't2', 't3'])
  })

  it('映射页显示为已删除（没有警告），30 天后移除；同名新清单接回原来的二级领域', async () => {
    const w = await initialized(seed)
    const domainId = prop(pageByDidaId(w, 't1')!, '二级领域')!.relation![0]!.id
    deleteList(w, 'p-dev')
    await w.engine().runRound()
    let view = await w.engine().inspectStructure(true)
    expect(view.warnings).toEqual([])
    expect(view.rows.find((r) => r.didaId === 'p-dev')).toMatchObject({ status: 'deleted', didaName: '开发', notionTitle: '开发' })

    // 新建一个同名清单：接回原来的二级领域，不重复新建
    w.dida.projects.push({ id: 'p-dev2', name: '开发', groupId: 'g-work', kind: 'TASK' })
    w.dida.addTask({ id: 't9', projectId: 'p-dev2', title: '新清单的任务' })
    advance(w, 1)
    await w.engine().runRound()
    expect(prop(pageByDidaId(w, 't9')!, '二级领域')?.relation).toEqual([{ id: domainId }])
    expect(domainPages(w).filter((p) => titleOf(p, '二级领域') === '开发')).toHaveLength(1)

    advance(w, 60 * 24 * 31)
    await w.engine().runRound()
    view = await w.engine().inspectStructure(true)
    expect(view.rows.some((r) => r.didaId === 'p-dev')).toBe(false)
    expect((await w.store.load(w.profile.id)).domains.lists['p-dev']).toBeUndefined()
  })
})

describe('任务被移到不同步的地方', () => {
  it('移到排在很多归档清单后面的“不同步”清单：只解除关联，不进回收站', async () => {
    const w = await makeWorld({
      seed: (w) => {
        for (let i = 0; i < 12; i++) w.dida.projects.push({ id: `p-old${i}`, name: `旧清单${i}`, closed: true, kind: 'TASK' })
        w.dida.projects.push({ id: 'p-x', name: '私人', kind: 'TASK' })
        w.profile.scope.excludedLists = ['p-x']
        w.dida.addTask({ id: 't1', projectId: 'p-dev', title: '私事' })
      }
    })
    await w.engine().runRound({ initial: true })
    advance(w, 1)
    w.dida.updateTask('t1', { projectId: 'p-x' })
    await w.engine().runRound()
    expect(pageByDidaId(w, 't1')).toBeDefined()
    expect((await w.store.load(w.profile.id)).tasks.t1).toBeUndefined()
  })

  it('收件箱不同步时，移到收件箱的任务只解除关联', async () => {
    const w = await makeWorld({
      seed: (w) => {
        w.profile.scope.includeInbox = false
        w.dida.inboxInFilter = false
        w.dida.addTask({ id: 't1', projectId: 'p-dev', title: '随手记' })
      }
    })
    await w.engine().runRound({ initial: true })
    advance(w, 1)
    w.dida.updateTask('t1', { projectId: 'inbox123' })
    await w.engine().runRound()
    expect(pageByDidaId(w, 't1')).toBeDefined()
    expect((await w.store.load(w.profile.id)).tasks.t1).toBeUndefined()
  })
})

describe('「新建同名二级领域」', () => {
  it('连续多轮只新建一次', async () => {
    const w = await makeWorld({
      seed: (w) => {
        w.profile.mappings.lists['p-dev'] = { mode: 'create' }
        w.dida.addTask({ id: 't1', projectId: 'p-dev', title: 'A' })
      }
    })
    const devDomains = () => domainPages(w).filter((p) => titleOf(p, '二级领域') === '开发').length
    const before = devDomains()
    await w.engine().runRound({ initial: true })
    expect(devDomains()).toBe(before + 1)
    const total = domainPages(w).length
    for (let i = 0; i < 3; i++) {
      advance(w, 6)
      await w.engine().runRound()
    }
    expect(domainPages(w).length).toBe(total)
  })
})

describe('trackLists', () => {
  const base = { names: {}, zone: 'Asia/Shanghai' }
  const empty = { archived: {}, deleted: {} }

  it('新归档按时区记录检测日期；消失的清单确认后才算删除，没确认的先不动', () => {
    const now = new Date('2026-09-27T17:30:00Z') // 上海 09-28 01:30
    const input = {
      ...base,
      prev: { archived: { p2: { name: '旧', date: '2026-09-01', at: '2026-09-01T00:00:00Z' } }, deleted: {} },
      projects: [
        { id: 'p1', name: '开发', closed: true },
        { id: 'p2', name: '旧', closed: false },
        { id: 'p3', name: '没用过的归档', closed: true }
      ],
      knownProjectIds: ['p1', 'p2', 'p8', 'p9', 'inbox1'],
      names: { p9: '被删的' },
      now
    }
    expect(probeCandidates(input)).toEqual(['p8', 'p9'])
    const r = trackLists({ ...input, probes: new Map([['p8', { id: 'p8', name: '隐藏的归档', closed: true }], ['p9', null]]) })
    expect(r.archived.get('p1')).toBe('2026-09-28')
    expect(r.archived.get('p8')).toBe('2026-09-28')
    expect(r.archived.has('p3')).toBe(false)
    expect(r.deleted).toEqual(new Set(['p9']))
    expect(r.events).toEqual([
      { kind: 'archived', projectId: 'p1', name: '开发' },
      { kind: 'reopened', projectId: 'p2', name: '旧' },
      { kind: 'archived', projectId: 'p8', name: '隐藏的归档' },
      { kind: 'deleted', projectId: 'p9', name: '被删的' }
    ])

    const unconfirmed = trackLists({ ...input, probes: new Map([['p9', 'error']]) })
    expect(unconfirmed.deleted.size).toBe(0)
    expect(unconfirmed.pending).toEqual(new Set(['p8', 'p9']))
  })

  it('检测日期保持不变；已删除记录 30 天后过期；清单列表为空时不判定删除', () => {
    const prev = {
      archived: { p1: { name: '开发', date: '2026-09-01', at: '2026-09-01T00:00:00Z' } },
      deleted: { p9: { name: '被删的', at: '2026-08-01T00:00:00Z' } }
    }
    const r = trackLists({ ...base, prev, projects: [{ id: 'p1', name: '开发', closed: true }], knownProjectIds: ['p1', 'p9'], now: new Date('2026-09-27T00:00:00Z') })
    expect(r.archived.get('p1')).toBe('2026-09-01')
    expect(r.events).toEqual([])
    expect(r.expired).toEqual(['p9'])
    expect(r.deleted.size).toBe(0)

    const glitch = trackLists({ ...base, prev: { ...empty, deleted: { p9: prev.deleted.p9 } }, projects: [], knownProjectIds: ['p1'], now: new Date('2026-08-02T00:00:00Z') })
    expect(glitch.deleted).toEqual(new Set(['p9']))
    expect(glitch.events).toEqual([])
    expect(probeCandidates({ prev: empty, projects: [], knownProjectIds: ['p1'], now: new Date() })).toEqual([])
  })

  it('已归档但列表里没有的清单，24 小时内不重复确认', () => {
    const prev = { archived: { p1: { name: '开发', date: '2026-09-01', at: '2026-09-01T00:00:00Z', checkedAt: '2026-09-27T00:00:00Z' } }, deleted: {} }
    const input = { prev, projects: [{ id: 'p2', name: '别的' }], knownProjectIds: ['p1'] }
    expect(probeCandidates({ ...input, now: new Date('2026-09-27T20:00:00Z') })).toEqual([])
    expect(probeCandidates({ ...input, now: new Date('2026-09-28T01:00:00Z') })).toEqual(['p1'])
  })
})

describe('planTasks：归档清单', () => {
  it('即使拿到“查不到”的确认结果，也不删除归档清单里的任务', async () => {
    const { planTasks } = await import('../../src/core/sync/planner')
    const w = await initialized((w) => void w.dida.addTask({ id: 't1', projectId: 'p-dev', title: '写接口' }))
    const state = await w.store.load(w.profile.id)
    const result = planTasks({
      state,
      profile: w.profile,
      schema: w.profile.schema!,
      settings: w.settings,
      userTimeZone: 'Asia/Shanghai',
      domainPlan: { listMap: new Map(), scopeProjectIds: new Set(), ops: [], warnings: [], rows: [] },
      tasks: [],
      confirmations: new Map([['t1', null]]),
      linkedPages: null,
      pageChecks: new Map(),
      candidates: null,
      lists: { archived: new Set(['p-dev']), deleted: new Set() },
      initial: false,
      now: w.now.value
    })
    expect(result.ops).toEqual([])
  })
})
