import type { ApiEvent, ApiMethod, FlowSyncApi } from '../shared/ipc'

declare global {
  interface Window {
    flowsync: {
      invoke<M extends ApiMethod>(method: M, ...args: Parameters<FlowSyncApi[M]>): ReturnType<FlowSyncApi[M]>
      on(event: ApiEvent, cb: (payload: unknown) => void): () => void
    }
  }
}

export {}
