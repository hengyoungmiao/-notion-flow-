import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { CliError } from '../core/adapters/exec'
import { collectDiagnostics } from '../core/diagnostics'
import type { DomainRow } from '../core/mapping/domains'
import { normalizeTitle } from '../core/mapping/text'
import type { SchedulerSnapshot } from '../core/scheduler'
import type { RoundResult, RoundSummary } from '../core/sync/engine'
import { writeJsonAtomic } from '../core/sync/state'
import type { AppSettings, DomainMapping, WorkspaceProfile } from '../core/types'
import { finishDidaOAuth, loadDidaOAuth, startDidaOAuth } from '../app/auth'
import { acquireLock, isPausedFlag, lockOwner, readStatus, releaseLock, sendRequest, setPausedFlag, type ControlRequest } from '../app/control'
import { runDoctor } from '../app/doctor'
import type { HomePaths } from '../app/paths'
import type { FlowSyncService } from '../app/service'
import { fromNow, localTime, MARK, table, type Output, type Prompter } from './io'

export interface Ctx {
  service: FlowSyncService
  paths: HomePaths
  out: Output
  prompt: Prompter
  /** 等待常驻服务处理请求的最长时间 */
  waitMs?: number
}

const STATUS_TEXT: Record<SchedulerSnapshot['status'], string> = {
  idle: '同步正常',
  running: '正在同步',
  paused: '已暂停',
  error: '同步出错，稍后自动重试',
  auth: '需要重新登录',
  blocked: '检测到大批量变更，等待确认',
  needs_setup: '尚未完成设置',
  needs_initial: '等待首次同步'
}

const ROW_STATUS: Record<DomainRow['status'], string> = {
  linked: '已关联',
  matched: '同名匹配',
  create: '将新建',
  excluded: '不同步',
  skip: '不绑定',
  none: '不绑定',
  broken: '已失效',
  archived: '已归档',
  deleted: '已删除'
}

function activeOrFail(ctx: Ctx, name?: string): WorkspaceProfile {
  if (name) return ctx.service.workspace(name)
  const ws = ctx.service.active()
  if (!ws) throw new Error('还没有工作空间：请先运行 flowsync setup')
  return ws
}

async function daemonRunning(ctx: Ctx): Promise<number | null> {
  return lockOwner(ctx.paths)
}

/** 通知常驻服务处理请求，并等它跑完一轮 */
async function requestAndWait(ctx: Ctx, request: ControlRequest): Promise<SchedulerSnapshot | null> {
  const before = (await readStatus(ctx.paths))?.scheduler.lastRunAt ?? null
  await sendRequest(ctx.paths, request)
  const deadline = Date.now() + (ctx.waitMs ?? 180_000)
  let started = false
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500))
    const s = (await readStatus(ctx.paths))?.scheduler
    if (!s) continue
    if (s.lastRunAt !== before) started = true
    if (started && s.status !== 'running') return s
  }
  return null
}

/** 常驻服务没在运行时，直接在当前进程跑一轮（持锁，避免同时启动的服务并发写入） */
async function runDirect(ctx: Ctx, opts: Parameters<NonNullable<ReturnType<FlowSyncService['activeEngine']>>['runRound']>[0]): Promise<RoundResult> {
  const engine = ctx.service.activeEngine()
  if (!engine) throw new Error('当前工作空间还没有完成设置：请先运行 flowsync setup')
  const owner = await acquireLock(ctx.paths)
  if (owner !== null) throw new Error(`后台服务正在运行（进程 ${owner}），请稍后再试`)
  try {
    return await engine.runRound(opts)
  } finally {
    await releaseLock(ctx.paths)
  }
}

// ───────────────────────── 打印 ─────────────────────────

