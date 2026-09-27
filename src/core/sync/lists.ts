import { DateTime } from 'luxon'
import { isTaskKind } from '../mapping/domains'
import type { DidaProject, ListLifecycle } from '../types'

/** 已删除清单在映射页保留显示的天数 */
export const DELETED_RETENTION_DAYS = 30
/** 已归档、但清单列表里没有的清单，隔多久再向滴答确认一次它还在（识别“先归档、后删除”） */
export const ARCHIVED_RECHECK_MS = 24 * 3600_000
/** 每轮最多确认几个清单 */
export const MAX_PROBES = 10

export interface ListEvent {
  kind: 'archived' | 'reopened' | 'deleted'
  projectId: string
  name: string
}

export interface ListTracking {
  /** 新的归档/删除记录（写回 state.lists） */
  lists: ListLifecycle
  /** 已归档的清单 → 检测到归档那天（本地日期）；其中的任务不做任何同步 */
  archived: Map<string, string>
  /** 已删除的清单（确认过） */
  deleted: Set<string>
  /** 从清单列表里消失、但还没确认是归档还是删除的清单：这一轮先不动 */
  pending: Set<string>
  /** 本轮新发生的变化（写入同步记录） */
  events: ListEvent[]
  /** 超过保留期、需要连同二级领域链接一起清掉的已删除清单 */
  expired: string[]
}

/** 单个清单的确认结果：清单对象 = 还在（多半是归档了）；null = 已删除；'error' = 这次没查成 */
export type ProbeResult = DidaProject | null | 'error'

export interface TrackInput {
  prev: ListLifecycle
  projects: DidaProject[]
  /** 同步用到过的清单（有领域链接或任务链接），不含收件箱 */
  knownProjectIds: Iterable<string>
  /** 清单的原名（来自领域链接），用于已删除清单的显示 */
  names: Record<string, string>
  /** 本轮向滴答确认过的清单（`project get`） */
  probes?: Map<string, ProbeResult>
  now: Date
  zone: string
}

/** 需要向滴答确认的清单：新从列表里消失的，以及已归档但列表里没有、且超过 24 小时没确认过的 */
export function probeCandidates(input: Omit<TrackInput, 'probes' | 'zone' | 'names'>): string[] {
  const { prev, projects, now } = input
  if (projects.length === 0) return []
  const listed = new Set(projects.map((p) => p.id))
  const out: string[] = []
  for (const id of new Set([...input.knownProjectIds, ...Object.keys(prev.archived)])) {
    if (listed.has(id) || id.startsWith('inbox') || prev.deleted[id]) continue
    const archived = prev.archived[id]
    if (archived && archived.checkedAt && now.getTime() - Date.parse(archived.checkedAt) < ARCHIVED_RECHECK_MS) continue
    out.push(id)
  }
  return out.slice(0, MAX_PROBES)
}

/**
 * 对比滴答清单列表和上次的记录，得出归档、重新打开、删除。
 * 清单从列表里消失时不直接当成删除：要向滴答确认（probes）查不到才算删除，能查到就当归档。
 */
export function trackLists(input: TrackInput): ListTracking {
  const { prev, projects, now } = input
  const probes = input.probes ?? new Map<string, ProbeResult>()
  const nowIso = now.toISOString()
  const today = DateTime.fromJSDate(now).setZone(input.zone).toISODate() ?? nowIso.slice(0, 10)
  const byId = new Map(projects.map((p) => [p.id, p]))
  const known = new Set([...input.knownProjectIds, ...Object.keys(prev.archived), ...Object.keys(prev.deleted)])
  const events: ListEvent[] = []
  const lists: ListLifecycle = { archived: {}, deleted: {} }
  const pending = new Set<string>()
  const expired: string[] = []
  const retentionMs = DELETED_RETENTION_DAYS * 86_400_000
  const archive = (id: string, name: string, checked: boolean) => {
    const before = prev.archived[id]
    lists.archived[id] = {
      name,
      date: before?.date ?? today,
      at: before?.at ?? nowIso,
      ...(checked ? { checkedAt: nowIso } : before?.checkedAt ? { checkedAt: before.checkedAt } : {})
    }
    if (!before) events.push({ kind: 'archived', projectId: id, name })
  }

  for (const id of known) {
    if (id.startsWith('inbox')) continue
    const project = byId.get(id)
    if (project) {
      if (!isTaskKind(project)) continue
      if (project.closed) archive(id, project.name, false)
      else if (prev.archived[id]) events.push({ kind: 'reopened', projectId: id, name: project.name })
      continue
    }

    // 不在清单列表里
    const deleted = prev.deleted[id]
    if (deleted) {
      if (projects.length > 0 && now.getTime() - Date.parse(deleted.at) > retentionMs) expired.push(id)
      else lists.deleted[id] = deleted
      continue
    }
    const probe = projects.length === 0 ? undefined : probes.get(id)
    if (probe === undefined || probe === 'error') {
      // 清单列表异常或还没确认：保持原状，这一轮不动它的任务
      if (prev.archived[id]) lists.archived[id] = prev.archived[id]
      else pending.add(id)
      continue
    }
    if (probe) {
      archive(id, probe.name, true)
      continue
    }
    const name = input.names[id] ?? prev.archived[id]?.name ?? '（已删除的清单）'
    lists.deleted[id] = { name, at: nowIso }
    events.push({ kind: 'deleted', projectId: id, name })
  }

  return {
    lists,
    archived: new Map(Object.entries(lists.archived).map(([id, v]) => [id, v.date])),
    deleted: new Set(Object.keys(lists.deleted)),
    pending,
    events,
    expired
  }
}
