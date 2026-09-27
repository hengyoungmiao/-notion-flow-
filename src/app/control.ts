import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SchedulerSnapshot } from '../core/scheduler'
import type { EndpointHealth, Endpoint } from '../core/adapters/resilient-dida'
import { readJson, writeJsonAtomic } from '../core/sync/state'
import type { HomePaths } from './paths'

/** 命令行发给常驻服务的请求：写一个文件，常驻服务处理后删除 */
export type ControlRequest = 'sync' | 'approve' | 'pause' | 'resume' | 'reload'

export interface DaemonStatus {
  pid: number
  version: string
  startedAt: string
  updatedAt: string
  workspace: string | null
  scheduler: SchedulerSnapshot
  dida: Record<Endpoint, EndpointHealth>
}

// ───────────────────────── 单实例锁 ─────────────────────────

export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export async function lockOwner(paths: HomePaths): Promise<number | null> {
  try {
    const pid = Number((await readFile(paths.lock, 'utf8')).trim())
    return isAlive(pid) ? pid : null
  } catch {
    return null
  }
}

/** 获取锁：已有存活的进程持有时返回它的 pid（获取失败），成功返回 null */
export async function acquireLock(paths: HomePaths, pid = process.pid): Promise<number | null> {
  await mkdir(paths.root, { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(paths.lock, String(pid), { flag: 'wx' })
      return null
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      const owner = await lockOwner(paths)
      if (owner && owner !== pid) return owner
      if (owner === pid) return null
      // 上次的进程已经不在了：清掉旧锁再试一次
      await rm(paths.lock, { force: true })
    }
  }
  return (await lockOwner(paths)) ?? -1
}

export async function releaseLock(paths: HomePaths, pid = process.pid): Promise<void> {
  try {
    if (Number((await readFile(paths.lock, 'utf8')).trim()) === pid) await rm(paths.lock, { force: true })
  } catch {
    /* ignore */
  }
}

// ───────────────────────── 请求文件 ─────────────────────────

export async function sendRequest(paths: HomePaths, request: ControlRequest): Promise<void> {
  await mkdir(paths.control, { recursive: true })
  await writeFile(join(paths.control, `${request}.request`), new Date().toISOString())
}

/** 读取并删除所有待处理请求（按固定顺序处理：pause/resume 先于 approve/sync） */
export async function takeRequests(paths: HomePaths): Promise<ControlRequest[]> {
  let files: string[]
  try {
    files = await readdir(paths.control)
  } catch {
    return []
  }
  const order: ControlRequest[] = ['reload', 'pause', 'resume', 'approve', 'sync']
  const found = new Set<ControlRequest>()
  for (const f of files) {
    const m = /^(\w+)\.request$/.exec(f)
    if (!m || !order.includes(m[1] as ControlRequest)) continue
    found.add(m[1] as ControlRequest)
    await rm(join(paths.control, f), { force: true })
  }
  return order.filter((r) => found.has(r))
}

// ───────────────────────── 暂停标记（重启后保持暂停） ─────────────────────────

export async function setPausedFlag(paths: HomePaths, paused: boolean): Promise<void> {
  await mkdir(paths.control, { recursive: true })
  if (paused) await writeFile(paths.pausedFlag, new Date().toISOString())
  else await rm(paths.pausedFlag, { force: true })
}

export async function isPausedFlag(paths: HomePaths): Promise<boolean> {
  try {
    await readFile(paths.pausedFlag)
    return true
  } catch {
    return false
  }
}

// ───────────────────────── 状态文件 ─────────────────────────

export async function writeStatus(paths: HomePaths, status: DaemonStatus): Promise<void> {
  await writeJsonAtomic(paths.status, status)
}

export async function readStatus(paths: HomePaths): Promise<DaemonStatus | null> {
  try {
    return await readJson<DaemonStatus>(paths.status)
  } catch {
    return null
  }
}