export function printSummary(out: Output, s: RoundSummary, applied?: RoundResult['appliedCounts']): void {
  const c = applied ?? s.counts
  out.line(
    `  新建 ${c.creates} · 关联已有 ${s.matches.length} · 更新 ${c.updates} · 校正 ${c.corrections} · 删除/放弃 ${c.destructive}` +
      ` · 同步区 ${s.bodies} · 关联项目 ${s.projectLinks} · 番茄记录 ${s.focus.creates}`
  )
  if (s.domainCreates.length) out.line(`  将新建领域：${s.domainCreates.map((d) => `${d.title}（${d.detail}）`).join('、')}`)
  const list = (title: string, items: RoundSummary['creates'], max = 15) => {
    if (!items.length) return
    out.line(`  ${title}（${items.length}）：`)
    for (const i of items.slice(0, max)) out.line(`    - ${i.title || '（无标题）'}${i.detail ? `：${i.detail}` : ''}`)
    if (items.length > max) out.line(`    …另外 ${items.length - max} 个`)
  }
  list('新建', s.creates)
  list('按标题关联到 Notion 已有页面（请检查有没有配错）', s.matches)
  list('更新', s.updates)
  list('删除/放弃', s.destructive)
  for (const w of s.warnings) out.line(`  ${MARK.warn} ${w}`)
}

async function printMapping(ctx: Ctx, ws: WorkspaceProfile): Promise<void> {
  const view = await ctx.service.engineFor(ws).inspectStructure(true)
  const rows = view.rows.map((r) => [
    r.type === 'group' ? '文件夹' : r.groupId ? '  清单' : '清单',
    r.didaName,
    ROW_STATUS[r.status],
    r.status === 'excluded' ? '' : (r.notionTitle ?? '')
  ])
  for (const l of table(['类型', '滴答', '结果', 'Notion 领域'], rows)) ctx.out.line(`  ${l}`)
  for (const w of view.warnings) ctx.out.line(`  ${MARK.warn} ${w}`)
  if (view.tagProjects?.length) {
    ctx.out.line('')
    ctx.out.line('  标签 → FLO.W 项目：')
    for (const l of table(['滴答标签', '关联的项目'], view.tagProjects.map((t) => [`#${t.tag}`, t.projectTitle ?? '未匹配']))) ctx.out.line(`  ${l}`)
  }
}

// ───────────────────────── 登录 ─────────────────────────

export async function loginDida(ctx: Ctx): Promise<number> {
  const { out, prompt, service } = ctx
  const way = await prompt.choose('选择滴答清单的登录方式：', ['在自己电脑的浏览器里授权（推荐）', '直接粘贴 access token'])
  let lists: number
  if (way === 0 && !service.fake) {
    const mod = await loadDidaOAuth(service.didaScriptPath())
    const start = startDidaOAuth(mod)
    out.line('')
    out.line('1. 在你自己电脑（或手机）的浏览器里打开下面的链接，登录滴答并点“同意/授权”：')
    out.line('')
    out.line(`   ${start.url}`)
    out.line('')
    out.line('2. 授权后浏览器会跳到一个 localhost 开头、打不开的页面（显示“无法访问此网站”是正常的）。')
    out.line('3. 把浏览器地址栏里那一整条链接复制下来，粘贴到这里。')
    const pasted = await prompt.ask('粘贴跳转后的完整链接')
    const token = await finishDidaOAuth(mod, start, pasted)
    lists = await service.didaSaveToken(token)
  } else {
    out.line('token 可以从这两个地方拿到：')
    out.line('  - 网页版滴答 → 头像 → 设置 → 账户与安全 → API 口令')
    out.line('  - 或者在自己电脑上运行 `npx @suibiji/dida-cli auth login` 登录，再从 ~/.config/dida-cli/config.json 复制 access_token')
    lists = await service.didaSaveToken(await prompt.secret('粘贴滴答 access token'))
  }
  out.line(`${MARK.ok} 滴答清单登录成功（${lists} 个清单）`)
  if (await daemonRunning(ctx)) await sendRequest(ctx.paths, 'sync')
  return lists
}

