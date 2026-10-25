import { setTokenUtil } from 'better-auth/oauth2'
import { createAuth, linkedAccountAccessToken, type CloudflareEnv } from './auth'
import { formBody, MetaGraphError, metaGraphRequest } from './meta-graph'

/**
 * Instagram as its own connection: Instagram Login for professional accounts,
 * its own record, its own disconnect — not derived from a Facebook Page.
 *
 * The Instagram identity and its token are a Better Auth linked account (the
 * Generic OAuth `instagram` provider in server/utils/auth.ts). The
 * organization stores the account it acts through and the professional
 * account publishing addresses.
 */

export const INSTAGRAM_GRAPH_VERSION = 'v23.0'
const INSTAGRAM_GRAPH = `https://graph.instagram.com/${INSTAGRAM_GRAPH_VERSION}`

/**
 * The one token operation Better Auth cannot perform. A long-lived Instagram
 * token lasts sixty days and is renewed by exchanging the token itself at
 * `refresh_access_token` with `grant_type=ig_refresh_token` — not the OAuth
 * refresh-token grant Better Auth's Generic OAuth refresh sends to a token
 * URL, and Instagram issues no refresh token for it to send. So the token is
 * read through Better Auth, renewed here inside its last week, and written
 * back to the same Better Auth account row, encrypted the way Better Auth
 * stores every token.
 */
const TOKEN_RENEWAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

export async function instagramAccessToken(env: CloudflareEnv, accountId: string): Promise<string> {
  const token = await linkedAccountAccessToken(env, accountId)
  if (!token.accessTokenExpiresAt) throw new Error('The linked Instagram account has no token expiry. Connect Instagram again.')
  if (token.accessTokenExpiresAt.getTime() - Date.now() > TOKEN_RENEWAL_WINDOW_MS) return token.accessToken

  const params = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: token.accessToken })
  const renewed = longLivedToken(await metaGraphRequest(`https://graph.instagram.com/refresh_access_token?${params.toString()}`))

  const context = await createAuth(env).$context
  const updated = await context.internalAdapter.updateAccount(accountId, {
    // This app's concrete options type narrows AuthContext; setTokenUtil reads only options and secretConfig.
    accessToken: await setTokenUtil(renewed.accessToken, context as unknown as Parameters<typeof setTokenUtil>[1]),
    accessTokenExpiresAt: renewed.expiresAt,
  })
  if (!updated) throw new Error('The renewed Instagram token could not be saved to its linked account.')
  return renewed.accessToken
}

function longLivedToken(token: { access_token?: string; expires_in?: number }): { accessToken: string; expiresAt: Date } {
  if (!token.access_token || typeof token.expires_in !== 'number') {
    throw new MetaGraphError('invalid-response', 'Instagram did not return a long-lived access token and its lifetime')
  }
  return {
    accessToken: token.access_token,
    expiresAt: new Date(Date.now() + token.expires_in * 1000),
  }
}

export async function getInstagramAccount(accessToken: string): Promise<{ id: string; username: string }> {
  const params = new URLSearchParams({ fields: 'user_id,username', access_token: accessToken })
  const account: { user_id?: string; id?: string; username?: string } = await metaGraphRequest(`${INSTAGRAM_GRAPH}/me?${params.toString()}`)
  const id = account.user_id ?? account.id
  if (!id || !account.username) throw new Error('Instagram did not return the connected account')
  return { id: String(id), username: account.username }
}

export interface InstagramTarget {
  userId: string
  accessToken: string
}

