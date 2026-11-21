import type { PDFDocumentProxy } from 'pdfjs-dist'

/**
 * A PDF opened for drawing its pages in the browser. pdf.js exists only in
 * the browser build: on the server the import below is dead code the bundler
 * drops, so the Worker never carries it.
 */
export async function openPdfDocument(data: Uint8Array): Promise<PDFDocumentProxy> {
  const pdfjs = import.meta.client ? await import('pdfjs-dist') : null
  if (!pdfjs) throw new Error('PDF pages are drawn in the browser')
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href
  return pdfjs.getDocument({ data }).promise
}
