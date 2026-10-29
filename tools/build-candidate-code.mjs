/** Rebuild application code against a previously verified native/dependency build. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const [previousPath, destination] = process.argv.slice(2)
if (!previousPath || !destination)
  throw new Error(
    'Usage: node tools/build-candidate-code.mjs PREVIOUS_SUCCESSFUL_BUILD_JSON OUTPUT_DIRECTORY',
  )
const previous = JSON.parse(fs.readFileSync(previousPath, 'utf8'))
if (!previous.checks?.some((check) => check.name === 'build-all' && check.status === 'passed'))
  throw new Error('A completed full native/dependency build is required first.')
const hashFile = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const native = previous.artifacts.find((item) => item.path.endsWith('xlsx-sidecar.exe'))
if (!native?.sha256 || hashFile(path.join(root, native.path)) !== native.sha256)
  throw new Error('Native helper changed; run the complete build first.')
const lock = previous.artifacts.find((item) => item.path === 'package-lock.json')
if (!lock?.sha256 || hashFile(path.join(root, lock.path)) !== lock.sha256)
  throw new Error('Dependency lock changed; run the complete build first.')
const runtimeDeps = path.join(root, 'packages/cli/dist/node_modules')
const installedJsdom = JSON.parse(
  fs.readFileSync(path.join(root, 'node_modules/jsdom/package.json')),
)
const copiedJsdom = JSON.parse(fs.readFileSync(path.join(runtimeDeps, 'jsdom/package.json')))
if (installedJsdom.version !== copiedJsdom.version)
  throw new Error('CLI external dependencies changed; run its complete build first.')
function treeDigest(directory, sourceOnly = false) {
  const entries = []
  const walk = (dir) => {
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (
        sourceOnly &&
        [
          'node_modules',
          'out',
          'dist',
          'target',
          '.git',
          'release',
          'build',
          '.cache',
          '.vite',
        ].includes(entry.name)
      )
        continue
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (
        entry.isFile() &&
        (!sourceOnly || /\.(ts|tsx|mjs|cjs|js|css|json|toml|rs|html)$/.test(entry.name))
      )
        entries.push([path.relative(directory, file).replaceAll('\\', '/'), hashFile(file)])
    }
  }
  walk(directory)
  return {
    files: entries.length,
    sha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
  }
}
const out = path.resolve(destination)
fs.mkdirSync(out, { recursive: true })
const before = {
  apps: treeDigest(path.join(root, 'apps'), true),
  packages: treeDigest(path.join(root, 'packages'), true),
}
// The external tree is reused without deleting/copying thousands of unchanged files.
const dependencyTree = treeDigest(runtimeDeps)
const report = {
  startedAt: new Date().toISOString(),
  finishedAt: null,
  node: process.version,
  previousBuild: path.resolve(previousPath),
  nativeSha256: native.sha256,
  lockSha256: lock.sha256,
  dependencyTree,
  source: before,
  checks: [],
  success: false,
  artifacts: [],
}
const save = () =>
  fs.writeFileSync(path.join(out, 'code-build.json'), JSON.stringify(report, null, 2) + '\n')
const jobs = [
  ...['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html'].map((name) => ({
    name,
    cwd: path.join(root, 'apps', name),
    args: [path.join(root, 'node_modules/electron-vite/bin/electron-vite.js'), 'build'],
  })),
  { name: 'cli', cwd: root, args: ['packages/cli/build.mjs'] },
  {
    name: 'shell',
    cwd: path.join(root, 'apps/shell'),
    args: [path.join(root, 'node_modules/electron-vite/bin/electron-vite.js'), 'build'],
  },
]
for (const job of jobs) {
  const logPath = path.join(out, `${job.name}.log`),
    fd = fs.openSync(logPath, 'w'),
    started = Date.now()
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, job.args, {
      cwd: job.cwd,
      windowsHide: true,
      shell: false,
      env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=2048' },
      stdio: ['ignore', fd, fd],
    })
    child.once('error', reject)
    child.once('close', resolve)
  }).finally(() => fs.closeSync(fd))
  report.checks.push({
    name: job.name,
    exitCode: code,
    status: code === 0 ? 'passed' : 'failed',
    durationMs: Date.now() - started,
    logPath,
    logSha256: hashFile(logPath),
  })
  save()
  console.log(`${job.name}: ${code === 0 ? 'passed' : 'failed'}`)
  if (code !== 0) {
    process.exitCode = 1
    break
  }
}
const after = {
  apps: treeDigest(path.join(root, 'apps'), true),
  packages: treeDigest(path.join(root, 'packages'), true),
}
report.sourceChangedDuringBuild = JSON.stringify(before) !== JSON.stringify(after)
report.sourceAfter = after
report.finishedAt = new Date().toISOString()
report.success =
  report.checks.length === jobs.length &&
  report.checks.every((check) => check.exitCode === 0) &&
  !report.sourceChangedDuringBuild
for (const name of ['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html', 'shell', 'cli']) {
  const relative =
    name === 'cli' ? 'packages/cli/dist/vantage.cjs' : `apps/${name}/out/main/index.js`
  report.artifacts.push({ path: relative, sha256: hashFile(path.join(root, relative)) })
}
save()
if (!report.success) process.exitCode = 1
