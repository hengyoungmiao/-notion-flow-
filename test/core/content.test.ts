import { describe, expect, it } from 'vitest'
import { FLOW_IDS } from '../../src/core/adapters/fake'
import { upgradeSchema } from '../../src/core/notion/discovery'
import { MemoryStateStore } from '../../src/core/sync/state'
import { projectKey } from '../../src/core/sync/planner'
import { advance, makeWorld, pageByDidaId, prop, syncSection, taskPages, titleOf, type World } from './helpers'

const S = FLOW_IDS.status
const callouts = (w: World, pageId: string) => w.notion.blockTree(pageId).filter((b) => b.type === 'callout')

describe('页面顶部同步区', () => {
  it('写入描述和检查事项，变化时重写，不变时不写', async () => {
    const w = await makeWorld({
      seed: (w) =>
        void w.dida.addTask({
          id: 't1',
          projectId: 'p-dev',
          title: '发布',
          kind: 'CHECKLIST',
          desc: '先看 **发布清单**',
          items: [
            { id: 'i2', title: '打 tag', status: 0, sortOrder: 2 },
            { id: 'i1', title: '跑测试', status: 1, sortOrder: 1 }
          ]
        })
    })
    const e = w.engine()
    await e.runRound({ initial: true })
    const page = pageByDidaId(w, 't1')!
    expect(syncSection(w, page.id)).toEqual(['先看 发布清单', '检查事项', '[x] 跑测试', '[ ] 打 tag'])

    advance(w, 1)
    const idle = await e.runRound()
    expect(idle.summary.bodies).toBe(0)

    advance(w, 1)
    w.dida.updateTask('t1', { items: [{ id: 'i1', title: '跑测试', status: 1, sortOrder: 1 }, { id: 'i2', title: '打 tag', status: 1, sortOrder: 2 }] })
    await e.runRound()
    expect(callouts(w, page.id)).toHaveLength(1)
    expect(syncSection(w, page.id)).toEqual(['先看 发布清单', '检查事项', '[x] 跑测试', '[x] 打 tag'])

    advance(w, 1)
    w.dida.updateTask('t1', { desc: '', items: [] })
    await e.runRound()
    expect(callouts(w, page.id)).toHaveLength(0)
  })

  it('保留页面里用户自己写的正文', async () => {
    const w = await makeWorld({ seed: (w) => void w.dida.addTask({ id: 't1', projectId: 'p-dev', title: 'A', content: '第一版' }) })
    const e = w.engine()
    await e.runRound({ initial: true })
    const page = pageByDidaId(w, 't1')!
    await w.notion.appendBlocks(page.id, [{ type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: 'Claude 的笔记' } }] } }])
    advance(w, 1)
    w.dida.updateTask('t1', { content: '第二版' })
    await e.runRound()
    const tree = w.notion.blockTree(page.id)
    expect(tree.map((b) => b.type)).toEqual(['callout', 'paragraph'])
    expect(syncSection(w, page.id)).toEqual(['第二版'])
    expect((tree[1]!.content as any).rich_text[0].text.content).toBe('Claude 的笔记')
  })

  it('本地状态丢失后不会出现两个同步区', async () => {
    const w = await makeWorld({ seed: (w) => void w.dida.addTask({ id: 't1', projectId: 'p-dev', title: 'A', content: '描述' }) })
    await w.engine().runRound({ initial: true })
    w.store = new MemoryStateStore()
    await w.engine().runRound({ initial: true })
    expect(callouts(w, pageByDidaId(w, 't1')!.id)).toHaveLength(1)
  })

  it('每轮最多重写 40 个同步区，其余下一轮继续', async () => {
    const w = await makeWorld({
      seed: (w) => {
        for (let i = 0; i < 45; i++) w.dida.addTask({ id: `t${i}`, projectId: 'p-dev', title: `任务${i}`, content: `描述${i}` })
      }
    })
    const e = w.engine()
    await e.runRound({ initial: true })
    const withSection = () => taskPages(w).filter((p) => callouts(w, p.id).length === 1).length
    expect(withSection()).toBe(40)
    advance(w, 1)
    await e.runRound()
    expect(withSection()).toBe(45)
  })

  it('关闭开关后不写同步区', async () => {
    const w = await makeWorld({
      settings: { syncBody: false },
      seed: (w) => void w.dida.addTask({ id: 't1', projectId: 'p-dev', title: 'A', content: '描述' })
    })
    await w.engine().runRound({ initial: true })
    expect(callouts(w, pageByDidaId(w, 't1')!.id)).toHaveLength(0)
  })
})

