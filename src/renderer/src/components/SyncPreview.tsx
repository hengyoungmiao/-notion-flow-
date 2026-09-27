import { Alert, Card, Col, Collapse, List, Row, Statistic, Tag, Typography } from 'antd'
import type { RoundSummary } from '../../../core/sync/engine'

export function SyncPreview({ summary }: { summary: RoundSummary }) {
  const items = [
    {
      key: 'creates',
      label: `在 Notion 新建任务（${summary.creates.length}）`,
      children: <PlainList items={summary.creates.map((c) => ({ title: c.title || '（无标题）' }))} />
    },
    {
      key: 'matches',
      label: `关联已有的 Notion 任务（${summary.matches.length}）`,
      children: (
        <PlainList
          items={summary.matches.map((m) => ({ title: m.title, extra: m.detail ? `将按滴答更新：${m.detail}` : '无需修改' }))}
        />
      )
    },
    {
      key: 'domains',
      label: `新建领域（${summary.domainCreates.length}）`,
      children: <PlainList items={summary.domainCreates.map((d) => ({ title: d.title, tag: d.detail }))} />
    }
  ]
  if (summary.updates.length)
    items.push({
      key: 'updates',
      label: `更新任务（${summary.updates.length}）`,
      children: <PlainList items={summary.updates.map((u) => ({ title: u.title, extra: u.detail }))} />
    })
  if (summary.destructive.length)
    items.push({
      key: 'destructive',
      label: `删除/放弃（${summary.destructive.length}）`,
      children: <PlainList items={summary.destructive.map((u) => ({ title: u.title, extra: u.detail }))} />
    })
  return (
    <div>
      <Row gutter={12} style={{ marginBottom: 16 }}>
        <Col span={6}>
          <Card size="small">
            <Statistic title="新建任务" value={summary.creates.length} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="关联已有任务" value={summary.matches.length} />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small">
            <Statistic title="新建领域" value={summary.domainCreates.length} />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small">
            <Statistic title="番茄记录" value={summary.focus.creates} />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small">
            <Statistic title="删除/放弃" value={summary.destructive.length} valueStyle={summary.destructive.length ? { color: '#dc2626' } : undefined} />
          </Card>
        </Col>
      </Row>
      {summary.warnings.map((w) => (
        <Alert key={w} type="warning" showIcon message={w} style={{ marginBottom: 8 }} />
      ))}
      <Collapse items={items} size="small" />
    </div>
  )
}

function PlainList({ items }: { items: Array<{ title: string; extra?: string; tag?: string }> }) {
  if (items.length === 0) return <Typography.Text type="secondary">无</Typography.Text>
  return (
    <List
      size="small"
      dataSource={items.slice(0, 200)}
      renderItem={(i) => (
        <List.Item extra={i.tag ? <Tag>{i.tag}</Tag> : undefined}>
          <List.Item.Meta title={i.title} description={i.extra} />
        </List.Item>
      )}
      footer={items.length > 200 ? <Typography.Text type="secondary">另有 {items.length - 200} 条未显示</Typography.Text> : undefined}
    />
  )
}
