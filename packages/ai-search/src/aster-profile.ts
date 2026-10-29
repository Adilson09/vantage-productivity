// Aster Office: one isolated default for auth, launcher discovery and CLI audit data.
import { homedir } from 'node:os'
import { join } from 'node:path'

export function asterCliStateDir(env: NodeJS.ProcessEnv = process.env): string {
  // The existing override remains an explicit opt-in to a shared/custom store.
  if (env.ASTER_AUTH_DIR) return env.ASTER_AUTH_DIR
  if (env.GENOFFICE_AUTH_DIR) return env.GENOFFICE_AUTH_DIR
  const home =
    process.platform === 'win32'
      ? env.USERPROFILE || env.HOME || homedir()
      : env.HOME || env.USERPROFILE || homedir()
  return join(home, '.aster-office')
}
