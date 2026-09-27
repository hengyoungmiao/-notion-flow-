// 生成自带 Node 运行时的 Linux 发布包：release/flowsync-linux-<arch>.tar.gz
//   flowsync/bin/flowsync       启动脚本
//   flowsync/node/bin/node      Node 运行时
//   flowsync/app/               程序（dist/flowsync.mjs）+ 生产依赖（dida-cli、ntn 当前架构的二进制）
// 用法：node scripts/package.mjs [--arch x64|arm64] [--node v22.22.2]
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : def
}
const arch = opt('arch', process.arch === 'arm64' ? 'arm64' : 'x64')
const nodeVersion = opt('node', 'v22.22.2')
const root = resolve(import.meta.dirname, '..')
const out = join(root, 'release')
const stage = join(out, `stage-${arch}`, 'flowsync')
const run = (cmd, argv, cwd = root) => execFileSync(cmd, argv, { cwd, stdio: 'inherit' })

if (!existsSync(join(root, 'dist', 'flowsync.mjs'))) run('node', ['scripts/build.mjs'])
rmSync(join(out, `stage-${arch}`), { recursive: true, force: true })
mkdirSync(join(stage, 'bin'), { recursive: true })
mkdirSync(join(stage, 'app', 'dist'), { recursive: true })

// 程序 + 生产依赖
cpSync(join(root, 'dist', 'flowsync.mjs'), join(stage, 'app', 'dist', 'flowsync.mjs'))
cpSync(join(root, 'package.json'), join(stage, 'app', 'package.json'))
cpSync(join(root, 'package-lock.json'), join(stage, 'app', 'package-lock.json'))
run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], join(stage, 'app'))
// 只保留目标架构的 ntn 二进制
const ntnDist = join(stage, 'app', 'node_modules', 'ntn', 'dist')
for (const d of readdirSync(ntnDist)) if (d.startsWith('ntn-') && d !== `ntn-linux-${arch}`) rmSync(join(ntnDist, d), { recursive: true, force: true })
if (!existsSync(join(ntnDist, `ntn-linux-${arch}`, 'ntn'))) throw new Error(`ntn 没有 linux-${arch} 版本`)
chmodSync(join(ntnDist, `ntn-linux-${arch}`, 'ntn'), 0o755)

// Node 运行时
const cache = join(out, 'cache')
mkdirSync(cache, { recursive: true })
const nodeName = `node-${nodeVersion}-linux-${arch}`
const nodeTar = join(cache, `${nodeName}.tar.xz`)
if (!existsSync(nodeTar)) run('curl', ['-fsSL', '-o', nodeTar, `https://nodejs.org/dist/${nodeVersion}/${nodeName}.tar.xz`])
run('tar', ['-xJf', nodeTar, '-C', cache])
mkdirSync(join(stage, 'node', 'bin'), { recursive: true })
cpSync(join(cache, nodeName, 'bin', 'node'), join(stage, 'node', 'bin', 'node'))
cpSync(join(cache, nodeName, 'LICENSE'), join(stage, 'node', 'LICENSE'))
chmodSync(join(stage, 'node', 'bin', 'node'), 0o755)

// 启动脚本
writeFileSync(
  join(stage, 'bin', 'flowsync'),
  `#!/bin/sh
# FlowSync 启动脚本：使用自带的 Node 运行
DIR="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
exec "$DIR/node/bin/node" "$DIR/app/dist/flowsync.mjs" "$@"
`
)
chmodSync(join(stage, 'bin', 'flowsync'), 0o755)

const tarball = join(out, `flowsync-linux-${arch}.tar.gz`)
rmSync(tarball, { force: true })
run('tar', ['-czf', tarball, '-C', join(out, `stage-${arch}`), 'flowsync'])
console.log(`打包完成：${tarball}`)
