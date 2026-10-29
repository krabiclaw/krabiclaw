import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { request, type APIRequestContext } from '@playwright/test'

// The seed talks to the local Worker the way an owner's browser and MCP client
// do: Better Auth for identity and organizations, the editor upload for media,
// MCP for everything an owner authors. Every call either succeeds or throws
// with the server's own message.

export class SeedClient {
  readonly baseURL: string
  readonly api: APIRequestContext
  // Assigned in the body: `node --experimental-strip-types` (local:seed) cannot run parameter properties.
  private constructor(baseURL: string, api: APIRequestContext) {
    this.baseURL = baseURL
    this.api = api
  }

  static async signedIn(baseURL: string, email: string, password: string) {
    const api = await request.newContext({ baseURL, extraHTTPHeaders: { origin: new URL(baseURL).origin } })
    const client = new SeedClient(baseURL, api)
    await client.auth('sign-in/email', { email, password, rememberMe: false })
    return client
  }

  async dispose() { await this.api.dispose() }

  async auth<T = Record<string, unknown>>(path: string, data?: Record<string, unknown>): Promise<T> {
    const response = data ? await this.api.post(`/api/auth/${path}`, { data }) : await this.api.get(`/api/auth/${path}`)
    if (response.status() !== 200) throw new Error(`Better Auth ${path} failed: ${response.status()} ${await response.text()}`)
    return await response.json() as T
  }

  async json<T = Record<string, unknown>>(method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, data?: unknown, expected = [200, 201]): Promise<T> {
    const response = await this.api.fetch(path, { method, ...(data === undefined ? {} : { data }) })
    if (!expected.includes(response.status())) throw new Error(`${method} ${path} failed: ${response.status()} ${await response.text()}`)
    return await response.json() as T
  }

  async tool<T = Record<string, unknown>>(organizationId: string, name: string, args: Record<string, unknown>): Promise<T> {
    const response = await this.api.post('/api/mcp', {
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-krabiclaw-organization-id': organizationId },
      data: { jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: { organization_id: organizationId, ...args } } },
    })
    const text = await response.text()
    if (response.status() !== 200) throw new Error(`MCP ${name} failed: ${response.status()} ${text}`)
    const body = JSON.parse(text.includes('data:') ? text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('') : text)
    if (body.error || body.result?.isError) throw new Error(`MCP ${name} failed: ${JSON.stringify(body.error ?? body.result.content)}`)
    return body.result.structuredContent as T
  }

  /** Uploads one synthetic file through the editor's media library. */
  async upload(organizationId: string, file: string, options: { altText: string; poster?: string } ): Promise<{ id: string; public_url: string }> {
    const media = (name: string, mimeType: string) => ({ name, mimeType, buffer: readFileSync(new URL(`./media/${name}`, import.meta.url)) })
    const multipart = file.endsWith('.mp4')
      ? { video: media(file, 'video/mp4'), thumbnail: media(options.poster!, 'image/avif') }
      : { image: media(file, 'image/avif') }
    const response = await this.api.post(`/api/editor/organizations/${organizationId}/media/upload`, { multipart })
    if (response.status() !== 200) throw new Error(`Upload ${file} failed: ${response.status()} ${await response.text()}`)
    const uploaded = await response.json() as { asset_id: string; public_url: string }
    const described = await this.api.patch(`/api/editor/organizations/${organizationId}/media/${uploaded.asset_id}`, { data: { alt_text: options.altText } })
    if (described.status() !== 200) throw new Error(`Describing ${file} failed: ${described.status()} ${await described.text()}`)
    return { id: uploaded.asset_id, public_url: uploaded.public_url }
  }
}