export async function loginNotion(ctx: Ctx, ws: WorkspaceProfile): Promise<void> {
  const { out, prompt, service } = ctx
  const way = await prompt.choose(`选择 Notion（工作空间「${ws.name}」）的登录方式：`, [
    '使用 Notion 集成 token（推荐服务器使用）',
    '用 Notion 账号登录（在浏览器里确认验证码）'
  ])
  let name: string | null
  if (way === 0) {
    out.line('')
    out.line('1. 打开 https://www.notion.so/profile/integrations ，点“新建集成”，类型选“内部”，选中你的工作空间。')
    out.line('2. 在集成的“配置”页复制“内部集成密钥”（以 ntn_ 开头）。')
    out.line('3. 在 Notion 里打开 FLO.W 模板最上层的页面 → 右上角 ··· → 连接（Connections）→ 选这个集成，')
    out.line('   这样集成才能读写 FLO.W 里的任务库、领域库、项目库和番茄库。')
    name = (await service.notionUseToken(ws.id, await prompt.secret('粘贴集成密钥'))).workspaceName
  } else {
    const info = await service.notionLoginStart(ws.id)
    out.line('')
    out.line(`在浏览器里打开：${info.url}`)
    out.line(`确认页面上的验证码是：${info.code}`)
    out.line('确认后这里会自动继续（最多等 10 分钟）…')
    name = (await service.notionLoginPoll(ws.id)).workspaceName
  }
  out.line(`${MARK.ok} Notion 已连接${name ? `：${name}` : ''}`)
  if (await daemonRunning(ctx)) await sendRequest(ctx.paths, 'sync')
}

async function bindDatabase(ctx: Ctx, ws: WorkspaceProfile): Promise<void> {
  const { out, prompt, service } = ctx
  for (let attempt = 0; attempt < 5; attempt++) {
    out.line('正在查找 FLO.W「我的任务 DB」…')
    const candidates = await service.findTaskDatabases(ws.id)
    const options = [...candidates.map((c) => `${c.title}${c.looksLikeFlow ? '（像 FLO.W 任务库）' : ''}`), '都不是，粘贴任务库的链接']
    const pick = await prompt.choose('选择 FLO.W 的任务库：', options, Math.max(0, candidates.findIndex((c) => c.looksLikeFlow)))
    const target = pick < candidates.length ? candidates[pick]!.dataSourceId : await prompt.ask('粘贴「FLO.W - 我的任务 DB」的链接')
    const res = await service.bindTaskDatabase(ws.id, target)
    for (const i of res.issues) out.line(`  ${i.level === 'error' ? MARK.bad : MARK.warn} ${i.message}`)
    if (!res.ok) {
      out.line(`${MARK.bad} 这个数据库不像 FLO.W「我的任务 DB」，请换一个`)
      continue
    }
    if (res.needsDidaIdProperty) {
      const yes = await prompt.confirm('需要在任务库里新增一个「滴答ID」文本字段（用来关联滴答任务，不改动模板原有字段），可以吗？', true)
      if (!yes) throw new Error('没有「滴答ID」字段无法同步')
      await service.ensureDidaIdProperty(ws.id)
      out.line(`${MARK.ok} 已新增「滴答ID」字段`)
    }
    out.line(`${MARK.ok} 已识别任务库「${res.tasksTitle}」`)
    return
  }
  throw new Error('没能识别 FLO.W 任务库')
}

// ───────────────────────── setup ─────────────────────────