describe('子任务', () => {
  it('父任务列出子任务（可跳转、带勾选状态），子任务显示父任务', async () => {
    const w = await makeWorld({
      seed: (w) => {
        w.dida.addTask({ id: 'p1', projectId: 'p-dev', title: '网站上线' })
        w.dida.addTask({ id: 'c1', projectId: 'p-dev', title: '写文案', parentId: 'p1', sortOrder: 1 })
        w.dida.addTask({ id: 'c2', projectId: 'p-dev', title: '配域名', parentId: 'p1', sortOrder: 2 })
      }
    })
    const e = w.engine()
    await e.runRound({ initial: true })
    advance(w, 1)
    await e.runRound()
    const parent = pageByDidaId(w, 'p1')!
    const c1 = pageByDidaId(w, 'c1')!
    const c2 = pageByDidaId(w, 'c2')!
    expect(syncSection(w, parent.id)).toEqual(['子任务', `[ ] @${c1.id}`, `[ ] @${c2.id}`])
    expect(syncSection(w, c1.id)).toEqual([`↖ 父任务：@${parent.id}`])

    advance(w, 1)
    w.dida.updateTask('c1', { status: 2, completedTime: '2026-09-27T08:05:00.000+0000' })
    await e.runRound()
    expect(syncSection(w, parent.id)).toEqual(['子任务', `[x] @${c1.id}`, `[ ] @${c2.id}`])
  })
})

describe('标签关联项目', () => {
  const seedProjects = (w: World) => {
    const site = w.notion.seedPage(FLOW_IDS.projects, { title: { title: [{ text: { content: '网站改版' } }] } })
    const book = w.notion.seedPage(FLOW_IDS.projects, { title: { title: [{ text: { content: 'Book Club' } }] } })
    return { site, book }
  }

  it('按标签关联、保留手动关联、去掉标签后解除、子任务继承', async () => {
    let ids: ReturnType<typeof seedProjects>
    const w = await makeWorld({
      seed: (w) => {
        ids = seedProjects(w)
        w.dida.addTask({ id: 't1', projectId: 'p-dev', title: '首页设计', tags: ['网站 改版'] })
        w.dida.addTask({ id: 't2', projectId: 'p-dev', title: '读书会', tags: ['#bookclub', '随便'] })
        w.dida.addTask({ id: 'c1', projectId: 'p-dev', title: '切图', parentId: 't1' })
      }
    })
    const e = w.engine()
    const res = await e.runRound({ initial: true })
    expect(res.summary.projectLinks).toBe(3)
    const t1 = pageByDidaId(w, 't1')!
    expect(prop(t1, '关联项目')?.relation).toEqual([{ id: ids!.site.id }])
    expect(prop(pageByDidaId(w, 't2')!, '关联项目')?.relation).toEqual([{ id: ids!.book.id }])
    expect(prop(pageByDidaId(w, 'c1')!, '关联项目')?.relation).toEqual([{ id: ids!.site.id }])

    // 手动加一个关联，去掉标签后只解除同步写入的那个
    await w.notion.updatePage(t1.id, { properties: { p_project: { relation: [{ id: ids!.site.id }, { id: 'manual-project' }] } } })
    advance(w, 1)
    w.dida.updateTask('t1', { tags: [] })
    await e.runRound()
    expect(prop(pageByDidaId(w, 't1')!, '关联项目')?.relation).toEqual([{ id: 'manual-project' }])
  })

  it('关闭开关后不改动关联项目', async () => {
    const w = await makeWorld({
      settings: { syncProjects: false },
      seed: (w) => {
        seedProjects(w)
        w.dida.addTask({ id: 't1', projectId: 'p-dev', title: 'A', tags: ['网站改版'] })
      }
    })
    await w.engine().runRound({ initial: true })
    expect(prop(pageByDidaId(w, 't1')!, '关联项目')?.relation).toEqual([])
  })

  it('标签与项目名归一化比较', () => {
    expect(projectKey('#网站 改版')).toBe(projectKey('网站改版'))
    expect(projectKey('ＢＯＯＫ-Club')).toBe(projectKey('book club'))
  })

  it('旧配置补充识别项目库', async () => {
    const w = await makeWorld()
    const legacy = { ...w.profile.schema! }
    delete legacy.projects
    delete legacy.tasks.props.project
    const upgraded = await upgradeSchema(w.notion, legacy)
    expect(upgraded.projects?.dataSourceId).toBe(FLOW_IDS.projects)
    expect(upgraded.tasks.props.project).toBe('p_project')
  })
})

