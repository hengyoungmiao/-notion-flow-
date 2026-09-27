import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { WorkspaceState } from '../types'

export function emptyState(workspaceId: string): WorkspaceState {
  return {
    version: 1,
    workspaceId,
    initializedAt: null,
    lastSuccessAt: null,
    lastReconcileAt: null,
    tasks: {},
    notionRemoved: {},
    domains: { lists: {}, groups: {} },
    pendingApproval: null,
    foreignSightings: 0,
    focus: { cursor: null, links: {} },
    lists: { archived: {}, deleted: {} }
  }
}

const BUSY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

/** Windows 上目标文件被杀毒软件/索引短暂占用时 rename 会报 EPERM/EBUSY，稍等重试 */
export async function renameWithRetry(
  from: string,
  to: string,
  doRename: (a: string, b: string) => Promise<void> = rename,
  delays = [50, 100, 200, 400, 800]
): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      return await doRename(from, to)
    } catch (e) {
      if (i >= delays.length || !BUSY_CODES.has((e as NodeJS.ErrnoException).code ?? '')) throw e
      await new Promise((r) => setTimeout(r, delays[i]))
    }
  }
}

/** 原子写 JSON：先写临时文件再 rename，避免崩溃时留下半个文件 */
export async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  try {
    await renameWithRetry(tmp, path)
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw e
  }
}

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

/** 读取 JSON；内容损坏时把原文件改名备份（`.corrupt-时间戳`）并返回 `corrupt: true` */
export async function readJsonOrQuarantine<T>(path: string): Promise<{ data: T | null; corrupt: boolean }> {
  try {
    return { data: await readJson<T>(path), corrupt: false }
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e
    await renameWithRetry(path, `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`).catch(() => undefined)
    return { data: null, corrupt: true }
  }
}

export interface StateStore {
  load(workspaceId: string): Promise<WorkspaceState>
  save(state: WorkspaceState): Promise<void>
  remove(workspaceId: string): Promise<void>
}

export class FileStateStore implements StateStore {
  /** 状态文件损坏并已重建时回调（用于在同步记录里提示） */
  onRecovered?: (workspaceId: string) => void

  constructor(private readonly dir: string) {}

  private path(workspaceId: string): string {
    return join(this.dir, `${workspaceId}.json`)
  }

  async load(workspaceId: string): Promise<WorkspaceState> {
    const { data, corrupt } = await readJsonOrQuarantine<WorkspaceState>(this.path(workspaceId))
    if (corrupt) {
      // 状态文件只在首次同步后才会写入，损坏说明已经初始化过：
      // 从空状态继续，下一轮校正会按「滴答ID」把已有页面重新关联起来，不会重复创建
      this.onRecovered?.(workspaceId)
      return { ...emptyState(workspaceId), initializedAt: new Date().toISOString() }
    }
    if (!data) return emptyState(workspaceId)
    return {
      ...emptyState(workspaceId),
      ...data,
      domains: { lists: data.domains?.lists ?? {}, groups: data.domains?.groups ?? {} },
      focus: { cursor: data.focus?.cursor ?? null, links: data.focus?.links ?? {} },
      lists: { archived: data.lists?.archived ?? {}, deleted: data.lists?.deleted ?? {} }
    }
  }

  async save(state: WorkspaceState): Promise<void> {
    await writeJsonAtomic(this.path(state.workspaceId), state)
  }

  async remove(workspaceId: string): Promise<void> {
    const { rm } = await import('node:fs/promises')
    await rm(this.path(workspaceId), { force: true })
  }
}

export class MemoryStateStore implements StateStore {
  readonly states = new Map<string, WorkspaceState>()
  async load(workspaceId: string): Promise<WorkspaceState> {
    const s = this.states.get(workspaceId)
    return s ? structuredClone(s) : emptyState(workspaceId)
  }
  async save(state: WorkspaceState): Promise<void> {
    this.states.set(state.workspaceId, structuredClone(state))
  }
  async remove(workspaceId: string): Promise<void> {
    this.states.delete(workspaceId)
  }
}
