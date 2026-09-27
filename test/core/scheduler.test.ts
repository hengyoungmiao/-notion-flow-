import { describe, expect, it, vi } from 'vitest'
import { CliError } from '../../src/core/adapters/exec'
import { DEFAULT_SETTINGS } from '../../src/core/config'
import { Scheduler } from '../../src/core/scheduler'
import { NeedsInitialSyncError, type RoundResult, type SyncEngine } from '../../src/core/sync/engine'
import { collectDiagnostics, sanitizeTask } from '../../src/core/diagnostics'
import { FakeDida } from '../../src/core/adapters/fake'

function result(writes: number): RoundResult {
  return {
    summary: { counts: { creates: writes, updates: 0, corrections: 0, destructive: 0, links: 0, unlinks: 0 }, creates: [], updates: [], matches: [], destructive: [], domainCreates: [], domainRows: [], warnings: [] },
    applied: true,
    blocked: null,
    writes,
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
