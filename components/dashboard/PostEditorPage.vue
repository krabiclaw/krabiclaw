<template>
  <DashboardIndexPanel id="post" :title="isNew ? 'New post' : 'Post'">
    <template v-if="post" #right>
      <UTooltip text="Preview">
        <UButton ref="previewButton" color="neutral" variant="ghost" icon="i-lucide-eye" aria-label="Preview" :to="previewPath" :disabled="busy || !viewUrl" class="size-10 rounded-full" data-testid="post-preview" />
      </UTooltip>
      <DashboardResourceLocalization :organization-id="organizationId" resource-type="content_document" :resource-id="String(post.id)" :resource-label="String(post.title || 'Post')" :fields="postLocalizationFields" :language-settings-path="organizationLocalizationSettingsPath" :disabled="busy" />
    </template>
    <UAlert v-if="loadError || editor.error.value || actionError" class="mb-6" color="error" title="Post could not be completed" :description="loadError || editor.error.value || actionError || ''" />
    <div v-if="!loadError" class="grid items-start gap-10 lg:grid-cols-2">
      <fieldset :disabled="busy || unconfirmedCreation" :inert="busy || unconfirmedCreation || undefined" class="min-w-0 space-y-8">
        <PostMediaFields v-model:media="editor.form.media" :organization-id="organizationId" />
        <UFormField label="Caption" :hint="`${POST_BODY_MAX - editor.form.body.length}/${POST_BODY_MAX}`">
          <UTextarea v-model="editor.form.body" aria-label="Caption" placeholder="Write a caption…" variant="none" :rows="4" autoresize :maxlength="POST_BODY_MAX" class="w-full" />
        </UFormField>
        <UCollapsible v-model:open="detailsOpen">
          <UButton label="More options" color="neutral" variant="link" trailing-icon="i-lucide-chevron-down" class="px-0" />
          <template #content>
            <div class="space-y-6 pt-6">
              <UFormField label="Headline" hint="Optional"><UInput v-model="editor.form.title" aria-label="Headline" class="w-full" :maxlength="POST_TITLE_MAX" /></UFormField>
              <UFormField label="Link button label" hint="Optional"><UInput :model-value="action.label" aria-label="Link button label" class="w-full" :maxlength="POST_CALL_TO_ACTION_LABEL_MAX" @update:model-value="writeAction('label', String($event))" /></UFormField>
              <UFormField label="Link destination" hint="Optional"><UInput :model-value="action.url" aria-label="Link destination" placeholder="https:// or tel:+66…" class="w-full" @update:model-value="writeAction('url', String($event))" /></UFormField>
              <UFormField v-if="organizationLocations.length" label="Location"><USelect v-model="locationChoice" aria-label="Location" :items="locationItems" class="w-full" /></UFormField>
            </div>
          </template>
        </UCollapsible>
        <p v-if="validationError" role="alert" class="text-sm text-error">{{ validationError }}</p>
        <div>
          <h2 class="text-lg font-semibold text-highlighted">Publish to</h2>
          <UAlert v-if="connectionsError" class="mt-4" color="error" title="Social accounts could not be read" :description="connectionsError" />
          <p v-if="connectionStatus === 'pending'" class="mt-4 text-sm text-muted">Reading social accounts…</p>
          <ul class="mt-2 divide-y divide-default">
            <li v-for="row in rows" :key="row.channel" class="flex items-start gap-3 py-5">
              <UIcon :name="row.icon" class="mt-0.5 size-5 shrink-0" aria-hidden="true" />
              <div class="min-w-0 flex-1">
                <p class="text-base text-highlighted">{{ row.name }}<span v-if="row.target" class="text-muted"> · {{ row.target }}</span></p>
                <p class="mt-1 text-sm" :class="row.tone">{{ row.state }}</p>
                <p v-if="row.detail" class="mt-1 text-sm text-muted">{{ row.detail }}</p>
                <div v-if="row.url || row.reconcileId || row.connectUrl" class="mt-2 flex flex-wrap gap-2">
                  <UButton v-if="row.url" :to="row.url" target="_blank" color="neutral" variant="link" size="sm">View</UButton>
                  <UButton v-if="row.reconcileId" color="neutral" variant="link" size="sm" :loading="reconciling === row.reconcileId" @click="reconcile(row.reconcileId)">Check with {{ row.name }}</UButton>
                  <UButton v-if="row.connectUrl" :to="row.connectUrl" target="_blank" :aria-label="`Connect ${row.name} (opens in a new tab)`" color="neutral" variant="link" size="sm" trailing-icon="i-lucide-external-link">Connect</UButton>
                </div>
              </div>
              <UCheckbox v-if="row.selectable" :model-value="selected.includes(row.channel)" :aria-label="`Publish to ${row.name}`" class="mt-1" @update:model-value="toggle(row.channel, $event === true)" />
            </li>
          </ul>
        </div>
      </fieldset>
      <section class="hidden min-w-0 lg:sticky lg:top-0 lg:block" aria-label="Post preview">
        <h2 class="mb-4 text-sm font-semibold text-muted">Preview</h2>
        <SocialPostMedia v-if="previewMedia.length" :media="previewMedia" :title="editor.form.title || undefined" :description="editor.form.body" fit="contain" frame-class="aspect-square overflow-hidden rounded-xl bg-elevated" eager />
        <h3 v-if="editor.form.title" class="mt-5 break-words text-xl font-semibold text-highlighted">{{ editor.form.title }}</h3>
        <p v-if="editor.form.body" class="mt-4 whitespace-pre-line break-words text-base leading-relaxed [overflow-wrap:anywhere]">{{ editor.form.body }}</p>
        <p v-if="!previewMedia.length && !editor.form.title && !editor.form.body" class="py-12 text-muted">Your photo and caption will appear here.</p>
        <span v-if="editor.form.callToAction?.label" class="mt-5 inline-block rounded-full border border-default px-4 py-2 text-sm font-semibold">{{ editor.form.callToAction.label }}</span>
      </section>
    </div>
    <template #footer>
      <DashboardPanelFooter :save-label="post?.status === 'published' && !selected.length ? 'Save changes' : 'Publish'" :loading="busy" :disabled="post?.status === 'published' && !selected.length ? !canSave : !canPublish" @cancel="cancel" @save="commit(post?.status !== 'published' || selected.length > 0)">
        <template v-if="post?.status !== 'published'" #secondary><UButton label="Save draft" color="neutral" variant="link" :disabled="!canSave || busy" @click="commit(false)" /></template>
      </DashboardPanelFooter>
    </template>
  </DashboardIndexPanel>
  <DashboardContentPreview v-model:open="previewOpen" title="Post preview" :content-title="String(post?.title ?? '')" :src="viewUrl" :public-url="publicUrl" :viewport="previewViewport" :error="previewFailure" @update:viewport="changePreviewViewport" @after:leave="restorePreviewFocus" />
