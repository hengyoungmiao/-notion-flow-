import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { API_METHODS, IPC_EVENT_PREFIX, IPC_INVOKE, type ApiEvent, type ApiMethod } from '../shared/ipc'

const allowed = new Set<string>(API_METHODS)

contextBridge.exposeInMainWorld('flowsync', {
  invoke: (method: ApiMethod, ...args: unknown[]) => {
    if (!allowed.has(method)) return Promise.reject(new Error(`不允许的方法：${method}`))
    return ipcRenderer.invoke(IPC_INVOKE, method, ...args)
  },
  on: (event: ApiEvent, cb: (payload: unknown) => void) => {
    const channel = IPC_EVENT_PREFIX + event
    const listener = (_e: IpcRendererEvent, payload: unknown) => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
})
