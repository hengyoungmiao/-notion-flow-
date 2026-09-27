// 把命令行打包成单个 ESM 文件 dist/flowsync.mjs（dida-cli、ntn 运行时从 node_modules 查找）
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

await build({
  entryPoints: ['src/cli/bin.ts'],
  outfile: 'dist/flowsync.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['@suibiji/dida-cli', 'ntn'],
  define: { __FLOWSYNC_VERSION__: JSON.stringify(pkg.version) },
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
  },
  legalComments: 'none',
  logLevel: 'warning'
})
console.log(`built dist/flowsync.mjs (v${pkg.version})`)
