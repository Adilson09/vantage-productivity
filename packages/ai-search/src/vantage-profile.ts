// Vantage Productivity: one isolated default for auth, launcher discovery and CLI audit data.
import { homedir } from 'node:os'
import { join } from 'node:path'

export function vantageCliStateDir(env: NodeJS.ProcessEnv = process.env): string {
  // The existing override remains an explicit opt-in to a shared/custom store.
  if (env.VANTAGE_AUTH_DIR) return env.VANTAGE_AUTH_DIR
  const home =
    process.platform === 'win32'
      ? env.USERPROFILE || env.HOME || homedir()
      : env.HOME || env.USERPROFILE || homedir()
  return join(home, '.vantage-productivity')
}