type GraphInit = RequestInit
const withToken = (target: InstagramTarget, init: GraphInit = {}): GraphInit => ({
  ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${target.accessToken}` },
})

// ── Publication primitives: containers, their status, media_publish ───────

export type InstagramContainerInput =
  | { kind: 'image'; url: string; caption?: string; carouselItem: boolean; altText?: string | null }
  | { kind: 'video'; url: string; caption?: string; carouselItem: boolean; coverUrl?: string | null }
  | { kind: 'carousel'; children: readonly string[]; caption?: string }

/** A media container. Instagram fetches the URL itself; nothing is public until it is published. */
export async function createMediaContainer(target: InstagramTarget, input: InstagramContainerInput): Promise<string> {
  const fields: Record<string, string | boolean | undefined> = input.kind === 'image'
    ? { image_url: input.url, is_carousel_item: input.carouselItem || undefined, alt_text: input.altText || undefined }
    : input.kind === 'video'
      // A standalone video is a Reel; a carousel child is a VIDEO item.
      ? { media_type: input.carouselItem ? 'VIDEO' : 'REELS', video_url: input.url, is_carousel_item: input.carouselItem || undefined, cover_url: input.carouselItem ? undefined : input.coverUrl || undefined }
      : { media_type: 'CAROUSEL', children: input.children.join(',') }
  if (!('carouselItem' in input && input.carouselItem) && input.caption) fields.caption = input.caption
  const result = await metaGraphRequest<{ id?: string }>(`${INSTAGRAM_GRAPH}/${target.userId}/media`, withToken(target, { ...formBody(fields) }))
  if (!result.id) throw new Error('Instagram created no media container')
  return result.id
}

export type InstagramContainerStatus = 'EXPIRED' | 'ERROR' | 'FINISHED' | 'IN_PROGRESS' | 'PUBLISHED'

export async function readContainerStatus(target: InstagramTarget, containerId: string): Promise<{ status: InstagramContainerStatus; detail: string | null }> {
  const result = await metaGraphRequest<{ status_code?: string; status?: string }>(
    `${INSTAGRAM_GRAPH}/${containerId}?fields=status_code,status`, withToken(target, {}))
  const status = result.status_code
  if (status !== 'EXPIRED' && status !== 'ERROR' && status !== 'FINISHED' && status !== 'IN_PROGRESS' && status !== 'PUBLISHED') {
    throw new Error(`Instagram reported container ${containerId} in an unknown state: ${String(status)}`)
  }
  return { status, detail: result.status ?? null }
}

/** Publishes the saved container. The answer is the published media id. */
export async function publishContainer(target: InstagramTarget, containerId: string): Promise<string> {
  const result = await metaGraphRequest<{ id?: string }>(`${INSTAGRAM_GRAPH}/${target.userId}/media_publish`, withToken(target, { ...formBody({ creation_id: containerId }) }))
  if (!result.id) throw new Error('Instagram did not return the published media id')
  return result.id
}

export interface InstagramMediaRecord {
  id: string
  caption?: string
  media_type: 'IMAGE' | 'VIDEO' | 'CAROUSEL_ALBUM'
  media_product_type?: string
  media_url?: string
  thumbnail_url?: string
  permalink?: string
  timestamp: string
  username?: string
  children?: { data?: Array<{ id: string; media_type: 'IMAGE' | 'VIDEO'; media_url?: string; thumbnail_url?: string }> }
}

const MEDIA_FIELDS = 'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,username,children{id,media_type,media_url,thumbnail_url}'

export async function readMedia(target: InstagramTarget, mediaId: string): Promise<InstagramMediaRecord> {
  return await metaGraphRequest<InstagramMediaRecord>(`${INSTAGRAM_GRAPH}/${mediaId}?fields=${MEDIA_FIELDS}`, withToken(target, {}))
}

/** One page of the account's own media, newest first, with every carousel child, and the cursor for the next. */
export async function listMedia(target: InstagramTarget, input: { after: string | null; limit: number }): Promise<{ items: InstagramMediaRecord[]; after: string | null }> {
  const params = new URLSearchParams({ fields: MEDIA_FIELDS, limit: String(input.limit), ...(input.after ? { after: input.after } : {}) })
  const page = await metaGraphRequest<{ data?: InstagramMediaRecord[]; paging?: { cursors?: { after?: string }; next?: string } }>(
    `${INSTAGRAM_GRAPH}/${target.userId}/media?${params}`, withToken(target, {}))
  if (!Array.isArray(page.data)) throw new MetaGraphError('invalid-response', 'Meta returned no post inventory')
  if (page.paging?.next && !page.paging.cursors?.after) throw new MetaGraphError('invalid-response', 'Meta returned another page without its cursor')
  return { items: page.data, after: page.paging?.next ? page.paging.cursors!.after! : null }
}

// ── Insights (instagram_business_manage_insights) ─────────────────────────

/** Account metrics Instagram totals over a range (period=day, metric_type=total_value). */
export const ACCOUNT_INSIGHT_METRICS = ['views', 'reach', 'accounts_engaged', 'total_interactions', 'likes', 'comments', 'shares', 'saves', 'replies', 'profile_links_taps'] as const
export type AccountInsightMetric = typeof ACCOUNT_INSIGHT_METRICS[number]

/** Lifetime metrics Instagram reports for both feed posts and reels. */
export const MEDIA_INSIGHT_METRICS = ['views', 'reach', 'likes', 'comments', 'shares', 'saved', 'total_interactions'] as const
export type MediaInsightMetric = typeof MEDIA_INSIGHT_METRICS[number]

type InsightValues = { data?: Array<{ name?: string; total_value?: { value?: unknown }; values?: Array<{ value?: unknown }> }> }

/** Each named metric Instagram returned, by name; one it did not return is absent, never zero. */
function insightValues<M extends string>(response: InsightValues, metrics: readonly M[], read: (entry: NonNullable<InsightValues['data']>[number]) => unknown): Partial<Record<M, number>> {
  if (!Array.isArray(response.data)) throw new MetaGraphError('invalid-response', 'Instagram returned no insights data')
  const values: Partial<Record<M, number>> = {}
  for (const entry of response.data) {
    const value = read(entry)
    if (metrics.includes(entry.name as M) && typeof value === 'number') values[entry.name as M] = value
  }
  return values
}

/** The account's totals for [since, until), as Instagram reports them. */
export async function readAccountInsights(target: InstagramTarget, range: { since: Date; until: Date }): Promise<Partial<Record<AccountInsightMetric, number>>> {
  const params = new URLSearchParams({
    metric: ACCOUNT_INSIGHT_METRICS.join(','), period: 'day', metric_type: 'total_value',
    since: String(Math.floor(range.since.getTime() / 1000)), until: String(Math.floor(range.until.getTime() / 1000)),
  })
  const response = await metaGraphRequest<InsightValues>(`${INSTAGRAM_GRAPH}/${target.userId}/insights?${params}`, withToken(target, {}))
  return insightValues(response, ACCOUNT_INSIGHT_METRICS, entry => entry.total_value?.value)
}

/** A feed post's or reel's lifetime metrics, as Instagram reports them. */
export async function readMediaInsights(target: InstagramTarget, mediaId: string): Promise<Partial<Record<MediaInsightMetric, number>>> {
  const response = await metaGraphRequest<InsightValues>(`${INSTAGRAM_GRAPH}/${mediaId}/insights?metric=${MEDIA_INSIGHT_METRICS.join(',')}`, withToken(target, {}))
  return insightValues(response, MEDIA_INSIGHT_METRICS, entry => entry.total_value?.value ?? entry.values?.[0]?.value)
}
