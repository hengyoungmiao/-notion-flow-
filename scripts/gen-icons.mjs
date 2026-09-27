// 生成应用图标与托盘图标（纯 Node，无依赖）：node scripts/gen-icons.mjs
import { writeFileSync, mkdirSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function png(size, pixel) {
  const SS = 4
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const [pr, pg, pb, pa] = pixel((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size)
          r += pr * pa; g += pg * pa; b += pb * pa; a += pa
        }
      const o = y * (size * 4 + 1) + 1 + x * 4
      const n = SS * SS
      raw[o] = a ? Math.round(r / a) : 0
      raw[o + 1] = a ? Math.round(g / a) : 0
      raw[o + 2] = a ? Math.round(b / a) : 0
      raw[o + 3] = Math.round((a / n) * 255)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

const inRoundRect = (x, y, m, r) => {
  const cx = Math.min(Math.max(x, m + r), 1 - m - r)
  const cy = Math.min(Math.max(y, m + r), 1 - m - r)
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
}
// 向右的箭头（滴答 → Notion）
const inArrow = (x, y) => {
  const shaft = x >= 0.26 && x <= 0.6 && Math.abs(y - 0.5) <= 0.075
  const head = x >= 0.55 && x <= 0.78 && Math.abs(y - 0.5) <= (0.78 - x) * 0.95
  return shaft || head
}
const inCheckDot = (x, y) => (x - 0.3) ** 2 + (y - 0.5) ** 2 <= 0.012

const lerp = (a, b, t) => Math.round(a + (b - a) * t)
const app = png(512, (x, y) => {
  if (!inRoundRect(x, y, 0.04, 0.2)) return [0, 0, 0, 0]
  if (inArrow(x, y) || inCheckDot(x, y)) return [255, 255, 255, 1]
  const t = (x + y) / 2
  return [lerp(79, 20, t), lerp(70, 184, t), lerp(229, 166, t), 1]
})
mkdirSync('resources', { recursive: true })
writeFileSync('resources/icon.png', app)

const tray = (rgb) =>
  png(32, (x, y) => {
    const d = (x - 0.5) ** 2 + (y - 0.5) ** 2
    if (d > 0.23) return [0, 0, 0, 0]
    if (inArrow(x, y)) return [255, 255, 255, 1]
    return [...rgb, 1]
  })
writeFileSync('resources/tray-ok.png', tray([22, 163, 74]))
writeFileSync('resources/tray-paused.png', tray([120, 128, 140]))
writeFileSync('resources/tray-error.png', tray([220, 38, 38]))
console.log('icons written')
