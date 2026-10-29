import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { _electron as electron } from '@playwright/test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const [packageArg, outputArg] = process.argv.slice(2)
if (!packageArg || !outputArg) throw new Error('Provide unpacked package and evidence directories.')
const packaged = path.resolve(packageArg),
  output = path.resolve(outputArg)
await fs.mkdir(output, { recursive: true })
const scratch = await fs.mkdtemp(path.join(output, 'profile-'))
const executablePath = path.join(packaged, 'Vantage Productivity.exe')
const report = {
  startedAt: new Date().toISOString(),
  executablePath,
  scratch,
  scope:
    'Actual unsigned Windows package: launch and selected local workflow smoke. Editor checks prove load only, not full editing or interoperability acceptance.',
  checks: [],
}
const save = () =>
  fs.writeFile(path.join(output, 'packaged-smoke.json'), JSON.stringify(report, null, 2))
const step = async (name, fn) => {
  const started = Date.now()
  try {
    const detail = await fn()
    report.checks.push({ name, status: 'passed', durationMs: Date.now() - started, detail })
    console.log(`${name}: passed`)
    return detail
  } catch (e) {
    report.checks.push({
      name,
      status: 'failed',
      durationMs: Date.now() - started,
      error: String(e.stack || e),
    })
    console.log(`${name}: failed: ${e.message}`)
  } finally {
    await save()
  }
}
const require = createRequire(path.join(root, 'apps/shell/package.json'))
const { PDFDocument } = require('pdf-lib')
const pdf = await PDFDocument.create()
pdf.addPage([300, 300])
const pdfPath = path.join(scratch, 'sample.pdf')
await fs.writeFile(pdfPath, await pdf.save())
const sha = async (p) =>
  createHash('sha256')
    .update(await fs.readFile(p))
    .digest('hex')
