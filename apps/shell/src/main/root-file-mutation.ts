import {
  reserveFileMutation, type FileMutationPath,
} from '../../../../packages/electron-utils/src/file-publication-exclusion'

interface RootMutationIntent { beginMutation(reason: string): () => void }
const unverified = (error: unknown) => !!error && typeof error === 'object' &&
  (error as { code?: unknown }).code === 'VANTAGE_FILE_PUBLICATION_UNATTESTED'

function ownActual<T>(actual: Promise<T>, releaseIntent: () => void): Promise<T> {
  return actual.then(value => { releaseIntent(); return value }, error => {
    // A broken settlement contract must not unlock Root close/removal either.
    if (!unverified(error)) releaseIntent()
    throw error
  })
}

/** Reserve Root's close/mutation epoch synchronously, then drain real writes. */
export function runRootFileMutation<T>(
  intent: RootMutationIntent, paths: readonly FileMutationPath[], reason: string,
  actualMoveAndRefresh: () => Promise<T>,
): Promise<T> {
  const releaseIntent = intent.beginMutation(reason)
  let reservation
  try { reservation = reserveFileMutation(paths) }
  catch (error) { releaseIntent(); throw error }
  return ownActual(reservation.run(actualMoveAndRefresh), releaseIntent)
}

/**
 * A legacy synchronous path-return hook cannot promise a deferred physical
 * destination. Refuse visibly if a real publisher must drain; otherwise start
 * the synchronous move now and keep both reservations through async refresh.
 */
export function tryReadyRootFileMutation<T>(
  intent: RootMutationIntent, paths: readonly FileMutationPath[], reason: string,
  actualMoveAndRefresh: () => Promise<T>,
): { started: false } | { started: true; actual: Promise<T> } {
  const releaseIntent = intent.beginMutation(reason)
  let reservation
  try { reservation = reserveFileMutation(paths) }
  catch (error) { releaseIntent(); throw error }
  if (!reservation.isReady()) {
    reservation.cancelPending()
    releaseIntent()
    return { started: false }
  }
  return { started: true, actual: ownActual(reservation.runReady(actualMoveAndRefresh), releaseIntent) }
}
