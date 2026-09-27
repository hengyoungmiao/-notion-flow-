import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { DidaCommand } from '../core/adapters/dida'
import { runProcess } from '../core/adapters/exec'

const ntnPlatformDir = (): string => `ntn-${process.platform}-${process.arch}`
const ntnExe = (): string => (process.platform === 'win32' ? 'ntn.exe' : 'ntn')

/** 内置的 ntn：打包后在 resources/bin，开发时直接用 node_modules/ntn 自带的平台二进制 */
export function ntnPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'bin', ntnExe())
  return join(app.getAppPath(), 'node_modules', 'ntn', 'dist', ntnPlatformDir(), ntnExe())
}

/** 内置的 dida-cli：用 Electron 自带的 Node 运行（ELECTRON_RUN_AS_NODE=1） */
export function didaCommand(timeoutMs?: number): DidaCommand {
  const script = app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@suibiji', 'dida-cli', 'dist', 'index.js')
    : join(app.getAppPath(), 'node_modules', '@suibiji', 'dida-cli', 'dist', 'index.js')
  return { command: process.execPath, baseArgs: [script], env: { ELECTRON_RUN_AS_NODE: '1' }, timeoutMs }
}

export async function toolVersions(): Promise<{ ntn: string | null; dida: string | null }> {
  const read = async (cmd: string, args: string[], env?: Record<string, string>) => {
    try {
      if (!existsSync(cmd) && cmd !== process.execPath) return null
      const r = await runProcess(cmd, args, { env, timeoutMs: 20_000 })
      return r.code === 0 ? r.stdout.trim().replace(/^ntn\s+/, '') : null
    } catch {
      return null
    }
  }
  const d = didaCommand()
  const [ntn, dida] = await Promise.all([read(ntnPath(), ['--version']), read(d.command, [...d.baseArgs, '--version'], d.env)])
  return { ntn, dida }
}
