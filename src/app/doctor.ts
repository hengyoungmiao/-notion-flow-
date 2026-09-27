import { access, constants } from 'node:fs/promises'
import { CliError } from '../core/adapters/exec'
import { FALLBACKS } from '../core/adapters/resilient-dida'
import { refreshTaskSchema } from '../core/notion/schema'
import type { DidaTask } from '../core/types'
import { lockOwner, readStatus } from './control'
import type { HomePaths } from './paths'
import { APP_VERSION, didaScript, ntnPath, toolVersions } from './runtime'
import type { FlowSyncService } from './service'

export interface DoctorLine {
  group: string
  name: string
  /** true 正常；false 有问题；null 跳过或仅提示 */
  ok: boolean | null
  detail: string
}

const DAY = 86_400_000

function describe(e: unknown): string {
  if (e instanceof CliError) return `${e.status ? `HTTP ${e.status}：` : ''}${e.message}`
  return e instanceof Error ? e.message : String(e)
}

/** 环境、滴答各接口、Notion 访问权限、后台服务状态逐项检查 */
export async function runDoctor(service: FlowSyncService, paths: HomePaths, now = new Date()): Promise<DoctorLine[]> {
  const lines: DoctorLine[] = []
  const add = (group: string, name: string, ok: boolean | null, detail: string) => lines.push({ group, name, ok, detail })

  // ── 环境 ──
  add('环境', 'FlowSync', true, `${APP_VERSION}${service.fake ? '（演示模式）' : ''}`)
  add('环境', 'Node.js', true, process.version)
  if (!service.fake) {
    const v = await toolVersions()
    add('环境', 'Notion CLI（ntn）', !!v.ntn, v.ntn ?? `找不到或无法运行：${ntnPath()}`)
    add('环境', '滴答 CLI（dida-cli）', !!v.dida, v.dida ?? `找不到或无法运行：${didaScript()}`)
  }
  try {
    await access(paths.root, constants.W_OK)
    add('环境', '数据目录', true, paths.root)
  } catch {
    add('环境', '数据目录', false, `${paths.root} 不可写`)
  }

  // ── 滴答 ──
  const dida = service.rawDida
  let lists: string[] = []
  try {
    const projects = await dida.listProjects()
    const active = projects.filter((p) => !p.closed && (p.kind ?? 'TASK').toUpperCase() !== 'NOTE')
    lists = active.map((p) => p.id)
    add('滴答清单', '登录（project list）', true, `已登录，${active.length} 个清单${projects.length > active.length ? `（另有 ${projects.length - active.length} 个已归档或笔记清单）` : ''}`)
  } catch (e) {
    const auth = e instanceof CliError && e.kind === 'auth'
    add('滴答清单', '登录（project list）', false, auth ? '未登录或 token 已失效：运行 flowsync login dida' : describe(e))
  }
  if (lists.length) {
    const probe = async (name: string, fallback: string | null, fn: () => Promise<string>) => {
      try {
        add('滴答清单', name, true, await fn())
      } catch (e) {
        if (e instanceof CliError && e.kind === 'auth') add('滴答清单', name, false, `登录失效：${describe(e)}`)
        else add('滴答清单', name, fallback ? null : false, `不可用（${describe(e)}）${fallback ? `→ ${fallback}` : ''}`)
      }
    }
    const sample = lists.slice(0, 3)
    let someTask: DidaTask | undefined
    await probe('偏好设置（preference）', FALLBACKS.preference, async () => {
      const p = await dida.getPreference()
      return typeof p.timeZone === 'string' ? `时区 ${p.timeZone}` : '可用（没有时区信息）'
    })
    await probe('清单文件夹（project group list）', FALLBACKS.groups, async () => `${(await dida.listGroups()).length} 个文件夹`)
    await probe('未完成任务（task filter）', FALLBACKS.filter, async () => {
      const tasks = await dida.listOpenTasks(sample)
      someTask ??= tasks[0]
      return `前 ${sample.length} 个清单共 ${tasks.length} 个未完成任务`
    })
    await probe('清单任务（project data，官方接口）', null, async () => {
      const tasks = await dida.listProjectTasks(sample[0]!)
      someTask ??= tasks[0]
      return `第一个清单有 ${tasks.length} 个未完成任务`
    })
    await probe('已完成任务（task completed）', FALLBACKS.completed, async () => {
      const tasks = await dida.listCompletedTasks(new Date(now.getTime() - 3 * DAY), now)
      return `最近 3 天完成 ${tasks.length} 个`
    })
    await probe('单个任务（task get，官方接口）', null, async () => {
      if (!someTask) return '没有可用来测试的任务，跳过'
      const t = await dida.getTask(someTask.projectId, someTask.id)
      return t ? '可用' : '返回为空'
    })
    await probe('标签（tag list）', FALLBACKS.tags, async () => `${(await dida.listTags()).length} 个标签`)
    await probe('番茄记录（focus list）', FALLBACKS.focus, async () => {
      const f = await dida.listFocus(new Date(now.getTime() - 3 * DAY), now, 'pomodoro')
      return `最近 3 天 ${f.length} 条番茄记录`
    })
  }

  // ── Notion ──
  const workspaces = service.workspaces()
  if (!workspaces.length) add('Notion', '工作空间', null, '还没有工作空间：运行 flowsync setup')
  for (const ws of workspaces) {
    const group = `Notion · ${ws.name}${ws.id === service.config.get().activeWorkspaceId ? '（当前）' : ''}`
    try {
      const me = await service.clientFor(ws).whoami()
      add(group, '登录', true, `${me.workspaceName ?? '已连接'}${ws.auth.type === 'token' ? '（集成 token）' : '（ntn 登录）'}`)
    } catch (e) {
      add(group, '登录', false, e instanceof CliError && e.kind === 'auth' ? '未登录或已失效：运行 flowsync login notion' : describe(e))
      continue
    }
    if (!ws.schema) {
      add(group, 'FLO.W 任务库', false, '还没有识别：运行 flowsync setup')
      continue
    }
    try {
      const ds = await service.clientFor(ws).getDataSource(ws.schema.tasks.dataSourceId)
      const r = refreshTaskSchema(ws.schema, ds)
      if (r.fatal) add(group, 'FLO.W 任务库', false, r.fatal)
      else add(group, 'FLO.W 任务库', r.issues.length ? null : true, r.issues.length ? r.issues.join('；') : `「${ws.schema.tasks.title}」字段完整`)
    } catch (e) {
      add(group, 'FLO.W 任务库', false, `无法读取（${describe(e)}）。集成 token 需要在 Notion 里把 FLO.W 页面共享给该集成`)
    }
    const state = await service.store.load(ws.id)
    add(group, '首次同步', state.initializedAt ? true : null, state.initializedAt ? `已完成，关联 ${Object.keys(state.tasks).length} 个任务` : '还没有完成：运行 flowsync setup')
  }

  // ── 后台服务 ──
  const owner = await lockOwner(paths)
  const status = await readStatus(paths)
  if (owner) {
    const s = status?.scheduler
    add('后台服务', '运行状态', s?.status === 'error' || s?.status === 'auth' ? false : true, `运行中（进程 ${owner}）${s ? `，状态：${s.status}，上次成功：${s.lastSuccessAt ?? '—'}` : ''}`)
  } else add('后台服务', '运行状态', null, '没有运行：sudo systemctl start flowsync（或前台运行 flowsync run）')
  return lines
}
