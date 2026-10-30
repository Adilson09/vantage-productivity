import { readFile } from 'node:fs/promises'
import { writeDraftJournal } from '@vantage/electron-utils/draft-journal'
import {
  classifyPdfWorkspaceBase,
  encodePdfWorkspace,
  pdfDigest,
} from '../../src/main/pdf-workspace'
import { completeWorkspace } from './pdf-workspace'

const [recoveryRoot, originalPath, token] = process.argv.slice(2)
if (!recoveryRoot || !originalPath || !token)
  throw new Error('Missing reserved crash-fixture arguments.')
const bytes = Buffer.from(await readFile(originalPath))
if ((await classifyPdfWorkspaceBase(bytes)).kind !== 'unencrypted')
  throw new Error('Crash fixture refuses a protected or unknown base.')
const envelope = encodePdfWorkspace(bytes, completeWorkspace(), {
  displayName: 'Original.pdf',
  originalPath,
})
const receipt = await writeDraftJournal(recoveryRoot, {
  id: token,
  module: 'pdf',
  documentPath: originalPath,
  extension: '.vpdfdraft',
  bytes: envelope,
})
if (!receipt || receipt.sha256 !== pdfDigest(envelope))
  throw new Error('The actual complete journal did not publish.')
process.stdout.write(
  JSON.stringify({ phase: 'journal-published', token, sha256: receipt.sha256 }) + '\n',
)
setInterval(() => {}, 1000)
