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
