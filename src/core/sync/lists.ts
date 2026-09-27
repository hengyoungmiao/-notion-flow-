import { DateTime } from 'luxon'
import { isTaskKind } from '../mapping/domains'
import type { DidaProject, ListLifecycle } from '../types'

/** 已删除清单在映射页保留显示的天数 */
export const DELETED_RETENTION_DAYS = 30

export interface ListEvent {
  kind: 'archived' | 'reopened' | 'deleted'
  projectId: string
  name: string
}

export interface ListTracking {
  /** 新的归档/删除记录（写回 state.lists） */
  lists: ListLifecycle
  /** 已归档的清单 → 检测到归档那天（本地日期） */
  archived: Map<string, string>
  /** 已删除的清单 */
  deleted: Set<string>
  /** 本轮新发生的变化（写入同步记录） */
  events: ListEvent[]
  /** 超过保留期、需要连同二级领域链接一起清掉的已删除清单 */
  expired: string[]
}

export interface TrackInput {
  prev: ListLifecycle
  projects: DidaProject[]
  /** 同步用到过的清单（有领域链接或任务链接），不含收件箱 */
  knownProjectIds: Iterable<string>
  /** 清单的原名（来自领域链接），用于已删除清单的显示 */
  names: Record<string, string>
  now: Date
  zone: string
}

/** 对比滴答清单列表和上次的记录，得出归档、重新打开、删除 */
export function trackLists(input: TrackInput): ListTracking {
  const { prev, projects, now } = input
  const nowIso = now.toISOString()
  const today = DateTime.fromJSDate(now).setZone(input.zone).toISODate() ?? nowIso.slice(0, 10)
  const byId = new Map(projects.map((p) => [p.id, p]))
  const known = new Set([...input.knownProjectIds, ...Object.keys(prev.archived), ...Object.keys(prev.deleted)])
  const events: ListEvent[] = []
  const lists: ListLifecycle = { archived: {}, deleted: {} }

  for (const id of known) {
    const project = byId.get(id)
    if (!project || !isTaskKind(project)) continue
    const before = prev.archived[id]
    if (project.closed) {
      lists.archived[id] = before ? { ...before, name: project.name } : { name: project.name, date: today, at: nowIso }
      if (!before) events.push({ kind: 'archived', projectId: id, name: project.name })
    } else if (before) {
      events.push({ kind: 'reopened', projectId: id, name: project.name })
    }
  }

  // 清单列表为空多半是接口异常：这一轮不判定删除，沿用上次的记录
  const expired: string[] = []
  if (projects.length === 0) {
    lists.deleted = { ...prev.deleted }
  } else {
    const retentionMs = DELETED_RETENTION_DAYS * 86_400_000
    for (const id of known) {
      if (byId.has(id) || id.startsWith('inbox')) continue
      const before = prev.deleted[id]
      if (before) {
        if (now.getTime() - Date.parse(before.at) > retentionMs) expired.push(id)
        else lists.deleted[id] = before
        continue
      }
      const name = input.names[id] ?? prev.archived[id]?.name ?? '（已删除的清单）'
      lists.deleted[id] = { name, at: nowIso }
      events.push({ kind: 'deleted', projectId: id, name })
    }
  }

  return {
    lists,
    archived: new Map(Object.entries(lists.archived).map(([id, v]) => [id, v.date])),
    deleted: new Set(Object.keys(lists.deleted)),
    events,
    expired
  }
}