export async function setup(ctx: Ctx, opts: { workspace?: string; skipDida?: boolean } = {}): Promise<void> {
  const { out, prompt, service } = ctx
  out.line('FlowSync 设置向导（随时可以按 Ctrl+C 退出，已完成的步骤会保留）')
  out.line('')

  // 1. 滴答
  if (!opts.skipDida) {
    out.line('【1/6】滴答清单')
    let lists: number | null = null
    try {
      lists = await service.didaVerify()
    } catch (e) {
      out.line(`${MARK.warn} 检查滴答登录时出错：${e instanceof Error ? e.message : String(e)}`)
    }
    if (lists !== null) {
      out.line(`${MARK.ok} 滴答清单已登录（${lists} 个清单）`)
      if (!(await prompt.confirm('继续使用这个滴答账号？', true))) lists = null
    }
    if (lists === null) await loginDida(ctx)
    out.line('')
  }

  // 2. 工作空间 + Notion
  out.line('【2/6】Notion 工作空间')
  let ws: WorkspaceProfile
  if (opts.workspace) ws = service.workspaces().find((w) => w.name === opts.workspace) ?? (await service.createWorkspace(opts.workspace))
  else {
    const all = service.workspaces()
    if (all.length === 0) ws = await service.createWorkspace(await prompt.ask('给这个 Notion 工作空间起个名字', '个人空间'))
    else if (all.length === 1) ws = all[0]!
    else ws = all[await prompt.choose('要设置哪个工作空间？', all.map((w) => w.name), Math.max(0, all.findIndex((w) => w.id === service.active()?.id)))]!
  }
  const me = await service.notionWhoami(ws.id).catch(() => null)
  if (me && (await prompt.confirm(`Notion 已连接（${me.workspaceName ?? ws.name}），继续使用？`, true))) out.line(`${MARK.ok} 使用已连接的 Notion`)
  else await loginNotion(ctx, ws)
  out.line('')

  // 3. 任务库
  out.line('【3/6】识别 FLO.W 任务库')
  ws = service.workspace(ws.id)
  if (ws.schema?.tasks.props.didaId && (await prompt.confirm(`继续使用任务库「${ws.schema.tasks.title}」？`, true))) out.line(`${MARK.ok} 使用已识别的任务库`)
  else await bindDatabase(ctx, ws)
  ws = service.workspace(ws.id)
  out.line('')

  // 4. 领域映射
  out.line('【4/6】领域映射（滴答文件夹 → 一级领域，清单 → 二级领域）')
  await printMapping(ctx, ws)
  out.line('  需要调整的话，之后运行：flowsync mapping set <清单名> <领域名 | auto | create | skip>')
  out.line('')

  // 5. 同步范围
  out.line('【5/6】同步范围')
  const includeInbox = await prompt.confirm('同步收件箱里的任务？（收件箱任务不绑定领域）', ws.scope.includeInbox)
  const days = Number(await prompt.ask('首次同步时导入最近几天已完成的任务（0 表示不导入）', String(ws.scope.importCompletedDays)))
  await service.updateScope(ws.id, { includeInbox, importCompletedDays: Number.isFinite(days) && days >= 0 ? Math.min(365, Math.round(days)) : 0 })
  const settings = service.config.get().settings
  const syncFocus = await prompt.confirm('同步番茄钟和正计时记录到 FLO.W 任务番茄数据库？', settings.syncFocus)
  await service.updateSettings({ syncFocus })
  ws = service.workspace(ws.id)
  out.line('')

  // 6. 预览并首次同步
  out.line('【6/6】预览并开始首次同步')
  const state = await service.store.load(ws.id)
  if (state.initializedAt) {
    out.line(`${MARK.ok} 这个工作空间已经完成过首次同步（${localTime(state.initializedAt)}），不需要重做。`)
  } else {
    out.line('正在读取滴答和 Notion，生成预览…')
    const preview = await service.previewInitial(ws.id)
    printSummary(out, preview.summary)
    if (!(await prompt.confirm('确认开始首次同步？开始前会先把 Notion 任务库备份到本机', true))) {
      out.line('已取消。准备好后再运行 flowsync setup。')
      return
    }
    const res = await service.startInitial(ws.id)
    out.line(`${MARK.ok} 首次同步完成：新建 ${res.appliedCounts.creates} 个、关联 ${res.summary.matches.length} 个任务`)
    if (res.backupPath) out.line(`  备份：${res.backupPath}`)
  }
  if (!service.active()) await service.setActive(ws.id)
  out.line('')
  if (await daemonRunning(ctx)) {
    await sendRequest(ctx.paths, 'reload')
    out.line(`${MARK.ok} 后台服务已在运行，会自动使用新的设置。`)
  } else {
    out.line('下一步：启动后台服务，之后滴答里的变化会自动同步到 Notion：')
    out.line('  sudo systemctl enable --now flowsync')
    out.line('查看状态：flowsync status　　查看记录：flowsync log -f')
  }
}

// ───────────────────────── 状态、同步、确认 ─────────────────────────

