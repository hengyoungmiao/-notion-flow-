import { App, Form, InputNumber, Switch, Typography } from 'antd'
import { api } from '../api'
import type { WorkspaceView } from '../../../shared/ipc'

export function ScopeForm({ workspace }: { workspace: WorkspaceView }) {
  const { message } = App.useApp()
  const save = async (patch: Partial<WorkspaceView['scope']>) => {
    const res = await api.updateScope(workspace.id, patch)
    if (!res.ok) message.error(res.error ?? '保存失败')
  }
  return (
    <Form layout="vertical" style={{ maxWidth: 560 }}>
      <Form.Item label="同步收件箱里的任务" extra="收件箱任务在 Notion 中不绑定领域。">
        <Switch checked={workspace.scope.includeInbox} onChange={(v) => void save({ includeInbox: v })} />
      </Form.Item>
      <Form.Item label="首次同步时导入最近几天已完成的任务" extra="0 表示不导入历史完成任务；之后在滴答完成的任务都会同步。">
        <InputNumber
          min={0}
          max={365}
          addonAfter="天"
          value={workspace.scope.importCompletedDays}
          onChange={(v) => void save({ importCompletedDays: Number(v ?? 0) })}
        />
      </Form.Item>
      <Typography.Text type="secondary">不想同步的清单，可以在「领域映射」里设为“不同步这个清单”。</Typography.Text>
    </Form>
  )
}
