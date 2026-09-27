import { CloudSyncOutlined, PauseCircleOutlined, PlayCircleOutlined, WarningOutlined } from '@ant-design/icons'
import { Alert, App, Button, Card, Col, Collapse, List, Modal, Row, Space, Statistic, Typography } from 'antd'
import { useState } from 'react'
import { api, useActivity } from '../api'
import { ActivityIcon } from '../components/ActivityIcon'
import { DidaLogin } from '../components/DidaLogin'
import { StatusTag } from '../components/StatusBadge'
import { clock, fromNow } from '../format'
import type { AppViewState } from '../../../shared/ipc'

export default function Dashboard({ state, navigate }: { state: AppViewState; navigate: (key: string) => void }) {
  const { message } = App.useApp()
  const activity = useActivity(12)
  const [syncing, setSyncing] = useState(false)
  const [approving, setApproving] = useState(false)
  const [didaModal, setDidaModal] = useState(false)
  const s = state.scheduler
  const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId)

  const syncNow = async () => {
    setSyncing(true)
    const res = await api.syncNow()
    setSyncing(false)
    if (res.ok) message.success('同步完成')
    else message.error(res.error ?? '同步失败')
  }

  const approve = async () => {
    setApproving(true)
    const res = await api.approvePending()
    setApproving(false)
    if (res.ok) message.success('已确认并执行')
    else message.error(res.error ?? '执行失败')
  }

  return (
    <div className="page">
      <h1 className="page-title">概览</h1>
      <p className="page-sub">滴答清单 → Notion FLO.W 的同步状态</p>

      <Card style={{ marginBottom: 16 }}>
        <Row align="middle" gutter={16}>
          <Col flex="auto">
            <Space direction="vertical" size={2}>
              <Space>
                <Typography.Title level={4} style={{ margin: 0 }}>
                  {ws?.name ?? '未选择工作空间'}
                </Typography.Title>
                <StatusTag status={s.status} />
              </Space>
              <Typography.Text type="secondary">
                Notion：{ws?.notionWorkspaceName ?? '—'} · 任务库：{ws?.schema?.tasks ?? '—'}
              </Typography.Text>
              <Typography.Text type="secondary">
                上次同步：{fromNow(s.lastSuccessAt)}（{clock(s.lastSuccessAt)}）
                {s.nextRunAt && s.status !== 'paused' ? ` · 下次：${clock(s.nextRunAt)}` : ''}
                {` · 当前间隔 ${s.intervalSec} 秒`}
              </Typography.Text>
            </Space>
          </Col>
          <Col>
            <Space>
              <Button type="primary" icon={<CloudSyncOutlined />} loading={syncing || s.status === 'running'} onClick={syncNow}>
                立即同步
              </Button>
              {s.status === 'paused' ? (
                <Button icon={<PlayCircleOutlined />} onClick={() => void api.resume()}>
                  继续
                </Button>
              ) : (
                <Button icon={<PauseCircleOutlined />} onClick={() => void api.pause()}>
                  暂停
                </Button>
              )}
            </Space>
          </Col>
        </Row>
      </Card>

      {s.status === 'blocked' && s.pending && (
        <Alert
          style={{ marginBottom: 16 }}
          type="warning"
          showIcon
          icon={<WarningOutlined />}
          message="检测到大批量变更，已暂停等待你确认"
          description={
            <div>
              <div style={{ marginBottom: 8 }}>{s.pending.reason}。新建和关联已照常执行，修改/删除暂未执行。</div>
              <List size="small" dataSource={s.pending.sample} renderItem={(i) => <List.Item>{i}</List.Item>} />
            </div>
          }
          action={
            <Space direction="vertical">
              <Button type="primary" danger loading={approving} onClick={approve}>
                确认并执行
              </Button>
              <Button onClick={() => void api.pause()}>先暂停同步</Button>
            </Space>
          }
        />
      )}
      {s.status === 'auth' && (
        <Alert
          style={{ marginBottom: 16 }}
          type="error"
          showIcon
          message={`${s.lastError?.tool === 'dida' ? '滴答清单' : 'Notion'}登录已失效，自动同步已暂停`}
          description={s.lastError?.message}
          action={
            s.lastError?.tool === 'dida' ? (
              <Button type="primary" onClick={() => setDidaModal(true)}>
                重新登录滴答
              </Button>
            ) : (
              <Button type="primary" onClick={() => navigate('workspaces')}>
                去重新登录 Notion
              </Button>
            )
          }
        />
      )}
      {s.status === 'error' && s.lastError && (
        <Alert style={{ marginBottom: 16 }} type="error" showIcon message="同步出错，稍后会自动重试" description={s.lastError.message} />
      )}
      {s.status === 'needs_initial' && (
        <Alert
          style={{ marginBottom: 16 }}
          type="info"
          showIcon
          message="当前工作空间还没有完成首次同步"
          action={
            <Button type="primary" onClick={() => navigate('workspaces')}>
              去完成设置
            </Button>
          }
        />
      )}

      <Row gutter={16} style={{ marginBottom: 16 }}>
        {[
          { title: '今日新建', value: s.today.created },
          { title: '今日更新', value: s.today.updated },
          { title: '今日校正', value: s.today.corrected },
          { title: '已关联任务', value: ws?.linkedCount ?? 0 }
        ].map((t) => (
          <Col span={6} key={t.title}>
            <Card className="stat-tile">
              <Statistic title={t.title} value={t.value} />
            </Card>
          </Col>
        ))}
      </Row>

      {s.warnings.length > 0 && (
        <Collapse
          style={{ marginBottom: 16 }}
          items={[
            {
              key: 'w',
              label: `提示（${s.warnings.length}）`,
              children: s.warnings.map((w) => <Alert key={w} type="warning" showIcon message={w} style={{ marginBottom: 6 }} />)
            }
          ]}
        />
      )}

      <Card title="最近动态" extra={<Button type="link" onClick={() => navigate('activity')}>查看全部</Button>}>
        <List
          size="small"
          locale={{ emptyText: '暂无动态' }}
          dataSource={activity}
          renderItem={(e) => (
            <List.Item>
              <List.Item.Meta avatar={<ActivityIcon kind={e.kind} />} title={e.title} description={e.detail} />
              <Typography.Text type="secondary">{fromNow(e.at)}</Typography.Text>
            </List.Item>
          )}
        />
      </Card>

      <Modal open={didaModal} footer={null} onCancel={() => setDidaModal(false)} title="重新登录滴答清单">
        <DidaLogin state={state} onDone={() => setDidaModal(false)} />
      </Modal>
    </div>
  )
}