describe('重复任务', () => {
  it('只有一个页面：排期后移、完成副本计入完成记录、同步区显示中文规则', async () => {
    const w = await makeWorld({
      seed: (w) =>
        void w.dida.addTask({
          id: 'r1',
          projectId: 'p-dev',
          title: '周会',
          repeatFlag: 'RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO',
          repeatFrom: 0,
          isAllDay: true,
          dueDate: '2026-09-27T16:00:00.000+0000',
          timeZone: 'Asia/Shanghai'
        })
    })
    const e = w.engine()
    await e.runRound({ initial: true })
    const page = pageByDidaId(w, 'r1')!
    expect(syncSection(w, page.id)).toEqual(['🔁 每周一 · 按截止日期重复'])

    // 在滴答完成一次：原任务日期后移，并产生一条已完成副本
    advance(w, 1)
    w.dida.updateTask('r1', { dueDate: '2026-10-04T16:00:00.000+0000' })
    w.dida.addTask({ id: 'r1-done-1', projectId: 'p-dev', title: '周会', status: 2, completedTime: '2026-09-27T08:01:00.000+0000', timeZone: 'Asia/Shanghai' })
    await e.runRound()
    const after = pageByDidaId(w, 'r1')!
    expect(taskPages(w)).toHaveLength(1)
    expect(prop(after, '排期')?.date).toEqual({ start: '2026-10-05', end: null })
    expect(prop(after, '状态')?.status?.id).toBe(S.todo)
    expect(syncSection(w, page.id)).toEqual(['🔁 每周一 · 按截止日期重复', '✅ 最近完成：09-27（共 1 次）'])

    // 同一条完成副本在下一轮仍在时间窗口内，不重复计数
    advance(w, 1)
    await e.runRound()
    expect(syncSection(w, page.id)).toEqual(['🔁 每周一 · 按截止日期重复', '✅ 最近完成：09-27（共 1 次）'])
  })
})

