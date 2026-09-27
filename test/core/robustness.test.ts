import { describe, expect, it } from 'vitest'
import { CliError } from '../../src/core/adapters/exec'
import { FLOW_IDS } from '../../src/core/adapters/fake'
import { SyncEngine } from '../../src/core/sync/engine'
import type { FlowSchema } from '../../src/core/types'
import { advance, makeWorld, pageByDidaId, prop, syncSection, type World } from './helpers'

const S = FLOW_IDS.status
const callouts = (w: World, pageId: string) => w.notion.blockTree(pageId).filter((b) => b.type === 'callout')
const tasksDs = (w: World) => w.notion.sources.get(FLOW_IDS.tasks)!.ds

async function initialized(seed: (w: World) => void, settings = {}) {
  const w = await makeWorld({ seed, settings })
  await w.engine().runRound({ initial: true })
  w.logs.length = 0
  advance(w, 1)
  return w
}

describe('任务库字段变化', () => {
  it('Notion 里新增的状态选项不会被改回「待办」', async () => {
    const w = await initialized((w) => void w.dida.addTask({ id: 't1', projectId: 'p-dev', title: '写接口' }))
    const status = tasksDs(w).properties['状态']!.status!
    status.options.push({ id: 'st-wait', name: '等待' })
    status.groups.find((g) => g.name === 'In progress')!.option_ids.push('st-wait')
    const page = pageByDidaId(w, 't1')!
    await w.notion.updatePage(page.id, { properties: { p_status: { status: { id: 'st-wait' } } } })

    const saved: FlowSchema[] = []
    const engine = new SyncEngine({
      dida: w.dida,
      notion: w.notion,
      store: w.store,
      profile: w.profile,
      settings: w.settings,
      log: (e) => w.logs.push(e),
      now: () => w.now.value,
      onSchemaChange: (s) => saved.push(s)
    })
    advance(w, 11)
    await engine.runRound()
    expect(prop(pageByDidaId(w, 't1')!, '状态')?.status?.id).toBe('st-wait')
    expect(saved[0]?.tasks.statusGroups['st-wait']).toBe('open')
  })

  it('可选字段被删除：不再写入并给出提示，其它字段照常同步', async () => {
    const w = await initialized((w) => void w.dida.addTask({ id: 't1', projectId: 'p-dev', title: '写接口' }))
    delete tasksDs(w).properties['完成日期']
    w.dida.updateTask('t1', { status: 2, completedTime: '2026-09-27T09:00:00.000+0000' })
    const res = await w.engine().runRound()
    expect(res.summary.warnings).toContain('任务库的「完成日期」字段已被删除，暂停同步这个字段')
    expect(prop(pageByDidaId(w, 't1')!, '状态')?.status?.id).toBe(S.done)
    expect(w.logs.some((l) => l.kind === 'error')).toBe(false)
  })

  it('属性 ID 编码形式不同（%E6… 与原文）视为同一个字段，并改用任务库里的写法', async () => {
    const w = await initialized((w) => void w.dida.addTask({ id: 't1', projectId: 'p-dev', title: '写接口' }))
    const original = w.profile.schema!.tasks.props.didaId
    w.profile.schema = {
      ...w.profile.schema!,
      tasks: { ...w.profile.schema!.tasks, props: { ...w.profile.schema!.tasks.props, didaId: encodeURIComponent(original) } }
    }
    expect(w.profile.schema.tasks.props.didaId).not.toBe(original)
    const saved: FlowSchema[] = []
    const engine = new SyncEngine({
      dida: w.dida,
      notion: w.notion,
      store: w.store,
      profile: w.profile,
      settings: w.settings,
      log: (e) => w.logs.push(e),
      now: () => w.now.value,
      onSchemaChange: (s) => saved.push(s)
    })
    w.dida.addTask({ id: 't2', projectId: 'p-dev', title: '新任务' })
    const res = await engine.runRound()
    expect(res.summary.warnings.some((m) => m.includes('重新识别'))).toBe(false)
    expect(saved[0]?.tasks.props.didaId).toBe(original)
    expect(pageByDidaId(w, 't2')).toBeDefined()
    expect(w.logs.some((l) => l.kind === 'error')).toBe(false)
  })

  it('任务库返回编码形式的 ID、本地存的是原文：同样视为同一个字段', async () => {
    const w = await initialized((w) => void w.dida.addTask({ id: 't1', projectId: 'p-dev', title: '写接口' }))
    const ds = tasksDs(w)
    const encoded = encodeURIComponent(ds.properties['滴答ID']!.id)
    ds.properties['滴答ID'] = { ...ds.properties['滴答ID']!, id: encoded }
    w.dida.addTask({ id: 't2', projectId: 'p-dev', title: '新任务' })
    const res = await w.engine().runRound()
    expect(res.summary.warnings.some((m) => m.includes('重新识别'))).toBe(false)
    expect(pageByDidaId(w, 't2')).toBeDefined()
    expect(w.logs.some((l) => l.kind === 'error')).toBe(false)
  })

  it('必需字段删掉后又新建了同名字段：自动改绑，同步照常', async () => {
    const w = await initialized(
      (w) => void w.dida.addTask({ id: 't1', projectId: 'p-dev', title: '写接口', dueDate: '2026-09-28T02:00:00.000+0000', timeZone: 'Asia/Shanghai' })
    )
    const ds = tasksDs(w)
    delete ds.properties['排期']
    ds.properties['排期'] = { id: 'p_sched2', name: '排期', type: 'date' }
    w.dida.updateTask('t1', { dueDate: '2026-09-29T02:00:00.000+0000' })
    const res = await w.engine().runRound()
    expect(res.summary.warnings).toContain('任务库的「排期」字段已重新识别')
    expect(prop(pageByDidaId(w, 't1')!, '排期')?.date?.start).toBe('2026-09-29T10:00:00+08:00')
  })

  it('必需字段被删除：给出明确的错误', async () => {
    const w = await initialized((w) => void w.dida.addTask({ id: 't1', projectId: 'p-dev', title: '写接口' }))
    delete tasksDs(w).properties['排期']
    await expect(w.engine().runRound()).rejects.toThrow('任务库的「排期」字段已被删除或更改')
  })
})

