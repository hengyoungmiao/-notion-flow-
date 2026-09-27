import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DidaCliReader, listCompletedRange } from '../../src/core/adapters/dida'
import { CliError, withRetry } from '../../src/core/adapters/exec'
import { FakeDida } from '../../src/core/adapters/fake'
import { isIdempotent } from '../../src/core/adapters/notion'
import { ConfigStore, DEFAULT_SETTINGS, sanitizeSettings } from '../../src/core/config'
import { FileStateStore, renameWithRetry, writeJsonAtomic } from '../../src/core/sync/state'

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix))

describe('滴答 CLI 输出', () => {
  it('接口返回空内容（CLI 打印 undefined）时视为没有结果，而不是报错', async () => {
    const dir = tmp('flowsync-fake-dida-')
    const script = join(dir, 'fake-dida.js')
    writeFileSync(script, 'console.log(JSON.stringify(undefined, null, 2))\n')
    const reader = new DidaCliReader({ command: process.execPath, baseArgs: [script] })
    expect(await reader.getTask('p1', 't1')).toBeNull()
    expect(await reader.listProjects()).toEqual([])
  })

  it('已完成任务按不超过 29 天分段读取', async () => {
    const dida = new FakeDida()
    dida.addTask({ id: 'old', projectId: 'p', status: 2, completedTime: '2026-08-01T08:00:00.000+0000' })
    dida.addTask({ id: 'new', projectId: 'p', status: 2, completedTime: '2026-09-20T08:00:00.000+0000' })
    const tasks = await listCompletedRange(dida, new Date('2026-07-29T00:00:00Z'), new Date('2026-09-27T00:00:00Z'))
    expect(tasks.map((t) => t.id).sort()).toEqual(['new', 'old'])
    expect(dida.calls.filter((c) => c === 'completed')).toHaveLength(3)
  })
})

describe('Notion 请求重试', () => {
  it('新建页面、追加子块不幂等；查询和更新可以重试', () => {
    expect(isIdempotent('POST', 'v1/pages')).toBe(false)
    expect(isIdempotent('PATCH', 'v1/blocks/abc/children')).toBe(false)
    expect(isIdempotent('POST', 'v1/data_sources/ds/query')).toBe(true)
    expect(isIdempotent('PATCH', 'v1/pages/abc')).toBe(true)
    expect(isIdempotent('GET', 'v1/blocks/abc/children?start_cursor=x')).toBe(true)
  })

  it('不幂等的请求超时后不重试，限流时重试', async () => {
    let calls = 0
    const timeout = () => {
      calls++
      return Promise.reject(new CliError('Notion 请求超时', 'ntn', 'timeout'))
    }
    await expect(withRetry(timeout, 4, 1, true)).rejects.toMatchObject({ kind: 'timeout' })
    expect(calls).toBe(1)

    calls = 0
    await expect(withRetry(timeout, 3, 1, false)).rejects.toMatchObject({ kind: 'timeout' })
    expect(calls).toBe(3)

    calls = 0
    const limited = () => (++calls < 3 ? Promise.reject(new CliError('rate limited', 'ntn', 'rate_limit')) : Promise.resolve('ok'))
    expect(await withRetry(limited, 4, 1, true)).toBe('ok')
    expect(calls).toBe(3)
  })
})

describe('本地文件', () => {
  it('rename 遇到 EPERM 时短暂重试', async () => {
    let calls = 0
    const flaky = async () => {
      if (++calls < 3) throw Object.assign(new Error('busy'), { code: 'EPERM' })
    }
    await renameWithRetry('a', 'b', flaky, [1, 1, 1])
    expect(calls).toBe(3)

    const broken = async () => {
      throw Object.assign(new Error('nope'), { code: 'ENOENT' })
    }
    await expect(renameWithRetry('a', 'b', broken, [1, 1])).rejects.toThrow('nope')
  })

  it('状态文件损坏时备份原文件，并从空状态继续（下一轮按滴答ID重新关联）', async () => {
    const dir = tmp('flowsync-state-')
    writeFileSync(join(dir, 'ws1.json'), '{"version":1,"tasks":{"t1":')
    const store = new FileStateStore(dir)
    const recovered: string[] = []
    store.onRecovered = (id) => recovered.push(id)
    const state = await store.load('ws1')
    expect(state.tasks).toEqual({})
    expect(state.initializedAt).not.toBeNull()
    expect(state.lastReconcileAt).toBeNull()
    expect(recovered).toEqual(['ws1'])
    expect(readdirSync(dir).some((f) => f.startsWith('ws1.json.corrupt-'))).toBe(true)
  })

  it('配置文件损坏时改用最近一次保存的备份', async () => {
    const dir = tmp('flowsync-config-')
    const store = new ConfigStore(dir)
    await store.load()
    await store.update((c) => {
      c.onboarded = true
      c.settings.deletePolicy = 'abandon'
    })
    writeFileSync(join(dir, 'config.json'), '{"version":1,"workspa')
    const reloaded = new ConfigStore(dir)
    const config = await reloaded.load()
    expect(reloaded.recovered).toBe('backup')
    expect(config.onboarded).toBe(true)
    expect(config.settings.deletePolicy).toBe('abandon')
  })

  it('原子写入不留下临时文件', async () => {
    const dir = tmp('flowsync-atomic-')
    await writeJsonAtomic(join(dir, 'a.json'), { a: 1 })
    expect(readdirSync(dir)).toEqual(['a.json'])
  })
})

describe('设置校验', () => {
  it('只把不合法的那一项换成默认值，其它设置保留', () => {
    const s = sanitizeSettings({ pollMinSec: 1, deletePolicy: 'abandon', syncBody: false, breaker: { maxTrash: 50, maxUpdateRatio: 9 } })
    expect(s.pollMinSec).toBe(DEFAULT_SETTINGS.pollMinSec)
    expect(s.deletePolicy).toBe('abandon')
    expect(s.syncBody).toBe(false)
    expect(s.breaker).toEqual({ maxTrash: 50, maxUpdateRatio: DEFAULT_SETTINGS.breaker.maxUpdateRatio, minUpdates: DEFAULT_SETTINGS.breaker.minUpdates })
  })

  it('未知字段被丢弃，缺失字段补默认值（包括已取消的旧设置）', () => {
    const s = sanitizeSettings({ foo: 1, archivedListsComplete: true })
    expect(s).toEqual(DEFAULT_SETTINGS)
    expect('archivedListsComplete' in s).toBe(false)
  })
})