describe('重复任务按日程处理', () => {
  const T = FLOW_IDS.type
  const weekly = { repeatFlag: 'RRULE:FREQ=WEEKLY;BYDAY=MO', isAllDay: true, dueDate: '2026-09-27T16:00:00.000+0000', timeZone: 'Asia/Shanghai' }
  const typeOf = (w: World, id: string) => prop(pageByDidaId(w, id)!, '任务类型')?.select?.id

  it('重复任务新建为「日程」，普通全天任务仍为「待办」', async () => {
    const w = await makeWorld({
      seed: (w) => {
        w.dida.addTask({ id: 'r1', projectId: 'p-dev', title: '周会', ...weekly })
        w.dida.addTask({ id: 'n1', projectId: 'p-dev', title: '交报告', isAllDay: true, dueDate: '2026-09-27T16:00:00.000+0000' })
      }
    })
    await w.engine().runRound({ initial: true })
    expect(typeOf(w, 'r1')).toBe(T.schedule)
    expect(typeOf(w, 'n1')).toBe(T.todo)
  })

  it('旧页面补写「日程」，在 Notion 改掉后校正时改回；批量补写不触发熔断', async () => {
    const w = await makeWorld({
      settings: { recurringAsSchedule: false },
      seed: (w) => {
        for (let i = 0; i < 15; i++) w.dida.addTask({ id: `r${i}`, projectId: 'p-dev', title: `重复${i}`, ...weekly })
      }
    })
    await w.engine().runRound({ initial: true })
    expect(typeOf(w, 'r0')).toBe(T.todo)

    w.settings = { ...w.settings, recurringAsSchedule: true }
    advance(w, 1)
    const res = await w.engine().runRound()
    expect(res.blocked).toBeNull()
    expect(taskPages(w).every((p) => prop(p, '任务类型')?.select?.id === T.schedule)).toBe(true)

    const page = pageByDidaId(w, 'r0')!
    await w.notion.updatePage(page.id, { properties: { p_type: { select: { id: T.todo } } } })
    advance(w, 11)
    await w.engine().runRound()
    expect(typeOf(w, 'r0')).toBe(T.schedule)
  })

  it('重复任务不按标签关联项目：旧的同步关联移除、手动关联保留，子任务不继承', async () => {
    let site!: { id: string }
    const w = await makeWorld({
      settings: { recurringAsSchedule: false },
      seed: (w) => {
        site = w.notion.seedPage(FLOW_IDS.projects, { title: { title: [{ text: { content: '网站改版' } }] } })
        w.dida.addTask({ id: 'r1', projectId: 'p-dev', title: '周报', tags: ['网站改版'], ...weekly })
        w.dida.addTask({ id: 'c1', projectId: 'p-dev', title: '整理数据', parentId: 'r1' })
        w.dida.addTask({ id: 'n1', projectId: 'p-dev', title: '首页设计', tags: ['网站改版'] })
      }
    })
    await w.engine().runRound({ initial: true })
    expect(prop(pageByDidaId(w, 'r1')!, '关联项目')?.relation).toEqual([{ id: site.id }])
    expect(prop(pageByDidaId(w, 'c1')!, '关联项目')?.relation).toEqual([{ id: site.id }])

    const r1 = pageByDidaId(w, 'r1')!
    await w.notion.updatePage(r1.id, { properties: { p_project: { relation: [{ id: site.id }, { id: 'manual-project' }] } } })
    w.settings = { ...w.settings, recurringAsSchedule: true }
    advance(w, 1)
    w.dida.updateTask('r1', { title: '周报（新）' })
    w.dida.updateTask('c1', { title: '整理数据（新）' })
    await w.engine().runRound()
    expect(prop(pageByDidaId(w, 'r1')!, '关联项目')?.relation).toEqual([{ id: 'manual-project' }])
    expect(prop(pageByDidaId(w, 'c1')!, '关联项目')?.relation).toEqual([])
    expect(prop(pageByDidaId(w, 'n1')!, '关联项目')?.relation).toEqual([{ id: site.id }])
  })

  it('关闭开关后：重复任务按时间规则设置类型，并按标签关联项目', async () => {
    let site!: { id: string }
    const w = await makeWorld({
      settings: { recurringAsSchedule: false },
      seed: (w) => {
        site = w.notion.seedPage(FLOW_IDS.projects, { title: { title: [{ text: { content: '网站改版' } }] } })
        w.dida.addTask({ id: 'r1', projectId: 'p-dev', title: '周报', tags: ['网站改版'], ...weekly })
      }
    })
    await w.engine().runRound({ initial: true })
    expect(typeOf(w, 'r1')).toBe(T.todo)
    expect(prop(pageByDidaId(w, 'r1')!, '关联项目')?.relation).toEqual([{ id: site.id }])
  })
})
