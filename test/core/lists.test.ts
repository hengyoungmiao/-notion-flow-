import { describe, expect, it } from 'vitest'
import { FLOW_IDS } from '../../src/core/adapters/fake'
import { trackLists } from '../../src/core/sync/lists'
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
const doneDate = (w: World, didaId: string) => prop(pageByDidaId(w, didaId)!, '完成日期')?.date?.start ?? null
const logTitles = (w: World) => w.logs.map((l) => l.title)

describe('清单归档', () => {
  const seed = (w: World) => {
    w.dida.addTask({ id: 't1', projectId: 'p-dev', title: '写接口' })
    w.dida.addTask({ id: 't2', projectId: 'p-dev', title: '已完成的', timeZone: 'Asia/Shanghai' })
    w.dida.addTask({ id: 't3', projectId: 'p-read', title: '读书' })
  }
  /** t2 在归档前已经在滴答完成（上海时间 09-27 17:00） */
  const completeT2 = async (w: World) => {
    w.dida.updateTask('t2', { status: 2, completedTime: '2026-09-27T09:00:00.000+0000' })
    await w.engine().runRound()
    advance(w, 1)
  }

  it('未完成任务标记完成（完成日期为检测日），已完成的保持原日期，二级领域不变，不调用滴答接口', async () => {
    const w = await initialized(seed)
    await completeT2(w)
    const domainBefore = prop(pageByDidaId(w, 't1')!, '二级领域')?.relation
    setProject(w, 'p-dev', { closed: true })
    advance(w, 60 * 20) // 2026-09-28 12:00（上海）
    w.dida.addTask({ id: 't4', projectId: 'p-dev', title: '归档后完成', status: 2, completedTime: '2026-09-28T03:00:00.000+0000' })
    w.dida.calls.length = 0
    await w.engine().runRound()

    expect(status(w, 't1')).toBe(S.done)
    expect(doneDate(w, 't1')).toBe('2026-09-28')
    expect(doneDate(w, 't2')).toBe('2026-09-27')
    expect(status(w, 't3')).toBe(S.todo)
    expect(prop(pageByDidaId(w, 't1')!, '二级领域')?.relation).toEqual(domainBefore)
    expect(pageByDidaId(w, 't4')).toBeUndefined()
    expect(w.dida.calls).not.toContain('get')
    expect(logTitles(w)).toContain('清单「开发」已归档')
    expect(logTitles(w)).toContain('清单已归档，任务标记完成「写接口」')

    // 之后保持稳定，不再重复写入
    advance(w, 1)
    w.notion.writes = 0
    await w.engine().runRound()
    expect(w.notion.writes).toBe(0)
  })

  it('熔断后隔天才确认，完成日期仍是检测到归档的那天', async () => {
    const w = await initialized((w) => {
      for (let i = 0; i < 12; i++) w.dida.addTask({ id: `t${i}`, projectId: 'p-dev', title: `任务${i}` })
    })
    setProject(w, 'p-dev', { closed: true })
    const first = await w.engine().runRound()
    expect(first.blocked?.sample).toContain('清单已归档，任务标记完成「任务0」')
    expect(status(w, 't0')).toBe(S.todo)

    advance(w, 60 * 24)
    const approved = await w.engine().runRound({ approve: true })
    expect(approved.blocked).toBeNull()
    expect(taskPages(w).every((p) => prop(p, '完成日期')?.date?.start === '2026-09-27')).toBe(true)
  })

  it('清单重新打开：未完成的任务恢复为未完成，滴答里已完成的保持完成', async () => {
    const w = await initialized(seed)
    await completeT2(w)
    setProject(w, 'p-dev', { closed: true })
    await w.engine().runRound()
    expect(status(w, 't1')).toBe(S.done)

    advance(w, 10)
    setProject(w, 'p-dev', { closed: false })
    w.logs.length = 0
    await w.engine().runRound()
    expect(status(w, 't1')).toBe(S.todo)
    expect(doneDate(w, 't1')).toBeNull()
    expect(status(w, 't2')).toBe(S.done)
    expect(logTitles(w)).toContain('清单「开发」已重新打开，恢复按滴答状态同步')
  })

  it('关闭开关：只解除关联，页面保持原样，绝不移入回收站', async () => {
    const w = await initialized(seed, { archivedListsComplete: false })
    setProject(w, 'p-dev', { closed: true })
    w.dida.failGetForUnknownProject = true
    await w.engine().runRound()
    expect(status(w, 't1')).toBe(S.todo)
    expect(pageByDidaId(w, 't1')).toBeDefined()
    expect((await w.store.load(w.profile.id)).tasks.t1).toBeUndefined()
    expect(logTitles(w)).toContain('清单已归档，已解除关联「写接口」')
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

  it('新归档按时区记录检测日期；重新打开和删除产生事件', () => {
    const now = new Date('2026-09-27T17:30:00Z') // 上海 09-28 01:30
    const r = trackLists({
      ...base,
      prev: { archived: { p2: { name: '旧', date: '2026-09-01', at: '2026-09-01T00:00:00Z' } }, deleted: {} },
      projects: [
        { id: 'p1', name: '开发', closed: true },
        { id: 'p2', name: '旧', closed: false },
        { id: 'p3', name: '没用过的归档', closed: true }
      ],
      knownProjectIds: ['p1', 'p2', 'p9', 'inbox1'],
      names: { p9: '被删的' },
      now
    })
    expect(r.archived.get('p1')).toBe('2026-09-28')
    expect(r.archived.has('p3')).toBe(false)
    expect(r.deleted).toEqual(new Set(['p9']))
    expect(r.events).toEqual([
      { kind: 'archived', projectId: 'p1', name: '开发' },
      { kind: 'reopened', projectId: 'p2', name: '旧' },
      { kind: 'deleted', projectId: 'p9', name: '被删的' }
    ])
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
  })
})
