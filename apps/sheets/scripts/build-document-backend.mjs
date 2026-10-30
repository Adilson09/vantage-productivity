/** Bundle the trusted local automation host without Electron or workspace imports. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const sheetsRoot = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--out' || !isAbsolute(args[1]))) {
  throw new Error(
    'Use --out <absolute destination>, or omit it for dist/backend/spreadsheet-backend.cjs.',
  )
}
const outfile = args[1] ?? resolve(sheetsRoot, 'dist/backend/spreadsheet-backend.cjs')
await mkdir(dirname(outfile), { recursive: true })
const result = await build({
  entryPoints: [resolve(sheetsRoot, 'scripts/spreadsheet-backend-host.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  sourcemap: false,
  legalComments: 'eof',
  metafile: true,
  logLevel: 'info',
})
const dependencies = Object.keys(result.metafile.inputs).filter((path) =>
  path.includes('node_modules/'),
)
if (
  Object.values(result.metafile.outputs).some((output) =>
    output.imports.some((item) => item.path === 'electron' || item.path.startsWith('@vantage/')),
  )
) {
  throw new Error('The standalone spreadsheet host retained an application-only runtime import.')
}
await writeFile(
  `${outfile}.build.json`,
  JSON.stringify(
    {
      format: 1,
      nodeMajor: 24,
      host: 'spreadsheet-backend',
      bytes: (await readFile(outfile)).length,
      bundledDependencyFiles: dependencies.length,
    },
    null,
    2,
  ) + '\n',
)
