import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 打包产物冒烟测试（真实模式，不登录）：确认内置 ntn 与 dida-cli 能在打包路径下被找到并运行
const packaged = process.env.FLOWSYNC_PACKAGED_APP

test.skip(!packaged, '设置 FLOWSYNC_PACKAGED_APP 指向打包后的可执行文件')

test('打包后的应用能找到内置 CLI', async () => {
  const home = mkdtempSync(join(tmpdir(), 'flowsync-home-'))
  const app = await electron.launch({
    executablePath: packaged!,
    args: ['--no-sandbox', '--disable-gpu', `--user-data-dir=${join(home, 'userdata')}`],
    env: { ...process.env, HOME: home, USERPROFILE: home, FLOWSYNC_FAKE: '' }
  })
  const page = await app.firstWindow()
  await expect(page.getByText('欢迎使用 FlowSync')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('0.23.10')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('0.1.14')).toBeVisible()
  await page.screenshot({ path: join(__dirname, '../../e2e-screenshots/40-packaged-welcome.png') })
  await app.close()
})
