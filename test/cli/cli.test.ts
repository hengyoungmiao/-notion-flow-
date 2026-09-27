import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseDidaCallback } from '../../src/app/auth'
import { acquireLock, isPausedFlag, readStatus, releaseLock, sendRequest, takeRequests } from '../../src/app/control'
import { Daemon } from '../../src/app/daemon'
import { homePaths } from '../../src/app/paths'
import { FlowSyncService } from '../../src/app/service'
import { FLOW_IDS, type FakeNotion } from '../../src/core/adapters/fake'
import * as cmd from '../../src/cli/commands'
import { ScriptedPrompter, textWidth, type Output } from '../../src/cli/io'
import { parseArgs, runCli } from '../../src/cli/main'

const tmp = () => mkdtempSync(join(tmpdir(), 'flowsync-cli-'))

function capture(): Output & { lines: string[]; text: () => string } {
  const lines: string[] = []
  return { lines, line: (t = '') => lines.push(t), error: (t) => lines.push(t), text: () => lines.join('\n') }
}

async function setupDemo(home = tmp()) {
  const service = new FlowSyncService({ home, fake: true })
  await service.init()
  const out = capture()
  // 滴答保持登录、工作空间名默认、Notion 保持连接、任务库选默认、同意新增滴答ID、收件箱/天数/番茄默认、确认首次同步
  const prompt = new ScriptedPrompter(['', '', '', '', '', '', '', '', ''])
  const ctx: cmd.Ctx = { service, paths: homePaths(home), out, prompt, waitMs: 5000 }
  await cmd.setup(ctx)
  return { service, ctx, out, prompt, home }
}

describe('命令行解析', () => {
  it('支持位置参数和各种选项写法', () => {
    expect(parseArgs(['mapping', 'set', '开发', 'skip', '--home', '/x', '-n', '20', '--dry-run', '--rounds=3'])).toEqual({
      command: 'mapping',
      positional: ['set', '开发', 'skip'],
      flags: { home: '/x', n: '20', 'dry-run': true, rounds: '3' }
    })
    expect(parseArgs([]).command).toBe('help')
  })

  it('--version、未知命令', async () => {
    const out = capture()
    expect(await runCli(['--version'], { out })).toBe(0)
    expect(out.lines[0]).toMatch(/^\d+\.\d+\.\d+$/)
    expect(await runCli(['nope', '--home', tmp(), '--fake'], { out: capture() })).toBe(2)
  })

  it('中文按两个字符宽度对齐', () => {
    expect(textWidth('开发ab')).toBe(6)
  })
})

describe('设置向导（演示模式）', () => {
  it('从零走完：识别任务库、新增滴答ID、预览、首次同步', async () => {
    const { service, out, prompt } = await setupDemo()
    const ws = service.active()!
    expect(ws.name).toBe('个人空间')
    expect(ws.schema?.tasks.props.didaId).toBeTruthy()
    const state = await service.store.load(ws.id)
    expect(state.initializedAt).not.toBeNull()
    expect(Object.keys(state.tasks).length).toBeGreaterThan(5)
    const notion = service.clientFor(ws) as FakeNotion
    expect(notion.pagesOf(FLOW_IDS.tasks).length).toBeGreaterThan(5)
    expect(out.text()).toContain('首次同步完成')
    expect(out.text()).toContain('sudo systemctl enable --now flowsync')
    expect(prompt.asked.some((q) => q.includes('滴答ID'))).toBe(true)
  })

  it('再次运行时不重做首次同步', async () => {
    const { service, ctx } = await setupDemo()
    const out = capture()
    await cmd.setup({ ...ctx, out, prompt: new ScriptedPrompter(['', '', '', '', '', '']) })
    expect(out.text()).toContain('已经完成过首次同步')
    expect(service.active()).not.toBeNull()
  })
})

describe('滴答授权链接', () => {
  it('从跳转后的链接取出授权码，state 不一致时拒绝', () => {
    expect(parseDidaCallback('http://localhost:8765/callback?code=abc123&state=s1', 's1')).toBe('abc123')
    expect(parseDidaCallback('  abc123  ', 's1')).toBe('abc123')
    expect(() => parseDidaCallback('http://localhost:8765/callback?code=abc&state=other', 's1')).toThrow('state 不一致')
    expect(() => parseDidaCallback('http://localhost:8765/callback?error=access_denied&state=s1', 's1')).toThrow('拒绝')
    expect(() => parseDidaCallback('http://localhost:8765/callback?state=s1', 's1')).toThrow('授权码')
  })
})

