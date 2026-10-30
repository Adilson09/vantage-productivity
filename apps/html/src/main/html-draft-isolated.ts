import { Worker } from 'node:worker_threads'
import { HTML_DRAFT_MAX_BYTES, type HtmlDraftMaterialization } from '../shared/html-draft'
import type { HtmlDraftAssetGrant } from './html-draft-assets'

interface Job {
  purpose?:'close-proof'
  expiresAt:number
  bytes: Buffer
  grant: HtmlDraftAssetGrant
  resolve: (result: HtmlDraftMaterialization) => void
  reject: (error: Error) => void
  expiry: ReturnType<typeof setTimeout>
}
/** Parsing and compression never run on Electron's main thread. Queued jobs retain their original expiry. */
export class HtmlDraftMaterializer {
  private readonly queued: Job[] = []
  private running = 0
  constructor(
    private readonly workerUrl: string | URL,
    private readonly timeoutMs = 5000,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 5000)
      throw new Error('Invalid HTML recovery processing budget.')
  }
  prepare(bytes: Buffer, grant: HtmlDraftAssetGrant,options:{purpose?:'close-proof'}={}): Promise<HtmlDraftMaterialization> {
    if(options.purpose!==undefined&&options.purpose!=='close-proof')return Promise.reject(new Error('Invalid HTML worker purpose.'))
    if (!Buffer.isBuffer(bytes) || bytes.length > HTML_DRAFT_MAX_BYTES)
      return Promise.reject(new Error('The HTML draft exceeds 16 MiB.'))
    if (this.running >= 2 && this.queued.length >= 4)
      return Promise.reject(new Error('HTML recovery is busy; the previous copy is retained.'))
    return new Promise((resolve, reject) => {
      const job: Job = {
        bytes,expiresAt:Date.now()+this.timeoutMs,
        grant,purpose:options.purpose,
        resolve,
        reject,
        expiry: setTimeout(() => {
          const position = this.queued.indexOf(job)
          if (position >= 0) {
            this.queued.splice(position, 1)
            reject(
              new Error('HTML recovery expired before processing; the previous copy is retained.'),
            )
          }
        }, this.timeoutMs),
      }
      this.queued.push(job)
      this.pump()
    })
  }
  private pump(): void {
    while (this.running < 2 && this.queued.length) this.start(this.queued.shift()!)
  }
  private start(job: Job): void {
    clearTimeout(job.expiry)
    if(job.expiresAt<=Date.now()){job.reject(new Error('HTML recovery expired before processing; its original budget was not replenished.'));this.pump();return}
    this.running++
    let worker: Worker
    try {
      worker = new Worker(this.workerUrl, {
        workerData: { bytes: job.bytes, grant: job.grant,...(job.purpose?{purpose:job.purpose}:{}) },
        resourceLimits: {
          maxOldGenerationSizeMb: 256,
          maxYoungGenerationSizeMb: 32,
          stackSizeMb: 4,
        },
        stdout: true,
        stderr: true,
      })
    } catch (error) {
      this.running--
      job.reject(error instanceof Error ? error : new Error('HTML recovery could not start.'))
      this.pump()
      return
    }
    let settled = false,
      outputBytes = 0
    const finish = (error?: Error, result?: HtmlDraftMaterialization): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) job.reject(error)
      else job.resolve(result!)
      void worker.terminate()
    }
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            'HTML resource capture exceeded its processing deadline; the previous copy is retained.',
          ),
        ),
      Math.max(0,job.expiresAt-Date.now()),
    )
    for (const stream of [worker.stdout, worker.stderr])
      stream?.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length
        if (outputBytes > 64 * 1024)
          finish(new Error('HTML recovery produced excessive diagnostics.'))
      })
    worker.on('message', (value: unknown) => {
      if (!value || typeof value !== 'object') {
        finish(new Error('Invalid HTML recovery response.'))
        return
      }
      const response = value as { bytes?: unknown; remoteReferences?: unknown; error?: unknown;unsealedExecutableReferences?:unknown }
      const keys = Object.keys(response).sort().join(',')
      if (keys === 'error' && typeof response.error === 'string' && response.error.length <= 1024) {
        finish(new Error(response.error))
        return
      }
      if (
        keys !== (job.purpose==='close-proof'?'bytes,remoteReferences,unsealedExecutableReferences':'bytes,remoteReferences') ||
        job.purpose==='close-proof'&&typeof response.unsealedExecutableReferences!=='boolean'||
        !(response.bytes instanceof ArrayBuffer) ||
        response.bytes.byteLength > HTML_DRAFT_MAX_BYTES ||
        !Number.isSafeInteger(response.remoteReferences) ||
        (response.remoteReferences as number) < 0 ||
        (response.remoteReferences as number) > 10000
      ) {
        finish(new Error('Invalid or oversized HTML recovery response.'))
        return
      }
      finish(undefined, {
        bytes: Buffer.from(response.bytes),
        remoteReferences: response.remoteReferences as number,
        ...(job.purpose==='close-proof'?{unsealedExecutableReferences:response.unsealedExecutableReferences as boolean}:{}),
      })
    })
    worker.once('error', (error) => finish(error))
    worker.once('exit', (code) => {
      if (!settled)
        finish(new Error('HTML recovery worker exited before completing (' + code + ').'))
      // A timed-out worker continues to own its slot until actual exit.
      this.running--
      this.pump()
    })
  }
}
