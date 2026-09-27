export type ActivityKind =
  | 'create'
  | 'update'
  | 'correct'
  | 'relink'
  | 'trash'
  | 'abandon'
  | 'unlink'
  | 'removed'
  | 'domain'
  | 'warning'
  | 'error'
  | 'info'

export interface ActivityEntry {
  id: string
  at: string
  kind: ActivityKind
  title: string
  detail?: string
  didaId?: string
  pageId?: string
}

export type ActivitySink = (entry: Omit<ActivityEntry, 'id' | 'at'>) => void

let seq = 0
export function makeEntry(e: Omit<ActivityEntry, 'id' | 'at'>, now = new Date()): ActivityEntry {
  seq = (seq + 1) % 1_000_000
  return { ...e, id: `${now.getTime().toString(36)}-${seq}`, at: now.toISOString() }
}

/** 内存环形缓冲（界面「同步记录」） */
export class ActivityLog {
  private entries: ActivityEntry[] = []
  private listeners = new Set<(e: ActivityEntry) => void>()
  constructor(private readonly capacity = 2000) {}

  push(e: Omit<ActivityEntry, 'id' | 'at'>): ActivityEntry {
    const entry = makeEntry(e)
    this.entries.push(entry)
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity)
    for (const l of this.listeners) l(entry)
    return entry
  }

  list(limit = 500): ActivityEntry[] {
    return this.entries.slice(-limit).reverse()
  }

  onEntry(listener: (e: ActivityEntry) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
