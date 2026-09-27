// 主进程 ⇄ 渲染进程共享的 IPC 类型（渲染进程拿不到任何凭据）

import type { ActivityEntry } from '../core/activity'
import type { SchedulerSnapshot } from '../core/scheduler'
import type { RoundSummary } from '../core/sync/engine'
import type { BindIssue } from '../core/notion/schema'
import type { AppSettings, DomainMapping } from '../core/types'
import type { DomainRow } from '../core/mapping/domains'

export interface WorkspaceView {
  id: string
  name: string
  notionWorkspaceName: string | null
  notionUserName: string | null
  authType: 'ntn' | 'token'
  loggedIn: boolean
  schema: { tasks: string; domains: string | null; areas: string | null } | null
  /** 已识别数据库且有「滴答ID」字段，可以同步 */
  ready: boolean
  initialized: boolean
  linkedCount: number
  lastSuccessAt: string | null
  scope: { excludedLists: string[]; includeInbox: boolean; importCompletedDays: number }
  removedCount: number
}

export interface AppViewState {
  demo: boolean
  onboarded: boolean
  settings: AppSettings
  workspaces: WorkspaceView[]
  activeWorkspaceId: string | null
  scheduler: SchedulerSnapshot
  dida: { loggedIn: boolean | null; checking: boolean; error: string | null }
  versions: { app: string; ntn: string | null; dida: string | null; electron: string }
  platform: string
}

export interface NotionLoginStart {
  url: string
  code: string
}

export interface TaskCandidateView {
  dataSourceId: string
  title: string
  looksLikeFlow: boolean
}

export interface BindResultView {
  ok: boolean
  issues: BindIssue[]
  schema: { tasks: string; domains: string | null; areas: string | null } | null
  needsDidaIdProperty: boolean
}

export interface MappingView {
  rows: DomainRow[]
  warnings: string[]
  notionDomains: Array<{ pageId: string; title: string }>
  notionAreas: Array<{ pageId: string; title: string }>
  /** 标签 → 项目对照；未启用标签关联项目时为 null */
  tagProjects: Array<{ tag: string; projectTitle: string | null }> | null
}

export interface RemovedView {
  didaId: string
  pageId: string
  title: string
  at: string
}

export interface ActionResult<T = void> {
  ok: boolean
  error?: string
  data?: T
}

/** 渲染进程可调用的方法（全部经过 preload 白名单） */
export interface FlowSyncApi {
  getState(): Promise<AppViewState>
  checkEnvironment(): Promise<AppViewState['versions']>

  // 滴答清单登录（token 由 dida-cli 自己保存）
  didaLoginBrowser(): Promise<ActionResult>
  didaCancelLogin(): Promise<void>
  didaSaveToken(token: string): Promise<ActionResult>
  didaCheck(): Promise<ActionResult<boolean>>
  didaLogout(): Promise<ActionResult>

  // 工作空间
  createWorkspace(name: string): Promise<ActionResult<string>>
  renameWorkspace(id: string, name: string): Promise<ActionResult>
  removeWorkspace(id: string): Promise<ActionResult>
  setActiveWorkspace(id: string): Promise<ActionResult>
  notionLoginStart(id: string): Promise<ActionResult<NotionLoginStart>>
  notionLoginPoll(id: string): Promise<ActionResult>
  notionLoginCancel(id: string): Promise<void>
  notionUseToken(id: string, token: string): Promise<ActionResult>
  findTaskDatabases(id: string): Promise<ActionResult<TaskCandidateView[]>>
  bindTaskDatabase(id: string, dataSourceIdOrLink: string): Promise<ActionResult<BindResultView>>
  ensureDidaIdProperty(id: string): Promise<ActionResult>
  updateScope(id: string, scope: Partial<WorkspaceView['scope']>): Promise<ActionResult>

  // 领域映射
  getMapping(id: string): Promise<ActionResult<MappingView>>
  setListMapping(id: string, projectId: string, mapping: DomainMapping): Promise<ActionResult>
  setGroupMapping(id: string, groupId: string, mapping: DomainMapping): Promise<ActionResult>

  // 同步
  previewInitialSync(id: string): Promise<ActionResult<RoundSummary>>
  startInitialSync(id: string): Promise<ActionResult<{ backupPath: string | null; summary: RoundSummary }>>
  syncNow(): Promise<ActionResult>
  pause(): Promise<void>
  resume(): Promise<void>
  approvePending(): Promise<ActionResult>
  getActivity(limit?: number): Promise<ActivityEntry[]>
  getRemoved(id: string): Promise<RemovedView[]>
  restoreRemoved(id: string, didaId: string): Promise<ActionResult>

  // 设置与工具
  updateSettings(patch: Partial<AppSettings>): Promise<ActionResult>
  finishOnboarding(): Promise<void>
  exportDiagnostics(): Promise<ActionResult<string>>
  openExternal(url: string): Promise<void>
  openPath(kind: 'logs' | 'backups' | 'data'): Promise<void>
}

export type ApiMethod = keyof FlowSyncApi

export const API_METHODS: ApiMethod[] = [
  'getState',
  'checkEnvironment',
  'didaLoginBrowser',
  'didaCancelLogin',
  'didaSaveToken',
  'didaCheck',
  'didaLogout',
  'createWorkspace',
  'renameWorkspace',
  'removeWorkspace',
  'setActiveWorkspace',
  'notionLoginStart',
  'notionLoginPoll',
  'notionLoginCancel',
  'notionUseToken',
  'findTaskDatabases',
  'bindTaskDatabase',
  'ensureDidaIdProperty',
  'updateScope',
  'getMapping',
  'setListMapping',
  'setGroupMapping',
  'previewInitialSync',
  'startInitialSync',
  'syncNow',
  'pause',
  'resume',
  'approvePending',
  'getActivity',
  'getRemoved',
  'restoreRemoved',
  'updateSettings',
  'finishOnboarding',
  'exportDiagnostics',
  'openExternal',
  'openPath'
]

export type ApiEvent = 'state' | 'activity'
export const IPC_INVOKE = 'flowsync:invoke'
export const IPC_EVENT_PREFIX = 'flowsync:event:'
