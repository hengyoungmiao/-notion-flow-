import { FolderOutlined, ReloadOutlined, UnorderedListOutlined } from '@ant-design/icons'
import { Alert, App, Button, Select, Space, Table, Tag, Typography } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import type { DomainRow } from '../../../core/mapping/domains'
import type { DomainMapping } from '../../../core/types'
import type { MappingView } from '../../../shared/ipc'

const STATUS: Record<DomainRow['status'], { text: string; color: string }> = {
  linked: { text: '已关联', color: 'green' },
  matched: { text: '同名匹配', color: 'blue' },
  create: { text: '将新建', color: 'purple' },
  excluded: { text: '不同步', color: 'default' },
  skip: { text: '不绑定', color: 'default' },
  none: { text: '不绑定', color: 'default' },
  broken: { text: '已失效', color: 'red' },
  archived: { text: '已归档', color: 'default' },
  deleted: { text: '已删除', color: 'default' }
}

interface TreeRow extends DomainRow {
  key: string
  children?: TreeRow[]
}

function currentValue(row: DomainRow): string {
  if (row.mode === 'map' && row.notionPageId) return `map:${row.notionPageId}`
  if (row.status === 'excluded' || row.mode === 'skip') return 'skip'
  if (row.mode === 'create') return 'create'
  return 'auto'
}

function toMapping(value: string): DomainMapping {
  if (value.startsWith('map:')) return { mode: 'map', pageId: value.slice(4) }
  if (value === 'create') return { mode: 'create' }
  if (value === 'skip') return { mode: 'skip' }
  return { mode: 'auto' }
}

export function MappingTable({ workspaceId, compact }: { workspaceId: string; compact?: boolean }) {
  const { message } = App.useApp()
  const [data, setData] = useState<MappingView | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    const res = await api.getMapping(workspaceId)
    setLoading(false)
    if (res.ok && res.data) {
      setData(res.data)
      setError(null)
    } else setError(res.error ?? '读取失败')
  }

  useEffect(() => {
    void load()
  }, [workspaceId])

  const tree = useMemo<TreeRow[]>(() => {
    if (!data) return []
    const groups = data.rows.filter((r) => r.type === 'group')
    const lists = data.rows.filter((r) => r.type === 'list')
    const result: TreeRow[] = groups.map((g) => ({
      ...g,
      key: `g:${g.didaId}`,
      children: lists.filter((l) => l.groupId === g.didaId).map((l) => ({ ...l, key: `l:${l.didaId}` }))
    }))
    const known = new Set(groups.map((g) => g.didaId))
    for (const l of lists.filter((l) => !l.groupId || !known.has(l.groupId))) result.push({ ...l, key: `l:${l.didaId}` })
    return result
  }, [data])

  const change = async (row: DomainRow, value: string) => {
    const mapping = toMapping(value)
    const res =
      row.type === 'group'
        ? await api.setGroupMapping(workspaceId, row.didaId, mapping)
        : await api.setListMapping(workspaceId, row.didaId, mapping)
    if (!res.ok) message.error(res.error ?? '保存失败')
    await load()
  }

  if (error) return <Alert type="error" showIcon message="无法读取领域映射" description={error} action={<Button onClick={load}>重试</Button>} />

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      {data?.warnings.map((w) => <Alert key={w} type="warning" showIcon message={w} />)}
      <Table<TreeRow>
        size="small"
        loading={loading}
        dataSource={tree}
        pagination={false}
        expandable={{ defaultExpandAllRows: true }}
        scroll={compact ? { y: 360 } : undefined}
        title={() => (
          <Space>
            <Typography.Text type="secondary">滴答文件夹 → 一级领域，清单 → 二级领域。名称一致会自动关联，也可以手动指定。</Typography.Text>
            <Button size="small" icon={<ReloadOutlined />} onClick={load}>
              刷新
            </Button>
          </Space>
        )}
        columns={[
          {
            title: '滴答清单',
            dataIndex: 'didaName',
            render: (name: string, row) => (
              <Space>
                {row.type === 'group' ? <FolderOutlined /> : <UnorderedListOutlined />}
                <span>{name}</span>
              </Space>
            )
          },
          {
            title: '对应的 Notion 领域',
            width: 300,
            render: (_: unknown, row) => {
              const pages = row.type === 'group' ? data?.notionAreas ?? [] : data?.notionDomains ?? []
              const kind = row.type === 'group' ? '一级领域' : '二级领域'
              return (
                <Select
                  size="small"
                  style={{ width: '100%' }}
                  disabled={row.status === 'archived' || row.status === 'deleted'}
                  value={currentValue(row)}
                  onChange={(v) => void change(row, v)}
                  showSearch
                  optionFilterProp="label"
                  options={[
                    { value: 'auto', label: `自动（同名关联，没有则新建）` },
                    { value: 'create', label: `新建同名${kind}` },
                    { value: 'skip', label: row.type === 'group' ? '不绑定一级领域' : '不同步这个清单' },
                    { label: `已有的${kind}`, options: pages.map((p) => ({ value: `map:${p.pageId}`, label: p.title || '（无标题）' })) }
                  ]}
                />
              )
            }
          },
          {
            title: '当前结果',
            width: 220,
            render: (_: unknown, row) => (
              <Space>
                <Tag color={STATUS[row.status].color}>{STATUS[row.status].text}</Tag>
                {row.notionTitle && row.status !== 'excluded' && (
                  <Typography.Text type="secondary">
                    {row.status === 'archived' || row.status === 'deleted' ? `原来对应「${row.notionTitle}」` : row.notionTitle}
                  </Typography.Text>
                )}
              </Space>
            )
          }
        ]}
      />
      {data?.tagProjects && (
        <Table
          size="small"
          rowKey="tag"
          pagination={false}
          scroll={compact ? { y: 240 } : undefined}
          dataSource={data.tagProjects}
          title={() => (
            <Typography.Text type="secondary">
              标签 → 项目：滴答任务打上与 FLO.W 项目同名的标签，就会关联到该项目（忽略大小写、空格和标点）。
            </Typography.Text>
          )}
          locale={{ emptyText: '滴答里还没有标签' }}
          columns={[
            { title: '滴答标签', dataIndex: 'tag', render: (t: string) => <Tag>#{t}</Tag> },
            {
              title: '关联的 FLO.W 项目',
              dataIndex: 'projectTitle',
              render: (p: string | null) => (p ? <Tag color="green">{p}</Tag> : <Typography.Text type="secondary">未匹配（不影响项目）</Typography.Text>)
            }
          ]}
        />
      )}
    </Space>
  )
}
