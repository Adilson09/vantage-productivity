import { Worker } from 'node:worker_threads'
// Embed the upstream self-contained build so packaged applications do not need
// a separately installed pdf-lib tree at runtime. Vite includes this as text.
import pdfLibSource from 'pdf-lib/dist/pdf-lib.min.js?raw'

export interface PdfStructureResult {
  status: 'pass' | 'warning' | 'fail'
  detail: string
  pages?: number
}

// The input cap is enforced by auditFile before this worker receives bytes.
// Separate heap + deadline keeps expensive parser work off the desktop main loop.
const workerSource =
  pdfLibSource +
  `\n;
const { parentPort, workerData } = require('node:worker_threads');
const { PDFDocument } = exports;
(async () => {
  try {
    const pdf = await PDFDocument.load(workerData.bytes, {
      updateMetadata: false, throwOnInvalidObject: true,
    });
    const pages = pdf.getPages();
    if (!pages.length || pages.length > 5000) throw new Error('Page count is outside the 1–5,000 page inspection budget');
    for (const page of pages) {
      const { width, height } = page.getSize();
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
        throw new Error('A page has invalid dimensions');
    }
    parentPort.postMessage({ status: 'pass', pages: pages.length,
      detail: 'Parsed the PDF object tree and ' + pages.length + ' page dictionaries in an isolated parser worker. Page dimensions are valid. Content streams were not rendered; tags, accessibility and conformance are not certified.' });
  } catch (error) {
    const message = String(error && error.message || error).slice(0, 600);
    parentPort.postMessage({ status: /encrypted/i.test(message) ? 'warning' : 'fail',
      detail: /encrypted/i.test(message) ? 'The PDF is encrypted. Object/page inspection was not completed; unlock a separate copy to inspect it.' : 'PDF object/page parsing did not complete: ' + message });
  }
})();
`

export function inspectPdfStructure(
  bytes: Uint8Array,
  timeoutMs = 5000,
): Promise<PdfStructureResult> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: PdfStructureResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      resolve(result)
    }
    const worker = new Worker(workerSource, {
      eval: true,
      workerData: { bytes: new Uint8Array(bytes) },
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    })
    const timer = setTimeout(
      () =>
        finish({
          status: 'warning',
          detail:
            'PDF parsing exceeded the 5-second deadline. Object/page inspection is incomplete.',
        }),
      timeoutMs,
    )
    worker.once('message', (result: PdfStructureResult) => finish(result))
    worker.once('error', (error) =>
      finish({
        status: 'warning',
        detail: `PDF parser worker stopped. Inspection is incomplete: ${error.message.slice(0, 400)}`,
      }),
    )
    worker.once('exit', (code) => {
      if (!settled)
        finish({
          status: 'warning',
          detail: `PDF parser worker exited (${code}) before returning a complete result.`,
        })
    })
  })
}
