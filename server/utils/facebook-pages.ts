import type { OrganizationIntegration } from '~/shared/organization-settings'
import { linkedAccountAccessToken, type CloudflareEnv } from './auth'
import { formBody, metaGraphRequest } from './meta-graph'
import type { MetaDeadline } from './meta-graph'

/**
 * A Facebook Page as an organization's integration, and the Page Graph calls
 * post management makes through it.
 *
 * The Facebook identity and its user token are a Better Auth linked account;
 * the organization stores which of those accounts it acts through and which
 * Page it chose. A Page token is never stored: it is read from the Pages the
 * linked account manages each time one is needed, so a Page the account stops
 * managing stops working rather than carrying on with a copied credential.
 *
 * The API version is pinned. The primitives are Meta's own: an unpublished
 * photo, an unpublished Page post that attaches them, `is_published` on that
 * same post; a published video upload; a Reel upload session finished with
 * `video_state=PUBLISHED`, which answers with the Page post. Meta offers no
 * later publish of an unpublished video — `published=true` on one answers
 * `(#200) Permissions error` (production, 2026-10-06) — so a video's upload or
 * a Reel's finish is the irreversible call, and Meta's answer to it is the
 * publication.
 */

export const FACEBOOK_GRAPH_VERSION = 'v25.0'
const GRAPH_BASE = `https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}`

export interface FacebookPage {
  id: string
  name: string
  access_token: string
  category?: string
  fan_count?: number
  picture?: { data: { url: string } }
}

export interface FacebookPageTarget {
  pageId: string
  pageToken: string
}

type GraphInit = RequestInit & { deadline?: MetaDeadline }

