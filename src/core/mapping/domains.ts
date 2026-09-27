import type { DidaGroup, DidaProject, DomainLink, DomainMapping, WorkspaceProfile, WorkspaceState } from '../types'
import { normalizeTitle } from './text'

export interface NotionDomainPage {
  pageId: string
  title: string
  areaIds: string[]
}

export interface NotionAreaPage {
  pageId: string
  title: string
}

export const KEEP = 'keep:'

export type DomainOp =
  | { kind: 'createArea'; groupId: string; name: string }
  | { kind: 'renameArea'; groupId: string; pageId: string; name: string }
  | { kind: 'linkArea'; groupId: string; link: DomainLink }
  | { kind: 'createDomain'; projectId: string; name: string; areaRef: string | null }
  | { kind: 'renameDomain'; projectId: string; pageId: string; name: string }
  | { kind: 'setDomainArea'; projectId: string; pageId: string; add: string | null; remove: string | null; current: string[] }
  | { kind: 'linkDomain'; projectId: string; link: DomainLink }

export interface DomainPlan {
  /** 清单 → 二级领域页 ID / `pending:<projectId>` / KEEP（映射失效，保持任务现状）/ null（不设置） */
  listMap: Map<string, string | null>
  /** 参与同步的清单 */
  scopeProjectIds: Set<string>
  ops: DomainOp[]
  warnings: string[]
  /** 供界面展示的映射表 */
  rows: DomainRow[]
}

export interface DomainRow {
  type: 'group' | 'list'
  didaId: string
  didaName: string
  groupId: string | null
  status: 'linked' | 'matched' | 'create' | 'skip' | 'none' | 'broken' | 'excluded'
  notionPageId: string | null
  notionTitle: string | null
  mode: DomainMapping['mode'] | 'created' | null
  needsFolderHint?: boolean
}

export interface DomainInput {
  projects: DidaProject[]
  groups: DidaGroup[]
  notionDomains: NotionDomainPage[]
  notionAreas: NotionAreaPage[]
  profile: Pick<WorkspaceProfile, 'scope' | 'mappings'>
  state: Pick<WorkspaceState, 'domains'>
  autoCreate: boolean
  /** 结构数据库不可用（例如未识别到领域库）时只做范围计算 */
  domainsAvailable: boolean
  areasAvailable: boolean
}

export function isTaskList(p: DidaProject): boolean {
  return (p.kind ?? 'TASK').toUpperCase() !== 'NOTE' && !p.closed
}