export async function status(ctx: Ctx): Promise<void> {
  const { out, service } = ctx
  const ws = service.active()
  const owner = await daemonRunning(ctx)
  const st = await readStatus(ctx.paths)
  const s = owner ? st?.scheduler : undefined
  out.line(`工作空间：${ws?.name ?? '（未设置）'}${ws?.notionWorkspaceName ? `（Notion：${ws.notionWorkspaceName}）` : ''}`)
  out.line(`后台服务：${owner ? `运行中（进程 ${owner}）` : '没有运行（sudo systemctl start flowsync）'}`)
  if (await isPausedFlag(ctx.paths)) out.line('同步：已暂停（flowsync resume 继续）')
  if (!ws) return
  const state = await service.store.load(ws.id)
  if (s) {
    out.line(`状态：${STATUS_TEXT[s.status]}`)
    out.line(`上次成功同步：${fromNow(s.lastSuccessAt)}（${localTime(s.lastSuccessAt)}）`)
    if (s.nextRunAt && s.status !== 'paused') out.line(`下次同步：${localTime(s.nextRunAt)}（当前间隔 ${s.intervalSec} 秒）`)
    out.line(`今天：新建 ${s.today.created} · 更新 ${s.today.updated} · 校正 ${s.today.corrected} · 删除 ${s.today.removed}`)
    if (s.lastError) out.line(`${MARK.bad} 最近的错误：${s.lastError.message}`)
  } else {
    out.line(`上次成功同步：${fromNow(state.lastSuccessAt)}（${localTime(state.lastSuccessAt)}）`)
  }
  out.line(`已关联任务：${Object.keys(state.tasks).length} 个${state.initializedAt ? '' : '（还没有完成首次同步）'}`)
  const pending = s?.pending ?? state.pendingApproval
  if (pending) {
    out.line('')
    out.line(`${MARK.warn} 检测到大批量变更，已暂停等待确认：${pending.reason}`)
    for (const line of pending.sample) out.line(`    - ${line}`)
    out.line('  新建和关联照常执行；确认执行修改/删除请运行：flowsync approve')
  }
  const down = Object.entries(st?.dida ?? {}).filter(([, h]) => h.ok === false)
  if (owner && down.length) {
    out.line('')
    out.line('滴答接口降级：')
    for (const [, h] of down) out.line(`  ${MARK.warn} ${h.error} → ${h.fallback}`)
  }
}

export async function sync(ctx: Ctx, opts: { dryRun?: boolean }): Promise<void> {
  const { out } = ctx
  if (opts.dryRun) {
    const engine = ctx.service.activeEngine()
    if (!engine) throw new Error('当前工作空间还没有完成设置：请先运行 flowsync setup')
    const res = await engine.runRound({ dryRun: true, forceStructure: true, forceReconcile: true })
    out.line('预览（不会写入）：')
    printSummary(out, res.summary)
    return
  }
  if (await daemonRunning(ctx)) {
    out.line('已通知后台服务立即同步，等待完成…')
    const s = await requestAndWait(ctx, 'sync')
    out.line(s ? `${s.status === 'idle' ? MARK.ok : MARK.warn} ${STATUS_TEXT[s.status]}${s.lastError ? `：${s.lastError.message}` : ''}` : '后台服务还在处理，稍后用 flowsync status 查看')
    return
  }
  const res = await runDirect(ctx, { forceStructure: true, forceReconcile: true })
  out.line(`${res.blocked ? MARK.warn : MARK.ok} 同步完成`)
  printSummary(out, res.summary, res.appliedCounts)
  if (res.blocked) out.line(`${MARK.warn} 检测到大批量变更，修改/删除未执行：${res.blocked.reason}。确认请运行 flowsync approve`)
}

export async function approve(ctx: Ctx): Promise<void> {
  const { out, service } = ctx
  const ws = activeOrFail(ctx)
  const state = await service.store.load(ws.id)
  const st = await readStatus(ctx.paths)
  const pending = st?.scheduler.pending ?? state.pendingApproval
  if (!pending) {
    out.line('没有等待确认的变更。')
    return
  }
  out.line(`将执行：${pending.reason}`)
  if (await daemonRunning(ctx)) {
    const s = await requestAndWait(ctx, 'approve')
    out.line(s ? `${MARK.ok} 已确认并执行（${STATUS_TEXT[s.status]}）` : '后台服务还在处理，稍后用 flowsync status 查看')
    return
  }
  const res = await runDirect(ctx, { approve: true, forceReconcile: true })
  out.line(`${MARK.ok} 已确认并执行`)
  printSummary(out, res.summary, res.appliedCounts)
}

