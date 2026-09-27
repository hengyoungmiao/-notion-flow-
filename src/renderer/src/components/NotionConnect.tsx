import { CheckCircleFilled, DatabaseOutlined, LinkOutlined, LoginOutlined, SearchOutlined } from '@ant-design/icons'
import { Alert, App, Button, Card, Collapse, Descriptions, Input, Radio, Space, Spin, Steps, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { api } from '../api'
import type { BindResultView, NotionLoginStart, TaskCandidateView, WorkspaceView } from '../../../shared/ipc'

interface Props {
  workspace: WorkspaceView
  onDone?: () => void
}

/** 连接 Notion：两步登录 → 识别 FLO.W 任务库 → 添加「滴答ID」字段 */
export function NotionConnect({ workspace, onDone }: Props) {
  const { message } = App.useApp()
  const [login, setLogin] = useState<NotionLoginStart | null>(null)
  const [polling, setPolling] = useState(false)
  const [token, setToken] = useState('')
  const [candidates, setCandidates] = useState<TaskCandidateView[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [choice, setChoice] = useState<string>('')
  const [link, setLink] = useState('')
  const [binding, setBinding] = useState(false)
  const [bind, setBind] = useState<BindResultView | null>(null)
  const [adding, setAdding] = useState(false)

  const loggedIn = workspace.loggedIn && !!workspace.notionWorkspaceName
  const bound = !!workspace.schema && !bind?.needsDidaIdProperty
  const step = !loggedIn ? 0 : !workspace.schema || bind?.needsDidaIdProperty ? 1 : 2

  useEffect(() => {
    if (step === 2) onDone?.()
  }, [step])

  const startLogin = async () => {
    const res = await api.notionLoginStart(workspace.id)
    if (!res.ok || !res.data) return void message.error(res.error ?? '无法开始登录')
    setLogin(res.data)
    void api.openExternal(res.data.url)
    setPolling(true)
    const done = await api.notionLoginPoll(workspace.id)
    setPolling(false)
    setLogin(null)
    if (done.ok) message.success('Notion 已登录')
    else message.error(done.error ?? 'Notion 登录未完成')
  }

  const useToken = async () => {
    const res = await api.notionUseToken(workspace.id, token)
    if (res.ok) {
      setToken('')
      message.success('已使用集成 token 连接')
    } else message.error(res.error ?? '连接失败')
  }

  const search = async () => {
    setSearching(true)
    const res = await api.findTaskDatabases(workspace.id)
    setSearching(false)
    if (!res.ok) return void message.error(res.error ?? '搜索失败')
    setCandidates(res.data ?? [])
    const first = res.data?.find((c) => c.looksLikeFlow)
    if (first) setChoice(first.dataSourceId)
  }

  useEffect(() => {
    if (loggedIn && !workspace.schema && candidates === null && !searching) void search()
  }, [loggedIn])

  const doBind = async (target: string) => {
    setBinding(true)
    const res = await api.bindTaskDatabase(workspace.id, target)
    setBinding(false)
    if (!res.ok || !res.data) return void message.error(res.error ?? '识别失败')
    setBind(res.data)
    if (!res.data.ok) message.error('这个数据库不像 FLO.W「我的任务 DB」，请换一个')
  }

  const addProperty = async () => {
    setAdding(true)
    const res = await api.ensureDidaIdProperty(workspace.id)
    setAdding(false)
    if (res.ok) {
      setBind((b) => (b ? { ...b, needsDidaIdProperty: false } : b))
      message.success('已在任务库中新增「滴答ID」字段')
    } else message.error(res.error ?? '添加字段失败')
  }

  return (
    <Card>
      <Steps
        size="small"
        current={step}
        style={{ marginBottom: 24 }}
        items={[{ title: '登录 Notion' }, { title: '识别 FLO.W 任务库' }, { title: '完成' }]}
      />

      {step === 0 && (
        <div>
          {login ? (
            <Space direction="vertical" style={{ width: '100%' }} align="center">
              <Typography.Text>浏览器已打开 Notion 授权页面，请确认页面上显示的验证码与下面一致：</Typography.Text>
              <div className="code-box mono">{login.code}</div>
              <Space>
                <Button icon={<LinkOutlined />} onClick={() => void api.openExternal(login.url)}>
                  重新打开授权页面
                </Button>
                <Button onClick={() => void api.notionLoginCancel(workspace.id)}>取消</Button>
              </Space>
              {polling && <Spin tip="等待你在浏览器中确认…" style={{ marginTop: 12 }} />}
            </Space>
          ) : (
            <Space direction="vertical" style={{ width: '100%' }}>
              <Typography.Paragraph>
                使用 Notion 官方命令行工具（ntn）登录。每个工作空间单独登录、互不影响，登录时在 Notion 授权页面里选择要连接的空间。
              </Typography.Paragraph>
              <Button type="primary" icon={<LoginOutlined />} onClick={startLogin}>
                登录 Notion
              </Button>
              <Collapse
                ghost
                size="small"
                items={[
                  {
                    key: 'token',
                    label: '高级：使用 Notion 集成 token',
                    children: (
                      <Space direction="vertical" style={{ width: '100%' }}>
                        <Typography.Text type="secondary">
                          适合无法使用浏览器登录的情况。需要在 Notion 中把 FLO.W 页面共享给该集成。token 会加密保存在本机。
                        </Typography.Text>
                        <Space.Compact style={{ width: '100%' }}>
                          <Input.Password placeholder="ntn_…" value={token} onChange={(e) => setToken(e.target.value)} />
                          <Button disabled={!token.trim()} onClick={useToken}>
                            连接
                          </Button>
                        </Space.Compact>
                      </Space>
                    )
                  }
                ]}
              />
            </Space>
          )}
        </div>
      )}

      {step === 1 && (
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <Typography.Text>
            已连接：<b>{workspace.notionWorkspaceName}</b>
            {workspace.notionUserName ? `（${workspace.notionUserName}）` : ''}
          </Typography.Text>
          {!bind?.ok && (
            <>
              <Space>
                <Button icon={<SearchOutlined />} loading={searching} onClick={search}>
                  重新搜索
                </Button>
              </Space>
              {candidates && candidates.length > 0 && (
                <Radio.Group value={choice} onChange={(e) => setChoice(e.target.value)} style={{ width: '100%' }}>
                  <Space direction="vertical" style={{ width: '100%' }}>
                    {candidates.map((c) => (
                      <Radio key={c.dataSourceId} value={c.dataSourceId}>
                        <DatabaseOutlined /> {c.title}{' '}
                        {c.looksLikeFlow ? (
                          <Typography.Text type="success">（符合 FLO.W 任务库结构）</Typography.Text>
                        ) : (
                          <Typography.Text type="secondary">（结构不匹配）</Typography.Text>
                        )}
                      </Radio>
                    ))}
                  </Space>
                </Radio.Group>
              )}
              {candidates && candidates.length === 0 && (
                <Alert type="info" showIcon message="没有搜索到任务库，可能是当前账号没有访问权限。可以直接粘贴「我的任务 DB」的链接。" />
              )}
              <Button type="primary" disabled={!choice} loading={binding} onClick={() => void doBind(choice)}>
                使用选中的数据库
              </Button>
              <Space.Compact style={{ width: '100%' }}>
                <Input placeholder="或粘贴「FLO.W - 我的任务 DB」的链接" value={link} onChange={(e) => setLink(e.target.value)} />
                <Button disabled={!link.trim()} loading={binding} onClick={() => void doBind(link)}>
                  识别链接
                </Button>
              </Space.Compact>
            </>
          )}
          {bind && (
            <>
              {bind.schema && (
                <Descriptions size="small" column={1} bordered>
                  <Descriptions.Item label="任务库">{bind.schema.tasks}</Descriptions.Item>
                  <Descriptions.Item label="二级领域库">{bind.schema.domains ?? '未找到'}</Descriptions.Item>
                  <Descriptions.Item label="一级领域库">{bind.schema.areas ?? '未找到'}</Descriptions.Item>
                </Descriptions>
              )}
              {bind.issues.map((i) => (
                <Alert key={i.message} type={i.level === 'error' ? 'error' : 'warning'} showIcon message={i.message} />
              ))}
              {bind.ok && bind.needsDidaIdProperty && (
                <Alert
                  type="info"
                  showIcon
                  message="需要在任务库中新增一个「滴答ID」文本字段"
                  description="用于记录每个任务对应的滴答任务，防止重复创建。只新增字段，不会修改或删除模板原有的任何内容；你可以在视图中隐藏它。"
                  action={
                    <Button type="primary" loading={adding} onClick={addProperty}>
                      添加字段
                    </Button>
                  }
                />
              )}
              {!bind.ok && <Button onClick={() => setBind(null)}>换一个数据库</Button>}
            </>
          )}
        </Space>
      )}

      {step === 2 && bound && (
        <Space direction="vertical">
          <Typography.Text>
            <CheckCircleFilled style={{ color: '#16a34a', marginRight: 8 }} />
            已连接 <b>{workspace.notionWorkspaceName}</b>，任务库：{workspace.schema?.tasks}
          </Typography.Text>
          <Typography.Text type="secondary">
            二级领域库：{workspace.schema?.domains ?? '未找到'} · 一级领域库：{workspace.schema?.areas ?? '未找到'}
          </Typography.Text>
        </Space>
      )}
    </Card>
  )
}