</template>

<script setup lang="ts">
import { useEventListener } from '@vueuse/core'
import { isNavigationFailure, onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'
import DashboardResourceLocalization from '~/components/dashboard/DashboardResourceLocalization.vue'
import DashboardContentPreview from '~/components/dashboard/DashboardContentPreview.vue'
import PostMediaFields from '~/components/dashboard/PostMediaFields.vue'
import SocialPostMedia from '~/components/social/SocialPostMedia.vue'
import { usePostEditor, type PostMediaFormItem, type PublishOutcome, type PublishTarget, type SocialChannel } from '~/composables/usePostEditor'
import type { PublicPostMedia } from '~/server/utils/post-management'
import { parsePostInput, POST_BODY_MAX, POST_TITLE_MAX, POST_CALL_TO_ACTION_LABEL_MAX, type PostCallToAction } from '~/shared/posts'
import { isBlogPostResponse } from '~/lib/components/workspace/blog/blog-response-contracts'
import { getErrorMessage, isNotFoundError } from '~/utils/errors'

const route = useRoute()
const level = useRouteLevel()
const dashboardApi = useDashboardApi()
const toast = useToast()
const dashboard = useDashboardOrganization()
const organizationId = await useDashboardOrganizationId()
const postId = String(route.params.postId ?? '')
const isNew = postId === 'new'
const scopeLocationId = useLocationScope()
const editor = usePostEditor(organizationId, scopeLocationId)
const { locations: organizationLocations } = await useOrganizationLocations()
const sourceArticleId = typeof route.query.article_id === 'string' && route.query.article_id.trim() ? route.query.article_id : null
if (route.query.article_id !== undefined && !sourceArticleId) throw createError({ statusCode: 400, statusMessage: 'An article ID is required' })
if (route.query.channel !== undefined && route.query.channel !== 'facebook') throw createError({ statusCode: 400, statusMessage: 'Unsupported prepared channel' })
const { data: sourceArticle, error: sourceError } = await useAsyncData(`post-source-article:${organizationId}:${sourceArticleId ?? ''}`, async () => {
  if (!isNew || !sourceArticleId) return null
  const response = await dashboardApi(`/api/editor/organizations/${organizationId}/blog/${encodeURIComponent(sourceArticleId)}`, { validate: isBlogPostResponse })
  if (response.post.status !== 'published' || !response.post.public_path) throw createError({ statusCode: 409, statusMessage: 'Publish the article before preparing a social post' })
  const origin = dashboard.organization.value?.public_url
  if (!origin) throw createError({ statusCode: 409, statusMessage: 'The website needs a public address before sharing an article' })
  return { article: response.post, url: new URL(response.post.public_path, origin).toString() }
})
const { data, error } = await useAsyncData(`dashboard-post:${organizationId}:${postId}`, async () => isNew ? null : dashboardApi(`/api/editor/organizations/${organizationId}/posts/${postId}`, {
  validate: (value): value is { post: ApiRecord } => isRecord(value) && isRecord(value.post) && typeof value.post.id === 'string',
}))
if (isNotFoundError(error.value) || isNotFoundError(sourceError.value)) throw createError({ statusCode: 404, statusMessage: 'Post or article not found' })
const loadError = computed(() => sourceError.value || error.value ? getErrorMessage(sourceError.value ?? error.value, 'The post could not be loaded') : null)
if (data.value?.post) editor.loadFrom(data.value.post)
const post = editor.record

function initialDraft() {
  const source = sourceArticle.value
  return {
    location_id: scopeLocationId.value, title: source?.article.title ?? '',
    body: source ? [source.article.title, source.article.excerpt].filter(Boolean).join('\n\n') : '',
    callToAction: source ? { label: 'Read article', url: source.url } as PostCallToAction : null,
    media: source?.article.cover ? [{ ...source.article.cover, slot: 'cover' as const, alt_text: source.article.cover.alt_text ?? '' }] as PostMediaFormItem[] : [],
    idempotency_key: crypto.randomUUID(),
    submitted: false,
    created_id: null as string | null,
    selected: [] as Array<'organization' | SocialChannel>,
  }
}
const draftKey = `post-draft:${organizationId}:${scopeLocationId.value ?? ''}:${sourceArticleId ?? ''}`
const draft = useState(draftKey, initialDraft)
if (isNew) {
  if (draft.value.created_id) await editor.reload(draft.value.created_id)
  else Object.assign(editor.form, { title: draft.value.title, body: draft.value.body, callToAction: draft.value.callToAction, media: draft.value.media, location_id: draft.value.location_id })
  watch(editor.form, value => { Object.assign(draft.value, { title: value.title, body: value.body, callToAction: value.callToAction, media: value.media, location_id: value.location_id }) }, { deep: true, flush: 'sync' })
}
const selected = ref<Array<'organization' | SocialChannel>>(isNew ? [...draft.value.selected] : [])
if (isNew) watch(selected, value => { draft.value.selected = value }, { flush: 'sync' })
const detailsOpen = ref(Boolean(editor.form.title || editor.form.callToAction))
const action = computed(() => editor.form.callToAction ?? { label: '', url: '' })
function writeAction(field: 'label' | 'url', value: string) {
  const next = { ...action.value, [field]: value }
  editor.form.callToAction = next.label.trim() || next.url.trim() ? next : null
}
const WHOLE_WEBSITE = 'whole-website'
const locationItems = computed(() => [{ label: 'Whole website', value: WHOLE_WEBSITE }, ...organizationLocations.value.map(location => ({ label: location.title, value: location.id }))])
const locationChoice = computed({ get: () => editor.form.location_id ?? WHOLE_WEBSITE, set: (value: string) => { editor.form.location_id = value === WHOLE_WEBSITE ? null : value; selected.value = selected.value.filter(channel => channel === 'organization') } })
const previewMedia = computed<PublicPostMedia[]>(() => editor.form.media.filter((item): item is PostMediaFormItem & { public_url: string } => Boolean(item.asset_id && item.public_url)).map(item => ({ asset_id: item.asset_id, public_url: item.public_url, thumbnail_url: item.thumbnail_url ?? null, kind: item.kind === 'video' ? 'video' : 'image', alt_text: item.alt_text, width: null, height: null })))

interface Channel { channel: SocialChannel; connected: boolean; target_id: string | null; target_name: string | null; connection_revision: string | null; problems: Array<{ code: string; message: string }>; connect_url: string }
const { data: connections, error: connectionFailure, status: connectionStatus, refresh: refreshConnections } = await useAsyncData(
  () => `post-publish-targets:${organizationId}:${editor.form.location_id ?? ''}`,
  () => dashboardApi('/api/integrations/social-connections', { query: { locationId: editor.form.location_id ?? '' }, validate: (value): value is { channels: Channel[] } => isRecord(value) && Array.isArray(value.channels) }),
)
useEventListener(import.meta.client ? window : undefined, 'focus', () => refreshConnections())
const connectionsError = computed(() => connectionFailure.value ? getErrorMessage(connectionFailure.value, 'Failed to read connections') : null)
const lastOutcomes = ref<PublishOutcome[]>([])
const reconciling = ref<string | null>(null)
const CHANNELS: Record<SocialChannel, { name: string; icon: string }> = { facebook: { name: 'Facebook', icon: 'i-logos-facebook' }, instagram: { name: 'Instagram', icon: 'i-skill-icons-instagram' }, discord: { name: 'Discord', icon: 'i-logos-discord-icon' } }
const STATE_WORDS: Record<string, string> = { published: 'Published', preparing: 'Being prepared', publishing: 'Publishing', failed: 'Not published', unknown: 'Outcome unknown — check it', removed: 'Removed from the channel' }
const rows = computed(() => {
  const record = post.value
  const publications = Array.isArray(record?.publications) ? record.publications as ApiRecord[] : []
  const outcome = (channel: string) => lastOutcomes.value.find(item => item.channel === channel)
  return [{ channel: 'organization' as const, name: 'Website', icon: 'i-lucide-globe', target: null as string | null,
    selectable: record?.status !== 'published', state: record?.status === 'published' ? 'Live' : 'Not published', tone: record?.status === 'published' ? 'text-success' : 'text-muted',
    detail: outcome('organization')?.message ?? null, url: record?.status === 'published' && typeof record.canonical_url === 'string' ? record.canonical_url : null,
    reconcileId: null as string | null, connectUrl: null as string | null,
  }, ...(connectionStatus.value === 'success' ? connections.value?.channels ?? [] : []).map(channel => {
    const publication = publications.find(item => item.channel === channel.channel)
    const state = publication ? String(publication.state) : null
    const blocked = !channel.connected || channel.problems.length > 0
    return { channel: channel.channel, ...CHANNELS[channel.channel], target: channel.target_name,
      selectable: !blocked && (!publication || state === 'failed' || state === 'preparing'),
      state: state ? STATE_WORDS[state] ?? state : blocked ? channel.problems.map(problem => problem.message).join(' ') || 'Not connected' : 'Not published',
      tone: state === 'published' ? 'text-success' : state === 'failed' || state === 'unknown' ? 'text-warning' : 'text-muted',
      detail: outcome(channel.channel)?.message ?? (publication?.message ? String(publication.message) : null) ?? (publication?.local_content_changed ? 'The post changed here after it was sent; the external post was not edited.' : null),
      url: typeof publication?.public_url === 'string' ? publication.public_url : null,
      reconcileId: state === 'unknown' ? String(publication!.id) : null, connectUrl: channel.connected ? null : channel.connect_url,
    }
  })]
})
if (isNew && route.query.channel === 'facebook' && !selected.value.length && rows.value.find(row => row.channel === 'facebook')?.selectable) selected.value = ['facebook']
watch(() => JSON.stringify(connections.value?.channels.map(channel => [channel.channel, channel.target_id, channel.connection_revision, channel.connected, channel.problems])), () => { selected.value = selected.value.filter(channel => channel === 'organization') })
function toggle(channel: 'organization' | SocialChannel, checked: boolean) { selected.value = checked ? [...new Set([...selected.value, channel])] : selected.value.filter(item => item !== channel) }
const committing = ref(false)
const busy = computed(() => committing.value || editor.saving.value || editor.publishing.value)
const unconfirmedCreation = computed(() => isNew && draft.value.submitted && !post.value)
const actionError = ref('')
const validationError = computed(() => {
  try {
    parsePostInput({ title: editor.form.title, body: editor.form.body, call_to_action: editor.form.callToAction, location_id: editor.form.location_id, media: editor.form.media.map(item => ({ asset_id: item.asset_id, slot: item.slot })) }, 'create')
    return null
  } catch (cause) { return getErrorMessage(cause, 'Check the post before saving') }
})
const valid = computed(() => !loadError.value && !validationError.value)
const hasContent = computed(() => Boolean(editor.form.body.trim() || editor.form.title.trim() || editor.form.media.some(item => item.asset_id)))
const canSave = computed(() => valid.value && (isNew ? hasContent.value : editor.isDirty.value))
const canPublish = computed(() => valid.value && hasContent.value && selected.value.length > 0 && selected.value.every(channel => rows.value.some(row => row.channel === channel && row.selectable)))

async function commit(publish: boolean) {
  if (busy.value || (publish ? !canPublish.value : !canSave.value)) return
  committing.value = true
  actionError.value = ''
  try {
    const targets: PublishTarget[] = publish ? selected.value.map(channel => {
      if (channel === 'organization') return { channel }
      const connection = connections.value?.channels.find(item => item.channel === channel)
      if (!connection?.target_id || !connection.connection_revision) throw new Error(`The ${channel} destination must be read before publishing`)
      return { channel, target_id: connection.target_id, connection_revision: connection.connection_revision }
    }) : []
    if (isNew && !post.value) draft.value.submitted = true
    const saved = post.value && !editor.isDirty.value ? post.value : await editor.save(post.value ? String(post.value.id) : isNew ? null : postId, draft.value.idempotency_key)
    if (!saved) {
      if (isNew && editor.creationRejected.value) {
        draft.value.submitted = false
        draft.value.idempotency_key = crypto.randomUUID()
      }
      return
    }
    if (isNew) draft.value.created_id = String(saved.id)
    if (publish) {
      const result = await editor.publish(String(saved.id), targets)
      if (result) {
        lastOutcomes.value = result.outcomes
        selected.value = selected.value.filter(channel => result.outcomes.some(outcome => outcome.channel === channel && outcome.status === 'failed'))
      }
      const failures = result?.outcomes.filter(outcome => !['published', 'already_published'].includes(outcome.status))
      if (!result || failures?.length) toast.add({ title: 'Post saved', description: editor.error.value || failures?.map(outcome => outcome.message || `${outcome.channel}: ${outcome.status}`).join(' · ') || 'Check the publication results before trying again.', color: 'warning' })
    } else toast.add({ title: saved.status === 'published' ? 'Changes saved' : 'Draft saved', color: 'success' })
    await refreshNuxtData()
    if (isNew) {
      const { article_id: _articleId, ...query } = route.query
      const navigation = await navigateTo({ path: level.path.value.replace(/\/new$/, `/${String(saved.id)}`), query }, { replace: true })
      if (isNavigationFailure(navigation)) throw navigation
      clearNuxtState(draftKey)
    }
  } catch (cause) { actionError.value = getErrorMessage(cause, 'The post could not be completed') } finally { committing.value = false }
}
async function reconcile(publicationId: string) {
  reconciling.value = publicationId
  try { await editor.reconcile(String(post.value!.id), publicationId) } finally { reconciling.value = null }
}
async function cancel() {
  if (busy.value) return
  if (!level.to.value) throw new Error('The post has no parent destination')
  await navigateTo(level.to.value)
}
onBeforeRouteLeave(to => !busy.value || Boolean(post.value && to.path === level.path.value.replace(/\/new$/, `/${String(post.value.id)}`)))
onBeforeRouteUpdate(to => !busy.value || to.path === route.path && to.query.article_id === route.query.article_id && to.query.location_id === route.query.location_id || Boolean(post.value && to.path === level.path.value.replace(/\/new$/, `/${String(post.value.id)}`)))
onUnmounted(() => { if (isNew && !draft.value.submitted) clearNuxtState(draftKey) })
const viewUrl = computed(() => {
  const value = post.value?.status === 'published' ? post.value.canonical_url : post.value?.preview_url
  return typeof value === 'string' && value ? value : null
})
const publicUrl = computed(() => post.value?.status === 'published' ? viewUrl.value : null)
const { previewButton, previewPath, previewOpen, previewViewport, previewFailure, changePreviewViewport, restorePreviewFocus } = useDashboardContentPreview(computed(() => loadError.value || (!viewUrl.value ? 'The saved post could not be loaded for preview.' : '')))
const organizationLocalizationSettingsPath = `/dashboard/${route.params.orgSlug}/website/localization`
const postLocalizationFields = computed(() => [{ key: 'title', label: 'Title', source: post.value?.title }, { key: 'summary', label: 'Caption', source: post.value?.body, multiline: true, rows: 6 }, ...(isRecord(post.value?.call_to_action) ? [{ key: 'metadata.call_to_action.label', label: 'Link button label', source: post.value.call_to_action.label }] : [])])
useSeoMeta({ title: `${isNew ? 'New post' : 'Post'} | KrabiClaw Dashboard`, robots: 'noindex, nofollow' })
</script>
