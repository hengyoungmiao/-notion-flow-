import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import electronPath from 'electron'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(__dirname, '../..')
const shots = join(root, 'e2e-screenshots')
mkdirSync(shots, { recursive: true })

async function launch(preset?: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    executablePath: electronPath as unknown as string,
    args: [join(root, 'out/main/index.js'), '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, FLOWSYNC_FAKE: '1', ...(preset ? { FLOWSYNC_DEMO_PRESET: preset } : {}) }
  })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1180, height: 780 })
  return { app, page }
}

const shot = (page: Page, name: string) => page.screenshot({ path: join(shots, `${name}.png`) })

test('首次设置向导（演示模式）', async () => {
  const { app, page } = await launch()
  await expect(page.getByText('欢迎使用 FlowSync')).toBeVisible()
  await expect(page.getByText('0.23.10（演示）')).toBeVisible()
  await shot(page, '01-welcome')
  await page.getByRole('button', { name: '下一步' }).click()

  await expect(page.getByRole('button', { name: '浏览器授权登录' })).toBeVisible()
  await shot(page, '02-dida-login')
  await page.getByRole('button', { name: '浏览器授权登录' }).click()
  await expect(page.getByText('滴答清单已登录。')).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: '下一步' }).click()

  await page.getByRole('button', { name: '下一步' }).first().click()
  await expect(page.getByRole('button', { name: '登录 Notion' })).toBeVisible()
  await shot(page, '03-notion-login')
  await page.getByRole('button', { name: '登录 Notion' }).click()
  await expect(page.getByText('DEMO-123')).toBeVisible()
  await shot(page, '04-notion-code')
  await expect(page.getByText('符合 FLO.W 任务库结构')).toBeVisible({ timeout: 10_000 })
  await shot(page, '05-find-db')
  await page.getByRole('button', { name: '使用选中的数据库' }).click()
  await expect(page.getByText('需要在任务库中新增一个「滴答ID」文本字段')).toBeVisible()
  await shot(page, '06-dida-id-field')
  await page.getByRole('button', { name: '添加字段' }).click()
  await expect(page.getByText('任务库：FLO.W - 我的任务 DB · Max')).toBeVisible()
  await page.getByRole('button', { name: '下一步' }).click()

  await expect(page.getByText('产品开发').first()).toBeVisible()
  await shot(page, '07-mapping')
  await page.getByRole('button', { name: '下一步' }).click()
  await expect(page.getByText('同步收件箱里的任务')).toBeVisible()
  await shot(page, '08-scope')
  await page.getByRole('button', { name: '下一步' }).click()

  await expect(page.getByText('首次同步预览')).toBeVisible()
  await expect(page.getByText('关联已有任务')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('番茄记录')).toBeVisible()
  await expect(page.getByText(/个任务会按标签关联到 FLO.W 项目/)).toBeVisible()
  await shot(page, '09-preview')
  await page.getByRole('button', { name: /备份并开始首次同步/ }).click()
  await expect(page.getByText('首次同步完成')).toBeVisible({ timeout: 20_000 })
  await shot(page, '10-done')
  await page.getByRole('button', { name: '进入 FlowSync' }).click()
  await expect(page.getByRole('heading', { name: '概览' })).toBeVisible()
  await shot(page, '11-dashboard-after-setup')
  await app.close()
})

test('主界面各页面（演示模式，已配置）', async () => {
  const { app, page } = await launch('ready')
  await expect(page.getByRole('heading', { name: '概览' })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('同步正常').first()).toBeVisible({ timeout: 20_000 })
  await shot(page, '20-dashboard')

  await page.getByRole('menuitem', { name: '工作空间' }).click()
  await expect(page.getByText('公司空间', { exact: true })).toBeVisible()
  await shot(page, '21-workspaces')

  await page.getByRole('menuitem', { name: '领域映射' }).click()
  await expect(page.getByText('客户项目').first()).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('#v2.3版本发布')).toBeVisible()
  await expect(page.getByText('v2.3 版本发布', { exact: true })).toBeVisible()
  await shot(page, '22-mapping')

  await page.getByRole('menuitem', { name: '同步记录' }).click()
  await expect(page.getByText('首次同步完成').first()).toBeVisible()
  await expect(page.getByText('番茄钟 · 整理 v2.3 需求清单（25 分钟）').first()).toBeVisible()
  await shot(page, '23-activity')

  await page.getByRole('menuitem', { name: '设置' }).click()
  await expect(page.getByText('批量变更熔断')).toBeVisible()
  await shot(page, '24-settings')
  await app.close()
})

test('大批量删除触发熔断确认（演示模式）', async () => {
  const { app, page } = await launch('blocked')
  await expect(page.getByText('检测到大批量变更，已暂停等待你确认')).toBeVisible({ timeout: 30_000 })
  await shot(page, '30-breaker')
  await page.getByRole('button', { name: '确认并执行' }).click()
  await expect(page.getByText('同步正常').first()).toBeVisible({ timeout: 20_000 })
  await shot(page, '31-breaker-approved')
  await app.close()
})
