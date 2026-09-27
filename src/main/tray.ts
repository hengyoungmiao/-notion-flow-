import { Menu, Tray, nativeImage, type NativeImage } from 'electron'
import { join } from 'node:path'
import type { AppViewState } from '../shared/ipc'

const STATUS_TEXT: Record<string, string> = {
  idle: '同步正常',
  running: '正在同步…',
  paused: '已暂停',
  error: '同步出错，稍后自动重试',
  auth: '需要重新登录',
  blocked: '等待确认大批量变更',
  needs_setup: '尚未完成设置',
  needs_initial: '等待首次同步'
}

export interface TrayActions {
  show: () => void
  syncNow: () => void
  pause: () => void
  resume: () => void
  switchWorkspace: (id: string) => void
  quit: () => void
}

export class AppTray {
  private tray: Tray
  private icons: Record<'ok' | 'paused' | 'error', NativeImage>

  constructor(resourcesDir: string, private readonly actions: TrayActions) {
    const load = (name: string) => nativeImage.createFromPath(join(resourcesDir, `tray-${name}.png`)).resize({ width: 16, height: 16 })
    this.icons = { ok: load('ok'), paused: load('paused'), error: load('error') }
    this.tray = new Tray(this.icons.ok)
    this.tray.setToolTip('FlowSync')
    this.tray.on('click', () => actions.show())
  }

  update(state: AppViewState): void {
    const s = state.scheduler.status
    const icon = s === 'error' || s === 'auth' || s === 'blocked' ? 'error' : s === 'paused' || s === 'needs_setup' || s === 'needs_initial' ? 'paused' : 'ok'
    this.tray.setImage(this.icons[icon])
    const active = state.workspaces.find((w) => w.id === state.activeWorkspaceId)
    this.tray.setToolTip(`FlowSync · ${active?.name ?? '未配置'} · ${STATUS_TEXT[s] ?? s}`)
    const paused = s === 'paused'
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `${active?.name ?? 'FlowSync'} — ${STATUS_TEXT[s] ?? s}`, enabled: false },
        { type: 'separator' },
        { label: '立即同步', click: () => this.actions.syncNow(), enabled: s !== 'needs_setup' },
        paused ? { label: '继续同步', click: () => this.actions.resume() } : { label: '暂停同步', click: () => this.actions.pause() },
        {
          label: '切换工作空间',
          enabled: state.workspaces.length > 1,
          submenu: state.workspaces.map((w) => ({
            label: w.name,
            type: 'radio' as const,
            checked: w.id === state.activeWorkspaceId,
            // 还没完成首次同步的空间不能直接切换（需要先在主界面完成设置）
            enabled: w.initialized || w.id === state.activeWorkspaceId,
            click: () => this.actions.switchWorkspace(w.id)
          }))
        },
        { type: 'separator' },
        { label: '打开主界面', click: () => this.actions.show() },
        { label: '退出 FlowSync', click: () => this.actions.quit() }
      ])
    )
  }

  destroy(): void {
    this.tray.destroy()
  }
}
