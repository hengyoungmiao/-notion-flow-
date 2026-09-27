import type { AppSettings, PendingApproval } from '../types'
import { countOps, describeOp, type TaskOp } from './planner'

export interface BreakerVerdict {
  blocked: boolean
  pending: PendingApproval | null
}

/**
 * 批量变更熔断：一轮计划移入回收站/标记放弃过多，或修改比例过高时暂停，等待用户在界面确认。
 * 新建、关联不受限制（不会破坏已有数据）。
 */
export function evaluateBreaker(
  ops: TaskOp[],
  linkedCount: number,
  breaker: AppSettings['breaker'],
  now: Date
): BreakerVerdict {
  const counts = countOps(ops)
  const updates = counts.updates + counts.corrections
  const updateLimit = Math.max(breaker.minUpdates, Math.ceil(linkedCount * breaker.maxUpdateRatio))
  const reasons: string[] = []
  if (counts.destructive > breaker.maxTrash) reasons.push(`计划删除/放弃 ${counts.destructive} 个 Notion 任务（上限 ${breaker.maxTrash}）`)
  if (updates > updateLimit) reasons.push(`计划修改 ${updates} 个 Notion 任务（上限 ${updateLimit}）`)
  if (reasons.length === 0) return { blocked: false, pending: null }
  const sample = ops
    .filter((o) => o.kind === 'trash' || o.kind === 'abandon' || (o.kind === 'update' && (o.reason === 'dida' || o.reason === 'drift')))
    .slice(0, 20)
    .map(describeOp)
  return {
    blocked: true,
    pending: { createdAt: now.toISOString(), reason: reasons.join('；'), trash: counts.destructive, updates, sample }
  }
}

/** 熔断时仍可执行的安全操作：新建、关联、解除关联、状态记录 */
export function safeSubset(ops: TaskOp[]): TaskOp[] {
  return ops.filter(
    (o) =>
      o.kind === 'create' ||
      o.kind === 'link' ||
      o.kind === 'touch' ||
      o.kind === 'unlink' ||
      o.kind === 'removed' ||
      (o.kind === 'update' && (o.reason === 'relink' || o.reason === 'match'))
  )
}
