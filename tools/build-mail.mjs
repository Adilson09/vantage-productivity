// Aster Office addition (2026): build the pinned, isolated Windows mail companion.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('This companion build currently requires Windows x64 and the MSVC toolchain.')
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'companions', 'depesha')
const stage = path.join(root, 'companions', 'depesha-bin')
const npm = process.env.npm_execpath
if (!npm || !npm.endsWith('npm-cli.js')) throw new Error('Run this helper with npm run build:mail.')
// Cargo and Tauri use different working directories; share one absolute target.
const target = path.resolve(
  process.cwd(),
  process.env.CARGO_TARGET_DIR || path.join(source, 'target'),
)
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        ![
          'RUSTFLAGS',
          'CARGO_ENCODED_RUSTFLAGS',
          'CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS',
          'CARGO_TARGET_DIR',
        ].includes(name.toUpperCase()),
    ),
  ),
  CARGO_TARGET_DIR: target,
  CARGO_BUILD_JOBS: '2',
  CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS: '-C target-feature=+crt-static',
}
async function run(args) {
  const child = spawn(process.execPath, [npm, ...args], {
    cwd: source,
    env,
    stdio: 'inherit',
    windowsHide: true,
  })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  if (code !== 0) throw new Error(`Mail build step failed (${code}): npm ${args.join(' ')}`)
}
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const notices = await fs.readFile(path.join(source, 'THIRD-PARTY-NOTICES.txt'))
if (notices.length < 10000)
  throw new Error('Mail dependency notices must be generated before building.')
const dependencies = Object.fromEntries(
  await Promise.all(
    ['Cargo.lock', 'package-lock.json'].map(async (name) => [
      name,
      hash(await fs.readFile(path.join(source, name))),
    ]),
  ),
)
// The source archive retains the exact dependency notice texts for its locked versions.
const coverage = JSON.parse(await fs.readFile(path.join(source, 'ASTER_NOTICE_LOCKS.json'), 'utf8'))
for (const [name, sha256] of Object.entries(dependencies)) {
  if (coverage[name] !== sha256)
    throw new Error(`${name} changed: regenerate and review Mail dependency notices.`)
}
await run(['ci'])
await run(['run', 'check'])
await run([
  'run',
  'tauri',
  '--',
  'build',
  '--no-bundle',
  '--ci',
  '--target',
  'x86_64-pc-windows-msvc',
  '--',
  '--locked',
  '--jobs',
  '2',
])
const executable = path.join(target, 'x86_64-pc-windows-msvc', 'release', 'aster-mail.exe')
const bytes = await fs.readFile(executable)
await fs.mkdir(stage, { recursive: true })
await fs.writeFile(path.join(stage, 'aster-mail.exe'), bytes)
await fs.writeFile(path.join(stage, 'THIRD-PARTY-NOTICES.txt'), notices)
await fs.writeFile(
  path.join(stage, 'ASTER_MAIL_BUILD.json'),
  JSON.stringify(
    {
      product: 'Aster Mail',
      version: '0.8.17',
      upstream: 'https://github.com/fgbm/depesha',
      commit: 'd3c3a2b63cc9a1e194aa3ed3842d8d3fd0f2e0b4',
      identifier: 'org.asteroffice.mail',
      binary: 'aster-mail.exe',
      sha256: hash(bytes),
      bytes: bytes.length,
      dependencies,
      target: 'x86_64-pc-windows-msvc',
      staticCrt: true,
      updater: false,
      e2eFeature: false,
      builtAt: new Date().toISOString(),
      validation: 'Source compilation only; run the desktop acceptance checks separately.',
    },
    null,
    2,
  ),
)
console.log(`Mail companion staged in ${stage}`)
