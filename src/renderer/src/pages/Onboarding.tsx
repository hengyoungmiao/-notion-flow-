import { CheckCircleFilled, CloseCircleFilled, RocketOutlined } from '@ant-design/icons'
import { Alert, App, Button, Card, Descriptions, Input, Result, Space, Steps, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { DidaLogin } from '../components/DidaLogin'
import { MappingTable } from '../components/MappingTable'
import { NotionConnect } from '../components/NotionConnect'
import { ScopeForm } from '../components/ScopeForm'
import { SyncPreview } from '../components/SyncPreview'
import type { RoundSummary } from '../../../core/sync/engine'
import type { AppViewState, WorkspaceView } from '../../../shared/ipc'

interface Props {
  state: AppViewState
  /** 添加新工作空间时复用（跳过欢迎和滴答登录） */
  mode?: 'first-run' | 'add-workspace'
  /** 继续设置一个已创建的工作空间 */
  workspaceId?: string
  onFinished?: () => void
}

export function SetupFlow({ state, mode = 'first-run', workspaceId, onFinished }: Props) {
  const { message } = App.useApp()
  const first = mode === 'first-run'
  const [step, setStep] = useState(0)
  const [wsId, setWsId] = useState<string | null>(workspaceId ?? (first ? state.activeWorkspaceId : null))
  const [wsName, setWsName] = useState(first ? '个人空间' : '')
  const [preview, setPreview] = useState<RoundSummary | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [starting, setStarting] = useState(false)
  const [done, setDone] = useState<{ backupPath: string | null; summary: RoundSummary } | null>(null)

  const ws: WorkspaceView | undefined = state.workspaces.find((w) => w.id === wsId)
  const steps = [
    ...(first ? [{ key: 'welcome', title: '欢迎' }, { key: 'dida', title: '登录滴答' }] : []),
    { key: 'notion', title: '连接 Notion' },
    { key: 'mapping', title: '领域映射' },
    { key: 'scope', title: '同步范围' },
    { key: 'preview', title: '预览并开始' }
  ]
  const current = steps[step]!.key

  useEffect(() => {
    if (first) void api.checkEnvironment()
  }, [])

  const createWs = async () => {
    const res = await api.createWorkspace(wsName)
    if (res.ok && res.data) setWsId(res.data)
    else message.error(res.error ?? '创建失败')
  }

  const makePreview = async () => {
    if (!wsId) return
    setPreviewing(true)
    const res = await api.previewInitialSync(wsId)
    setPreviewing(false)
    if (res.ok && res.data) setPreview(res.data)
    else message.error(res.error ?? '生成预览失败')
  }

  useEffect(() => {
    if (current === 'preview' && !preview) void makePreview()
  }, [current])

  const start = async () => {
    if (!wsId) return
    setStarting(true)
    const res = await api.startInitialSync(wsId)
    setStarting(false)
    if (res.ok && res.data) setDone(res.data)
    else message.error(res.error ?? '首次同步失败')
  }

  const finish = async () => {
    if (first) await api.finishOnboarding()
    onFinished?.()
  }

  const canNext =
    current === 'welcome'
      ? !!state.versions.ntn && !!state.versions.dida
      : current === 'dida'
        ? state.dida.loggedIn === true
        : current === 'notion'
          ? !!ws?.ready
          : true

  if (done) {
    return (
      <Result
        status="success"
        title="首次同步完成"
        subTitle={`新建 ${done.summary.creates.length} 个任务，关联 ${done.summary.matches.length} 个已有任务。之后滴答里的变化会自动同步到 Notion。`}
        extra={[
          <Button type="primary" key="go" onClick={finish}>
            {first ? '进入 FlowSync' : '完成'}
          </Button>,
          done.backupPath ? (
            <Button key="backup" onClick={() => void api.openPath('backups')}>
              查看备份
            </Button>
          ) : null
        ]}
      />
    )
  }

  return (
    <div className={first ? 'onboarding' : undefined}>
      {first && (
        <Space align="center" style={{ marginBottom: 24 }}>
          <img src="./icon.png" width={40} height={40} alt="" />
          <div>
            <Typography.Title level={3} style={{ margin: 0 }}>
              欢迎使用 FlowSync
            </Typography.Title>
            <Typography.Text type="secondary">把滴答清单的任务单向同步到 Notion FLO.W</Typography.Text>
          </div>
        </Space>
      )}
      <Steps current={step} items={steps.map((s) => ({ title: s.title }))} style={{ marginBottom: 24 }} />

      {current === 'welcome' && (
        <Card>
          <Typography.Paragraph>
            FlowSync 以<b>滴答清单为唯一数据来源</b>，把任务单向同步到 FLO.W「我的任务 DB」：
          </Typography.Paragraph>
          <ul>
            <li>滴答清单 → 二级领域，滴答文件夹 → 一级领域，任务自动绑定领域；</li>
            <li>
              同步只维护这些字段：任务、状态（未完成/完成/放弃）、排期、完成日期、下一步做什么？、二级领域、滴答ID；
            </li>
            <li>关联项目、笔记、前置任务、页面正文等其它内容永远不会被改动；</li>
            <li>FlowSync 对滴答<b>只读</b>，不会修改或删除滴答里的任何数据。</li>
          </ul>
          <Descriptions size="small" column={1} bordered title="内置工具">
            <Descriptions.Item label="Notion CLI（ntn）">
              <ToolVersion value={state.versions.ntn} />
            </Descriptions.Item>
            <Descriptions.Item label="滴答清单 CLI（dida-cli）">
              <ToolVersion value={state.versions.dida} />
            </Descriptions.Item>
          </Descriptions>
        </Card>
      )}

      {current === 'dida' && <DidaLogin state={state} />}

      {current === 'notion' &&
        (ws ? (
          <NotionConnect workspace={ws} />
        ) : (
          <Card title="给这个 Notion 工作空间起个名字">
            <Space.Compact style={{ width: '100%', maxWidth: 480 }}>
              <Input value={wsName} placeholder="例如：个人空间、公司空间" onChange={(e) => setWsName(e.target.value)} onPressEnter={createWs} />
              <Button type="primary" disabled={!wsName.trim()} onClick={createWs}>
                下一步
              </Button>
            </Space.Compact>
          </Card>
        ))}

      {current === 'mapping' && wsId && (
        <Card>
          <MappingTable workspaceId={wsId} compact />
        </Card>
      )}

      {current === 'scope' && ws && (
        <Card>
          <ScopeForm workspace={ws} settings={state.settings} />
        </Card>
      )}

      {current === 'preview' && (
        <Card
          title="首次同步预览"
          extra={
            <Button size="small" loading={previewing} onClick={makePreview}>
              重新生成
            </Button>
          }
        >
          {preview ? (
            <Space direction="vertical" style={{ width: '100%' }}>
              <Alert
                type="info"
                showIcon
                message="开始前会先把 Notion 任务库的现状备份到本机。已关联的 Notion 任务，其同步字段会按滴答的值更新。"
              />
              <SyncPreview summary={preview} />
            </Space>
          ) : (
            <Typography.Text type="secondary">{previewing ? '正在读取滴答和 Notion，生成预览…' : '点击“重新生成”获取预览'}</Typography.Text>
          )}
        </Card>
      )}

      <Space style={{ marginTop: 20, width: '100%', justifyContent: 'space-between' }}>
        <Button disabled={step === 0} onClick={() => setStep(step - 1)}>
          上一步
        </Button>
        {current === 'preview' ? (
          <Button type="primary" icon={<RocketOutlined />} disabled={!preview} loading={starting} onClick={start}>
            备份并开始首次同步
          </Button>
        ) : (
          <Button type="primary" disabled={!canNext} onClick={() => setStep(step + 1)}>
            下一步
          </Button>
        )}
      </Space>
    </div>
  )
}

function ToolVersion({ value }: { value: string | null }) {
  return value ? (
    <Typography.Text>
      <CheckCircleFilled style={{ color: '#16a34a', marginRight: 6 }} />
      {value}
    </Typography.Text>
  ) : (
    <Typography.Text type="danger">
      <CloseCircleFilled style={{ marginRight: 6 }} />
      未找到（请重新安装 FlowSync）
    </Typography.Text>
  )
}

export default function Onboarding({ state }: { state: AppViewState }) {
  return <SetupFlow state={state} mode="first-run" />
}
