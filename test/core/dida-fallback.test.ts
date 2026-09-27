import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DidaCliReader } from '../../src/core/adapters/dida'
import { CliError } from '../../src/core/adapters/exec'
import { FLOW_IDS } from '../../src/core/adapters/fake'
import { ResilientDida } from '../../src/core/adapters/resilient-dida'
import { SyncEngine } from '../../src/core/sync/engine'
import { advance, makeWorld, pageByDidaId, prop, type World } from './helpers'

const missing = () => new CliError('DIDA API 错误 404: not found', 'dida', 'not_found', 404)

function resilientEngine(w: World, warnings: string[] = []) {
  const dida = new ResilientDida(w.dida, { now: () => w.now.value.getTime(), warn: (_ep, m) => warnings.push(m) })
  const engine = new SyncEngine({
    dida,
    notion: w.notion,
    store: w.store,
    profile: w.profile,
    settings: w.settings,
    log: (e) => w.logs.push(e),
    now: () => w.now.value
  })
  return { dida, engine }
}

describe('滴答接口不可用时的替代方案', () => {
  it('偏好设置、文件夹、未完成任务接口都不可用：改用 project data，同步照常', async () => {
    const w = await makeWorld({ seed: (w) => void w.dida.addTask({ id: 't1', projectId: 'p-dev', title: '写接口' }) })
    for (const ep of ['preference', 'groups', 'open']) w.dida.failEndpoints.set(ep, missing())
    const warnings: string[] = []
    const { dida, engine } = resilientEngine(w, warnings)
    await engine.runRound({ initial: true })
    expect(pageByDidaId(w, 't1')).toBeDefined()
    expect(w.dida.calls).toContain('projectData')
    expect(warnings.some((m) => m.includes('task filter') && m.includes('project data'))).toBe(true)
    expect(dida.healthReport().filter.ok).toBe(false)

    // 1 小时内不再调用不可用的接口
    w.dida.calls.length = 0
    advance(w, 1)
    w.dida.addTask({ id: 't2', projectId: 'p-dev', title: '写文档' })
    await engine.runRound()
    expect(w.dida.calls).not.toContain('open')
    expect(pageByDidaId(w, 't2')).toBeDefined()
    expect(warnings.filter((m) => m.includes('task filter'))).toHaveLength(1)
  })

  it('已完成任务接口不可用：完成状态由逐条确认发现', async () => {
    const w = await makeWorld({ seed: (w) => void w.dida.addTask({ id: 't1', projectId: 'p-dev', title: '写接口' }) })
    w.dida.failEndpoints.set('completed', missing())
    const { engine } = resilientEngine(w)
    await engine.runRound({ initial: true })
    advance(w, 1)
    w.dida.updateTask('t1', { status: 2, completedTime: '2026-09-27T08:00:30.000+0000' })
    await engine.runRound()
    expect(prop(pageByDidaId(w, 't1')!, '状态')?.status?.id).toBe(FLOW_IDS.status.done)
  })

  it('标签接口不可用：从任务里汇总标签', async () => {
    const w = await makeWorld({ seed: (w) => void w.dida.addTask({ id: 't1', projectId: 'p-dev', title: 'A', tags: ['网站改版'] }) })
    w.dida.failEndpoints.set('tags', missing())
    const { dida } = resilientEngine(w)
    expect(await dida.listTags()).toEqual([{ name: '网站改版', label: '网站改版' }])
  })

  it('番茄接口不可用：跳过番茄同步，绝不把已有记录当成删除', async () => {
    const w = await makeWorld({
      seed: (w) => {
        w.dida.addTask({ id: 't1', projectId: 'p-dev', title: '写接口' })
        w.dida.addFocus({ id: 'f1', type: 0, taskId: 't1', startTime: '2026-09-26T01:00:00+0000', endTime: '2026-09-26T01:25:00+0000', duration: 1500 })
      }
    })
    const { engine } = resilientEngine(w)
    await engine.runRound({ initial: true })
    const focusPages = () => w.notion.pagesOf(FLOW_IDS.focus).filter((p) => !p.in_trash)
    expect(focusPages()).toHaveLength(1)

    w.dida.focus.clear()
    w.dida.failEndpoints.set('focus:pomodoro', missing())
    w.dida.failEndpoints.set('focus:get', missing())
    advance(w, 2)
    await engine.runRound({ forceReconcile: true })
    expect(focusPages()).toHaveLength(1)
  })

  it('登录失效照常报出来，不会被当成接口不可用', async () => {
    const w = await makeWorld({ seed: (w) => void w.dida.addTask({ id: 't1', projectId: 'p-dev', title: 'A' }) })
    w.dida.failEndpoints.set('open', new CliError('DIDA API 错误 401', 'dida', 'auth', 401))
    const { engine } = resilientEngine(w)
    await expect(engine.runRound({ initial: true })).rejects.toMatchObject({ kind: 'auth' })
  })
})

describe('验证滴答登录', () => {
  it('用官方接口 project list 验证，不依赖偏好设置接口', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowsync-dida-verify-'))
    const script = join(dir, 'fake-dida.js')
    writeFileSync(
      script,
      [
        "const args = process.argv.slice(2).join(' ')",
        "if (args.startsWith('preference')) { console.error('DIDA API 错误 404: not found'); process.exit(1) }",
        "if (args.startsWith('project list')) { console.log(JSON.stringify([{ id: 'p1', name: '开发' }])); process.exit(0) }",
        "console.error('DIDA API 错误 500'); process.exit(1)"
      ].join('\n')
    )
    const reader = new DidaCliReader({ command: process.execPath, baseArgs: [script] })
    expect(await reader.verifyAuth()).toBe(true)
    expect(await new ResilientDida(reader).getPreference()).toEqual({})
  })
})
