// ───────────────────────── 滴答清单（Open API 原始结构，只读） ─────────────────────────

export interface DidaProject {
  id: string
  name: string
  groupId?: string | null
  closed?: boolean | null
  kind?: string | null // TASK | NOTE
  permission?: string | null // read | comment | write
  sortOrder?: number
}

export interface DidaGroup {
  id: string
  name: string
  sortOrder?: number
}

export interface DidaChecklistItem {
  id?: string
  title?: string
  status?: number
  sortOrder?: number
}

export interface DidaTag {
  name: string
  label?: string
  parent?: string | null
}

export interface DidaTask {
  id: string
  projectId: string
  title?: string
  content?: string
  desc?: string
  startDate?: string | null
  dueDate?: string | null
  isAllDay?: boolean
  timeZone?: string | null
  status?: number // -1 已放弃，0 未完成，2 已完成
  completedTime?: string | null
  modifiedTime?: string | null
  etag?: string
  kind?: string | null // TEXT | NOTE | CHECKLIST
  parentId?: string | null
  repeatFlag?: string | null
  repeatFrom?: number | string | null
  repeatTaskId?: string | null
  childIds?: string[] | null
  sortOrder?: number
  items?: DidaChecklistItem[]
  tags?: string[]
  priority?: number
}

/** 专注记录：type 0 = 番茄钟，1 = 正计时 */
export interface DidaFocus {
  id: string
  type?: number | string
  taskId?: string | null
  tasks?: Array<{ taskId?: string; id?: string; title?: string; projectId?: string }> | null
  note?: string | null
  startTime?: string | null
  endTime?: string | null
  /** 专注时长（秒） */
  duration?: number | null
  pauseDuration?: number | null
  status?: number | null
  etag?: string | null
}

export interface DidaPreference {
  timeZone?: string
  [key: string]: unknown
}

// ───────────────────────── Notion（REST API 2026-03-11 子集） ─────────────────────────

export interface NotionRichText {
  plain_text?: string
  text?: { content: string }
  type?: string
}

export interface NotionDateValue {
  start: string
  end?: string | null
  time_zone?: string | null
}

export interface NotionPropertyValue {
  id: string
  type: string
  title?: NotionRichText[]
  rich_text?: NotionRichText[]
  status?: { id: string; name: string } | null
  select?: { id: string; name: string } | null
  date?: NotionDateValue | null
  relation?: { id: string }[]
  has_more?: boolean
  [key: string]: unknown
}

export interface NotionPage {
  object?: 'page'
  id: string
  url?: string
  created_time?: string
  last_edited_time?: string
  in_trash?: boolean
  archived?: boolean
  parent?: { type: string; data_source_id?: string; database_id?: string }
  properties: Record<string, NotionPropertyValue>
}

export interface NotionStatusOption {
  id: string
  name: string
  color?: string
}

export interface NotionStatusGroup {
  id: string
  name: string
  color?: string
  option_ids: string[]
}

export interface NotionPropertySchema {
  id: string
  name: string
  type: string
  status?: { options: NotionStatusOption[]; groups: NotionStatusGroup[] }
  select?: { options: NotionStatusOption[] }
  relation?: { data_source_id?: string; database_id?: string; type?: string }
  [key: string]: unknown
}

export interface NotionDataSource {
  object?: 'data_source'
  id: string
  title?: NotionRichText[]
  parent?: { type: string; database_id?: string }
  properties: Record<string, NotionPropertySchema>
  url?: string
}

export interface NotionQueryResult<T> {
  results: T[]
  next_cursor: string | null
  has_more: boolean
}

// ───────────────────────── FLO.W 结构绑定（按属性 ID / 选项 ID） ─────────────────────────

export type StatusGroup = 'open' | 'done' | 'abandoned'

export interface FlowSchema {
  tasks: {
    dataSourceId: string
    title: string
    props: {
      title: string
      status: string
      schedule: string
      completedAt: string | null
      note: string | null
      domain: string | null
      didaId: string
      taskType: string | null
      /** 「关联项目」关系；旧配置可能没有 */
      project?: string | null
    }
    statusOptions: { open: string; done: string; abandoned: string }
    statusGroups: Record<string, StatusGroup>
    taskTypeOptions: { schedule: string | null; todo: string | null }
  }
  domains: {
    dataSourceId: string
    title: string
    props: { title: string; area: string | null }
  } | null
  areas: {
    dataSourceId: string
    title: string
    props: { title: string }
  } | null
  /** FLO.W「我的项目 DB」（通过任务库的「关联项目」找到）；undefined 表示旧配置尚未识别 */
  projects?: {
    dataSourceId: string
    title: string
    props: { title: string }
  } | null
  /** FLO.W「任务番茄数据库」（通过任务库的「关联番茄」找到）；undefined 表示旧配置尚未识别 */
  focus?: {
    dataSourceId: string
    title: string
    props: { title: string; task: string; start: string; end: string | null; minutes: string | null }
  } | null
}

// ───────────────────────── 配置 ─────────────────────────

export type DomainMapping =
  | { mode: 'auto' }
  | { mode: 'map'; pageId: string }
  | { mode: 'create' }
  | { mode: 'skip' }

export interface WorkspaceProfile {
  id: string
  name: string
  notionWorkspaceName: string | null
  notionUserName: string | null
  auth: { type: 'ntn' } | { type: 'token'; tokenEnc: string }
  schema: FlowSchema | null
  scope: {
    excludedLists: string[]
    includeInbox: boolean
    importCompletedDays: number
  }
  mappings: {
    lists: Record<string, DomainMapping>
    groups: Record<string, DomainMapping>
  }
  createdAt: string
}

