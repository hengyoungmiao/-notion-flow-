import { useEffect, useState } from 'react'
import type { ActivityEntry } from '../../core/activity'
import type { ApiMethod, AppViewState, FlowSyncApi } from '../../shared/ipc'

/** 类型安全的 IPC 调用：api.syncNow() → 主进程 AppController.syncNow() */
export const api = new Proxy({} as FlowSyncApi, {
  get: (_t, method: string) =>
    (...args: unknown[]) =>
      (window.flowsync.invoke as (m: ApiMethod, ...a: unknown[]) => Promise<unknown>)(method as ApiMethod, ...args)
})

export function useAppState(): [AppViewState | null, () => Promise<void>] {
  const [state, setState] = useState<AppViewState | null>(null)
  const refresh = async () => setState(await api.getState())
  useEffect(() => {
    void refresh()
    return window.flowsync.on('state', (s) => setState(s as AppViewState))
  }, [])
  return [state, refresh]
}

export function useActivity(limit = 500): ActivityEntry[] {
  const [entries, setEntries] = useState<ActivityEntry[]>([])
  useEffect(() => {
    void api.getActivity(limit).then(setEntries)
    return window.flowsync.on('activity', (e) => setEntries((prev) => [e as ActivityEntry, ...prev].slice(0, limit)))
  }, [limit])
  return entries
}

export function useSystemDark(): boolean {
  const query = '(prefers-color-scheme: dark)'
  const [dark, setDark] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const on = (e: MediaQueryListEvent) => setDark(e.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return dark
}
