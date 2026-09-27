import { CheckOutlined, DeleteOutlined, EditOutlined, LoginOutlined, PlusOutlined, SettingOutlined, SwapOutlined } from '@ant-design/icons'
import { App, Button, Card, Col, Descriptions, Input, Modal, Popconfirm, Row, Space, Tag, Typography } from 'antd'
import { useState } from 'react'
import { api } from '../api'
import { NotionConnect } from '../components/NotionConnect'
import { fromNow } from '../format'
import { SetupFlow } from './Onboarding'
import type { AppViewState, WorkspaceView } from '../../../shared/ipc'

export default function Workspaces({ state }: { state: AppViewState }) {
  const { message } = App.useApp()
  const [setup, setSetup] = useState<{ open: boolean; workspaceId?: string }>({ open: false })
  const [connect, setConnect] = useState<WorkspaceView | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)

  const activate = async (id: string) => {
    const res = await api.setActiveWorkspace(id)
    if (res.ok) message.success('已切换工作空间，下一轮同步开始写入该空间')
    else message.error(res.error ?? '切换失败')
  }

  const remove = async (id: string) => {
    const res = await api.removeWorkspace(id)
    if (res.ok) message.success('已删除（Notion 中的数据不受影响）')
    else message.error(res.error ?? '删除失败')
  }

  const rename = async () => {
    if (!renaming) return
    const res = await api.renameWorkspace(renaming.id, renaming.name)
    if (!res.ok) message.error(res.error ?? '重命名失败')
    setRenaming(null)
  }

  const liveConnect = connect ? state.workspaces.find((w) => w.id === connect.id) ?? connect : null

  return (
    <div className="page">
      <Space style={{ width: '100%', justifyContent: 'space-between' }} align="start">
        <div>
          <h1 className="page-title">工作空间</h1>
          <p className="page-sub">同一时间只同步到一个 Notion 工作空间。每个空间的登录和同步状态互相独立，切回来会自动补齐期间的变化。</p>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setSetup({ open: true })}>
          添加工作空间
        </Button>
      </Space>

      <Row gutter={[16, 16]}>
        {state.workspaces.map((w) => {
          const active = w.id === state.activeWorkspaceId
          return (
            <Col span={12} key={w.id}>
              <Card
                title={
                  <Space>
                    {w.name}
                    {active && <Tag color="green">当前</Tag>}
                    {!w.initialized && <Tag color="orange">未完成设置</Tag>}
                    {w.authType === 'token' && <Tag>集成 token</Tag>}
                  </Space>
                }
                extra={
                  <Button size="small" type="text" icon={<EditOutlined />} onClick={() => setRenaming({ id: w.id, name: w.name })} />
                }
                actions={[
                  active ? (
                    <Typography.Text key="a" type="success">
                      <CheckOutlined /> 正在同步
                    </Typography.Text>
                  ) : (
                    <Button key="a" type="link" icon={<SwapOutlined />} disabled={!w.initialized} onClick={() => void activate(w.id)}>
                      设为当前
                    </Button>
                  ),
                  !w.initialized ? (
                    <Button key="s" type="link" icon={<SettingOutlined />} onClick={() => setSetup({ open: true, workspaceId: w.id })}>
                      完成设置
                    </Button>
                  ) : (
                    <Button key="c" type="link" icon={<LoginOutlined />} onClick={() => setConnect(w)}>
                      登录/识别
                    </Button>
                  ),
                  <Popconfirm
                    key="d"
                    title="删除这个工作空间？"
                    description="只删除本机的登录和同步记录，Notion 中的页面不受影响。"
                    okText="删除"
                    okButtonProps={{ danger: true }}
                    cancelText="取消"
                    onConfirm={() => void remove(w.id)}
                  >
                    <Button type="link" danger icon={<DeleteOutlined />}>
                      删除
                    </Button>
                  </Popconfirm>
                ]}
              >
                <Descriptions size="small" column={1}>
                  <Descriptions.Item label="Notion 空间">
                    {w.notionWorkspaceName ?? <Typography.Text type="secondary">未登录</Typography.Text>}
                  </Descriptions.Item>
                  <Descriptions.Item label="任务库">{w.schema?.tasks ?? '—'}</Descriptions.Item>
                  <Descriptions.Item label="领域库">
                    {w.schema ? `${w.schema.domains ?? '—'} / ${w.schema.areas ?? '—'}` : '—'}
                  </Descriptions.Item>
                  <Descriptions.Item label="已关联任务">{w.linkedCount}</Descriptions.Item>
                  <Descriptions.Item label="上次同步">{fromNow(w.lastSuccessAt)}</Descriptions.Item>
                </Descriptions>
              </Card>
            </Col>
          )
        })}
      </Row>

      <Modal
        open={setup.open}
        width={960}
        footer={null}
        destroyOnHidden
        title={setup.workspaceId ? '完成工作空间设置' : '添加 Notion 工作空间'}
        onCancel={() => setSetup({ open: false })}
      >
        <SetupFlow state={state} mode="add-workspace" workspaceId={setup.workspaceId} onFinished={() => setSetup({ open: false })} />
      </Modal>

      <Modal open={!!liveConnect} width={760} footer={null} destroyOnHidden title="登录 / 重新识别" onCancel={() => setConnect(null)}>
        {liveConnect && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Button onClick={() => void api.notionLoginStart(liveConnect.id).then(async (r) => {
              if (!r.ok || !r.data) return void message.error(r.error ?? '无法开始登录')
              void api.openExternal(r.data.url)
              Modal.info({ title: '请在浏览器中确认验证码', content: <div className="code-box mono">{r.data.code}</div> })
              const done = await api.notionLoginPoll(liveConnect.id)
              Modal.destroyAll()
              if (done.ok) message.success('Notion 已重新登录')
              else message.error(done.error ?? '登录未完成')
            })}>
              重新登录 Notion
            </Button>
            <NotionConnect workspace={liveConnect} />
          </Space>
        )}
      </Modal>

      <Modal open={!!renaming} title="重命名工作空间" okText="保存" cancelText="取消" onOk={rename} onCancel={() => setRenaming(null)}>
        <Input value={renaming?.name} onChange={(e) => setRenaming((r) => (r ? { ...r, name: e.target.value } : r))} />
      </Modal>
    </div>
  )
}
