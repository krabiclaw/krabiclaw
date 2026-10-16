const expectedBuildId = process.env.EXPECTED_NUXT_BUILD_ID?.trim()
const maxWaitMs = Number(process.env.NUXT_DEPLOYMENT_MAX_WAIT_MS ?? 300_000)
const intervalMs = Number(process.env.NUXT_DEPLOYMENT_POLL_INTERVAL_MS ?? 5_000)
const requestTimeoutMs = Number(process.env.NUXT_DEPLOYMENT_REQUEST_TIMEOUT_MS ?? 15_000)
const origins = process.argv.slice(2).map(value => new URL(value).origin)

if (!expectedBuildId) throw new Error('EXPECTED_NUXT_BUILD_ID is required')
if (origins.length === 0) throw new Error('At least one tenant origin is required')
if (!Number.isFinite(maxWaitMs) || maxWaitMs < 0) throw new Error('NUXT_DEPLOYMENT_MAX_WAIT_MS must be a non-negative number')
if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('NUXT_DEPLOYMENT_POLL_INTERVAL_MS must be a positive number')
if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0)
  throw new Error('NUXT_DEPLOYMENT_REQUEST_TIMEOUT_MS must be a positive number')

// A server error is the deployed Worker failing, not the edge catching up:
// waiting cannot fix it, so it ends the wait on the first attempt.
class ServerError extends Error {}

function cacheBuster() {
  return `deployment-check=${Date.now()}-${Math.random().toString(16).slice(2)}`
}

async function request(url, init = {}) {
  const response = await fetch(url, {
    cache: 'no-store',
    redirect: 'follow',
    signal: AbortSignal.timeout(requestTimeoutMs),
    ...init,
    headers: {
      'cache-control': 'no-cache',
      pragma: 'no-cache',
      ...init.headers,
    },
  })
  if (response.status >= 500) throw new ServerError(`${response.status} ${url}`)
  if (!response.ok) throw new Error(`${response.status} ${url}`)
  return response
}

function nuxtAssetUrls(html, origin) {
  const urls = new Set()
  const attributePattern = /(?:src|href)=["']([^"']+)["']/g
  for (const match of html.matchAll(attributePattern)) {
    const url = new URL(match[1].replaceAll('&amp;', '&'), origin)
    if (url.origin === origin && url.pathname.startsWith('/_nuxt/')) urls.add(url.href)
  }
  return [...urls]
}

async function verifyAssets(urls) {
  const queue = [...urls]
  const workers = Array.from({ length: Math.min(16, queue.length) }, async () => {
    while (queue.length > 0) await request(queue.shift(), { method: 'HEAD' })
  })
  await Promise.all(workers)
}

async function verifyOrigin(origin) {
  const latestUrl = `${origin}/_nuxt/builds/latest.json?${cacheBuster()}`
  const latest = await request(latestUrl).then(response => response.json())
  if (latest?.id !== expectedBuildId)
    throw new Error(`latest build is ${latest?.id ?? 'missing'}, expected ${expectedBuildId}`)

  const metaUrl = `${origin}/_nuxt/builds/meta/${expectedBuildId}.json?${cacheBuster()}`
  const metadata = await request(metaUrl).then(response => response.json())
  if (metadata?.id !== expectedBuildId) throw new Error('build metadata does not match the expected build')

  const homeUrl = `${origin}/?${cacheBuster()}`
  const html = await request(homeUrl).then(response => response.text())
  if (!html.includes(expectedBuildId)) throw new Error('HTML does not reference the expected build')

  const assets = nuxtAssetUrls(html, origin)
  if (assets.length === 0) throw new Error('HTML contains no same-origin Nuxt assets')
  await verifyAssets(assets)
  return assets.length
}

const startedAt = Date.now()
let attempt = 0

while (true) {
  attempt += 1
  const results = await Promise.allSettled(origins.map(verifyOrigin))
  const failures = results.flatMap((result, index) =>
    result.status === 'rejected' ? [`${origins[index]}: ${result.reason instanceof Error ? result.reason.message : result.reason}`] : [],
  )

  if (results.some(result => result.status === 'rejected' && result.reason instanceof ServerError))
    throw new Error(`Deployed Worker answers with a server error:\n${failures.join('\n')}`)

  if (failures.length === 0) {
    const assetCount = results.reduce((count, result) => count + (result.status === 'fulfilled' ? result.value : 0), 0)
    console.log(`Nuxt build ${expectedBuildId} converged across ${origins.length} origins (${assetCount} assets checked)`)
    break
  }

  if (Date.now() - startedAt >= maxWaitMs)
    throw new Error(`Nuxt deployment did not converge:\n${failures.join('\n')}`)

  console.log(`Deployment not converged (attempt ${attempt}): ${failures.join('; ')}`)
  await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, maxWaitMs - (Date.now() - startedAt))))
}
