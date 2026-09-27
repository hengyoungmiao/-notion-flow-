import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DidaCliReader } from '../../src/core/adapters/dida'
import { NtnNotionClient } from '../../src/core/adapters/notion'

const root = resolve(__dirname, '../..')
const didaScript = join(root, 'node_modules/@suibiji/dida-cli/dist/index.js')
const platformDir = `ntn-${process.platform === 'win32' ? 'win32' : process.platform}-${process.arch}`
const ntnBin = join(root, 'node_modules/ntn/dist', platformDir, process.platform === 'win32' ? 'ntn.exe' : 'ntn')

// 契约测试：确认两个官方 CLI 在“未登录”时的错误格式能被正确识别（不需要网络/账号）
describe('CLI contracts', () => {
  it('dida-cli reports missing login as an auth error', async () => {
    const home = mkdtempSync(join(tmpdir(), 'flowsync-dida-'))
    const reader = new DidaCliReader({
      command: process.execPath,
      baseArgs: [didaScript],
      env: { HOME: home, USERPROFILE: home }
    })
    await expect(reader.listProjects()).rejects.toMatchObject({ tool: 'dida', kind: 'auth' })
    expect(await reader.verifyAuth()).toBe(false)
  })

  it.skipIf(!existsSync(ntnBin))('ntn reports missing login as an auth error', async () => {
    const home = mkdtempSync(join(tmpdir(), 'flowsync-ntn-'))
    const client = new NtnNotionClient({ command: ntnBin, notionHome: home, env: { NOTION_KEYRING: '0' } })
    await expect(client.whoami()).rejects.toMatchObject({ tool: 'ntn', kind: 'auth' })
  })
})
