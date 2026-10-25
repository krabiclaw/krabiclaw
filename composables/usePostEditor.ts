import { parsePostInput, type PostCallToAction } from '~/shared/posts'
import { getErrorMessage } from '~/utils/errors'

export interface PostMediaFormItem {
  asset_id: string
  slot: 'cover' | 'gallery'
  alt_text: string
  public_url?: string | null
  thumbnail_url?: string | null
  kind?: string | null
}

export function normalizePostMediaForForm(items: unknown): PostMediaFormItem[] {
  if (!Array.isArray(items)) return []
  const media: PostMediaFormItem[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if ((record.slot !== 'cover' && record.slot !== 'gallery') || typeof record.asset_id !== 'string') continue
    media.push({
      asset_id: record.asset_id,
      slot: record.slot,
      alt_text: typeof record.alt_text === 'string' ? record.alt_text : '',
      public_url: typeof record.public_url === 'string' ? record.public_url : null,
      thumbnail_url: typeof record.thumbnail_url === 'string' ? record.thumbnail_url : null,
      kind: typeof record.kind === 'string' ? record.kind : null,
    })
  }
  return media
}

export const isPostResponse = (value: unknown): value is { post: ApiRecord } =>
  isRecord(value) && isRecord(value.post) && typeof value.post.id === 'string' && typeof value.post.updated_at === 'string'

export interface PublishOutcome {
  channel: 'organization' | SocialChannel
  target_id: string
  status: 'published' | 'already_published' | 'processing' | 'failed' | 'unknown' | 'skipped'
  publication_id?: string
  public_url?: string | null
  code?: string
  message?: string
}
export interface PublishResult { ok: boolean; post_id: string; updated_at: string; outcomes: PublishOutcome[] }
export type SocialChannel = 'facebook' | 'instagram' | 'discord'
export type PublishTarget = { channel: 'organization' } | { channel: SocialChannel; target_id: string; connection_revision: string }

const isPublishResult = (value: unknown): value is PublishResult =>
  isRecord(value) && typeof value.ok === 'boolean' && typeof value.updated_at === 'string' && Array.isArray(value.outcomes)

/**
 * The CMS's draft of one short post, written through the same editor routes —
 * and so the same domain functions — as MCP. Updates carry the revision the
 * post was read at; a stale one is the server's conflict to report.
 *
 * `locationId` is where a new post is written: a location the URL names, or
 * null for a site-wide post. It is the author's explicit scope, never a
 * location left over from an earlier screen.
 */
