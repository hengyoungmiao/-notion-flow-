import { desiredFocus, focusKind, focusTaskId, type DesiredFocus } from '../mapping/focus'
import type { DidaFocus, WorkspaceState } from '../types'

export type FocusOp =
  | { kind: 'focusCreate'; desired: DesiredFocus; taskPageId: string }
  | { kind: 'focusUpdate'; desired: DesiredFocus; pageId: string; taskPageId: string }
  | { kind: 'focusTrash'; focusId: string; pageId: string; title: string }

export interface FocusPlanInput {
  records: DidaFocus[]
  state: Pick<WorkspaceState, 'focus'>
  /** 滴答任务 → 已同步的 Notion 任务页（未同步返回 null） */
  taskFor: (didaId: string) => { pageId: string; title: string } | null
  /** 本轮读取窗口，窗口内缺席的记录才需要确认是否已删除 */
  from: Date
  to: Date
  /** 缺席记录的确认结果：null = 已删除 */
  confirmations: Map<string, DidaFocus | null>
  zone: string
}

/** 滴答专注记录 → FLO.W 任务番茄数据库（单向，只处理关联到已同步任务的记录） */
export function planFocus(input: FocusPlanInput): FocusOp[] {
  const ops: FocusOp[] = []
  const seen = new Set<string>()
  const handle = (r: DidaFocus) => {
    seen.add(r.id)
    const link = input.state.focus.links[r.id]
    if (link?.removed) return
    const taskId = focusTaskId(r)
    const task = taskId ? input.taskFor(taskId) : null
    if (!task) return
    const d = desiredFocus(r, task.title, input.zone)
    if (!d) return
    if (!link) ops.push({ kind: 'focusCreate', desired: d, taskPageId: task.pageId })
    else if (link.hash !== d.hash) ops.push({ kind: 'focusUpdate', desired: d, pageId: link.pageId, taskPageId: task.pageId })
  }
  for (const r of input.records) handle(r)
  for (const link of Object.values(input.state.focus.links)) {
    if (seen.has(link.focusId) || link.removed) continue
    if (!input.confirmations.has(link.focusId)) continue
    const found = input.confirmations.get(link.focusId)
    if (found) handle(found)
    else ops.push({ kind: 'focusTrash', focusId: link.focusId, pageId: link.pageId, title: '番茄记录' })
  }
  return ops
}

/** 窗口内、本轮没读到、需要逐条确认的已关联记录 */
export function missingInWindow(state: Pick<WorkspaceState, 'focus'>, seen: Set<string>, from: Date, to: Date) {
  return Object.values(state.focus.links).filter((l) => {
    if (l.removed || seen.has(l.focusId)) return false
    const at = Date.parse(l.startTime)
    return at >= from.getTime() && at <= to.getTime()
  })
}

export { focusKind }
