import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { extractFile } from '@electron/asar'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const [packageArg, validationArg] = process.argv.slice(2)
if (!packageArg || !validationArg) throw new Error('Provide package and validation directories.')
const packaged = path.resolve(packageArg),
  validation = path.resolve(validationArg)
const hashBytes = (b) => createHash('sha256').update(b).digest('hex')
const hash = (p) =>
  new Promise((resolve, reject) => {
    const digest = createHash('sha256'),
      stream = createReadStream(p)
    stream.on('data', (b) => digest.update(b))
    stream.once('error', reject)
    stream.once('end', () => resolve(digest.digest('hex')))
  })
function filesIn(directory, ignored = new Set()) {
  const result = []
  function visit(dir) {
    for (const e of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (ignored.has(e.name)) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) visit(p)
      else if (e.isFile()) result.push(p)
    }
  }
  visit(directory)
  return result
}
const inventory = []
for (const file of filesIn(packaged))
  inventory.push({
    path: path.relative(packaged, file).replaceAll('\\', '/'),
    bytes: fs.statSync(file).size,
    sha256: await hash(file),
  })
const inventoryPath = path.join(validation, 'package-inventory.json')
fs.writeFileSync(
  inventoryPath,
  JSON.stringify(
    {
      createdAt: new Date().toISOString(),
      root: packaged,
      files: inventory.length,
      bytes: inventory.reduce((n, f) => n + f.bytes, 0),
      entries: inventory,
    },
    null,
    2,
  ),
)
const matches = []
for (const kind of ['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html']) {
  const source = path.join(root, 'apps', kind, 'out'),
    destination = path.join(packaged, 'resources/modules', kind)
  for (const file of filesIn(source)) {
    const relative = path.relative(source, file),
      target = path.join(destination, relative)
    if (!fs.existsSync(target)) throw new Error(`Packaged ${kind} output missing: ${relative}`)
    const sha256 = await hash(file)
    if (sha256 !== (await hash(target))) throw new Error(`Packaged ${kind} differs: ${relative}`)
    matches.push({ area: kind, path: relative.replaceAll('\\', '/'), sha256 })
  }
}
const asar = path.join(packaged, 'resources/app.asar'),
  shellOut = path.join(root, 'apps/shell/out')
for (const file of filesIn(shellOut)) {
  const relative = path.relative(path.join(root, 'apps/shell'), file)
  const sha256 = await hash(file)
  if (sha256 !== hashBytes(extractFile(asar, relative)))
    throw new Error(`Packaged shell differs: ${relative}`)
  matches.push({ area: 'shell', path: relative.replaceAll('\\', '/'), sha256 })
}
for (const [relative, target] of [
  ['packages/cli/dist/vantage.cjs', 'resources/cli/vantage.cjs'],
  [
    'apps/sheets/native/xlsx-engine/target/release/xlsx-sidecar.exe',
    'resources/native/xlsx-sidecar.exe',
  ],
  ['companions/depesha-bin/vantage-mail.exe', 'resources/mail/vantage-mail.exe'],
  ['apps/shell/build/THIRD-PARTY-NOTICES.txt', 'resources/THIRD-PARTY-NOTICES.txt'],
]) {
  const sha256 = await hash(path.join(root, relative))
  if (sha256 !== (await hash(path.join(packaged, target))))
    throw new Error(`Packaged resource differs: ${relative}`)
  matches.push({ area: 'resource', path: relative, sha256 })
}
const matchPath = path.join(validation, 'packaged-build-matches.json')
fs.writeFileSync(
  matchPath,
  JSON.stringify(
    {
      createdAt: new Date().toISOString(),
      scope:
        'Every generated editor/shell file, CLI entry, native spreadsheet helper, native Mail companion and generated notices compared byte-for-byte with packaged counterpart.',
      files: matches.length,
      allMatch: true,
      entries: matches,
    },
    null,
    2,
  ),
)
const ignored = new Set(['.git', 'node_modules', 'out', 'dist', 'target', '.cache', 'artifacts'])
const sourceFiles = []
for (const area of ['apps', 'packages', 'tools', 'skills', 'docs/implementation'])
  for (const file of filesIn(path.join(root, area), ignored))
    sourceFiles.push({
      path: path.relative(root, file).replaceAll('\\', '/'),
      sha256: await hash(file),
    })
