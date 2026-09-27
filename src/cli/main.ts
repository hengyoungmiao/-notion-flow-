import { Daemon } from '../app/daemon'
import { flowsyncHome, homePaths } from '../app/paths'
import { APP_VERSION } from '../app/runtime'
import { FlowSyncService } from '../app/service'
import * as cmd from './commands'
import { consoleOutput, localTime, ScriptedPrompter, TerminalPrompter, type Output, type Prompter } from './io'

export interface ParsedArgs {
  command: string
  positional: string[]
  flags: Record<string, string | boolean>
}

/** 解析命令行：第一个非选项参数是命令，--x / --x=y / -f / -n 20 都支持 */
export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}
  const withValue = new Set(['home', 'n', 'rounds', 'workspace'])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1)
      else if (withValue.has(a.slice(2)) && argv[i + 1] !== undefined) flags[a.slice(2)] = argv[++i]!
      else flags[a.slice(2)] = true
    } else if (a.startsWith('-') && a.length > 1) {
      const key = a.slice(1)
      if (withValue.has(key) && argv[i + 1] !== undefined) flags[key] = argv[++i]!
      else flags[key] = true
    } else positional.push(a)
  }
  return { command: positional.shift() ?? 'help', positional, flags }
}

export const HELP = `FlowSync ${APP_VERSION}：滴答清单 → Notion FLO.W 单向同步

第一次使用：
  flowsync setup                 设置向导（登录滴答、登录 Notion、识别 FLO.W、预览、首次同步）
  sudo systemctl enable --now flowsync   启动后台服务（安装脚本已注册好）

日常：
  flowsync status                同步状态、是否在等确认、今日统计
  flowsync log [-f] [-n 50]      同步记录（-f 持续显示新记录）
  flowsync sync [--dry-run]      立即同步一轮（--dry-run 只预览不写入）
  flowsync approve               确认“大批量变更”并执行
  flowsync pause | resume        暂停 / 继续自动同步
  flowsync doctor [--export]     检查环境、滴答各接口、Notion 权限（--export 导出脱敏诊断样例）

调整：
  flowsync mapping [set <清单> <领域名|auto|create|skip>]   领域映射
  flowsync settings [set <名称> <值>]                        设置
  flowsync workspace list | add <名称> | use <名称> | remove <名称>
  flowsync login dida | notion [--workspace <名称>]          重新登录
  flowsync removed | restore <滴答ID>                        Notion 中已删除、停止同步的任务

后台服务：
  flowsync run                   前台运行同步服务（systemd 调用的就是这个）
  flowsync demo                  用内置示例数据演示一遍（不连接真实账号）

通用选项：--home <目录>（默认 ~/.flowsync，或环境变量 FLOWSYNC_HOME）　--fake（演示模式）`

export interface CliIo {
  out?: Output
  prompter?: Prompter
  env?: NodeJS.ProcessEnv
  /** 常驻服务：安装信号处理（测试时关闭） */
  handleSignals?: boolean
}

export async function runCli(argv: string[], io: CliIo = {}): Promise<number> {
  const out = io.out ?? consoleOutput
  const env = io.env ?? process.env
  const args = parseArgs(argv)
  if (args.command === 'version' || args.flags.version || args.flags.v) {
    out.line(APP_VERSION)
    return 0
  }
  if (args.command === 'help' || args.flags.help || args.flags.h) {
    out.line(HELP)
    return 0
  }
  const fake = !!args.flags.fake || env.FLOWSYNC_FAKE === '1' || args.command === 'demo'
  const home = typeof args.flags.home === 'string' ? args.flags.home : flowsyncHome(env)
  const paths = homePaths(home)
  const daemonMode = args.command === 'run'
  const service = new FlowSyncService({
    home,
    fake,
    echo: daemonMode ? (e) => out.line(`${localTime(e.at)}  ${e.title}${e.detail ? `（${e.detail}）` : ''}`) : undefined
  })
  const prompt = io.prompter ?? new TerminalPrompter(out)
  const ctx: cmd.Ctx = { service, paths, out, prompt }
  try {
    await service.init()
    const [first, ...rest] = args.positional
    switch (args.command) {
      case 'setup':
        await cmd.setup(ctx, { workspace: typeof args.flags.workspace === 'string' ? args.flags.workspace : undefined })
        return 0
      case 'login':
        if (first === 'dida') await cmd.loginDida(ctx)
        else if (first === 'notion') {
          const ws = typeof args.flags.workspace === 'string' ? service.workspace(args.flags.workspace) : (service.active() ?? service.workspaces()[0])
          if (!ws) throw new Error('还没有工作空间：请先运行 flowsync setup')
          await cmd.loginNotion(ctx, ws)
        } else throw new Error('用法：flowsync login dida | notion')
        return 0
      case 'status':
        await cmd.status(ctx)
        return 0
      case 'sync':
        await cmd.sync(ctx, { dryRun: !!args.flags['dry-run'] })
        return 0
      case 'approve':
        await cmd.approve(ctx)
        return 0
      case 'pause':
        await cmd.pause(ctx, true)
        return 0
      case 'resume':
        await cmd.pause(ctx, false)
        return 0
      case 'mapping':
        await cmd.mapping(ctx, args.positional)
        return 0
      case 'workspace':
      case 'workspaces':
        await cmd.workspace(ctx, args.positional)
        return 0
      case 'settings':
      case 'config':
        await cmd.settings(ctx, args.positional)
        return 0
      case 'log':
      case 'logs':
        await cmd.log(ctx, { lines: Number(args.flags.n ?? 50) || 50, follow: !!args.flags.f || !!args.flags.follow })
        return 0
      case 'removed':
        await cmd.removed(ctx)
        return 0
      case 'restore':
        await cmd.restore(ctx, first)
        return 0
      case 'doctor':
        return await cmd.doctor(ctx, { exportSample: !!args.flags.export })
      case 'demo': {
        // 演示：用内置示例数据走一遍设置向导（全部默认选项），再跑几轮同步（不连接任何真实账号）
        await cmd.setup({ ...ctx, prompt: new ScriptedPrompter(Array(12).fill('')) })
        const rounds = Number(args.flags.rounds ?? 1) || 1
        const daemon = new Daemon(service, paths, { rounds, controlIntervalMs: 200 })
        await daemon.start()
        await daemon.done
        out.line('')
        await cmd.status(ctx)
        return 0
      }
      case 'run': {
        const daemon = new Daemon(service, paths, { rounds: args.flags.rounds ? Number(args.flags.rounds) : undefined })
        await daemon.start()
        if (io.handleSignals !== false) {
          const stop = () => void daemon.stop()
          process.once('SIGTERM', stop)
          process.once('SIGINT', stop)
        }
        await daemon.done
        return 0
      }
      default:
        void rest
        out.error(`未知命令：${args.command}`)
        out.line(HELP)
        return 2
    }
  } catch (e) {
    out.error(`✗ ${cmd.describeError(e)}`)
    return 1
  } finally {
    prompt.close()
  }
}
