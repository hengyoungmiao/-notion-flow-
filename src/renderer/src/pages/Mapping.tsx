import { Card, Empty, Select, Space } from 'antd'
import { useState } from 'react'
import { MappingTable } from '../components/MappingTable'
import { ScopeForm } from '../components/ScopeForm'
import type { AppViewState } from '../../../shared/ipc'

export default function Mapping({ state }: { state: AppViewState }) {
  const ready = state.workspaces.filter((w) => w.ready)
  const [id, setId] = useState<string | undefined>(state.activeWorkspaceId ?? ready[0]?.id)
  const ws = state.workspaces.find((w) => w.id === id)
  return (
    <div className="page">
      <Space style={{ width: '100%', justifyContent: 'space-between' }} align="start">
        <div>
          <h1 className="page-title">领域映射</h1>
          <p className="page-sub">滴答文件夹 → 一级领域，滴答清单 → 二级领域。修改后下一轮同步生效。</p>
        </div>
        <Select style={{ width: 220 }} value={id} onChange={setId} options={ready.map((w) => ({ value: w.id, label: w.name }))} />
      </Space>
      {ws?.ready ? (
        <Space direction="vertical" style={{ width: '100%' }} size="large">
          <Card>
            <MappingTable workspaceId={ws.id} />
          </Card>
          <Card title="同步范围">
            <ScopeForm workspace={ws} settings={state.settings} />
          </Card>
        </Space>
      ) : (
        <Empty description="请先在「工作空间」中完成 Notion 连接" />
      )}
    </div>
  )
}