const authorized = (target: FacebookPageTarget, init: GraphInit = {}): GraphInit => ({
  ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${target.pageToken}` },
})

/** Pages assigned to the system user configured by Facebook Login for Business. */
export const listLinkedFacebookPages = async (env: CloudflareEnv, accountId: string): Promise<FacebookPage[]> => {
  const token = (await linkedAccountAccessToken(env, accountId)).accessToken
  const pages: FacebookPage[] = []
  let after: string | null = null
  const cursors = new Set<string>()
  // This configured identity delegates Pages through assigned_pages, not the
  // personal User's accounts edge. Its Page nodes expose access_token when
  // the assigned identity has the required Page role.
  do {
    const params: URLSearchParams = new URLSearchParams({ fields: 'id,name,access_token,category,fan_count,picture', limit: '100', ...(after ? { after } : {}) })
    const page: { data?: FacebookPage[]; paging?: { cursors?: { after?: string }; next?: string } } = await metaGraphRequest(
      `${GRAPH_BASE}/me/assigned_pages?${params}`, { headers: { authorization: `Bearer ${token}` } })
    if (!Array.isArray(page.data)) throw new Error('Facebook returned no assigned Pages data.')
    for (const assigned of page.data) {
      if (!assigned || typeof assigned.id !== 'string' || !assigned.id || typeof assigned.name !== 'string' || !assigned.name) {
        throw new Error('Facebook returned an assigned Page without its identity.')
      }
      if (typeof assigned.access_token !== 'string' || !assigned.access_token) {
        throw new Error(`Facebook returned no access token for assigned Page ${assigned.id}. Check its delegated Page permissions.`)
      }
      pages.push(assigned)
    }
    after = page.paging?.next ? page.paging.cursors?.after ?? null : null
    if (page.paging?.next && (typeof after !== 'string' || !after || cursors.has(after))) throw new Error('Facebook returned an invalid assigned Pages pagination cursor.')
    if (after) cursors.add(after)
  } while (after)
  return pages
}

/** The connected Page's token, read through the linked account that manages it. */
export const facebookPageToken = async (env: CloudflareEnv, connection: Pick<OrganizationIntegration, 'account_id' | 'target_id' | 'target_name'>): Promise<string> => {
  const page = (await listLinkedFacebookPages(env, connection.account_id)).find(candidate => candidate.id === connection.target_id)
  if (!page) throw new Error(`The linked Facebook system user has no assignment for Page ${connection.target_name}. Check its delegated Page access.`)
  return page.access_token
}

// ── Publication primitives ────────────────────────────────────────────────

/** An unpublished photo on the Page, for a post to attach. Facebook fetches `url` itself. */
export async function createUnpublishedPhoto(target: FacebookPageTarget, input: { url: string; altText: string | null }, deadline: MetaDeadline): Promise<string> {
  const result = await metaGraphRequest<{ id?: string }>(`${GRAPH_BASE}/${target.pageId}/photos`, authorized(target, {
    ...formBody({ url: input.url, published: false, ...(input.altText ? { alt_text_custom: input.altText } : {}) }), deadline,
  }))
  if (!result.id) throw new Error('Facebook created no photo')
  return result.id
}

/**
 * Publishes the Page post: the text, a native link when there is no media, and
 * the already-uploaded unpublished photos in the author's order. This is the one
 * irreversible call. Facebook does not publish an unpublished feed post later —
 * `is_published=true` on one answers `(#10) Failed to publish post` — so the post
 * gets its identity only from this call's answer.
 */
export async function publishPagePost(target: FacebookPageTarget, input: { message: string; link: string | null; photoIds: readonly string[] }, deadline: MetaDeadline): Promise<string> {
  const fields: Record<string, string> = {}
  if (input.message) fields.message = input.message
  if (input.link && input.photoIds.length === 0) fields.link = input.link
  input.photoIds.forEach((id, index) => { fields[`attached_media[${index}]`] = JSON.stringify({ media_fbid: id }) })
  const result = await metaGraphRequest<{ id?: string }>(`${GRAPH_BASE}/${target.pageId}/feed`, authorized(target, { ...formBody(fields), deadline }))
  if (!result.id) throw new Error('Facebook created no Page post')
  return result.id
}

export interface FacebookPostState { id: string; isPublished: boolean; permalink: string | null; createdTime: string | null }

export async function readPagePost(target: FacebookPageTarget, postId: string, deadline: MetaDeadline): Promise<FacebookPostState> {
  const result = await metaGraphRequest<{ id?: string; is_published?: boolean; permalink_url?: string; created_time?: string }>(
    `${GRAPH_BASE}/${postId}?fields=id,is_published,permalink_url,created_time`, authorized(target, { deadline }))
  if (!result.id || typeof result.is_published !== 'boolean') throw new Error('Facebook did not say whether the post is published')
  return { id: result.id, isPublished: result.is_published, permalink: result.permalink_url ?? null, createdTime: result.created_time ?? null }
}

/**
 * A published native video from a URL Facebook fetches. Publication is the
 * upload: Facebook posts it to the Page when processing completes, and
 * `readVideo` says when that has happened.
 */
export async function createVideo(target: FacebookPageTarget, input: { fileUrl: string; description: string; title: string | null }, deadline: MetaDeadline): Promise<string> {
  const result = await metaGraphRequest<{ id?: string }>(`${GRAPH_BASE}/${target.pageId}/videos`, authorized(target, {
    ...formBody({ file_url: input.fileUrl, ...(input.description ? { description: input.description } : {}), ...(input.title ? { title: input.title } : {}) }), deadline,
  }))
  if (!result.id) throw new Error('Facebook created no video')
  return result.id
}

/** Meta's Reels requirements: 9:16, at least 540×960, 3 to 90 seconds. */
export function isFacebookReel(video: { width: number | null; height: number | null; duration: number | null }): boolean {
  if (!video.width || !video.height || video.duration === null) return false
  return Math.abs(video.width / video.height - 9 / 16) <= 0.01 && video.width >= 540 && video.height >= 960 && video.duration >= 3 && video.duration <= 90
}

/** A Reel upload session: the video id Facebook will publish under, and nothing public yet. */
export async function startReel(target: FacebookPageTarget, deadline: MetaDeadline): Promise<string> {
  const result = await metaGraphRequest<{ video_id?: string; upload_url?: string }>(`${GRAPH_BASE}/${target.pageId}/video_reels`, authorized(target, { ...formBody({ upload_phase: 'start' }), deadline }))
  if (!result.video_id) throw new Error('Facebook started no Reel upload')
  return result.video_id
}

/** Facebook fetches the hosted file into the Reel upload session itself. */
export async function uploadReelFromUrl(target: FacebookPageTarget, videoId: string, fileUrl: string, deadline: MetaDeadline): Promise<void> {
  const result = await metaGraphRequest<{ success?: boolean }>(`https://rupload.facebook.com/video-upload/${FACEBOOK_GRAPH_VERSION}/${videoId}`, {
    method: 'POST', headers: { authorization: `OAuth ${target.pageToken}`, file_url: fileUrl }, deadline,
  })
  if (result.success !== true) throw new Error('Facebook did not accept the Reel upload')
}

/** The irreversible Reel call: finish the session as a published Reel with its caption. Facebook answers with the Page post it made. */
export async function finishReel(target: FacebookPageTarget, videoId: string, input: { description: string; title: string | null }, deadline: MetaDeadline): Promise<{ postId: string | null }> {
  const result = await metaGraphRequest<{ success?: boolean; post_id?: string }>(`${GRAPH_BASE}/${target.pageId}/video_reels`, authorized(target, {
    ...formBody({ upload_phase: 'finish', video_id: videoId, video_state: 'PUBLISHED', ...(input.description ? { description: input.description } : {}), ...(input.title ? { title: input.title } : {}) }), deadline,
  }))
  if (result.success !== true) throw new Error('Facebook did not confirm the Reel was published')
  return { postId: typeof result.post_id === 'string' && result.post_id ? result.post_id : null }
}

export interface FacebookVideoState {
  id: string
  processing: 'ready' | 'processing' | 'error'
  published: boolean
  postId: string | null
  permalink: string | null
  error: string | null
}

export async function readVideo(target: FacebookPageTarget, videoId: string, deadline: MetaDeadline): Promise<FacebookVideoState> {
  type Phase = { status?: string; errors?: Array<{ message?: string }> }
  const result = await metaGraphRequest<{ id?: string; published?: boolean; post_id?: string; permalink_url?: string; status?: { video_status?: string; processing_phase?: Phase; publishing_phase?: Phase } }>(
    `${GRAPH_BASE}/${videoId}?fields=id,published,post_id,permalink_url,status`, authorized(target, { deadline }))
  if (!result.id || typeof result.published !== 'boolean') throw new Error('Facebook did not say whether the video is published')
  const status = result.status?.video_status
  const processing = status === 'ready' ? 'ready' : status === 'error' ? 'error' : 'processing'
  const permalink = result.permalink_url ? new URL(result.permalink_url, 'https://www.facebook.com').toString() : null
  const errors = [...(result.status?.processing_phase?.errors ?? []), ...(result.status?.publishing_phase?.errors ?? [])].map(error => error.message).filter(Boolean)
  return { id: result.id, processing, published: result.published, postId: result.post_id ?? null, permalink,
    error: processing === 'error' ? errors.join('; ') || 'Facebook could not process the video' : null }
}

/** Deletes the explicitly addressed Page object and requires Meta's confirmation. */
export async function deletePageObject(target: FacebookPageTarget, objectId: string, deadline: MetaDeadline): Promise<void> {
  const result = await metaGraphRequest<{ success?: boolean }>(`${GRAPH_BASE}/${objectId}`, authorized(target, { method: 'DELETE', deadline }))
  if (result.success !== true) throw new Error(`Facebook did not confirm ${objectId} was deleted`)
}

// ── Reading the Page ───────────────────────────────────────────

export interface FacebookAttachmentMedia { image?: { src?: string; width?: number; height?: number }; source?: string }
export interface FacebookAttachment {
  type?: string
  media_type?: string
  url?: string
  unshimmed_url?: string
  title?: string
  description?: string
  target?: { id?: string; url?: string }
  media?: FacebookAttachmentMedia
  subattachments?: { data?: FacebookAttachment[] }
}
export interface FacebookPagePostRecord {
  id: string
  message?: string
  created_time: string
  permalink_url?: string
  attachments?: { data?: FacebookAttachment[] }
}

const ATTACHMENT_FIELDS = 'type,media_type,url,unshimmed_url,title,description,target{id,url},media{image,source}'

/** One page of the Page's own posts, newest first, and Meta's cursor for the next. */
export async function listPagePosts(target: FacebookPageTarget, input: { after: string | null; limit: number }, deadline: MetaDeadline): Promise<{ items: FacebookPagePostRecord[]; after: string | null }> {
  const params = new URLSearchParams({
    fields: `id,message,created_time,permalink_url,attachments{${ATTACHMENT_FIELDS},subattachments.limit(100){${ATTACHMENT_FIELDS}}}`,
    limit: String(input.limit),
    ...(input.after ? { after: input.after } : {}),
  })
  const page = await metaGraphRequest<{ data?: FacebookPagePostRecord[]; paging?: { cursors?: { after?: string }; next?: string } }>(
    `${GRAPH_BASE}/${target.pageId}/posts?${params}`, authorized(target, { deadline }))
  if (!Array.isArray(page.data)) throw new Error('Meta returned no post inventory')
  if (page.paging?.next && !page.paging.cursors?.after) throw new Error('Meta returned another page without its cursor')
  return { items: page.data, after: page.paging?.next ? page.paging.cursors!.after! : null }
}

/** One Page post by id, for reconciliation of an exact identity. */
export async function readPagePostRecord(target: FacebookPageTarget, postId: string, deadline: MetaDeadline): Promise<FacebookPagePostRecord> {
  const params = new URLSearchParams({ fields: `id,message,created_time,permalink_url,attachments{${ATTACHMENT_FIELDS},subattachments.limit(100){${ATTACHMENT_FIELDS}}}` })
  return await metaGraphRequest<FacebookPagePostRecord>(`${GRAPH_BASE}/${postId}?${params}`, authorized(target, { deadline }))
}