const originalPdfSha = await sha(pdfPath)
await fs.writeFile(
  path.join(scratch, 'app-settings.json'),
  JSON.stringify({ onboardingSeen: true, defaultSaveDir: path.join(scratch, 'documents') }),
)
await fs.mkdir(path.join(scratch, 'documents'))
const { ELECTRON_RUN_AS_NODE, VANTAGE_ENGINE_MANIFEST, ...hostEnv } = process.env
const env = {
  ...hostEnv,
  TEMP: scratch,
  TMP: scratch,
  VANTAGE_USER_DATA: scratch,
  VANTAGE_AUTH_DIR: path.join(scratch, 'auth'),
  VANTAGE_LANG: 'en',
  VANTAGE_NO_SPARE_VIEW: '1',
  VANTAGE_ENGINE_TEMP_DIR: scratch,
}
let app, page
async function runNode(args) {
  return new Promise((resolve, reject) => {
    let stdout = '',
      stderr = ''
    const child = spawn(executablePath, args, {
      cwd: scratch,
      windowsHide: true,
      shell: false,
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('Packaged command exceeded 45 seconds.'))
    }, 45000)
    child.stdout.on('data', (b) => {
      stdout += b
      if (stdout.length > 2e6) child.kill('SIGKILL')
    })
    child.stderr.on('data', (b) => {
      stderr += b
      if (stderr.length > 2e6) child.kill('SIGKILL')
    })
    child.once('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      code === 0
        ? resolve({ stdout, stderr })
        : reject(new Error(`Exit ${code}: ${stderr.slice(-4000)} ${stdout.slice(-1000)}`))
    })
  })
}
try {
  await step('packaged-launch', async () => {
    app = await electron.launch({ executablePath, args: [], cwd: scratch, env, timeout: 45000 })
    const deadline = Date.now() + 45000
    while (Date.now() < deadline) {
      page = app.windows().find((p) => p.url().includes('app.asar/out/renderer/'))
      if (page) break
      await new Promise((r) => setTimeout(r, 200))
    }
    if (!page) throw new Error('Packaged shell page was not created.')
    await page
      .getByRole('button', { name: /Tools and privacy/ })
      .first()
      .waitFor({ timeout: 45000 })
    const status = await page.evaluate(() => window.vantage.engineeringStatus())
    if (status.version !== '0.15.0-dev.1') throw new Error(`Wrong version ${status.version}`)
    await page.screenshot({ path: path.join(output, 'packaged-home.png') })
    return status
  })
  if (!app || !page) throw new Error('Cannot run desktop checks without the packaged shell.')
  await step('packaged-sqlite-fts5', async () =>
    runNode([
      '-e',
      "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(':memory:');d.exec('CREATE VIRTUAL TABLE probe USING fts5(body)');console.log(JSON.stringify({node:process.versions.node,electron:process.versions.electron,fts5:true}));d.close() ",
    ]),
  )
  await step('packaged-inspection-child-and-qpdf', async () => {
    await app.evaluate(({ dialog }, p) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] })
    }, pdfPath)
    const audit = await page.evaluate(() => window.vantage.inspectFile())
    if (audit?.kind !== 'pdf' || audit.summary.failed) throw new Error(JSON.stringify(audit))
    const checked = await page.evaluate(() => window.vantage.checkSpecialistPdf('qpdf'))
    if (checked?.status !== 'pass') throw new Error(JSON.stringify(checked))
    if ((await sha(pdfPath)) !== originalPdfSha) throw new Error('PDF source changed.')
    return { audit, checked, unchangedSourceSha256: originalPdfSha }
  })
  await step('packaged-database-record-and-isolated-query', async () => {
    const destination = path.join(scratch, 'records.vdb')
    await app.evaluate(({ dialog }, p) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: p })
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] })
    }, destination)
    const result = await page.evaluate(async () => {
      await window.vantage.openDatabase(true)
      await window.vantage.createDatabaseTable('people', [
        { name: 'name', type: 'TEXT' },
        { name: 'count', type: 'INTEGER' },
      ])
      await window.vantage.insertDatabaseRows('people', [{ name: 'Package smoke', count: 7 }])
      await window.vantage.openDatabase(false)
      return window.vantage.queryDatabase('SELECT name, count FROM people')
    })
    if (result.rows[0]?.name !== 'Package smoke' || result.rows[0]?.count !== 7)
      throw new Error(JSON.stringify(result))
    return { ...result, databaseSha256: await sha(destination) }
  })
  await step('packaged-local-mode-block', async () => {
    const value = await app.evaluate(async () => {
      try {
        await fetch('https://example.invalid/package-smoke')
        return 'Unexpected connection'
      } catch (e) {
        return String(e)
      }
    })
    if (!value.includes('Local mode')) throw new Error(value)
    return value
  })
  await step('packaged-cli-version-and-native-workbook', async () => {
    const cli = path.join(packaged, 'resources/cli/vantage.cjs')
    const version = await runNode([cli, '--version'])
    if (!version.stdout.includes('0.15.0-dev.1')) throw new Error(JSON.stringify(version))
    const workbook = path.join(scratch, 'native.xlsx')
    await fs.copyFile(
      path.join(root, 'apps/sheets/fixtures/generated/compatibility-basic.xlsx'),
      workbook,
    )
    const info = await runNode([cli, 'info', workbook])
    return { version, info }
  })
  const files = {
    docs: path.join(packaged, 'resources/shell-new/blank.docx'),
    sheets: path.join(packaged, 'resources/shell-new/blank.xlsx'),
    slides: path.join(packaged, 'resources/shell-new/blank.pptx'),
    pdf: pdfPath,
    markdown: path.join(scratch, 'sample.md'),
    html: path.join(scratch, 'sample.html'),
  }
  await fs.writeFile(files.markdown, '# Package smoke\n\nLocal editor load.\n')
  await fs.writeFile(
    files.html,
    '<!doctype html><html><head><title>Package smoke</title></head><body><h1>Local editor load</h1></body></html>',
  )
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
  })
  for (const [kind, file] of Object.entries(files))
    await step(`packaged-editor-load-${kind}`, async () => {
      await page.evaluate((p) => window.aiOffice.openPath(p), file)
      let editor
      const deadline = Date.now() + 45000
      while (Date.now() < deadline) {
        editor = app
          .windows()
          .find(
            (p) =>
              p.url().startsWith(`vantage-app://${kind}/`) ||
              p.url().replaceAll('\\', '/').includes(`/modules/${kind}/`),
          )
        if (editor) break
        await new Promise((r) => setTimeout(r, 150))
      }
      if (!editor)
        throw new Error(
          `${kind} view absent: ${app
            .windows()
            .map((p) => p.url())
            .join(',')}`,
        )
      await editor.waitForLoadState('domcontentloaded')
      await editor.waitForFunction(() => document.body?.innerText.trim().length > 20, undefined, {
        timeout: 30000,
      })
      const detail = await editor.evaluate(() => ({
        url: location.href,
        bodyCharacters: document.body.innerText.length,
        title: document.title,
      }))
      const tab = await page.evaluate(
        async (k) => (await window.aiOfficeTabs.list()).find((t) => t.kind === k),
        kind,
      )
      if (!tab) throw new Error(`${kind} tab absent`)
      await page.evaluate((id) => window.aiOfficeTabs.close(id), tab.id)
      return detail
    })
} catch (e) {
  report.fatalError = String(e.stack || e)
} finally {
  if (app) {
    try {
      await app.close()
    } catch (e) {
      report.closeError = String(e)
      app.process().kill('SIGKILL')
    }
  }
  report.finishedAt = new Date().toISOString()
  report.completedChecksPassed =
    !report.fatalError &&
    report.checks.length === 12 &&
    report.checks.every((c) => c.status === 'passed')
  report.releaseAccepted = false
  await save()
}
if (!report.completedChecksPassed) process.exitCode = 1
console.log(path.join(output, 'packaged-smoke.json'))
