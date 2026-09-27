import { describe, expect, it } from 'vitest'
import { KEEP, planDomains, type DomainInput } from '../../src/core/mapping/domains'
import { emptyState } from '../../src/core/sync/state'

function input(over: Partial<DomainInput> = {}): DomainInput {
  return {
    projects: [
      { id: 'p1', name: '开发', groupId: 'g1' },
      { id: 'p2', name: '阅读', groupId: null },
      { id: 'p3', name: '归档', groupId: 'g1', closed: true },
      { id: 'p4', name: '笔记', kind: 'NOTE' }
    ],
    groups: [{ id: 'g1', name: '工作' }],
    notionDomains: [],
    notionAreas: [],
    profile: { scope: { excludedLists: [], includeInbox: true, importCompletedDays: 0 }, mappings: { lists: {}, groups: {} } },
    state: emptyState('w'),
    autoCreate: true,
    domainsAvailable: true,
    areasAvailable: true,
    ...over
  }
}

describe('planDomains', () => {
  it('creates missing areas/domains and skips closed/note lists', () => {
    const plan = planDomains(input())
    expect([...plan.scopeProjectIds].sort()).toEqual(['p1', 'p2'])
    expect(plan.ops.map((o) => o.kind)).toEqual(['createArea', 'createDomain', 'createDomain'])
    expect(plan.listMap.get('p1')).toBe('pending:p1')
    const create = plan.ops.find((o) => o.kind === 'createDomain' && o.projectId === 'p1')
    expect(create).toMatchObject({ areaRef: 'pending:group:g1' })
  })

  it('matches by normalized name and adds the area relation', () => {
    const plan = planDomains(
      input({
        notionAreas: [{ pageId: 'A1', title: '工作' }],
        notionDomains: [{ pageId: 'D1', title: ' 开发 ', areaIds: [] }, { pageId: 'D2', title: '阅读', areaIds: ['X'] }]
      })
    )
    expect(plan.listMap.get('p1')).toBe('D1')
    expect(plan.listMap.get('p2')).toBe('D2')
    expect(plan.ops).toContainEqual({ kind: 'setDomainArea', projectId: 'p1', pageId: 'D1', add: 'A1', remove: null, current: [] })
    // 没有文件夹的清单不会去掉 Notion 里已有的一级领域
    expect(plan.ops.some((o) => o.kind === 'setDomainArea' && o.projectId === 'p2')).toBe(false)
  })

  it('does not auto-create when disabled', () => {
    const plan = planDomains(input({ autoCreate: false }))
    expect(plan.ops.filter((o) => o.kind.startsWith('create'))).toHaveLength(0)
    expect(plan.listMap.get('p1')).toBeNull()
    expect(plan.warnings.length).toBeGreaterThan(0)
  })

  it('marks links to deleted pages as broken (KEEP)', () => {
    const state = emptyState('w')
    state.domains.lists.p1 = { didaId: 'p1', pageId: 'GONE', mode: 'created', lastName: '开发', writtenAreaPageId: null }
    const plan = planDomains(input({ state }))
    expect(plan.listMap.get('p1')).toBe(KEEP)
    expect(plan.warnings.some((w) => w.includes('已被删除'))).toBe(true)
  })

  it('respects exclusions and manual skip', () => {
    const plan = planDomains(
      input({ profile: { scope: { excludedLists: ['p1'], includeInbox: true, importCompletedDays: 0 }, mappings: { lists: { p2: { mode: 'skip' } }, groups: {} } } })
    )
    expect(plan.scopeProjectIds.size).toBe(0)
    expect(plan.rows.filter((r) => r.status === 'excluded')).toHaveLength(2)
  })
})

