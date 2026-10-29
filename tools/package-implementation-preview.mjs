import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const [outputArg, logArg] = process.argv.slice(2)
if (!outputArg || !logArg)
  throw new Error('Usage: node tools/package-implementation-preview.mjs OUTPUT_DIRECTORY LOG_FILE')
const output = path.resolve(outputArg),
  logPath = path.resolve(logArg)
fs.mkdirSync(output, { recursive: true })
fs.mkdirSync(path.dirname(logPath), { recursive: true })
const fd = fs.openSync(logPath, 'w')
const args = [
  path.join(root, 'node_modules/electron-builder/cli.js'),
  '--win',
  '--dir',
  '--x64',
  '--publish',
  'never',
  `-c.electronDist=${path.join(root, 'node_modules/electron/dist')}`,
]
const code = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, {
    cwd: path.join(root, 'apps/shell'),
    windowsHide: true,
    shell: false,
    env: {
      ...process.env,
      BUILD_DIR: output,
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      CSC_LINK: '',
      WIN_CSC_LINK: '',
      VANTAGE_WIN_SIGN_MODE: '',
      VANTAGE_UPDATE_URL: '',
      VANTAGE_FONT_CDN_URL: '',
      NODE_OPTIONS: '--max-old-space-size=2048',
    },
    stdio: ['ignore', fd, fd],
  })
  child.once('error', reject)
  child.once('close', resolve)
}).finally(() => fs.closeSync(fd))
console.log(`Package: ${code === 0 ? 'passed' : 'failed'}`)
if (code !== 0) {
  console.error(fs.readFileSync(logPath, 'utf8').slice(-5000))
  process.exitCode = 1
}
