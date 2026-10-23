/** Fetch and inline a bounded public HTTP(S) image for the OG renderer. */
export interface FetchImageOptions {
  maxBytes?: number
}

const DEFAULT_MAX_BYTES = 5_000_000
const MAX_REDIRECTS = 5

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const a = parts[0]!
  const b = parts[1]!
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127) || a >= 224
}

function isPrivateIpv6(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return host === '::' || host === '::1' || host.startsWith('fc') || host.startsWith('fd')
    || /^fe[89ab]/.test(host) || host.startsWith('ff')
    || (host.startsWith('::ffff:') && isPrivateIpv4(host.slice(7)))
}

function publicImageUrl(value: string, base?: URL): URL | null {
  try {
    const url = new URL(value, base)
    if (url.protocol !== 'https:') return null
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
    if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')
      || hostname.endsWith('.local') || hostname.endsWith('.internal')
      || isPrivateIpv4(hostname) || isPrivateIpv6(hostname)) return null
    return url
  } catch {
    return null
  }
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel()
}

async function readBoundedStream(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array | null> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  if (size === 0) return null

  const buffer = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    buffer.set(chunk, offset)
    offset += chunk.byteLength
  }
  return buffer
}

export async function fetchTransformedImageAsDataUri(
  images: ImagesBinding,
  url: string | null | undefined,
  transform: ImageTransform,
  output: ImageOutputOptions,
  options: FetchImageOptions = {},
): Promise<string | null> {
  if (!url) return null
  let currentUrl = publicImageUrl(url)
  if (!currentUrl) return null

  let response: Response | null = null
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    response = await fetch(currentUrl, { redirect: 'manual' })
    if (response.status < 300 || response.status >= 400) break
    const location = response.headers.get('location')
    await cancelBody(response)
    if (!location || redirectCount === MAX_REDIRECTS) return null
    currentUrl = publicImageUrl(location, currentUrl)
    if (!currentUrl) return null
  }
  if (!response?.ok) {
    if (response) await cancelBody(response)
    return null
  }

  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() || ''
  if (!contentType.startsWith('image/')) {
    await cancelBody(response)
    return null
  }
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await cancelBody(response)
    return null
  }
  if (!response.body) return null

  const transformed = await images.input(response.body).transform(transform).output(output)
  const buffer = await readBoundedStream(transformed.image(), maxBytes)
  return buffer ? `data:${transformed.contentType()};base64,${uint8ArrayToBase64(buffer)}` : null
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}