export async function pause(ctx: Ctx, paused: boolean): Promise<void> {
  await setPausedFlag(ctx.paths, paused)
  if (await daemonRunning(ctx)) await sendRequest(ctx.paths, paused ? 'pause' : 'resume')
  ctx.out.line(`${MARK.ok} ${paused ? '已暂停自动同步（重启后也保持暂停）' : '已继续自动同步'}`)
}

// ───────────────────────── 映射 ─────────────────────────

export async function mapping(ctx: Ctx, args: string[]): Promise<void> {
  const ws = activeOrFail(ctx)
  if (args[0] !== 'set') {
    await printMapping(ctx, ws)
    ctx.out.line('')
    ctx.out.line('修改：flowsync mapping set <清单或文件夹名> <领域名 | auto | create | skip>')
    return
  }
  const [, name, ...rest] = args
  const target = rest.join(' ').trim()
  if (!name || !target) throw new Error('用法：flowsync mapping set <清单或文件夹名> <领域名 | auto | create | skip>')
  const view = await ctx.service.engineFor(ws).inspectStructure(true)
  const matches = view.rows.filter((r) => normalizeTitle(r.didaName) === normalizeTitle(name) && r.status !== 'archived' && r.status !== 'deleted')
  const row = matches.find((r) => r.type === 'list') ?? matches[0]
  if (!row) throw new Error(`滴答里没有找到名为「${name}」的清单或文件夹`)
  const pages = row.type === 'group' ? view.notionAreas : view.notionDomains
  let m: DomainMapping
  if (target === 'auto') m = { mode: 'auto' }
  else if (target === 'create') m = { mode: 'create' }
  else if (target === 'skip') m = { mode: 'skip' }
  else {
    const page = pages.find((p) => normalizeTitle(p.title) === normalizeTitle(target))
    if (!page) throw new Error(`Notion 里没有名为「${target}」的${row.type === 'group' ? '一级' : '二级'}领域`)
    m = { mode: 'map', pageId: page.pageId }
  }
  await ctx.service.setMapping(ws.id, row.type === 'group' ? 'groups' : 'lists', row.didaId, m)
  const label = m.mode === 'map' ? `「${target}」` : { auto: '自动（同名关联，没有则新建）', create: '新建同名领域', skip: row.type === 'group' ? '不绑定一级领域' : '不同步这个清单' }[m.mode]
  ctx.out.line(`${MARK.ok} ${row.type === 'group' ? '文件夹' : '清单'}「${row.didaName}」→ ${label}（下一轮同步生效）`)
}

// ───────────────────────── 工作空间 ─────────────────────────

export async function workspace(ctx: Ctx, args: string[]): Promise<void> {
  const { out, service } = ctx
  const [sub, ...rest] = args
  const name = rest.join(' ').trim()
  if (!sub || sub === 'list') {
    const activeId = service.config.get().activeWorkspaceId
    const rows: string[][] = []
    for (const w of service.workspaces()) {
      const state = await service.store.load(w.id)
      rows.push([
        `${w.id === activeId ? '* ' : '  '}${w.name}`,
        w.notionWorkspaceName ?? '未登录',
        w.schema?.tasks.title ?? '未识别',
        state.initializedAt ? `${Object.keys(state.tasks).length} 个任务` : '未完成首次同步'
      ])
    }
    if (!rows.length) out.line('还没有工作空间：运行 flowsync setup')
    else for (const l of table(['工作空间（* 为当前）', 'Notion', '任务库', '同步'], rows)) out.line(l)
    return
  }
  if (sub === 'add') {
    if (!name) throw new Error('用法：flowsync workspace add <名称>')
    await setup(ctx, { workspace: name, skipDida: true })
    return
  }
  if (sub === 'use') {
    const ws = await service.setActive(name)
    out.line(`${MARK.ok} 已切换到「${ws.name}」，后台服务下一轮开始同步这个空间（切回之前的空间时会补齐期间的变化）`)
    return
  }
  if (sub === 'remove') {
    const ws = service.workspace(name)
    if (!(await ctx.prompt.confirm(`删除工作空间「${ws.name}」的本机登录和同步记录？Notion 里的页面不受影响`, false))) return
    await service.removeWorkspace(ws.id)
    out.line(`${MARK.ok} 已删除「${ws.name}」`)
    return
  }
  throw new Error('用法：flowsync workspace list | add <名称> | use <名称> | remove <名称>')
}

