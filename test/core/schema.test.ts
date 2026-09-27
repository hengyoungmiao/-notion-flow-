import { describe, expect, it } from 'vitest'
import { FakeNotion, FLOW_IDS, createFlowWorkspace } from '../../src/core/adapters/fake'
import {
  bindFlowSchema,
  ensureDidaIdProperty,
  extractNotionId,
  findTaskCandidates,
  resolveTaskDataSource,
  validateSchema
} from '../../src/core/notion/discovery'

describe('FLO.W discovery', () => {
  it('binds tasks → domains → areas by following relations', async () => {
    const notion = new FakeNotion()
    createFlowWorkspace(notion)
    const res = await bindFlowSchema(notion, FLOW_IDS.tasks)
    expect(res.needsDidaIdProperty).toBe(true)
    const s = res.schema!
    expect(s.tasks.props).toMatchObject({ title: 'title', status: 'p_status', schedule: 'p_sched', completedAt: 'p_done', note: 'p_note', domain: 'p_domain' })
    expect(s.tasks.statusOptions).toEqual({ open: FLOW_IDS.status.todo, done: FLOW_IDS.status.done, abandoned: FLOW_IDS.status.abandoned })
    expect(s.tasks.statusGroups[FLOW_IDS.status.doing]).toBe('open')
    expect(s.tasks.statusGroups[FLOW_IDS.status.abandoned]).toBe('abandoned')
    expect(s.domains?.dataSourceId).toBe(FLOW_IDS.domains)
    expect(s.domains?.props.area).toBe('p_area')
    expect(s.areas?.dataSourceId).toBe(FLOW_IDS.areas)
  })

  it('adds the 滴答ID property once', async () => {
    const notion = new FakeNotion()
    createFlowWorkspace(notion)
    const res = await bindFlowSchema(notion, FLOW_IDS.tasks)
    const s = await ensureDidaIdProperty(notion, res.schema!)
    expect(s.tasks.props.didaId).toBeTruthy()
    const again = await ensureDidaIdProperty(notion, s)
    expect(again).toBe(s)
    expect(await validateSchema(notion, s)).toEqual([])
  })

  it('reports removed properties', async () => {
    const notion = new FakeNotion()
    createFlowWorkspace(notion, { withDidaId: true })
    const s = (await bindFlowSchema(notion, FLOW_IDS.tasks)).schema!
    delete notion.sources.get(FLOW_IDS.tasks)!.ds.properties['排期']
    const issues = await validateSchema(notion, s)
    expect(issues.some((i) => i.message.includes('排期'))).toBe(true)
  })

  it('rejects data sources that are not FLO.W task DBs', async () => {
    const notion = new FakeNotion()
    notion.addDataSource({ id: 'x', title: [{ plain_text: '随便' }], properties: { Name: { id: 'title', name: 'Name', type: 'title' } } })
    const res = await bindFlowSchema(notion, 'x')
    expect(res.schema).toBeNull()
    expect(res.issues.some((i) => i.level === 'error')).toBe(true)
  })

  it('finds candidates and resolves pasted links', async () => {
    const notion = new FakeNotion()
    createFlowWorkspace(notion)
    const candidates = await findTaskCandidates(notion)
    expect(candidates[0]).toMatchObject({ dataSourceId: FLOW_IDS.tasks, looksLikeFlow: true })
    expect(extractNotionId('https://www.notion.so/ws/FLO-W-4c6f1130184c8345a7318146b5373823?v=abc')).toBe('4c6f1130184c8345a7318146b5373823')
    expect(extractNotionId('collection://a1ef1130-184c-83d8-86c3-87eb16ef4a20')).toBe('a1ef1130184c83d886c387eb16ef4a20')
    await expect(resolveTaskDataSource(notion, 'no id here')).rejects.toThrow()
  })
})
