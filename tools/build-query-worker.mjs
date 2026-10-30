// Explicit development/CI prerequisite. Runtime discovery never compiles code.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cwd = fileURLToPath(new URL('../apps/sheets/', import.meta.url))
const result = spawnSync(
  'cargo',
  [
    'build',
    '--release',
    '--locked',
    '--manifest-path',
    'native/xlsx-engine/Cargo.toml',
    '--config',
    'native/xlsx-engine/.cargo/config.toml',
    '--bin',
    'vantage-query-worker',
  ],
  { cwd, stdio: 'inherit', shell: false, windowsHide: true },
)
if (result.error) throw result.error
process.exitCode = result.status ?? 1