// ───────────────────────── 设置 ─────────────────────────

const SETTING_LABELS: Partial<Record<keyof AppSettings | string, string>> = {
  pollMinSec: '轮询最短间隔（秒）',
  pollMaxSec: '轮询最长间隔（秒）',
  reconcileMinutes: 'Notion 校正间隔（分钟）',
  structureMinutes: '清单/领域结构刷新间隔（分钟）',
  deletePolicy: '滴答删除任务后：trash 移入回收站 / abandon 标记放弃 / ignore 保留不动',
  'breaker.maxTrash': '熔断：一轮删除超过几个就暂停',
  'breaker.maxUpdateRatio': '熔断：修改超过已关联任务的比例（0–1）',
  'breaker.minUpdates': '熔断：且修改至少几个',
  syncBody: '页面顶部同步区（描述、检查事项、子任务、重复规则）',
  syncProjects: '滴答标签自动关联 FLO.W 同名项目',
  recurringAsSchedule: '重复任务：任务类型固定为「日程」、不按标签关联项目',
  recurringCompletionRecords: '重复任务每次完成都在 Notion 另建一条（默认关）',
  syncFocus: '同步番茄钟和正计时记录',
  focusImportDays: '首次同步导入最近几天的专注记录',
  autoCreateDomains: '滴答新增清单/文件夹时自动新建领域',
  applyTemplate: '新建任务时套用 FLO.W 默认模板（实验性）',
  allDayEndExclusive: '全天多日任务的截止日为“结束日次日 0 点”',
  defaultTimeZone: '默认时区',
  'scope.includeInbox': '同步收件箱（当前工作空间）',
  'scope.importCompletedDays': '首次同步导入最近几天已完成的任务（当前工作空间）'
}

function parseValue(raw: string, current: unknown): unknown {
  if (typeof current === 'boolean') {
    if (['true', 'on', 'yes', '1', '开'].includes(raw)) return true
    if (['false', 'off', 'no', '0', '关'].includes(raw)) return false
    throw new Error('请输入 true 或 false')
  }
  if (typeof current === 'number') {
    const n = Number(raw)
    if (!Number.isFinite(n)) throw new Error('请输入数字')
    return n
  }
  return raw
}

export async function settings(ctx: Ctx, args: string[]): Promise<void> {
  const { out, service } = ctx
  const s = service.config.get().settings
  const ws = service.active()
  const flat: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(s)) {
    if (k === 'breaker') for (const [bk, bv] of Object.entries(v as object)) flat[`breaker.${bk}`] = bv
    else if (!['launchAtLogin', 'startMinimized', 'closeToTray'].includes(k)) flat[k] = v
  }
  if (ws) {
    flat['scope.includeInbox'] = ws.scope.includeInbox
    flat['scope.importCompletedDays'] = ws.scope.importCompletedDays
  }
  if (args[0] !== 'set') {
    for (const [k, v] of Object.entries(flat)) out.line(`${k} = ${String(v)}${SETTING_LABELS[k] ? `　　# ${SETTING_LABELS[k]}` : ''}`)
    out.line('')
    out.line('修改：flowsync settings set <名称> <值>，例如 flowsync settings set deletePolicy abandon')
    return
  }
  const [, key, raw] = args
  if (!key || raw === undefined || !(key in flat)) throw new Error(`用法：flowsync settings set <名称> <值>；可用名称：${Object.keys(flat).join('、')}`)
  const value = parseValue(raw, flat[key])
  if (key.startsWith('scope.')) await service.updateScope(ws!.id, { [key.slice(6)]: value } as Partial<WorkspaceProfile['scope']>)
  else if (key.startsWith('breaker.')) await service.updateSettings({ breaker: { ...s.breaker, [key.slice(8)]: value } })
  else await service.updateSettings({ [key]: value } as Partial<AppSettings>)
  const after = key.startsWith('scope.')
    ? (service.active()!.scope as unknown as Record<string, unknown>)[key.slice(6)]
    : key.startsWith('breaker.')
      ? (service.config.get().settings.breaker as unknown as Record<string, unknown>)[key.slice(8)]
      : (service.config.get().settings as unknown as Record<string, unknown>)[key]
  if (String(after) !== String(value)) throw new Error(`「${raw}」不是 ${key} 的有效值，已保持为 ${String(after)}`)
  out.line(`${MARK.ok} ${key} = ${String(after)}（下一轮同步生效）`)
}

