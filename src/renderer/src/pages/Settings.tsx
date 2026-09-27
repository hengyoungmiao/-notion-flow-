import { FileSearchOutlined, FolderOpenOutlined } from '@ant-design/icons'
import { App, Button, Card, Descriptions, Form, InputNumber, Radio, Select, Space, Switch, Typography } from 'antd'
import { api } from '../api'
import { DidaLogin } from '../components/DidaLogin'
import type { AppSettings } from '../../../core/types'
import type { AppViewState } from '../../../shared/ipc'

const ZONES = ['Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Tokyo', 'Asia/Singapore', 'Europe/London', 'America/Los_Angeles', 'America/New_York', 'UTC']

export default function Settings({ state }: { state: AppViewState }) {
  const { message } = App.useApp()
  const s = state.settings
  const save = async (patch: Partial<AppSettings>) => {
    const res = await api.updateSettings(patch)
    if (!res.ok) message.error(res.error ?? '保存失败')
  }
  const exportDiag = async () => {
    const res = await api.exportDiagnostics()
    if (res.ok) message.success('诊断样例已导出（已去除标题、描述等个人内容）')
    else message.error(res.error ?? '导出失败')
  }

  return (
    <div className="page">
      <h1 className="page-title">设置</h1>
      <p className="page-sub">修改后立即生效。</p>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Card title="同步">
          <Form layout="vertical" style={{ maxWidth: 640 }}>
            <Form.Item label="轮询间隔" extra="有变化时使用最短间隔，空闲时逐步放宽到最长间隔。">
              <Space>
                <InputNumber min={5} max={600} addonBefore="最短" addonAfter="秒" value={s.pollMinSec} onChange={(v) => v && void save({ pollMinSec: v })} />
                <InputNumber min={5} max={3600} addonBefore="最长" addonAfter="秒" value={s.pollMaxSec} onChange={(v) => v && void save({ pollMaxSec: v })} />
              </Space>
            </Form.Item>
            <Form.Item label="Notion 侧校正间隔" extra="定期检查 Notion 中同步字段是否被改动，并按滴答的值改回。">
              <InputNumber min={1} max={1440} addonAfter="分钟" value={s.reconcileMinutes} onChange={(v) => v && void save({ reconcileMinutes: v })} />
            </Form.Item>
            <Form.Item
              label="页面顶部的滴答同步区"
              extra="把描述、检查事项（可勾选）、子任务清单、重复规则和完成记录写到任务页面最上方；页面其余正文和「下一步做什么？」不受影响。关闭后会清掉已有的同步区。"
            >
              <Switch checked={s.syncBody} onChange={(v) => void save({ syncBody: v })} />
            </Form.Item>
            <Form.Item label="滴答标签自动关联 FLO.W 项目" extra="任务打上与项目同名的标签（如 #网站改版）就会关联到该项目，项目进度随之更新；子任务继承父任务的项目。">
              <Switch checked={s.syncProjects} onChange={(v) => void save({ syncProjects: v })} />
            </Form.Item>
            <Form.Item label="重复任务按日程处理" extra="重复任务的「任务类型」固定为「日程」（Notion 里改掉会被改回），并且不按标签关联项目。">
              <Switch checked={s.recurringAsSchedule} onChange={(v) => void save({ recurringAsSchedule: v })} />
            </Form.Item>
            <Form.Item
              label="滴答清单归档后，其中未完成的任务标记完成"
              extra="完成日期填检测到归档的那天；清单重新打开后恢复按滴答的实际状态同步。关闭时只解除关联，页面保持原样。"
            >
              <Switch checked={s.archivedListsComplete} onChange={(v) => void save({ archivedListsComplete: v })} />
            </Form.Item>
            <Form.Item label="同步番茄钟和正计时记录" extra="写入 FLO.W「任务番茄数据库」，并关联到对应任务；任务的「番茄时长统计」会自动计算。">
              <Space>
                <Switch checked={s.syncFocus} onChange={(v) => void save({ syncFocus: v })} />
                <InputNumber
                  min={0}
                  max={365}
                  addonBefore="首次导入最近"
                  addonAfter="天"
                  disabled={!s.syncFocus}
                  value={s.focusImportDays}
                  onChange={(v) => v !== null && void save({ focusImportDays: v })}
                />
              </Space>
            </Form.Item>
            <Form.Item label="滴答新增的清单/文件夹自动在 Notion 新建领域">
              <Switch checked={s.autoCreateDomains} onChange={(v) => void save({ autoCreateDomains: v })} />
            </Form.Item>
            <Form.Item label="重复任务每次完成都在 Notion 另建一条" extra="关闭时（推荐）不另建页面，完成记录写在原任务同步区的“最近完成”里。">
              <Switch checked={s.recurringCompletionRecords} onChange={(v) => void save({ recurringCompletionRecords: v })} />
            </Form.Item>
            <Form.Item label="新建任务时套用 FLO.W 默认任务模板" extra="实验性：请先确认模板不会覆盖同步写入的属性。">
              <Switch checked={s.applyTemplate} onChange={(v) => void save({ applyTemplate: v })} />
            </Form.Item>
          </Form>
        </Card>

        <Card title="安全">
          <Form layout="vertical" style={{ maxWidth: 640 }}>
            <Form.Item label="滴答中删除任务后，Notion 页面">
              <Radio.Group value={s.deletePolicy} onChange={(e) => void save({ deletePolicy: e.target.value })}>
                <Radio value="trash">移入回收站（30 天内可恢复）</Radio>
                <Radio value="abandon">标记为「放弃」</Radio>
                <Radio value="ignore">保留不动</Radio>
              </Radio.Group>
            </Form.Item>
            <Form.Item label="批量变更熔断" extra="超过阈值时暂停并等待你在概览页确认。">
              <Space wrap>
                <InputNumber min={0} max={1000} addonBefore="删除超过" addonAfter="个" value={s.breaker.maxTrash} onChange={(v) => v !== null && void save({ breaker: { ...s.breaker, maxTrash: v } })} />
                <InputNumber
                  min={1}
                  max={100}
                  addonBefore="修改超过"
                  addonAfter="%"
                  value={Math.round(s.breaker.maxUpdateRatio * 100)}
                  onChange={(v) => v && void save({ breaker: { ...s.breaker, maxUpdateRatio: v / 100 } })}
                />
                <InputNumber min={0} max={10000} addonBefore="且至少" addonAfter="个" value={s.breaker.minUpdates} onChange={(v) => v !== null && void save({ breaker: { ...s.breaker, minUpdates: v } })} />
              </Space>
            </Form.Item>
          </Form>
        </Card>

        <Card title="日期与时区">
          <Form layout="vertical" style={{ maxWidth: 640 }}>
            <Form.Item label="默认时区" extra="任务和滴答偏好设置都没有时区时使用。">
              <Select style={{ width: 240 }} value={s.defaultTimeZone} onChange={(v) => void save({ defaultTimeZone: v })} options={ZONES.map((z) => ({ value: z, label: z }))} />
            </Form.Item>
            <Form.Item label="全天多日任务的截止日为“结束日次日 0 点”" extra="待用真实数据校准；如果多日任务在 Notion 中少了一天或多了一天，切换这里。">
              <Switch checked={s.allDayEndExclusive} onChange={(v) => void save({ allDayEndExclusive: v })} />
            </Form.Item>
          </Form>
        </Card>

        <Card title="系统">
          <Form layout="vertical">
            <Form.Item label="开机自动启动">
              <Switch checked={s.launchAtLogin} onChange={(v) => void save({ launchAtLogin: v })} />
            </Form.Item>
            <Form.Item label="开机启动后最小化到托盘">
              <Switch checked={s.startMinimized} onChange={(v) => void save({ startMinimized: v })} />
            </Form.Item>
            <Form.Item label="关闭窗口时缩到托盘（继续后台同步）">
              <Switch checked={s.closeToTray} onChange={(v) => void save({ closeToTray: v })} />
            </Form.Item>
          </Form>
        </Card>

        <Card title="滴答清单账号">
          <DidaLogin state={state} />
        </Card>

        <Card title="工具与信息">
          <Space direction="vertical" style={{ width: '100%' }}>
            <Space wrap>
              <Button icon={<FileSearchOutlined />} onClick={exportDiag}>
                导出诊断样例
              </Button>
              <Button icon={<FolderOpenOutlined />} onClick={() => void api.openPath('logs')}>
                日志目录
              </Button>
              <Button icon={<FolderOpenOutlined />} onClick={() => void api.openPath('backups')}>
                备份目录
              </Button>
              <Button icon={<FolderOpenOutlined />} onClick={() => void api.openPath('data')}>
                数据目录
              </Button>
            </Space>
            <Typography.Text type="secondary">诊断样例只包含日期、状态等结构信息，用于校准全天任务、收件箱等细节，不含任务标题和描述。</Typography.Text>
            <Descriptions size="small" column={2} bordered style={{ marginTop: 8 }}>
              <Descriptions.Item label="FlowSync">{state.versions.app}</Descriptions.Item>
              <Descriptions.Item label="Electron">{state.versions.electron}</Descriptions.Item>
              <Descriptions.Item label="ntn">{state.versions.ntn ?? '未找到'}</Descriptions.Item>
              <Descriptions.Item label="dida-cli">{state.versions.dida ?? '未找到'}</Descriptions.Item>
            </Descriptions>
          </Space>
        </Card>
      </Space>
    </div>
  )
}
