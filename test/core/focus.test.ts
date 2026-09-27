import { describe, expect, it } from 'vitest'
import { FLOW_IDS } from '../../src/core/adapters/fake'
import { upgradeFocusSchema } from '../../src/core/notion/discovery'
import { desiredFocus, focusTaskId } from '../../src/core/mapping/focus'
import { MemoryStateStore } from '../../src/core/sync/state'
import type { NotionPage } from '../../src/core/types'
import { advance, makeWorld, pageByDidaId, prop, titleOf, type World } from './helpers'

const focusPages = (w: World): NotionPage[] => w.notion.pagesOf(FLOW_IDS.focus).filter((p) => !p.in_trash)

function seedTasks(w: World): void {
  w.dida.addTask({ id: 't1', projectId: 'p-dev', title: '写周报', timeZone: 'Asia/Shanghai' })
  w.dida.addTask({ id: 't2', projectId: 'p-read', title: '读书', timeZone: 'Asia/Shanghai' })
  w.dida.addTask({ id: 'tx', projectId: 'p-notes', title: '笔记里的东西', kind: 'NOTE' })
}

describe('番茄钟同步', () => {
  it('首次同步导入最近的专注记录并关联到任务', async () => {
    const w = await makeWorld({
      seed: (w) => {
        seedTasks(w)
        w.dida.addFocus({ id: 'f1', type: 0, taskId: 't1', startTime: '2026-09-26T01:00:00+0000', endTime: '2026-09-26T01:25:00+0000', duration: 1500 })
        w.dida.addFocus({
          id: 'f2',
          type: 1,
          tasks: [{ taskId: 't2', title: '读书' }],
          startTime: '2026-09-26T12:00:00+0000',
          endTime: '2026-09-26T13:10:00+0000',
          duration: 4200,
          note: '第三章'
        })
        // 关联的任务不同步 → 跳过；没有关联任务 → 跳过；超出导入天数 → 跳过
        w.dida.addFocus({ id: 'f3', type: 0, taskId: 'tx', startTime: '2026-09-26T02:00:00+0000', endTime: '2026-09-26T02:25:00+0000' })
        w.dida.addFocus({ id: 'f4', type: 0, startTime: '2026-09-26T03:00:00+0000', endTime: '2026-09-26T03:25:00+0000' })
        w.dida.addFocus({ id: 'f5', type: 0, taskId: 't1', startTime: '2026-07-01T03:00:00+0000', endTime: '2026-07-01T03:25:00+0000' })
      }
    })
    const preview = await w.engine().runRound({ initial: true, dryRun: true })
    expect(preview.summary.focus.creates).toBe(2)

    const res = await w.engine().runRound({ initial: true })
    expect(res.summary.focus.creates).toBe(2)
    const pages = focusPages(w)
    expect(pages).toHaveLength(2)
    const t1 = pageByDidaId(w, 't1')!
    const pomo = pages.find((p) => titleOf(p, '名称').startsWith('番茄钟'))!
    expect(titleOf(pomo, '名称')).toBe('番茄钟 · 写周报')
    expect(prop(pomo, '关联任务')?.relation).toEqual([{ id: t1.id }])
    expect(prop(pomo, '开始时间')?.date).toEqual({ start: '2026-09-26T09:00:00+08:00', end: null })
    expect(prop(pomo, '结束时间')?.date).toEqual({ start: '2026-09-26T09:25:00+08:00', end: null })
    expect(prop(pomo, '番茄默认时长')?.number).toBe(25)
    const timing = pages.find((p) => titleOf(p, '名称').startsWith('正计时'))!
    expect(titleOf(timing, '名称')).toBe('正计时 · 读书 — 第三章')
    expect(prop(timing, '番茄默认时长')?.number).toBe(70)
  })

  it('滴答里修改专注记录会更新，没有变化时不写入', async () => {
    const w = await makeWorld({
      seed: (w) => {
        seedTasks(w)
        w.dida.addFocus({ id: 'f1', type: 0, taskId: 't1', startTime: '2026-09-27T01:00:00+0000', endTime: '2026-09-27T01:25:00+0000', duration: 1500 })
      }
    })
    const e = w.engine()
    await e.runRound({ initial: true })
    advance(w, 2)
    const idle = await e.runRound()
    expect(idle.writes).toBe(0)

    advance(w, 2)
    w.dida.updateFocus('f1', { note: '改稿', endTime: '2026-09-27T01:30:00+0000', duration: 1800 })
    await e.runRound()
    const page = focusPages(w)[0]!
    expect(titleOf(page, '名称')).toBe('番茄钟 · 写周报 — 改稿')
    expect(prop(page, '番茄默认时长')?.number).toBe(30)
  })

  it('新产生的专注记录在后续轮次同步，删除的记录确认后移入回收站', async () => {
    const w = await makeWorld({ seed: seedTasks })
    const e = w.engine()
    await e.runRound({ initial: true })
    expect(focusPages(w)).toHaveLength(0)

    advance(w, 2)
    w.dida.addFocus({ id: 'f9', type: 0, taskId: 't2', startTime: '2026-09-27T08:00:00+0000', endTime: '2026-09-27T08:25:00+0000', duration: 1500 })
    await e.runRound()
    expect(focusPages(w)).toHaveLength(1)

    advance(w, 2)
    w.dida.focus.delete('f9')
    await e.runRound()
    expect(focusPages(w)).toHaveLength(0)
    expect(w.dida.calls).toContain('focus:get')
  })

  it('本地状态丢失后不会重复创建番茄记录', async () => {
    const w = await makeWorld({
      seed: (w) => {
        seedTasks(w)
        w.dida.addFocus({ id: 'f1', type: 0, taskId: 't1', startTime: '2026-09-26T01:00:00+0000', endTime: '2026-09-26T01:25:00+0000' })
      }
    })
    await w.engine().runRound({ initial: true })
    w.store = new MemoryStateStore()
    await w.engine().runRound({ initial: true })
    expect(focusPages(w)).toHaveLength(1)
  })

  it('超过 30 天的导入会分段读取', async () => {
    const w = await makeWorld({
      settings: { focusImportDays: 75 },
      seed: (w) => {
        seedTasks(w)
        w.dida.addFocus({ id: 'old', type: 0, taskId: 't1', startTime: '2026-07-20T01:00:00+0000', endTime: '2026-07-20T01:25:00+0000' })
        w.dida.addFocus({ id: 'new', type: 0, taskId: 't1', startTime: '2026-09-20T01:00:00+0000', endTime: '2026-09-20T01:25:00+0000' })
      }
    })
    await w.engine().runRound({ initial: true })
    expect(focusPages(w)).toHaveLength(2)
    expect(w.dida.calls.filter((c) => c === 'focus:pomodoro').length).toBeGreaterThanOrEqual(3)
  })

  it('一分钟内的轮次不重复读取专注记录', async () => {
    const w = await makeWorld({ seed: seedTasks })
    const e = w.engine()
    await e.runRound({ initial: true })
    advance(w, 0.25)
    w.dida.calls = []
    await e.runRound()
    expect(w.dida.calls.some((c) => c.startsWith('focus:'))).toBe(false)
  })

  it('关闭同步开关后不写入番茄记录', async () => {
    const w = await makeWorld({
      settings: { syncFocus: false },
      seed: (w) => {
        seedTasks(w)
        w.dida.addFocus({ id: 'f1', type: 0, taskId: 't1', startTime: '2026-09-26T01:00:00+0000', endTime: '2026-09-26T01:25:00+0000' })
      }
    })
    await w.engine().runRound({ initial: true })
    expect(focusPages(w)).toHaveLength(0)
  })

  it('在 Notion 里删除的番茄记录不再重建', async () => {
    const w = await makeWorld({
      seed: (w) => {
        seedTasks(w)
        w.dida.addFocus({ id: 'f1', type: 0, taskId: 't1', startTime: '2026-09-27T01:00:00+0000', endTime: '2026-09-27T01:25:00+0000' })
      }
    })
    const e = w.engine()
    await e.runRound({ initial: true })
    const page = focusPages(w)[0]!
    w.notion.sources.get(FLOW_IDS.focus)!.pages.delete(page.id)
    advance(w, 2)
    w.dida.updateFocus('f1', { note: '补充' })
    await e.runRound()
    advance(w, 2)
    await e.runRound()
    expect(w.notion.pagesOf(FLOW_IDS.focus)).toHaveLength(0)
    expect((await w.store.load(w.profile.id)).focus.links.f1?.removed).toBe(true)
  })

  it('旧版本的配置会补充识别番茄库', async () => {
    const w = await makeWorld()
    const { focus: _drop, ...legacy } = w.profile.schema!
    const upgraded = await upgradeFocusSchema(w.notion, legacy)
    expect(upgraded.focus?.dataSourceId).toBe(FLOW_IDS.focus)
    expect(upgraded.focus?.props).toMatchObject({ task: 'f_task', start: 'f_start', end: 'f_end', minutes: 'f_minutes' })
  })

  it('解析专注记录关联的任务和时长', () => {
    expect(focusTaskId({ id: 'a', taskId: 'x' })).toBe('x')
    expect(focusTaskId({ id: 'a', tasks: [{ id: 'y' }] })).toBe('y')
    expect(focusTaskId({ id: 'a' })).toBeNull()
    const d = desiredFocus({ id: 'a', taskId: 'x', startTime: '2026-09-27T01:00:00.000+0000', endTime: '2026-09-27T01:40:00.000+0000' }, '任务', 'Asia/Shanghai')
    expect(d?.minutes).toBe(40)
    expect(d?.kind).toBe('pomodoro')
  })
})