// ───────────────────────── 记录 ─────────────────────────

function formatEntry(line: string): string | null {
  try {
    const e = JSON.parse(line) as { at: string; kind: string; title: string; detail?: string }
    return `${localTime(e.at)}  ${e.title}${e.detail ? `（${e.detail}）` : ''}`
  } catch {
    return null
  }
}

export async function log(ctx: Ctx, opts: { lines: number; follow: boolean }): Promise<void> {
  const dir = ctx.service.config.logDir
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.startsWith('activity-')).sort()
  const collected: string[] = []
  for (const f of files.slice(-3)) collected.push(...(await readFile(join(dir, f), 'utf8')).split('\n').filter(Boolean))
  for (const l of collected.slice(-opts.lines)) {
    const text = formatEntry(l)
    if (text) ctx.out.line(text)
  }
  if (!opts.follow) return
  let current = files.at(-1) ? join(dir, files.at(-1)!) : ''
  let offset = current ? (await stat(current)).size : 0
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000))
    const today = join(dir, `activity-${new Date().toISOString().slice(0, 10)}.log`)
    if (today !== current) {
      current = today
      offset = 0
    }
    const size = await stat(current).then((s) => s.size).catch(() => 0)
    if (size <= offset) continue
    const chunk = (await readFile(current)).subarray(offset).toString('utf8')
    offset = size
    for (const l of chunk.split('\n').filter(Boolean)) {
      const t = formatEntry(l)
      if (t) ctx.out.line(t)
    }
  }
}

export async function removed(ctx: Ctx): Promise<void> {
  const ws = activeOrFail(ctx)
  const list = await ctx.service.removed(ws.id)
  if (!list.length) {
    ctx.out.line('没有在 Notion 中被删除、停止同步的任务。')
    return
  }
  for (const l of table(['滴答ID', '任务', '删除时间'], list.map((r) => [r.didaId, r.title, localTime(r.at)]))) ctx.out.line(l)
  ctx.out.line('')
  ctx.out.line('恢复同步（会在 Notion 重新创建）：flowsync restore <滴答ID>')
}

export async function restore(ctx: Ctx, didaId: string | undefined): Promise<void> {
  if (!didaId) throw new Error('用法：flowsync restore <滴答ID>')
  const ws = activeOrFail(ctx)
  await ctx.service.restore(ws.id, didaId)
  if (await daemonRunning(ctx)) await sendRequest(ctx.paths, 'sync')
  ctx.out.line(`${MARK.ok} 已恢复同步，下一轮会在 Notion 重新创建`)
}

// ───────────────────────── doctor ─────────────────────────

export async function doctor(ctx: Ctx, opts: { exportSample?: boolean }): Promise<number> {
  const lines = await runDoctor(ctx.service, ctx.paths)
  let group = ''
  let problems = 0
  for (const l of lines) {
    if (l.group !== group) {
      group = l.group
      ctx.out.line('')
      ctx.out.line(`【${group}】`)
    }
    if (l.ok === false) problems++
    ctx.out.line(`  ${l.ok === true ? MARK.ok : l.ok === false ? MARK.bad : MARK.warn} ${l.name}：${l.detail}`)
  }
  ctx.out.line('')
  ctx.out.line(problems ? `有 ${problems} 项需要处理。` : '检查完成，没有发现需要处理的问题。')
  if (opts.exportSample) {
    const report = await collectDiagnostics(ctx.service.dida)
    const path = join(ctx.paths.root, 'diagnostics', `diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    await writeJsonAtomic(path, { ...report, doctor: lines })
    ctx.out.line(`已导出脱敏诊断样例（不含任务标题和描述）：${path}`)
  }
  return problems ? 1 : 0
}

export function describeError(e: unknown): string {
  if (e instanceof CliError && e.kind === 'auth') {
    return e.tool === 'dida' ? '滴答清单登录无效或已过期：运行 flowsync login dida' : 'Notion 登录无效或已过期：运行 flowsync login notion'
  }
  return e instanceof Error ? e.message : String(e)
}
