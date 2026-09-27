import { FakeDida, FakeNotion, FLOW_IDS, createFlowWorkspace } from '../../src/core/adapters/fake'
import { DEFAULT_SETTINGS, newWorkspace } from '../../src/core/config'
import { bindFlowSchema, ensureDidaIdProperty } from '../../src/core/notion/discovery'
import { SyncEngine } from '../../src/core/sync/engine'
import { MemoryStateStore } from '../../src/core/sync/state'
import type { ActivityEntry } from '../../src/core/activity'
import type { AppSettings, NotionPage, WorkspaceProfile } from '../../src/core/types'
import { plainText } from '../../src/core/mapping/text'

export interface World {
  dida: FakeDida
  notion: FakeNotion
  store: MemoryStateStore
  profile: WorkspaceProfile
  settings: AppSettings
  logs: Array<Omit<ActivityEntry, 'id' | 'at'>>
  now: { value: Date }
  engine: () => SyncEngine
}

export async function makeWorld(opts: { settings?: Partial<AppSettings>; seed?: (w: World) => void } = {}): Promise<World> {
  const dida = new FakeDida()
  const notion = new FakeNotion()
  createFlowWorkspace(notion)
  const profile = newWorkspace('测试空间')
  const bound = await bindFlowSchema(notion, FLOW_IDS.tasks)
  profile.schema = await ensureDidaIdProperty(notion, bound.schema!)
  const world: World = {
    dida,
    notion,
    store: new MemoryStateStore(),
    profile,
    settings: { ...DEFAULT_SETTINGS, ...opts.settings },
    logs: [],
    now: { value: new Date('2026-09-27T08:00:00Z') },
    engine: () =>
      new SyncEngine({
        dida: world.dida,
        notion: world.notion,
        store: world.store,
        profile: world.profile,
        settings: world.settings,
        log: (e) => world.logs.push(e),
        now: () => world.now.value
      })
  }
  dida.groups = [{ id: 'g-work', name: '工作' }, { id: 'g-life', name: '生活' }]
  dida.projects = [
    { id: 'p-dev', name: '开发', groupId: 'g-work', kind: 'TASK' },
    { id: 'p-read', name: '阅读', groupId: 'g-life', kind: 'TASK' },
    { id: 'p-loose', name: '零散', groupId: null, kind: 'TASK' },
    { id: 'p-notes', name: '笔记本', groupId: 'g-life', kind: 'NOTE' }
  ]
  opts.seed?.(world)
  notion.writes = 0
  return world
}

export function advance(w: World, minutes: number): void {
  w.now = { value: new Date(w.now.value.getTime() + minutes * 60_000) }
}

export function taskPages(w: World): NotionPage[] {
  return w.notion.pagesOf(FLOW_IDS.tasks).filter((p) => !p.in_trash)
}

export function prop(page: NotionPage, name: string) {
  return page.properties[name]
}

export function titleOf(page: NotionPage, name = '任务'): string {
  const p = page.properties[name]
  return plainText(p?.title ?? p?.rich_text)
}

export function pageByDidaId(w: World, didaId: string): NotionPage | undefined {
  return taskPages(w).find((p) => plainText(p.properties['滴答ID']?.rich_text) === didaId)
}

export function domainPages(w: World): NotionPage[] {
  return w.notion.pagesOf(FLOW_IDS.domains)
}

export function areaPages(w: World): NotionPage[] {
  return w.notion.pagesOf(FLOW_IDS.areas)
}