describe('同步区写入失败', () => {
  it('旧内容保留；同样的失败 30 分钟内只记一次；之后自动修复且只有一个同步区', async () => {
    const w = await initialized((w) => void w.dida.addTask({ id: 't1', projectId: 'p-dev', title: 'A', content: '第一版' }))
    const page = pageByDidaId(w, 't1')!
    w.dida.updateTask('t1', { content: '第二版' })
    w.notion.failNextAppend = new CliError('body failed validation: link url is invalid', 'ntn', 'validation', 400)
    const e = w.engine()
    await e.runRound()
    expect(callouts(w, page.id)).toHaveLength(1)
    expect(syncSection(w, page.id)).toEqual(['第一版'])
    expect(w.logs.filter((l) => l.kind === 'error')).toHaveLength(1)

    advance(w, 1)
    await e.runRound()
    expect(w.logs.filter((l) => l.kind === 'error')).toHaveLength(1)
    expect(syncSection(w, page.id)).toEqual(['第一版'])

    advance(w, 31)
    await e.runRound()
    expect(callouts(w, page.id)).toHaveLength(1)
    expect(syncSection(w, page.id)).toEqual(['第二版'])
  })

  it('新同步区已写入但删除旧的失败：之后自动清理，只剩一个', async () => {
    const w = await initialized((w) => void w.dida.addTask({ id: 't1', projectId: 'p-dev', title: 'A', content: '第一版' }))
    const page = pageByDidaId(w, 't1')!
    w.dida.updateTask('t1', { content: '第二版' })
    w.notion.failNextDelete = new CliError('body failed validation', 'ntn', 'validation', 400)
    const e = w.engine()
    await e.runRound()
    expect(callouts(w, page.id)).toHaveLength(2)

    advance(w, 31)
    await e.runRound()
    expect(callouts(w, page.id)).toHaveLength(1)
    expect(syncSection(w, page.id)).toEqual(['第二版'])
  })

  it('关闭同步区开关后，清掉页面上已有的同步区', async () => {
    const w = await initialized((w) => void w.dida.addTask({ id: 't1', projectId: 'p-dev', title: 'A', content: '描述' }))
    const page = pageByDidaId(w, 't1')!
    expect(callouts(w, page.id)).toHaveLength(1)
    w.settings = { ...w.settings, syncBody: false }
    await w.engine().runRound()
    expect(callouts(w, page.id)).toHaveLength(0)
    expect((await w.store.load(w.profile.id)).tasks.t1?.body?.blockId).toBeNull()

    advance(w, 1)
    w.notion.writes = 0
    await w.engine().runRound()
    expect(w.notion.writes).toBe(0)
  })
})

describe('Notion 里删掉的页面', () => {
  it('下一次写入失败时立即确认并停止同步，不会每轮报错', async () => {
    const w = await initialized((w) => void w.dida.addTask({ id: 't1', projectId: 'p-dev', title: 'A' }))
    const page = pageByDidaId(w, 't1')!
    await w.notion.updatePage(page.id, { in_trash: true })
    w.dida.updateTask('t1', { title: 'A2' })
    await w.engine().runRound()
    const state = await w.store.load(w.profile.id)
    expect(state.tasks.t1).toBeUndefined()
    expect(state.notionRemoved.t1?.pageId).toBe(page.id)
    expect(w.logs.map((l) => l.title)).toContain('Notion 中已删除，不再同步「A2」')
    expect(w.logs.some((l) => l.kind === 'error')).toBe(false)
  })
})
