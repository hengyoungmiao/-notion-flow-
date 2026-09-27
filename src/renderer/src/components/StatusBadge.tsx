import { Badge, Tag } from 'antd'
import type { SyncStatus } from '../../../core/scheduler'

export const STATUS_META: Record<SyncStatus, { text: string; color: string; badge: 'success' | 'processing' | 'default' | 'error' | 'warning' }> = {
  idle: { text: '同步正常', color: 'green', badge: 'success' },
  running: { text: '正在同步', color: 'blue', badge: 'processing' },
  paused: { text: '已暂停', color: 'default', badge: 'default' },
  error: { text: '同步出错', color: 'red', badge: 'error' },
  auth: { text: '需要重新登录', color: 'red', badge: 'error' },
  blocked: { text: '等待确认', color: 'orange', badge: 'warning' },
  needs_setup: { text: '尚未设置', color: 'default', badge: 'default' },
  needs_initial: { text: '等待首次同步', color: 'orange', badge: 'warning' }
}

export function StatusTag({ status }: { status: SyncStatus }) {
  const m = STATUS_META[status]
  return (
    <Tag color={m.color} style={{ marginInlineEnd: 0 }}>
      <Badge status={m.badge} text={m.text} style={{ fontSize: 12 }} />
    </Tag>
  )
}
