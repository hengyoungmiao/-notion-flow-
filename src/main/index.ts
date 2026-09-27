import { BrowserWindow, Notification, app, ipcMain, powerMonitor, safeStorage, shell } from 'electron'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { API_METHODS, IPC_EVENT_PREFIX, IPC_INVOKE, type ApiMethod, type AppViewState } from '../shared/ipc'
import { didaCommand, ntnPath, toolVersions } from './binaries'
import { AppController } from './controller'
import { seedBlockedPreset, seedReadyPreset } from './demo-preset'
import { AppTray } from './tray'

const demo = process.env.FLOWSYNC_FAKE === '1'
const startHidden = process.argv.includes('--hidden')

if (demo) app.setPath('userData', mkdtempSync(join(tmpdir(), 'flowsync-demo-')))
app.setAppUserModelId('com.flowsync.app')

let win: BrowserWindow | null = null
let tray: AppTray | null = null
let controller: AppController | null = null
let quitting = false

const resourcesDir = app.isPackaged ? join(process.resourcesPath, 'resources') : join(app.getAppPath(), 'resources')

function createWindow(): void {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'FlowSync',
    icon: join(resourcesDir, 'icon.png'),
    autoHideMenuBar: true,
    backgroundColor: '#f5f6f8',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.once('ready-to-show', () => win?.show())
  win.on('close', (e) => {
    if (!quitting && controller?.config.get().settings.closeToTray) {
      e.preventDefault()
      win?.hide()
    }
  })
  win.on('closed', () => (win = null))
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://localhost') && !url.startsWith('file://')) e.preventDefault()
  })
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

function showWindow(): void {
  if (!win) createWindow()
  else {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())

  app.whenReady().then(async () => {
    controller = new AppController(app.getPath('userData'), {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      platform: process.platform,
      demo,
      ntnPath,
      didaCommand,
      toolVersions,
      encrypt: (plain) =>
        safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(plain).toString('base64') : `plain:${Buffer.from(plain).toString('base64')}`,
      decrypt: (enc) =>
        enc.startsWith('plain:')
          ? Buffer.from(enc.slice(6), 'base64').toString('utf8')
          : safeStorage.decryptString(Buffer.from(enc, 'base64')),
      openExternal: (url) => shell.openExternal(url),
      openPath: async (p) => void (await shell.openPath(p)),
      setLaunchAtLogin: (enabled, hidden) => {
        if (!app.isPackaged || demo) return
        app.setLoginItemSettings({ openAtLogin: enabled, args: hidden ? ['--hidden'] : [] })
      },
      notify: (title, body) => {
        if (Notification.isSupported()) new Notification({ title, body }).show()
      },
      emit: (event, payload) => {
        win?.webContents.send(IPC_EVENT_PREFIX + event, payload)
        if (event === 'state') tray?.update(payload as AppViewState)
      }
    })

    ipcMain.handle(IPC_INVOKE, async (_e, method: ApiMethod, ...args: unknown[]) => {
      if (!controller || !API_METHODS.includes(method)) throw new Error(`未知方法：${String(method)}`)
      const fn = controller[method] as (...a: unknown[]) => Promise<unknown>
      return fn.apply(controller, args)
    })

    await controller.init()
    if (demo && process.env.FLOWSYNC_DEMO_PRESET === 'ready') await seedReadyPreset(controller)
    if (demo && process.env.FLOWSYNC_DEMO_PRESET === 'blocked') await seedBlockedPreset(controller)

    tray = new AppTray(resourcesDir, {
      show: showWindow,
      syncNow: () => void controller?.syncNow(),
      pause: () => void controller?.pause(),
      resume: () => void controller?.resume(),
      switchWorkspace: (id) => void controller?.setActiveWorkspace(id),
      quit: () => {
        quitting = true
        app.quit()
      }
    })
    tray.update(await controller.getState())

    const shouldHide = startHidden && controller.config.get().onboarded
    if (!shouldHide) createWindow()

    powerMonitor.on('resume', () => void controller?.scheduler.syncNow())
    powerMonitor.on('unlock-screen', () => void controller?.scheduler.syncNow())
  })

  app.on('activate', () => showWindow())
  app.on('window-all-closed', () => {
    // 托盘常驻：关闭窗口不退出
  })
  app.on('before-quit', () => {
    quitting = true
    controller?.shutdown()
    tray?.destroy()
  })
}
