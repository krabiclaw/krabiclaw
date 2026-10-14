import type { NuxtApp } from '#app'
import { BROWSER_ERROR_PATH, ERROR_TELEMETRY_LIMITS, errorChainForTelemetry, serializeBrowserErrorReport, type BrowserErrorReport, type BrowserErrorSource } from '~/shared/error-telemetry'

class BrowserErrorNotRecorded extends Error {
  constructor(cause: unknown) {
    super('Browser error was not recorded', { cause })
    this.name = 'BrowserErrorNotRecorded'
  }
}

async function recordBrowserError(report: BrowserErrorReport): Promise<void> {
  try {
    const response = await fetch(BROWSER_ERROR_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      body: serializeBrowserErrorReport(report),
      keepalive: true,
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`Browser error collection was rejected (${response.status})`)
    const result: unknown = await response.json()
    if (!result || typeof result !== 'object' || Reflect.get(result, 'recorded') !== true || Reflect.get(result, 'event_id') !== report.event_id) {
      throw new Error('Browser error collection did not confirm the report')
    }
  } catch (error) {
    // The rejection remains visible in the browser; reporting it again would recurse.
    throw new BrowserErrorNotRecorded(error)
  }
}

export function registerErrorTracking(nuxtApp: NuxtApp): void {
  const reported = new WeakSet<object>()
  const report = (error: unknown, source: BrowserErrorSource, context?: string) => {
    const objects: object[] = []
    let current = error
    while (current && typeof current === 'object' && !objects.includes(current) && objects.length < ERROR_TELEMETRY_LIMITS.depth) {
      if (current instanceof BrowserErrorNotRecorded || reported.has(current)) return
      objects.push(current)
      current = Reflect.get(current, 'cause')
    }
    for (const object of objects) reported.add(object)
    void recordBrowserError({
      event_id: crypto.randomUUID(),
      source,
      page_path: window.location.pathname,
      ...(context ? { context } : {}),
      error_chain: errorChainForTelemetry(error),
    })
  }

  nuxtApp.hook('app:error', error => report(error, 'app_error'))
  nuxtApp.hook('vue:error', (error, _instance, info) => report(error, 'vue_error', info))
  nuxtApp.hook('app:chunkError', ({ error }) => report(error, 'chunk_error'))
  window.addEventListener('error', event => report(event.error ?? event.message, 'browser_error'))
  window.addEventListener('unhandledrejection', event => report(event.reason, 'unhandled_rejection'))
}
