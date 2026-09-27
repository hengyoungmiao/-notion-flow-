import { ExportOutlined, RedoOutlined } from '@ant-design/icons'
import { App, Button, Card, List, Segmented, Space, Table, Tag, Typography } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import { api, useActivity } from '../api'
import { ActivityIcon, KIND_TEXT } from '../components/ActivityIcon'
import { clock, notionUrl } from '../format'
import type { ActivityEntry, ActivityKind } from '../../../core/activity'
import type { AppViewState, RemovedView } from '../../../shared/ipc'

const FILTERS: Record<string, ActivityKind[] | null> = {
  全部: null,
  新建: ['create'],
  更新: ['update', 'relink'],
  校正: ['correct'],
  删除: ['trash', 'abandon', 'unlink', 'removed'],
  领域: ['domain'],
  错误: ['error', 'warning']
}

export default function Activity({ state }: { state: AppViewState }) {
  const { message } = App.useApp()
  const entries = useActivity(1000)
  const [filter, setFilter] = useState('全部')
  const [removed, setRemoved] = useState<RemovedView[]>([])
  const wsId = state.activeWorkspaceId

  const loadRemoved = async () => {
    if (wsId) setRemoved(await api.getRemoved(wsId))
  }
  useEffect(() => {
    void loadRemoved()
  }, [wsId, state.scheduler.lastSuccessAt])

  const rows = useMemo(() => {
    const kinds = FILTERS[filter]
    return kinds ? entries.filter((e) => kinds.includes(e.kind)) : entries
  }, [entries, filter])

  const restore = async (didaId: string) => {
    if (!wsId) return
    const res = await api.restoreRemoved(wsId, didaId)
    if (res.ok) message.success('已恢复同步，将重新在 Notion 创建')
    else message.error(res.error ?? '操作失败')
    await loadRemoved()
  }

  return (
    <div className="page">
      <h1 className="page-title">同步记录</h1>
      <p className="page-sub">本次运行以来的同步动态（完整日志保存在日志目录）。</p>
      <Card
        title={<Segmented options={Object.keys(FILTERS)} value={filter} onChange={(v) => setFilter(String(v))} />}
        extra={<Button onClick={() => void api.openPath('logs')}>打开日志目录</Button>}
      >
        <Table<ActivityEntry>
          size="small"
          rowKey="id"
          dataSource={rows}
          pagination={{ pageSize: 20, showSizeChanger: false }}
          columns={[
            { title: '时间', dataIndex: 'at', width: 140, render: (v: string) => <span className="mono">{clock(v)}</span> },
            {
              title: '类型',
              dataIndex: 'kind',
              width: 120,
              render: (k: ActivityKind) => (
                <Space>
                  <ActivityIcon kind={k} />
                  {KIND_TEXT[k]}
                </Space>
              )
            },
            {
              title: '内容',
              render: (_: unknown, e) => (
                <Space direction="vertical" size={0}>
                  <span>{e.title}</span>
                  {e.detail && <Typography.Text type="secondary">{e.detail}</Typography.Text>}
                </Space>
              )
            },
            {
              title: '',
              width: 110,
              render: (_: unknown, e) =>
                e.pageId ? (
                  <Button size="small" type="link" icon={<ExportOutlined />} onClick={() => void api.openExternal(notionUrl(e.pageId!))}>
                    打开页面
                  </Button>
                ) : null
            }
          ]}
        />
      </Card>

      <Card title="在 Notion 中被删除、已停止同步的任务" style={{ marginTop: 16 }}>
        <List
          size="small"
          locale={{ emptyText: '没有' }}
          dataSource={removed}
          renderItem={(r) => (
            <List.Item
              actions={[
                <Button key="r" size="small" icon={<RedoOutlined />} onClick={() => void restore(r.didaId)}>
                  重新创建
                </Button>
              ]}
            >
              <List.Item.Meta title={r.title} description={`删除时间：${clock(r.at)}`} />
              <Tag>滴答ID {r.didaId.slice(0, 8)}…</Tag>
            </List.Item>
          )}
        />
      </Card>
    </div>
  )
}
