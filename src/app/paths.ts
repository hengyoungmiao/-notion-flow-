import { homedir } from 'node:os'
import { join } from 'node:path'

/** FlowSync 的数据目录：配置、同步状态、日志、控制文件都在这里（可用 FLOWSYNC_HOME 修改） */
export function flowsyncHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.FLOWSYNC_HOME || join(homedir(), '.flowsync')
}

export interface HomePaths {
  root: string
  control: string
  status: string
  lock: string
  pausedFlag: string
}

export function homePaths(root: string): HomePaths {
  return {
    root,
    control: join(root, 'control'),
    status: join(root, 'status.json'),
    lock: join(root, 'daemon.lock'),
    pausedFlag: join(root, 'control', 'paused')
  }
}
