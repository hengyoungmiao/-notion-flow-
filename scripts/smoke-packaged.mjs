// 打包产物冒烟测试：用与应用相同的方式（spawn + ELECTRON_RUN_AS_NODE）调用内置 CLI
// 用法：node scripts/smoke-packaged.mjs <unpacked 目录>
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2]
if (!dir) throw new Error('缺少打包目录参数')
const win = process.platform === 'win32'
const exe = join(dir, win ? 'FlowSync.exe' : process.platform === 'darwin' ? 'FlowSync.app/Contents/MacOS/FlowSync' : 'flowsync')
const res = join(dir, 'resources')
const ntn = join(res, 'bin', win ? 'ntn.exe' : 'ntn')
const dida = join(res, 'app.asar.unpacked', 'node_modules', '@suibiji', 'dida-cli', 'dist', 'index.js')

for (const p of [exe, ntn, dida, join(res, 'resources', 'tray-ok.png')]) {
  if (!existsSync(p)) {
    console.error(`缺少文件：${p}`)
    process.exit(1)
  }
}

const run = (cmd, args, env = {}) => {
  const r = spawnSync(cmd, args, { env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true, timeout: 60_000 })
  return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}

const n = run(ntn, ['--version'])
console.log('ntn:', n.out, n.err)
if (n.code !== 0 || !n.out.includes('0.23.10')) process.exit(1)

const d = run(exe, [dida, '--version'], { ELECTRON_RUN_AS_NODE: '1' })
console.log('dida-cli:', d.out, d.err)
if (d.code !== 0 || d.out !== '0.1.14') process.exit(1)

console.log('打包产物冒烟测试通过')