describe('「新建同名」只执行一次', () => {
  it('已经新建过且页面还在：沿用，不再新建', () => {
    const state = emptyState('w')
    state.domains.lists.p1 = { didaId: 'p1', pageId: 'D-new', mode: 'created', lastName: '开发', writtenAreaPageId: null }
    state.domains.groups.g1 = { didaId: 'g1', pageId: 'A-new', mode: 'created', lastName: '工作', writtenAreaPageId: null }
    const plan = planDomains(
      input({
        state,
        notionAreas: [{ pageId: 'A-new', title: '工作' }],
        notionDomains: [{ pageId: 'D-new', title: '开发', areaIds: ['A-new'] }],
        profile: {
          scope: { excludedLists: [], includeInbox: true, importCompletedDays: 0 },
          mappings: { lists: { p1: { mode: 'create' } }, groups: { g1: { mode: 'create' } } }
        }
      })
    )
    expect(plan.ops.filter((o) => o.kind === 'createDomain' && o.projectId === 'p1')).toHaveLength(0)
    expect(plan.ops.filter((o) => o.kind === 'createArea')).toHaveLength(0)
    expect(plan.listMap.get('p1')).toBe('D-new')
  })

  it('新建的页面被删了，或原来是自动关联的：才会新建', () => {
    const state = emptyState('w')
    state.domains.lists.p1 = { didaId: 'p1', pageId: 'GONE', mode: 'created', lastName: '开发', writtenAreaPageId: null }
    state.domains.lists.p2 = { didaId: 'p2', pageId: 'D2', mode: 'auto', lastName: '阅读', writtenAreaPageId: null }
    const plan = planDomains(
      input({
        state,
        notionDomains: [{ pageId: 'D2', title: '阅读', areaIds: [] }],
        profile: {
          scope: { excludedLists: [], includeInbox: true, importCompletedDays: 0 },
          mappings: { lists: { p1: { mode: 'create' }, p2: { mode: 'create' } }, groups: {} }
        }
      })
    )
    expect(plan.ops.filter((o) => o.kind === 'createDomain').map((o) => (o as { projectId: string }).projectId).sort()).toEqual(['p1', 'p2'])
  })
})

describe('已归档 / 已删除的清单', () => {
  it('映射表显示为已归档、已删除，没有警告，不进入同步范围', () => {
    const state = emptyState('w')
    state.domains.lists.p3 = { didaId: 'p3', pageId: 'D3', mode: 'auto', lastName: '归档', writtenAreaPageId: null }
    state.domains.lists.gone = { didaId: 'gone', pageId: 'D9', mode: 'auto', lastName: '旧清单', writtenAreaPageId: null }
    state.lists.deleted.gone = { name: '旧清单', at: '2026-09-27T08:00:00.000Z' }
    const plan = planDomains(
      input({
        state,
        notionDomains: [
          { pageId: 'D3', title: '归档领域', areaIds: [] },
          { pageId: 'D9', title: '旧领域', areaIds: [] }
        ]
      })
    )
    expect(plan.warnings).toEqual([])
    expect(plan.scopeProjectIds.has('p3')).toBe(false)
    expect(plan.rows.find((r) => r.didaId === 'p3')).toMatchObject({ status: 'archived', notionTitle: '归档领域' })
    expect(plan.rows.find((r) => r.didaId === 'gone')).toMatchObject({ status: 'deleted', didaName: '旧清单', notionTitle: '旧领域' })
  })

  it('从没同步过的旧归档清单不显示', () => {
    const plan = planDomains(input())
    expect(plan.rows.some((r) => r.didaId === 'p3')).toBe(false)
  })

  it('同名新清单可以接回已删除清单原来的二级领域', () => {
    const state = emptyState('w')
    state.domains.lists.gone = { didaId: 'gone', pageId: 'D1', mode: 'auto', lastName: '开发', writtenAreaPageId: null }
    state.lists.deleted.gone = { name: '开发', at: '2026-09-27T08:00:00.000Z' }
    const plan = planDomains(input({ state, notionDomains: [{ pageId: 'D1', title: '开发', areaIds: [] }] }))
    expect(plan.listMap.get('p1')).toBe('D1')
    expect(plan.ops.some((o) => o.kind === 'createDomain' && o.projectId === 'p1')).toBe(false)
  })
})
