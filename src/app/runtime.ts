import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { DidaCommand } from '../core/adapters/dida'
import { runProcess } from '../core/adapters/exec'

const require = createRequire(import.meta.url)

function packageDir(name: string): string | null {
  try {
    return dirname(require.resolve(`${name}/package.json`))
  } catch {
    return null
  }
}

/** 内置的 dida-cli 入口脚本（用当前 Node 运行） */
export function didaScript(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FLOWSYNC_DIDA_SCRIPT) return env.FLOWSYNC_DIDA_SCRIPT
  const dir = packageDir('@suibiji/dida-cli')
  return dir ? join(dir, 'dist', 'index.js') : 'dida-cli-not-found'
}

export function didaCommand(timeoutMs = 60_000): DidaCommand {
  return { command: process.execPath, baseArgs: [didaScript()], timeoutMs }
}

/** 内置的 ntn（Notion 官方 CLI）平台二进制 */
export function ntnPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FLOWSYNC_NTN) return env.FLOWSYNC_NTN
  const dir = packageDir('ntn')
  const exe = process.platform === 'win32' ? 'ntn.exe' : 'ntn'
  return dir ? join(dir, 'dist', `ntn-${process.platform}-${process.arch}`, exe) : 'ntn-not-found'
}

export async function toolVersions(): Promise<{ ntn: string | null; dida: string | null }> {
  const read = async (cmd: string, args: string[]) => {
    try {
      if (cmd !== process.execPath && !existsSync(cmd)) return null
      const r = await runProcess(cmd, args, { timeoutMs: 20_000 })
      return r.code === 0 ? r.stdout.trim().replace(/^ntn\s+/, '') : null
    } catch {
      return null
    }
  }
  const [ntn, dida] = await Promise.all([read(ntnPath(), ['--version']), read(process.execPath, [didaScript(), '--version'])])
  return { ntn, dida }
}

declare const __FLOWSYNC_VERSION__: string | undefined

export const APP_VERSION: string = (() => {
  // 打包时由 esbuild 注入；开发/测试时读 package.json
  if (typeof __FLOWSYNC_VERSION__ !== 'undefined') return __FLOWSYNC_VERSION__
  try {
    return (require('../../package.json') as { version: string }).version
  } catch {
    return process.env.FLOWSYNC_VERSION ?? '0.0.0'
  }
})()
