import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
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
    focus: { cursor: null, links: {} }
  }
}

/** 原子写 JSON：先写临时文件再 rename，避免崩溃时留下半个文件 */
export async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await rename(tmp, path)
}

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

export interface StateStore {
  load(workspaceId: string): Promise<WorkspaceState>
  save(state: WorkspaceState): Promise<void>
  remove(workspaceId: string): Promise<void>
}

export class FileStateStore implements StateStore {
  constructor(private readonly dir: string) {}

  private path(workspaceId: string): string {
    return join(this.dir, `${workspaceId}.json`)
  }

  async load(workspaceId: string): Promise<WorkspaceState> {
    const data = await readJson<WorkspaceState>(this.path(workspaceId))
    if (!data) return emptyState(workspaceId)
    return {
      ...emptyState(workspaceId),
      ...data,
      domains: { lists: data.domains?.lists ?? {}, groups: data.domains?.groups ?? {} },
      focus: { cursor: data.focus?.cursor ?? null, links: data.focus?.links ?? {} }
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
