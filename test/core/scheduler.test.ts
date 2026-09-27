import { describe, expect, it, vi } from 'vitest'
import { CliError } from '../../src/core/adapters/exec'
import { DEFAULT_SETTINGS } from '../../src/core/config'
import { Scheduler } from '../../src/core/scheduler'
import { NeedsInitialSyncError, type RoundResult, type SyncEngine } from '../../src/core/sync/engine'
import { collectDiagnostics, sanitizeTask } from '../../src/core/diagnostics'
import { FakeDida } from '../../src/core/adapters/fake'

function result(writes: number): RoundResult {
  return {
    summary: { counts: { creates: writes, updates: 0, corrections: 0, destructive: 0, links: 0, unlinks: 0 }, creates: [], updates: [], matches: [], destructive: [], domainCreates: [], domainRows: [], focus: { creates: 0, updates: 0, trashes: 0 }, bodies: 0, projectLinks: 0, warnings: [] },
    applied: true,
    blocked: null,
    writes,
    appliedCounts: { creates: writes, updates: 0, corrections: 0, destructive: 0, links: 0, unlinks: 0 },
    reconciled: false,
    backupPath: null,
    durationMs: 1
  }
}

function fakeEngine(impl: () => Promise<RoundResult>): SyncEngine {
  return { runRound: vi.fn(impl) } as unknown as SyncEngine
}

describe('Scheduler', () => {
  it('backs off when idle and tightens after changes', async () => {
    let writes = 0
    const engine = fakeEngine(async () => result(writes))
    const s = new Scheduler({ engine: () => engine, workspaceId: () => 'w', settings: () => DEFAULT_SETTINGS })
    await s.syncNow()
    expect(s.snapshot().intervalSec).toBe(15)
    await s.syncNow()
    expect(s.snapshot().intervalSec).toBe(23)
    writes = 3
    await s.syncNow()
    expect(s.snapshot().intervalSec).toBe(10)
    expect(s.snapshot().today.created).toBe(3)
  })

  it('pauses on auth errors and reports needs_initial / needs_setup', async () => {
    const auth = new Scheduler({
      engine: () => fakeEngine(async () => { throw new CliError('401', 'dida', 'auth', 401) }),
      workspaceId: () => 'w',
      settings: () => DEFAULT_SETTINGS
    })
    await auth.syncNow()
    expect(auth.snapshot().status).toBe('auth')

    const init = new Scheduler({
      engine: () => fakeEngine(async () => { throw new NeedsInitialSyncError() }),
      workspaceId: () => 'w',
      settings: () => DEFAULT_SETTINGS
    })
    await init.syncNow()
    expect(init.snapshot().status).toBe('needs_initial')

    const none = new Scheduler({ engine: () => null, workspaceId: () => null, settings: () => DEFAULT_SETTINGS })
    await none.syncNow()
    expect(none.snapshot().status).toBe('needs_setup')
  })

  it('keeps paused status when paused during a running round', async () => {
    let release!: () => void
    const engine = fakeEngine(() => new Promise<RoundResult>((r) => (release = () => r(result(0)))))
    const s = new Scheduler({ engine: () => engine, workspaceId: () => 'w', settings: () => DEFAULT_SETTINGS })
    s.start()
    await vi.waitFor(() => expect(engine.runRound).toHaveBeenCalledTimes(1))
    s.pause()
    release()
    await s.waitIdle()
    expect(s.snapshot().status).toBe('paused')
    expect(s.snapshot().nextRunAt).toBeNull()
    s.stop()
  })

  it('never runs two rounds at the same time', async () => {
    let active = 0
    let maxActive = 0
    const releases: Array<() => void> = []
    const engine = fakeEngine(async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise<void>((r) => releases.push(r))
      active--
      return result(0)
    })
    const s = new Scheduler({ engine: () => engine, workspaceId: () => 'w', settings: () => DEFAULT_SETTINGS })
    s.start()
    await vi.waitFor(() => expect(engine.runRound).toHaveBeenCalledTimes(1))
    s.pause()
    s.resume()
    await new Promise((r) => setTimeout(r, 20))
    expect(engine.runRound).toHaveBeenCalledTimes(1)
    releases.shift()!()
    await vi.waitFor(() => expect(engine.runRound).toHaveBeenCalledTimes(2))
    s.stop()
    releases.shift()!()
    await s.waitIdle()
    expect(maxActive).toBe(1)
  })

  it('counts only applied operations in today stats', async () => {
    const engine = fakeEngine(async () => ({ ...result(0), summary: { ...result(0).summary, counts: { ...result(0).summary.counts, updates: 30 } } }))
    const s = new Scheduler({ engine: () => engine, workspaceId: () => 'w', settings: () => DEFAULT_SETTINGS })
    await s.syncNow()
    expect(s.snapshot().today.updated).toBe(0)
  })

  it('backs off exponentially on network errors', async () => {
    const s = new Scheduler({
      engine: () => fakeEngine(async () => { throw new CliError('fetch failed', 'dida', 'network') }),
      workspaceId: () => 'w',
      settings: () => DEFAULT_SETTINGS
    })
    await s.syncNow()
    expect(s.snapshot().status).toBe('error')
    expect(s.snapshot().lastError?.kind).toBe('network')
  })
})

describe('diagnostics', () => {
  it('strips personal content', async () => {
    const dida = new FakeDida()
    dida.projects = [{ id: 'p1', name: '私人清单' }]
    dida.addTask({ id: 'abc', projectId: 'p1', title: '秘密标题', content: '秘密内容', isAllDay: true, startDate: '2026-03-09T16:00:00+0000', dueDate: '2026-03-11T16:00:00+0000' })
    const report = await collectDiagnostics(dida)
    const text = JSON.stringify(report)
    expect(text).not.toContain('秘密')
    expect(text).not.toContain('私人清单')
    expect(report.samples.allDayMultiDay).toHaveLength(1)
    expect(sanitizeTask({ id: 'x', projectId: 'inbox1', title: 'hi' }).projectId).toBe('inbox*')
  })
})