export function usePostEditor(organizationId: string, locationId: Ref<string | null>) {
  const dashboardApi = useDashboardApi()
  const error = ref<string | null>(null)
  const { trackPostCreated, trackPostPublished } = useAnalytics()

  const form = reactive({
    title: '',
    body: '',
    callToAction: null as PostCallToAction | null,
    media: [] as PostMediaFormItem[],
    /** The location an existing post belongs to, or null for the whole website. */
    location_id: locationId.value,
  })
  // The record as last read, and the revision sent with every change.
  const record = ref<ApiRecord | null>(null)
  const updatedAt = ref<string | null>(null)
  let originalMedia: PostMediaFormItem[] = []
  const saving = ref(false)
  const publishing = ref(false)
  const creationRejected = ref(false)
  const savedSnapshot = ref('')

  function snapshot() {
    return JSON.stringify({
      title: form.title, body: form.body, callToAction: form.callToAction, location_id: form.location_id,
      media: form.media.filter(item => item.asset_id).map(item => ({ asset_id: item.asset_id, slot: item.slot })),
    })
  }
  const isDirty = computed(() => snapshot() !== savedSnapshot.value)

  function loadFrom(post: ApiRecord) {
    record.value = post
    form.title = String(post.title ?? '')
    form.body = String(post.body ?? '')
    form.callToAction = isRecord(post.call_to_action) && typeof post.call_to_action.label === 'string' && typeof post.call_to_action.url === 'string'
      ? { label: post.call_to_action.label, url: post.call_to_action.url }
      : null
    form.media = normalizePostMediaForForm(post.media)
    form.location_id = typeof post.location_id === 'string' && post.location_id ? post.location_id : null
    updatedAt.value = typeof post.updated_at === 'string' ? post.updated_at : null
    originalMedia = form.media.map(item => ({ ...item }))
    savedSnapshot.value = snapshot()
  }

  const fields = () => parsePostInput({
    title: form.title.trim() ? form.title : null,
    body: form.body.trim() ? form.body : null,
    call_to_action: form.callToAction && form.callToAction.label.trim() && form.callToAction.url.trim() ? form.callToAction : null,
  }, 'update')

  const isPlacementResponse = (value: unknown): value is { asset_ids: string[] } => isRecord(value) && Array.isArray(value.asset_ids)

  async function syncMedia(postId: string, current: ApiRecord) {
    const placement = (slot: 'cover' | 'gallery') => ({ owner_type: 'content_document', owner_id: postId, slot })
    const currentMedia = normalizePostMediaForForm(current.media)
    const originalCover = originalMedia.find(item => item.slot === 'cover')?.asset_id ?? null
    const currentCover = form.media.find(item => item.slot === 'cover')?.asset_id ?? null
    const savedCover = currentMedia.find(item => item.slot === 'cover')?.asset_id ?? null
    if (currentCover !== originalCover && savedCover !== originalCover && savedCover !== currentCover) throw new Error('The cover changed since it was read. Reload the post to review that change before saving.')
    if (currentCover !== originalCover && savedCover !== currentCover) {
      await dashboardApi(`/api/editor/organizations/${organizationId}/media/placements`, {
        method: 'PUT', body: { placement: placement('cover'), asset_id: currentCover }, validate: isPlacementResponse,
      })
    }
    const originalGallery = originalMedia.filter(item => item.slot === 'gallery').map(item => item.asset_id).filter(Boolean)
    const currentGallery = form.media.filter(item => item.slot === 'gallery').map(item => item.asset_id).filter(Boolean)
    const savedGallery = currentMedia.filter(item => item.slot === 'gallery').map(item => item.asset_id)
    const removed = originalGallery.filter(id => !currentGallery.includes(id))
    const added = currentGallery.filter(id => !originalGallery.includes(id) && !savedGallery.includes(id))
    for (const assetId of removed.filter(id => savedGallery.includes(id))) {
      await dashboardApi(`/api/editor/organizations/${organizationId}/media/placements/remove`, {
        method: 'POST', body: { placement: placement('gallery'), asset_id: assetId }, validate: isPlacementResponse,
      })
    }
    for (const assetId of added) {
      await dashboardApi(`/api/editor/organizations/${organizationId}/media/placements/attach`, {
        method: 'POST', body: { placement: placement('gallery'), asset_id: assetId }, validate: isPlacementResponse,
      })
    }
    // Attach appends and remove closes the gap, so this is the order the
    // server now holds; the author's order is set only when it differs.
    const serverOrder = [...savedGallery.filter(id => !removed.includes(id)), ...added]
    const desiredOrder = currentGallery.filter(id => serverOrder.includes(id))
    const knownOrder = serverOrder.filter(id => desiredOrder.includes(id))
    const orderChanged = desiredOrder.some((assetId, index) => knownOrder[index] !== assetId)
    if (orderChanged) {
      const moves = desiredOrder.map((assetId, index) => index === desiredOrder.length - 1
        ? { asset_id: assetId }
        : { asset_id: assetId, before_asset_id: desiredOrder[index + 1]! })
      await dashboardApi(`/api/editor/organizations/${organizationId}/media/placements/reorder`, {
        method: 'POST', body: { placement: placement('gallery'), moves: moves.reverse() }, validate: isPlacementResponse,
      })
    }
  }

  async function read(postId: string): Promise<ApiRecord> {
    const res = await dashboardApi<{ post: ApiRecord }>(`/api/editor/organizations/${organizationId}/posts/${postId}`, { validate: isPostResponse })
    return res.post
  }
  async function reload(postId: string): Promise<ApiRecord> {
    const post = await read(postId)
    loadFrom(post)
    return post
  }

  /** Creates the draft (under its idempotency key) or saves the changes; the saved post, or null with `error` set. */
  async function save(postId: string | null, idempotencyKey?: string): Promise<ApiRecord | null> {
    error.value = null
    creationRejected.value = false
    saving.value = true
    try {
      if (!postId) {
        if (!idempotencyKey) throw new Error('A new post needs its idempotency key')
        const res = await dashboardApi<{ post: ApiRecord }>(`/api/editor/organizations/${organizationId}/posts`, {
          method: 'POST',
          body: { idempotency_key: idempotencyKey, ...fields(), location_id: form.location_id,
            media: form.media.filter(item => item.asset_id).map(item => ({ asset_id: item.asset_id, slot: item.slot })) },
          validate: isPostResponse,
        })
        loadFrom(res.post)
        trackPostCreated(String(res.post.id), organizationId)
        return res.post
      }
      if (!updatedAt.value) throw new Error('The post has not been read yet')
      let current = await read(postId)
      const saved = JSON.parse(savedSnapshot.value) as { location_id: string | null }
      const currentFields = { title: current.title ?? null, body: current.body ?? null, call_to_action: current.call_to_action ?? null }
      const matchesBaseline = JSON.stringify(currentFields) === JSON.stringify(fieldsOf(savedSnapshot.value)) && current.location_id === saved.location_id
      const matchesDraft = JSON.stringify(currentFields) === JSON.stringify(fields()) && current.location_id === form.location_id
      if (!matchesBaseline && !matchesDraft) throw new Error('The post changed since it was read. Reload it to review those changes before saving.')
      // Confirm a lost PATCH through its actual saved values; never accept a
      // different writer's text merely because a newer revision was read.
      updatedAt.value = String(current.updated_at)
      const savedLocation = typeof current.location_id === 'string' ? current.location_id : null
      const locationChanged = form.location_id !== savedLocation
      // Sending matching fields also completes the canonical writer's card
      // work if the previous response was lost after its content committed.
      const response = await dashboardApi(`/api/editor/organizations/${organizationId}/posts/${postId}`, {
        method: 'PATCH', body: { expected_updated_at: updatedAt.value, ...fields(), ...(locationChanged ? { location_id: form.location_id } : {}) }, validate: isPostResponse,
      })
      current = response.post
      updatedAt.value = String(current.updated_at)
      record.value = current
      // Text may have committed before media fails. Keep that confirmed
      // baseline without replacing the author's pending media selection.
      savedSnapshot.value = JSON.stringify({ ...JSON.parse(savedSnapshot.value), title: current.title ?? '', body: current.body ?? '', callToAction: current.call_to_action ?? null, location_id: current.location_id })
      await syncMedia(postId, current)
      // Media changes advance the post's revision too; read it back once.
      return await reload(postId)
    } catch (err) {
      if (!postId && isRecord(err) && isRecord(err.data)) creationRejected.value = err.data.mutation_applied === false || isRecord(err.data.data) && err.data.data.mutation_applied === false
      error.value = getErrorMessage(err, 'Failed to save')
      return null
    } finally {
      saving.value = false
    }
  }

  function fieldsOf(saved: string) {
    const value = JSON.parse(saved || '{}') as { title?: string; body?: string; callToAction?: PostCallToAction | null }
    return {
      title: value.title?.trim() ? value.title : null,
      body: value.body?.trim() ? value.body : null,
      call_to_action: value.callToAction && value.callToAction.label.trim() && value.callToAction.url.trim() ? value.callToAction : null,
    }
  }

  /** Publishes to exactly the targets chosen; the outcome of each is the server's own. */
  async function publish(postId: string, targets: PublishTarget[]): Promise<PublishResult | null> {
    error.value = null
    publishing.value = true
    try {
      if (!updatedAt.value) throw new Error('The saved post must be read before publishing')
      const result = await dashboardApi<PublishResult>(`/api/editor/organizations/${organizationId}/posts/${postId}/publish`, {
        method: 'POST', body: { expected_updated_at: updatedAt.value, targets }, validate: isPublishResult,
      })
      if (result.outcomes.some(outcome => outcome.status === 'published')) trackPostPublished(postId, organizationId)
      await reload(postId)
      return result
    } catch (err) {
      error.value = getErrorMessage(err, 'Failed to publish')
      return null
    } finally {
      publishing.value = false
    }
  }

  async function reconcile(postId: string, publicationId: string): Promise<boolean> {
    error.value = null
    try {
      await dashboardApi(`/api/editor/organizations/${organizationId}/post-publications/${publicationId}/reconcile`, {
        method: 'POST', body: {}, validate: (value): value is ApiRecord => isRecord(value),
      })
      const current = await read(postId)
      if (isDirty.value) record.value = current
      else loadFrom(current)
      return true
    } catch (err) {
      error.value = getErrorMessage(err, 'Failed to check the publication')
      return false
    }
  }

  async function remove(postId: string): Promise<boolean> {
    error.value = null
    try {
      await dashboardApi(`/api/editor/organizations/${organizationId}/posts/${postId}`, {
        method: 'DELETE', validate: (value): value is { success: true } => isRecord(value) && value.success === true,
      })
      return true
    } catch (err) {
      error.value = getErrorMessage(err, 'Failed to delete')
      return false
    }
  }

  return { form, record, updatedAt, saving, publishing, creationRejected, isDirty, error, loadFrom, reload, save, publish, reconcile, remove }
}