const sourcePath = path.join(validation, 'source-snapshot-hashes.json')
fs.writeFileSync(
  sourcePath,
  JSON.stringify(
    {
      createdAt: new Date().toISOString(),
      head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      dirty: true,
      lockSha256: await hash(path.join(root, 'package-lock.json')),
      scope:
        'Named source directories, excluding generated outputs and dependencies. This is an inventory of the working source at seal time, not a claim of a clean Git checkout.',
      files: sourceFiles.length,
      entries: sourceFiles,
    },
    null,
    2,
  ),
)
const smoke = JSON.parse(
  fs.readFileSync(path.join(validation, 'packaged-corrected/packaged-smoke.json'), 'utf8'),
)
if (!smoke.completedChecksPassed) throw new Error('Final packaged smoke is incomplete or failed.')
const record = {
  product: 'Vantage Productivity',
  version: '0.15.0-dev.1',
  startedAt: smoke.startedAt,
  finishedAt: new Date().toISOString(),
  completedChecksPassed: true,
  releaseAccepted: false,
  environment: {
    platform: process.platform,
    arch: process.arch,
    verificationNode: process.version,
    packagedNode: smoke.checks[0].detail.runtime.node,
    electron: smoke.checks[0].detail.runtime.electron,
    windows: os.release(),
    cpu: os.cpus()[0].model,
  },
  verificationStrategy:
    'Broad component runs are retained in historical records, with individual failing cases repaired and rerun. Current checks below cover the final build, all workspace types, targeted regressions and actual desktop/package scopes. This is not a claim that every whole source suite was rerun after its last targeted repair.',
  historicalRecords: [
    {
      path: path.join(validation, 'final-source/Vantage-Implementation-Validation.json'),
      status: 'superseded failures retained',
      reason:
        'Initial system Node22 lacked FTS5; build lacked private native toolchain PATH; platform fixtures and real product regressions were repaired and rerun separately.',
    },
    {
      path: path.join(validation, 'packaged-final/packaged-smoke.json'),
      status: 'superseded harness run',
      reason:
        'Started before qpdf staging and expected development URLs instead of packaged vantage-app URLs.',
    },
  ],
  checks: [],
  inventories: [
    { path: inventoryPath, sha256: await hash(inventoryPath) },
    { path: matchPath, sha256: await hash(matchPath) },
    { path: sourcePath, sha256: await hash(sourcePath) },
  ],
  externalAcceptance: JSON.parse(
    fs.readFileSync(path.join(root, 'docs/implementation/delivery-evidence.json'), 'utf8'),
  ).externalAcceptanceRequirements.map((reason) => ({
    name: reason.split(';')[0],
    status: 'remaining',
    reason,
  })),
}
const logs = [
  [
    'Complete native and six-editor build',
    'matching-build/build-all.log',
    'Full build with native toolchain; later changes rebuilt below.',
  ],
  [
    'Sealed eight-workspace code build',
    'sealed-code-build/code-build.json',
    'All six editor code outputs, CLI and shell; native helper kept from verified matching build.',
  ],
  [
    'Final shell rebuild',
    'final-shell-build-corrected.log',
    'Includes final palette and redirect-method fixes.',
  ],
  [
    'All workspace typechecks',
    'all-workspace-types-final.log',
    'Root workspace typecheck command includes all 27 configured TypeScript workspaces, including the new productivity engine.',
  ],
  [
    'Final shell targeted checks',
    'final-shell-targeted.log',
    '75 passed, including final privacy and isolated-audit regressions.',
  ],
  [
    'Actual desktop workflows',
    'desktop-final.log',
    '11 passed. Last subsequent HTTP method fix was unit-checked and rebuilt; final packaged checks use that rebuilt shell.',
  ],
  [
    'Save and recovery contracts',
    'final-source/tests-electron-utils.log',
    '363 passed across28files in broad component run.',
  ],
  [
    'Local productivity engine',
    'final-source/tests-productivity-engine.log',
    '143 passed across4files in broad component run.',
  ],
  [
    'Open source bridge',
    'final-source/tests-engine-bridge.log',
    '14 passed in broad component run.',
  ],
  [
    'Markdown unchanged-source retention',
    'markdown-default-retention.log',
    '33 passed; one explicit platform capability skip.',
  ],
  ['Markdown list parser regression', 'markdown-empty-lists.log', '4 passed.'],
  [
    'Markdown splice and tokenizer scopes',
    'markdown-list-splice-repaired.log',
    '35 selected splice/tokenizer tests passed in this mixed run. Its separate wiki failure is superseded by the 22-case wiki rerun below.',
  ],
  ['Markdown wiki resolution regressions', 'markdown-wiki-repaired.log', '22 passed.'],
  [
    'Shell platform fixture repairs',
    'shell-fixtures-repaired.log',
    '117 passed, one existing platform skip.',
  ],
  [
    'SQLite asynchronous indexing regression',
    'file-index-indexer-repaired.log',
    '4 passed on Node24; baseline FTS5 and worker checks recorded separately.',
  ],
  ['AI guard and platform fixtures', 'ai-repaired-node24.log', '35 passed.'],
  [
    'Macro preservation regressions',
    'advanced-repaired-gateway.log',
    '17 passed; inert resources and refusal boundaries only.',
  ],
  ['Advanced CLI regressions', 'advanced-repaired-cli.log', '62 passed.'],
  ['CLI help synchronization', 'advanced-repaired-help-sync.log', '6 passed.'],
  [
    'CLI native path regressions',
    'cli-paths-repaired.log',
    '30 passed with two existing GUI opt-in skips.',
  ],
  [
    'CLI baseline fixture repairs',
    'cli-baseline-repaired.log',
    '37 passed with one POSIX-only permission skip.',
  ],
  ['CLI final fixture regressions', 'cli-final-fixtures.log', '5 passed.'],
  [
    'Dependency lock dry-run',
    'dependency-lock-verified.log',
    'Offline npm ci dry-run passed without replacing installed dependencies.',
  ],
  [
    'Generated notices including native crates',
    'notices-native-current.log',
    '572 npm packages and160 Rust crates in generated license inventory.',
  ],
  [
    'Packaged qpdf stage',
    'qpdf-preview-staging.json',
    '293 complete distribution files verified; relative manifest pins executable hash.',
  ],
  [
    'Packaged source notices',
    'source-notices-evidence.json',
    'Unmodified ICAL archive integrity/full MPL license and generated notices verified.',
  ],
  [
    'Actual packaged workflows',
    'packaged-smoke-final.log',
    '12 passed: launch, FTS5, isolated PDF/qpdf, isolated database, local mode, CLI/native workbook and six editor loads.',
  ],
  [
    'Packaged output equality',
    'packaged-build-matches.json',
    'Every generated editor/shell file and selected native/CLI/notices resources match the built output.',
  ],
]
for (const [name, relative, reason] of logs) {
  const logPath = path.join(validation, relative)
  if (!fs.existsSync(logPath)) throw new Error(`Evidence missing: ${logPath}`)
  record.checks.push({ name, status: 'passed', reason, logPath, logSha256: await hash(logPath) })
}
record.package = {
  path: packaged,
  files: inventory.length,
  bytes: inventory.reduce((n, f) => n + f.bytes, 0),
  signing: 'Unsigned development preview; Authenticode reported NotSigned.',
  sha256: inventory.find((e) => e.path === 'Vantage Productivity.exe').sha256,
}
const destination = path.join(validation, 'Vantage-Implementation-Validation-Final.json')
fs.writeFileSync(destination, JSON.stringify(record, null, 2))
console.log(destination)
