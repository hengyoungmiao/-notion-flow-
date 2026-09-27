import { DashboardOutlined, HistoryOutlined, PartitionOutlined, SettingOutlined, TeamOutlined } from '@ant-design/icons'
import { Layout, Menu, Select, Space, Spin, Tag, theme } from 'antd'
import { useState } from 'react'
import { api, useAppState } from './api'
import { StatusTag } from './components/StatusBadge'
import Activity from './pages/Activity'
import Dashboard from './pages/Dashboard'
import Mapping from './pages/Mapping'
import Onboarding from './pages/Onboarding'
import Settings from './pages/Settings'
import Workspaces from './pages/Workspaces'

const MENU = [
  { key: 'dashboard', icon: <DashboardOutlined />, label: '概览' },
  { key: 'workspaces', icon: <TeamOutlined />, label: '工作空间' },
  { key: 'mapping', icon: <PartitionOutlined />, label: '领域映射' },
  { key: 'activity', icon: <HistoryOutlined />, label: '同步记录' },
  { key: 'settings', icon: <SettingOutlined />, label: '设置' }
]

export default function App() {
  const [state] = useAppState()
  const [page, setPage] = useState('dashboard')
  const { token } = theme.useToken()

  if (!state) return <Spin fullscreen tip="正在启动…" />
  if (!state.onboarded)
    return (
      <Layout style={{ minHeight: '100%', background: token.colorBgLayout }}>
        <Layout.Content style={{ overflow: 'auto' }}>
          {state.demo && <DemoBanner />}
          <Onboarding state={state} />
        </Layout.Content>
      </Layout>
    )

  const initialized = state.workspaces.filter((w) => w.initialized)
  return (
    <Layout style={{ height: '100%' }}>
      <Layout.Sider width={200} theme="light" style={{ borderRight: `1px solid ${token.colorBorderSecondary}` }}>
        <div className="brand">
          <img src="./icon.png" alt="" />
          FlowSync
        </div>
        <Menu mode="inline" selectedKeys={[page]} items={MENU} onClick={(e) => setPage(e.key)} style={{ borderInlineEnd: 'none' }} />
      </Layout.Sider>
      <Layout>
        <Layout.Header
          style={{
            background: token.colorBgContainer,
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
            padding: '0 24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            height: 56
          }}
        >
          <Space>
            <span style={{ opacity: 0.65 }}>当前工作空间</span>
            <Select
              style={{ minWidth: 200 }}
              value={state.activeWorkspaceId ?? undefined}
              onChange={(id) => void api.setActiveWorkspace(id)}
              options={initialized.map((w) => ({ value: w.id, label: `${w.name}${w.notionWorkspaceName ? ` · ${w.notionWorkspaceName}` : ''}` }))}
            />
          </Space>
          <Space>
            {state.demo && <Tag color="purple">演示模式</Tag>}
            <StatusTag status={state.scheduler.status} />
          </Space>
        </Layout.Header>
        <Layout.Content style={{ overflow: 'auto', background: token.colorBgLayout }}>
          {page === 'dashboard' && <Dashboard state={state} navigate={setPage} />}
          {page === 'workspaces' && <Workspaces state={state} />}
          {page === 'mapping' && <Mapping state={state} />}
          {page === 'activity' && <Activity state={state} />}
          {page === 'settings' && <Settings state={state} />}
        </Layout.Content>
      </Layout>
    </Layout>
  )
}

function DemoBanner() {
  return (
    <div style={{ background: '#ede9fe', color: '#5b21b6', padding: '6px 16px', textAlign: 'center', fontSize: 13 }}>
      演示模式：使用内置示例数据，不会连接真实的滴答清单和 Notion 账号
    </div>
  )
}
