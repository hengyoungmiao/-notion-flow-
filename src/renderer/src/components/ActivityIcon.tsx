import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  DeleteOutlined,
  DisconnectOutlined,
  EditOutlined,
  InfoCircleOutlined,
  LinkOutlined,
  PartitionOutlined,
  PlusCircleOutlined,
  StopOutlined,
  SyncOutlined,
  WarningOutlined
} from '@ant-design/icons'
import type { ActivityKind } from '../../../core/activity'

export const KIND_TEXT: Record<ActivityKind, string> = {
  create: '新建',
  update: '更新',
  correct: '校正',
  relink: '关联',
  trash: '移入回收站',
  abandon: '标记放弃',
  unlink: '解除关联',
  removed: 'Notion 已删除',
  domain: '领域',
  warning: '提醒',
  error: '错误',
  info: '信息'
}

export function ActivityIcon({ kind }: { kind: ActivityKind }) {
  const style = { fontSize: 16 }
  switch (kind) {
    case 'create':
      return <PlusCircleOutlined style={{ ...style, color: '#16a34a' }} />
    case 'update':
      return <EditOutlined style={{ ...style, color: '#4f46e5' }} />
    case 'correct':
      return <SyncOutlined style={{ ...style, color: '#0891b2' }} />
    case 'relink':
      return <LinkOutlined style={{ ...style, color: '#4f46e5' }} />
    case 'trash':
      return <DeleteOutlined style={{ ...style, color: '#dc2626' }} />
    case 'abandon':
      return <StopOutlined style={{ ...style, color: '#ea580c' }} />
    case 'unlink':
      return <DisconnectOutlined style={{ ...style, color: '#78808c' }} />
    case 'removed':
      return <CloseCircleOutlined style={{ ...style, color: '#78808c' }} />
    case 'domain':
      return <PartitionOutlined style={{ ...style, color: '#7c3aed' }} />
    case 'warning':
      return <WarningOutlined style={{ ...style, color: '#d97706' }} />
    case 'error':
      return <CloseCircleOutlined style={{ ...style, color: '#dc2626' }} />
    default:
      return kind === 'info' ? <InfoCircleOutlined style={style} /> : <CheckCircleOutlined style={style} />
  }
}
