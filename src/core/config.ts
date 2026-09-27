import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import type { AppConfig, AppSettings, WorkspaceProfile } from './types'
import { readJson, writeJsonAtomic } from './sync/state'

export const DEFAULT_SETTINGS: AppSettings = {
  pollMinSec: 10,
  pollMaxSec: 60,
  reconcileMinutes: 10,
  structureMinutes: 5,
  deletePolicy: 'trash',
  breaker: { maxTrash: 5, maxUpdateRatio: 0.2, minUpdates: 10 },
  syncBody: true,
  syncProjects: true,
  applyTemplate: false,
  recurringCompletionRecords: false,
  syncFocus: true,
  focusImportDays: 30,
  autoCreateDomains: true,
  launchAtLogin: true,
  startMinimized: true,
  closeToTray: true,
  allDayEndExclusive: true,
  defaultTimeZone: 'Asia/Shanghai'
}

const settingsSchema = z.object({
  pollMinSec: z.number().min(5).max(600),
  pollMaxSec: z.number().min(5).max(3600),
  reconcileMinutes: z.number().min(1).max(1440),
  structureMinutes: z.number().min(1).max(1440),
  deletePolicy: z.enum(['trash', 'abandon', 'ignore']),
  breaker: z.object({
    maxTrash: z.number().min(0).max(1000),
    maxUpdateRatio: z.number().min(0).max(1),
    minUpdates: z.number().min(0).max(10000)
  }),
  syncBody: z.boolean(),
  syncProjects: z.boolean(),
  applyTemplate: z.boolean(),
  recurringCompletionRecords: z.boolean(),
  syncFocus: z.boolean(),
  focusImportDays: z.number().min(0).max(365),
  autoCreateDomains: z.boolean(),
  launchAtLogin: z.boolean(),
  startMinimized: z.boolean(),
  closeToTray: z.boolean(),
  allDayEndExclusive: z.boolean(),
  defaultTimeZone: z.string().min(1)
})

export function sanitizeSettings(input: unknown): AppSettings {
  const merged = {
    ...DEFAULT_SETTINGS,
    ...(typeof input === 'object' && input ? input : {}),
    breaker: { ...DEFAULT_SETTINGS.breaker, ...((input as Partial<AppSettings>)?.breaker ?? {}) }
  }
  const parsed = settingsSchema.safeParse(merged)
  if (!parsed.success) return DEFAULT_SETTINGS
  const s = parsed.data
  if (s.pollMaxSec < s.pollMinSec) s.pollMaxSec = s.pollMinSec
  return s
}

export function defaultConfig(): AppConfig {
  return { version: 1, activeWorkspaceId: null, workspaces: [], settings: DEFAULT_SETTINGS, onboarded: false }
}

export function newWorkspace(name: string): WorkspaceProfile {
  return {
    id: randomUUID(),
    name,
    notionWorkspaceName: null,
    notionUserName: null,
    auth: { type: 'ntn' },
    schema: null,
    scope: { excludedLists: [], includeInbox: true, importCompletedDays: 0 },
    mappings: { lists: {}, groups: {} },
    createdAt: new Date().toISOString()
  }
}

/** 配置文件：userData/config.json */
export class ConfigStore {
  private config: AppConfig = defaultConfig()
  private listeners = new Set<(c: AppConfig) => void>()

  constructor(readonly rootDir: string) {}

  get path(): string {
    return join(this.rootDir, 'config.json')
  }

  get notionHomesDir(): string {
    return join(this.rootDir, 'notion')
  }

  get stateDir(): string {
    return join(this.rootDir, 'state')
  }

  get backupDir(): string {
    return join(this.rootDir, 'backups')
  }

  get logDir(): string {
    return join(this.rootDir, 'logs')
  }

  notionHome(workspaceId: string): string {
    return join(this.notionHomesDir, workspaceId)
  }

  async load(): Promise<AppConfig> {
    const raw = await readJson<Partial<AppConfig>>(this.path)
    const base = defaultConfig()
    this.config = raw
      ? {
          ...base,
          ...raw,
          workspaces: (raw.workspaces ?? []).map((w) => ({ ...newWorkspace(w.name ?? '工作空间'), ...w })),
          settings: sanitizeSettings(raw.settings)
        }
      : base
    return this.get()
  }

  get(): AppConfig {
    return structuredClone(this.config)
  }

  active(): WorkspaceProfile | null {
    return this.config.workspaces.find((w) => w.id === this.config.activeWorkspaceId) ?? null
  }

  async update(mutator: (c: AppConfig) => void): Promise<AppConfig> {
    const next = structuredClone(this.config)
    mutator(next)
    next.settings = sanitizeSettings(next.settings)
    this.config = next
    await writeJsonAtomic(this.path, next)
    const snapshot = this.get()
    for (const l of this.listeners) l(snapshot)
    return snapshot
  }

  async upsertWorkspace(ws: WorkspaceProfile): Promise<AppConfig> {
    return this.update((c) => {
      const i = c.workspaces.findIndex((w) => w.id === ws.id)
      if (i >= 0) c.workspaces[i] = ws
      else c.workspaces.push(ws)
    })
  }

  onChange(listener: (c: AppConfig) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