export function planDomains(input: DomainInput): DomainPlan {
  const ops: DomainOp[] = []
  const warnings: string[] = []
  const rows: DomainRow[] = []
  const listMap = new Map<string, string | null>()
  const scopeProjectIds = new Set<string>()
  const excluded = new Set(input.profile.scope.excludedLists)

  const domainById = new Map(input.notionDomains.map((d) => [d.pageId, d]))
  const areaById = new Map(input.notionAreas.map((a) => [a.pageId, a]))

  // ── 文件夹 → 一级领域 ──
  const areaRefByGroup = new Map<string, string | null>()
  const claimedAreas = new Set<string>()
  for (const link of Object.values(input.state.domains.groups)) if (areaById.has(link.pageId)) claimedAreas.add(link.pageId)

  const groupsInUse = new Set(
    input.projects.filter((p) => isTaskList(p) && !excluded.has(p.id) && p.groupId).map((p) => p.groupId as string)
  )

  for (const group of input.groups) {
    if (!groupsInUse.has(group.id)) continue
    const mapping = input.profile.mappings.groups[group.id] ?? { mode: 'auto' }
    const link = input.state.domains.groups[group.id]
    const row: DomainRow = {
      type: 'group',
      didaId: group.id,
      didaName: group.name,
      groupId: null,
      status: 'none',
      notionPageId: null,
      notionTitle: null,
      mode: mapping.mode
    }
    rows.push(row)
    if (!input.areasAvailable || mapping.mode === 'skip') {
      areaRefByGroup.set(group.id, null)
      row.status = 'skip'
      continue
    }
    if (mapping.mode === 'map') {
      const area = areaById.get(mapping.pageId)
      if (!area) {
        warnings.push(`文件夹「${group.name}」手动对应的一级领域已不存在，请在「领域映射」里重新选择`)
        areaRefByGroup.set(group.id, null)
        row.status = 'broken'
        continue
      }
      areaRefByGroup.set(group.id, area.pageId)
      claimedAreas.add(area.pageId)
      Object.assign(row, { status: 'linked', notionPageId: area.pageId, notionTitle: area.title })
      if (!link || link.pageId !== area.pageId || link.mode !== 'map')
        ops.push({ kind: 'linkArea', groupId: group.id, link: newLink(group.id, area.pageId, 'map', group.name) })
      continue
    }
    if (link && mapping.mode !== 'create') {
      const area = areaById.get(link.pageId)
      if (!area) {
        warnings.push(`一级领域「${link.lastName}」在 Notion 中已被删除，文件夹「${group.name}」暂不绑定一级领域`)
        areaRefByGroup.set(group.id, null)
        row.status = 'broken'
        continue
      }
      areaRefByGroup.set(group.id, area.pageId)
      Object.assign(row, { status: 'linked', notionPageId: area.pageId, notionTitle: area.title, mode: link.mode })
      if (link.mode !== 'map' && link.lastName !== group.name) {
        ops.push({ kind: 'renameArea', groupId: group.id, pageId: area.pageId, name: group.name })
        ops.push({ kind: 'linkArea', groupId: group.id, link: { ...link, lastName: group.name } })
      }
      continue
    }
    const match =
      mapping.mode === 'create' ? undefined : uniqueByTitle(input.notionAreas, group.name, claimedAreas)
    if (match) {
      claimedAreas.add(match.pageId)
      areaRefByGroup.set(group.id, match.pageId)
      Object.assign(row, { status: 'matched', notionPageId: match.pageId, notionTitle: match.title, mode: 'auto' })
      ops.push({ kind: 'linkArea', groupId: group.id, link: newLink(group.id, match.pageId, 'auto', group.name) })
    } else if (input.autoCreate || mapping.mode === 'create') {
      areaRefByGroup.set(group.id, `pending:group:${group.id}`)
      Object.assign(row, { status: 'create', notionTitle: group.name, mode: 'created' })
      ops.push({ kind: 'createArea', groupId: group.id, name: group.name })
    } else {
      areaRefByGroup.set(group.id, null)
      warnings.push(`文件夹「${group.name}」没有找到同名的一级领域`)
    }
  }

  // ── 清单 → 二级领域 ──
  const claimedDomains = new Set<string>()
  for (const link of Object.values(input.state.domains.lists)) if (domainById.has(link.pageId)) claimedDomains.add(link.pageId)

  for (const project of input.projects) {
    if (!isTaskList(project)) continue
    const mapping = input.profile.mappings.lists[project.id] ?? { mode: 'auto' }
    const groupId = project.groupId ?? null
    const row: DomainRow = {
      type: 'list',
      didaId: project.id,
      didaName: project.name,
      groupId,
      status: 'none',
      notionPageId: null,
      notionTitle: null,
      mode: mapping.mode
    }
    rows.push(row)
    if (excluded.has(project.id) || mapping.mode === 'skip') {
      row.status = 'excluded'
      continue
    }
    scopeProjectIds.add(project.id)
    if (!input.domainsAvailable) {
      listMap.set(project.id, null)
      continue
    }
    const areaRef = groupId ? (areaRefByGroup.get(groupId) ?? null) : null
    const link = input.state.domains.lists[project.id]
    let pageId: string | null = null

    if (mapping.mode === 'map') {
      const domain = domainById.get(mapping.pageId)
      if (!domain) {
        warnings.push(`清单「${project.name}」手动对应的二级领域已不存在，请在「领域映射」里重新选择`)
        listMap.set(project.id, KEEP)
        row.status = 'broken'
        continue
      }
      pageId = domain.pageId
      claimedDomains.add(pageId)
      Object.assign(row, { status: 'linked', notionPageId: pageId, notionTitle: domain.title })
      if (!link || link.pageId !== pageId || link.mode !== 'map')
        ops.push({ kind: 'linkDomain', projectId: project.id, link: newLink(project.id, pageId, 'map', project.name, link?.writtenAreaPageId) })
    } else if (link && mapping.mode !== 'create') {
      const domain = domainById.get(link.pageId)
      if (!domain) {
        warnings.push(`二级领域「${link.lastName}」在 Notion 中已被删除，清单「${project.name}」的任务暂时保持原有领域`)
        listMap.set(project.id, KEEP)
        row.status = 'broken'
        continue
      }
      pageId = domain.pageId
      Object.assign(row, { status: 'linked', notionPageId: pageId, notionTitle: domain.title, mode: link.mode })
      if (link.mode !== 'map' && link.lastName !== project.name) {
        ops.push({ kind: 'renameDomain', projectId: project.id, pageId, name: project.name })
        ops.push({ kind: 'linkDomain', projectId: project.id, link: { ...link, lastName: project.name } })
      }
    } else {
      const candidates = input.notionDomains.filter(
        (d) => !claimedDomains.has(d.pageId) && normalizeTitle(d.title) === normalizeTitle(project.name)
      )
      let match: NotionDomainPage | undefined
      if (mapping.mode !== 'create') {
        if (candidates.length === 1) match = candidates[0]
        else if (candidates.length > 1) {
          match = candidates.find((c) => areaRef && c.areaIds.includes(areaRef)) ?? candidates[0]
          warnings.push(`有多个名为「${project.name}」的二级领域，已自动选择一个，可在「领域映射」里调整`)
        }
      }
      if (match) {
        pageId = match.pageId
        claimedDomains.add(pageId)
        Object.assign(row, { status: 'matched', notionPageId: pageId, notionTitle: match.title, mode: 'auto' })
        ops.push({ kind: 'linkDomain', projectId: project.id, link: newLink(project.id, pageId, 'auto', project.name) })
      } else if (input.autoCreate || mapping.mode === 'create') {
        const pending = `pending:${project.id}`
        listMap.set(project.id, pending)
        Object.assign(row, { status: 'create', notionTitle: project.name, mode: 'created' })
        ops.push({ kind: 'createDomain', projectId: project.id, name: project.name, areaRef: input.areasAvailable ? areaRef : null })
        continue
      } else {
        listMap.set(project.id, null)
        warnings.push(`清单「${project.name}」没有找到同名的二级领域，任务将不绑定领域`)
        continue
      }
    }

    listMap.set(project.id, pageId)
    // 保证二级领域的「一级领域」关系与滴答文件夹一致（只替换同步写入的值）
    if (pageId && input.areasAvailable) {
      const domain = domainById.get(pageId)
      const current = domain?.areaIds ?? []
      const written = link?.writtenAreaPageId ?? null
      const add = areaRef && !current.includes(areaRef) ? areaRef : null
      const remove = written && written !== areaRef && current.includes(written) ? written : null
      if (add || remove) ops.push({ kind: 'setDomainArea', projectId: project.id, pageId, add, remove, current })
      else if (areaRef && !areaRef.startsWith('pending:') && written !== areaRef && link)
        ops.push({ kind: 'linkDomain', projectId: project.id, link: { ...link, writtenAreaPageId: areaRef } })
    }
  }

  return { listMap, scopeProjectIds, ops, warnings, rows }
}

function newLink(
  didaId: string,
  pageId: string,
  mode: DomainLink['mode'],
  name: string,
  writtenAreaPageId: string | null = null
): DomainLink {
  return { didaId, pageId, mode, lastName: name, writtenAreaPageId }
}

function uniqueByTitle<T extends { pageId: string; title: string }>(
  pages: T[],
  name: string,
  claimed: Set<string>
): T | undefined {
  const found = pages.filter((p) => !claimed.has(p.pageId) && normalizeTitle(p.title) === normalizeTitle(name))
  return found[0]
}