export type DeletePolicy = 'trash' | 'abandon' | 'ignore'

export interface AppSettings {
  pollMinSec: number
  pollMaxSec: number
  reconcileMinutes: number
  structureMinutes: number
  deletePolicy: DeletePolicy
  breaker: { maxTrash: number; maxUpdateRatio: number; minUpdates: number }
  /** 描述、检查事项、子任务、重复规则写入页面顶部的“滴答同步区” */
  syncBody: boolean
  /** 滴答标签 #项目名 自动关联 FLO.W 同名项目 */
  syncProjects: boolean
  /** 重复任务：「任务类型」固定为「日程」，且不按标签关联项目 */
  recurringAsSchedule: boolean
  applyTemplate: boolean
  recurringCompletionRecords: boolean
  /** 同步滴答的番茄钟/正计时记录到 FLO.W 任务番茄数据库 */
  syncFocus: boolean
  /** 首次同步专注记录时导入最近几天 */
  focusImportDays: number
  autoCreateDomains: boolean
  launchAtLogin: boolean
  startMinimized: boolean
  closeToTray: boolean
  /** 全天多日任务的 dueDate 是否为“结束日次日 0 点”（待真实样例校准） */
  allDayEndExclusive: boolean
  defaultTimeZone: string
}

export interface AppConfig {
  version: 1
  activeWorkspaceId: string | null
  workspaces: WorkspaceProfile[]
  settings: AppSettings
  onboarded: boolean
}

// ───────────────────────── 同步状态（每个工作空间一份） ─────────────────────────

export interface WrittenTask {
  title: string
  statusGroup: StatusGroup
  schedule: NormalizedDate | null
  completedAt: NormalizedDate | null
  note: string | null
  domainPageId: string | null
  /** 同步写入过的项目（手动关联的项目不在这里） */
  projectPageIds?: string[]
  /** 同步维护的「任务类型」（只有重复任务会维护） */
  taskType?: 'schedule' | null
}

export interface TaskLink {
  didaId: string
  pageId: string
  projectId: string
  written: WrittenTask
  etag?: string
  createdBySync: boolean
  linkedAt: string
  lastSeenAt: string
  parentDidaId?: string | null
  /** 页面顶部同步区（callout）的块 ID 与内容哈希 */
  body?: { blockId: string | null; hash: string | null }
  /** 重复任务的完成记录：本地日期（最近 20 次）、总次数、已计入的完成副本 ID（去重用） */
  history?: { dates: string[]; count: number; ids: string[] }
}

export interface DomainLink {
  didaId: string
  pageId: string
  mode: 'auto' | 'map' | 'created'
  lastName: string
  writtenAreaPageId: string | null
}

export interface FocusLink {
  focusId: string
  pageId: string
  taskDidaId: string
  kind: 'pomodoro' | 'timing'
  /** 开始时间（UTC ISO），用于判断是否在本轮读取窗口内 */
  startTime: string
  hash: string
  /** 在 Notion 中被删除：不再重建 */
  removed?: boolean
}

export interface PendingApproval {
  createdAt: string
  reason: string
  trash: number
  updates: number
  sample: string[]
}

export interface WorkspaceState {
  version: 1
  workspaceId: string
  initializedAt: string | null
  lastSuccessAt: string | null
  lastReconcileAt: string | null
  tasks: Record<string, TaskLink>
  notionRemoved: Record<string, { pageId: string; title: string; at: string }>
  domains: {
    lists: Record<string, DomainLink>
    groups: Record<string, DomainLink>
  }
  pendingApproval: PendingApproval | null
  foreignSightings: number
  focus: {
    /** 上次成功读取专注记录的时间 */
    cursor: string | null
    links: Record<string, FocusLink>
  }
  /** 滴答清单的归档/删除记录（归档清单里的任务不做任何同步；已删除清单在映射页显示 30 天） */
  lists: ListLifecycle
}

export interface ListLifecycle {
  /** 已归档（closed）的清单：date 为检测到归档那天的本地日期；checkedAt 为最近一次向滴答确认它还存在的时间 */
  archived: Record<string, { name: string; date: string; at: string; checkedAt?: string }>
  /** 已在滴答删除的清单（映射页显示 30 天） */
  deleted: Record<string, { name: string; at: string }>
}

// ───────────────────────── 规范化值 ─────────────────────────

/** 规范化日期：纯日期保留 YYYY-MM-DD；带时间统一转成 UTC ISO（毫秒精度） */
export interface NormalizedDate {
  start: string
  end: string | null
}

export interface DesiredTask {
  didaId: string
  projectId: string
  title: string
  statusGroup: StatusGroup
  schedule: NormalizedDate | null
  /** 写入 Notion 用的原始 date 值（保留时区偏移） */
  scheduleValue: NotionDateValue | null
  completedAt: NormalizedDate | null
  completedValue: NotionDateValue | null
  note: string | null
  /** 期望的二级领域页；`pending:<projectId>` 表示本轮将新建 */
  domainPageId: string | null
  /** 期望由同步关联的项目；null 表示不管理 */
  projectPageIds: string[] | null
  parentDidaId: string | null
  taskTypeOnCreate: 'schedule' | 'todo'
  /** 需要持续维护的「任务类型」；null 表示只在新建时设置 */
  taskType: 'schedule' | null
}
