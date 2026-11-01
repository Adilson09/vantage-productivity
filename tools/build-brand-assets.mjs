// Deterministic platform-format preparation from the approved saddle mark.
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
const require = createRequire(new URL('./brand-assets/package.json', import.meta.url))
const sharp = require('sharp')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const master = path.join(root, 'docs/brand/vantage-saddle-mark.png')
const metadata = await sharp(master).metadata()
const { data, info } = await sharp(master).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
// Find substantial connected alpha components to ignore detached generation specks
// when choosing a crop. No recoloring or semantic artwork edits are performed.
const seen = new Uint8Array(info.width * info.height),
  components = []
for (let i = 0; i < seen.length; i++) {
  if (seen[i] || data[i * 4 + 3] < 128) continue
  const stack = [i]
  seen[i] = 1
  let count = 0,
    l = info.width,
    t = info.height,
    r = 0,
    b = 0
  while (stack.length) {
    const n = stack.pop(),
      x = n % info.width,
      y = Math.floor(n / info.width)
    count++
    l = Math.min(l, x)
    t = Math.min(t, y)
    r = Math.max(r, x)
    b = Math.max(b, y)
    for (const p of [
      x > 0 ? n - 1 : -1,
      x < info.width - 1 ? n + 1 : -1,
      y > 0 ? n - info.width : -1,
      y < info.height - 1 ? n + info.width : -1,
    ])
      if (p >= 0 && !seen[p] && data[p * 4 + 3] >= 128) {
        seen[p] = 1
        stack.push(p)
      }
  }
  if (count >= 1000) components.push({ count, l, t, r, b })
}
if (components.length < 1 || components.length > 4)
  throw Error('Unexpected saddle alpha components')
const left = Math.max(0, Math.min(...components.map((c) => c.l)) - 3),
  top = Math.max(0, Math.min(...components.map((c) => c.t)) - 3)
const right = Math.min(info.width - 1, Math.max(...components.map((c) => c.r)) + 3),
  bottom = Math.min(info.height - 1, Math.max(...components.map((c) => c.b)) + 3)
const crop = { left, top, width: right - left + 1, height: bottom - top + 1 }
const mark = await sharp(master)
  .extract(crop)
  .resize({ width: 820, height: 560, fit: 'inside', kernel: 'lanczos3' })
  .png()
  .toBuffer()
const m = await sharp(mark).metadata()
const tile = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect x="32" y="32" width="960" height="960" rx="188" fill="white"/></svg>',
)
const icon = await sharp(tile)
  .composite([
    { input: mark, left: Math.round((1024 - m.width) / 2), top: Math.round((1024 - m.height) / 2) },
  ])
  .png()
  .toBuffer()
const files = []
async function write(name, bytes) {
  await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true })
  await fs.writeFile(path.join(root, name), bytes)
  files.push({
    path: name,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  })
}
async function png(size) {
  return sharp(icon).resize(size, size, { kernel: 'lanczos3' }).png().toBuffer()
}
const sizes = [16, 20, 24, 32, 48, 64, 128, 256],
  images = await Promise.all(sizes.map(png))
const head = Buffer.alloc(6 + sizes.length * 16)
head.writeUInt16LE(1, 2)
head.writeUInt16LE(sizes.length, 4)
let offset = head.length
for (let i = 0; i < sizes.length; i++) {
  const at = 6 + i * 16
  head[at] = sizes[i] === 256 ? 0 : sizes[i]
  head[at + 1] = head[at]
  head.writeUInt16LE(1, at + 4)
  head.writeUInt16LE(32, at + 6)
  head.writeUInt32LE(images[i].length, at + 8)
  head.writeUInt32LE(offset, at + 12)
  offset += images[i].length
}
const ico = Buffer.concat([head, ...images])
const icnsChunks = []
for (const [type, size] of [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
]) {
  const image = await png(size),
    h = Buffer.alloc(8)
  h.write(type, 0, 4, 'ascii')
  h.writeUInt32BE(image.length + 8, 4)
  icnsChunks.push(h, image)
}
const icnsHead = Buffer.alloc(8)
icnsHead.write('icns', 0, 4, 'ascii')
icnsHead.writeUInt32BE(8 + icnsChunks.reduce((n, b) => n + b.length, 0), 4)
const icns = Buffer.concat([icnsHead, ...icnsChunks])
const svg = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><image width="1024" height="1024" href="data:image/png;base64,${icon.toString('base64')}"/></svg>`,
)
await write('docs/brand/vantage-app-icon.png', icon)
for (const base of ['apps/shell/build', 'apps/docs/build']) {
  await write(`${base}/icon.png`, icon)
  await write(`${base}/icon-mac.png`, icon)
  await write(`${base}/icon.ico`, ico)
  await write(`${base}/icon.icns`, icns)
}
await write('apps/shell/build/vantage.ico', ico)
await write('apps/shell/build/vantage.png', icon)
await write('apps/shell/build/vantage.svg', svg)
for (const size of [16, 32, 48, 64, 128, 256, 512, 1024])
  await write(`apps/shell/build/icons/${size}x${size}.png`, await png(size))
await write('apps/shell/src/renderer/src/assets/vantage-mark.png', await png(128))
await write('apps/shell/src/renderer/src/assets/vantage-logo.svg', svg)
for (const app of ['shell', 'docs', 'sheets', 'slides']) {
  const file = `apps/${app}/src/renderer/${app === 'shell' ? 'src/' : ''}assets/app-icon.png`
  await write(file, await png(256))
}
await write(
  'docs/brand/asset-manifest.json',
  Buffer.from(
    JSON.stringify(
      {
        source: 'User-provided Vantage Productivity saddle point logo.png',
        originalPreserved: 'docs/brand/vantage-logo-original.png',
        symbolMaster: 'docs/brand/vantage-saddle-mark.png',
        symbolPreparation:
          'Built-in image generation: remove lettering/background while preserving the saddle symbol; platform outputs use deterministic resizing and a clean white rounded tile.',
        inputDimensions: { width: metadata.width, height: metadata.height },
        crop,
        components,
        platformAcceptance:
          'Windows x64 preview checked separately; generated macOS/Linux formats do not establish platform release acceptance',
        files,
      },
      null,
      2,
    ) + '\n',
  ),
)
console.log(
  JSON.stringify({
    files: files.length,
    crop,
    components: components.length,
    icoFrames: sizes,
    iconSize: 1024,
  }),
)