describe('常驻服务', () => {
  it('跑指定轮数后退出，写状态文件并释放锁', async () => {
    const { service, ctx } = await setupDemo()
    const daemon = new Daemon(service, ctx.paths, { rounds: 1, controlIntervalMs: 50 })
    await daemon.start()
    await daemon.done
    const st = await readStatus(ctx.paths)
    expect(st?.workspace).toBe('个人空间')
    expect(st?.scheduler.lastSuccessAt).not.toBeNull()
    expect(existsSync(ctx.paths.lock)).toBe(false)
  })

  it('同一时间只能有一个服务', async () => {
    const { service, ctx } = await setupDemo()
    // 模拟另一个进程（用父进程的 pid，它一定存活）持有锁
    writeFileSync(ctx.paths.lock, String(process.ppid))
    const b = new Daemon(service, ctx.paths)
    await expect(b.start()).rejects.toThrow('已经在运行')
  })

  it('处理暂停请求：写入暂停标记，重启后仍暂停', async () => {
    const { service, ctx } = await setupDemo()
    const daemon = new Daemon(service, ctx.paths, { controlIntervalMs: 30 })
    await daemon.start()
    await cmd.pause(ctx, true)
    await new Promise((r) => setTimeout(r, 200))
    expect(daemon.scheduler.isPaused).toBe(true)
    await daemon.stop()
    expect(await isPausedFlag(ctx.paths)).toBe(true)

    const again = new Daemon(service, ctx.paths, { controlIntervalMs: 30 })
    await again.start()
    expect(again.scheduler.isPaused).toBe(true)
    await again.stop()
  })

  it('命令行修改配置后，服务自动重新读取', async () => {
    const { service, ctx, home } = await setupDemo()
    const daemon = new Daemon(service, ctx.paths, { controlIntervalMs: 30 })
    await daemon.start()
    const other = new FlowSyncService({ home, fake: true })
    await other.init()
    await other.updateSettings({ deletePolicy: 'abandon' })
    await new Promise((r) => setTimeout(r, 200))
    expect(service.config.get().settings.deletePolicy).toBe('abandon')
    await daemon.stop()
  })
})

describe('控制文件与锁', () => {
  it('请求按固定顺序取出并删除', async () => {
    const paths = homePaths(tmp())
    await sendRequest(paths, 'sync')
    await sendRequest(paths, 'pause')
    expect(await takeRequests(paths)).toEqual(['pause', 'sync'])
    expect(await takeRequests(paths)).toEqual([])
  })

  it('锁被存活进程持有时获取失败；进程已退出的旧锁会被清理', async () => {
    const paths = homePaths(tmp())
    expect(await acquireLock(paths)).toBeNull()
    expect(await acquireLock(paths, 123456789)).toBe(process.pid)
    await releaseLock(paths)
    writeFileSync(paths.lock, '999999999')
    expect(await acquireLock(paths)).toBeNull()
    expect(await readFile(paths.lock, 'utf8')).toBe(String(process.pid))
  })
})

describe('其它命令', () => {
  it('settings set 校验取值，mapping set 按名称指定', async () => {
    const { ctx, service } = await setupDemo()
    await cmd.settings(ctx, ['set', 'deletePolicy', 'abandon'])
    expect(service.config.get().settings.deletePolicy).toBe('abandon')
    await expect(cmd.settings(ctx, ['set', 'deletePolicy', 'boom'])).rejects.toThrow('不是 deletePolicy 的有效值')
    await cmd.settings(ctx, ['set', 'scope.includeInbox', 'false'])
    expect(service.active()!.scope.includeInbox).toBe(false)
    await cmd.settings(ctx, ['set', 'breaker.maxTrash', '8'])
    expect(service.config.get().settings.breaker.maxTrash).toBe(8)

    const lists = (await service.dida.listProjects()).filter((p) => !p.closed && p.kind !== 'NOTE')
    await cmd.mapping(ctx, ['set', lists[0]!.name, 'skip'])
    expect(service.active()!.scope.excludedLists).toContain(lists[0]!.id)
  })

  it('status、sync --dry-run、doctor 在演示模式下可用', async () => {
    const { ctx } = await setupDemo()
    const out = capture()
    await cmd.status({ ...ctx, out })
    expect(out.text()).toContain('个人空间')
    await cmd.sync({ ...ctx, out }, { dryRun: true })
    expect(out.text()).toContain('预览')
    expect(await cmd.doctor({ ...ctx, out }, {})).toBe(0)
    expect(out.text()).toContain('FLO.W 任务库')
  })

  it('配置文件只允许本人读写（里面可能有 Notion token）', async () => {
    const { service } = await setupDemo()
    const { stat } = await import('node:fs/promises')
    expect((await stat(service.config.path)).mode & 0o077).toBe(0)
  })
})
