import { CheckCircleFilled, KeyOutlined, LoginOutlined } from '@ant-design/icons'
import { App, Button, Card, Divider, Input, Space, Typography } from 'antd'
import { useState } from 'react'
import { api } from '../api'
import type { AppViewState } from '../../../shared/ipc'

export function DidaLogin({ state, onDone }: { state: AppViewState; onDone?: () => void }) {
  const { message } = App.useApp()
  const [waiting, setWaiting] = useState(false)
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)
  const loggedIn = state.dida.loggedIn === true

  const browser = async () => {
    setWaiting(true)
    const res = await api.didaLoginBrowser()
    setWaiting(false)
    if (res.ok) {
      message.success('滴答清单已登录')
      onDone?.()
    } else message.error(res.error ?? '登录失败')
  }

  const save = async () => {
    setSaving(true)
    const res = await api.didaSaveToken(token)
    setSaving(false)
    if (res.ok) {
      setToken('')
      message.success('API 口令已保存')
      onDone?.()
    } else message.error(res.error ?? '保存失败')
  }

  return (
    <Card>
      {loggedIn ? (
        <Space direction="vertical">
          <Typography.Text>
            <CheckCircleFilled style={{ color: '#16a34a', marginRight: 8 }} />
            滴答清单已登录。FlowSync 只会读取滴答数据，不会修改或删除任何内容。
          </Typography.Text>
          <Button size="small" onClick={() => void api.didaLogout()}>
            退出滴答登录
          </Button>
        </Space>
      ) : (
        <>
          <Typography.Paragraph>
            FlowSync 使用滴答官方命令行工具读取你的清单和任务，<b>只读不写</b>。登录凭据由官方工具保存在本机。
          </Typography.Paragraph>
          <Space>
            <Button type="primary" icon={<LoginOutlined />} loading={waiting} onClick={browser}>
              {waiting ? '请在浏览器中完成授权…' : '浏览器授权登录'}
            </Button>
            {waiting && <Button onClick={() => void api.didaCancelLogin()}>取消</Button>}
          </Space>
          <Divider plain>或者使用 API 口令</Divider>
          <Typography.Paragraph type="secondary">
            网页版滴答清单 → 头像 → 设置 → 账户与安全 → API 口令，创建后粘贴到这里。
          </Typography.Paragraph>
          <Space.Compact style={{ width: '100%' }}>
            <Input.Password prefix={<KeyOutlined />} placeholder="dp_…" value={token} onChange={(e) => setToken(e.target.value)} />
            <Button loading={saving} disabled={token.trim().length < 10} onClick={save}>
              保存口令
            </Button>
          </Space.Compact>
          {state.dida.error && (
            <Typography.Paragraph type="danger" style={{ marginTop: 12 }}>
              {state.dida.error}
            </Typography.Paragraph>
          )}
        </>
      )}
    </Card>
  )
}
