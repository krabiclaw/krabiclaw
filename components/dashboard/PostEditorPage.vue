<template>
  <!-- A post: its rows are the things it holds, each a leaf below this level. -->
  <DashboardIndexPanel id="post" :title="isNew ? 'New post' : editor.form.title || 'Post'" :auto-open="navigationGroups[0]?.items.find(item => item.to)?.to ?? null">
    <template v-if="post" #right>
      <DashboardResourceLocalization
        :organization-id="organizationId"
        resource-type="content_document"
        :resource-id="postId"
        resource-label="post"
        :fields="postLocalizationFields"
        :route-path="localizedPostPath"
        :language-settings-path="organizationLocalizationSettingsPath"
      />
    </template>

    <UAlert v-if="loadError" color="error" variant="soft" icon="i-lucide-triangle-alert" title="Post could not be loaded" :description="loadError" />
    <template v-else>
      <div v-if="isNew" class="mb-6 flex justify-end">
        <UButton :label="createActionLabel" :loading="editor.saving.value" @click="startOrCreate" />
      </div>
      <!-- The post as a visitor will see it, before and after it is live. -->
      <div v-if="post" class="mb-6 flex flex-wrap items-center gap-2">
        <UBadge :color="post.status === 'published' ? 'success' : 'neutral'" variant="soft">{{ post.status === 'published' ? 'Live on the website' : 'Draft' }}</UBadge>
        <UButton v-if="viewUrl" :to="viewUrl" target="_blank" size="sm" color="neutral" variant="soft" icon="i-lucide-external-link">
          {{ post.status === 'published' ? 'View post' : 'Preview' }}
        </UButton>
      </div>
      <EditorNavigationList :groups="navigationGroups" :active-item="level.child.value" />
    </template>
  </DashboardIndexPanel>
</template>

<script lang="ts">
import type { ComputedRef, InjectionKey, Ref } from 'vue'
import type { DashboardLocation } from '~/composables/useDashboardOrganization'

export const SECTION_KEYS = ['photo', 'headline', 'body', 'action', 'location', 'publishing'] as const
export type SectionKey = typeof SECTION_KEYS[number]

/** The post's draft and what its leaves show or do beside their one field. */
export interface PostEditor {
  editor: ReturnType<typeof usePostEditor>
  organizationLocations: ComputedRef<DashboardLocation[]>
  organizationId: string
  postId: ComputedRef<string>
  isNew: ComputedRef<boolean>
  post: ComputedRef<ApiRecord | null>
  loadError: ComputedRef<string | null>
  sectionLabels: ComputedRef<Record<SectionKey, string>>
  saveLabel: Ref<string | undefined>
  saveDisabled: Ref<boolean>
  revert: () => void
  save: () => Promise<void>
}

export const postEditorKey = Symbol('post-editor') as InjectionKey<PostEditor>
</script>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationGroup } from '~/components/dashboard/EditorNavigationList.vue'
import DashboardResourceLocalization from '~/components/dashboard/DashboardResourceLocalization.vue'
import { usePostEditor, type PostMediaFormItem } from '~/composables/usePostEditor'
import type { PostCallToAction } from '~/shared/posts'
import { isBlogPostResponse } from '~/lib/components/workspace/blog/blog-response-contracts'
import { getErrorMessage, isNotFoundError } from '~/utils/errors'

const route = useRoute()
const router = useRouter()
const dashboardApi = useDashboardApi()
const postId = computed(() => String(route.params.postId ?? ''))
const level = useRouteLevel()
const postPath = level.path

const organizationId = await useDashboardOrganizationId()
const isNew = computed(() => postId.value === 'new')
// Where a new post is written: the location the list was scoped to, or the whole website.
const scopeLocationId = useLocationScope()
const editor = usePostEditor(organizationId, scopeLocationId)
const { locations: organizationLocations } = await useOrganizationLocations()
const dashboard = useDashboardOrganization()
const sourceArticleId = computed(() => typeof route.query.article_id === 'string' && route.query.article_id.trim() ? route.query.article_id : null)
watchEffect(() => {
  if (route.query.article_id !== undefined && !sourceArticleId.value) showError(createError({ statusCode: 400, statusMessage: 'An article ID is required' }))
  if (route.query.channel !== undefined && route.query.channel !== 'facebook') showError(createError({ statusCode: 400, statusMessage: 'Unsupported prepared channel' }))
})
const { data: sourceArticle, error: sourceError } = await useAsyncData(
  () => `post-source-article:${organizationId}:${sourceArticleId.value ?? ''}`,
  async () => {
    if (!isNew.value || !sourceArticleId.value) return null
    const response = await dashboardApi(`/api/editor/organizations/${organizationId}/blog/${encodeURIComponent(sourceArticleId.value)}`, { validate: isBlogPostResponse })
    if (response.post.status !== 'published' || !response.post.public_path) throw createError({ statusCode: 409, statusMessage: 'Publish the article before preparing a social post' })
    const origin = dashboard.organization.value?.public_url
    if (!origin) throw createError({ statusCode: 409, statusMessage: 'The website needs a public address before sharing an article' })
    return { article: response.post, url: new URL(response.post.public_path, origin).toString() }
  },
)

const sectionLabels = computed<Record<SectionKey, string>>(() => ({
  photo: 'Photos and video',
  headline: 'Headline',
  body: 'Caption',
  action: 'Link button',
  publishing: 'Where it is published',
  location: 'Location',
}))
const detailKey = computed(() => level.child.value)
const editorKey = computed<SectionKey>(() => (detailKey.value ?? (isNew.value ? 'body' : 'photo')) as SectionKey)

const isSinglePostResponse = (value: unknown): value is { post: ApiRecord } => isRecord(value) && isRecord(value.post) && typeof value.post.id === 'string'
const { data, error } = await useAsyncData(
  computed(() => `dashboard-post:${organizationId}:${postId.value}`),
  async () => isNew.value ? null : await dashboardApi<{ post: ApiRecord }>(`/api/editor/organizations/${organizationId}/posts/${postId.value}`, { validate: isSinglePostResponse }),
  { watch: [postId] },
)
watchEffect(() => {
  if (isNotFoundError(error.value)) showError(createError({ statusCode: 404, statusMessage: 'Post not found' }))
})
const loadError = computed(() => {
  const cause = sourceError.value ?? error.value
  return cause && !isNotFoundError(cause) ? getErrorMessage(cause, 'Failed to load the post') : null
})
watchEffect(() => {
  if (isNotFoundError(sourceError.value)) showError(createError({ statusCode: 404, statusMessage: 'Article not found' }))
})
// The record as the editor last read it: a save or publish reads it again.
watch(() => data.value?.post ?? null, value => { if (value) editor.loadFrom(value) }, { immediate: true })
const post = computed(() => editor.record.value)

// ── The new post's draft ────────────────────────────────
/**
 * A half-written new post survives the walk between its own sections, which
 * remount this component, and carries the idempotency key its creation is sent
 * under, so a double press or a retried request makes one post.
 */
function initialDraft() {
  const source = sourceArticle.value?.article.id === sourceArticleId.value ? sourceArticle.value : null
  return {
    location_id: scopeLocationId.value, source_article_id: source?.article.id ?? null,
    title: source?.article.title ?? '',
    body: source ? [source.article.title, source.article.excerpt].filter(Boolean).join('\n\n') : '',
    callToAction: source ? { label: 'Read article', url: source.url } as PostCallToAction : null,
    media: source?.article.cover ? [{ ...source.article.cover, slot: 'cover' as const, alt_text: source.article.cover.alt_text ?? '' }] as PostMediaFormItem[] : [],
    idempotency_key: crypto.randomUUID(),
  }
}
const draftKey = `post-draft-${organizationId}-${postId.value}`
const draft = useState(draftKey, initialDraft)
function restoreDraft() {
  editor.form.title = draft.value.title
  editor.form.body = draft.value.body
  editor.form.callToAction = draft.value.callToAction
  editor.form.media = draft.value.media
  editor.form.location_id = draft.value.location_id
}
if (isNew.value) {
  watch([sourceArticle, scopeLocationId], () => {
    if (!isNew.value) return
    if (draft.value.location_id !== scopeLocationId.value || draft.value.source_article_id !== sourceArticleId.value) {
      draft.value = initialDraft()
    }
    restoreDraft()
  }, { immediate: true })
  watch(() => editor.form.body, value => { draft.value.body = value }, { flush: 'sync' })
  watch(() => editor.form.title, value => { draft.value.title = value }, { flush: 'sync' })
  watch(() => editor.form.callToAction, value => { draft.value.callToAction = value }, { deep: true, flush: 'sync' })
  watch(() => editor.form.media, value => { draft.value.media = value }, { deep: true, flush: 'sync' })
}

// ── The index ─────────────────────────────────────────────
function mediaSummary(): string {
  const count = editor.form.media.length
  return count ? `${count} ${count === 1 ? 'item' : 'items'}` : 'No photos or video'
}

function publishingSummary(): string {
  const record = post.value
  if (!record) return 'Website'
  const parts = [record.status === 'published' ? 'Website' : 'Not on the website yet']
  for (const publication of Array.isArray(record.publications) ? record.publications as ApiRecord[] : []) {
    const name = publication.channel === 'facebook' ? 'Facebook' : 'Instagram'
    parts.push(`${name}: ${String(publication.state)}`)
  }
  return parts.join(' · ')
}

/** A URL beneath this post that keeps the list's scope, so Back returns to the same list. */
function sectionPath(section: string) {
  return router.resolve({ path: `${postPath.value}/${section}`, query: route.query }).fullPath
}
function locationSummary(): string {
  const id = editor.form.location_id
  return id ? organizationLocations.value.find(location => location.id === id)?.title ?? 'Location' : 'Whole website'
}

// One flat list: what the post says, where it belongs, and where it is published.
const navigationGroups = computed<EditorNavigationGroup[]>(() => {
  const body = { id: 'body', label: 'Caption', summary: editor.form.body || 'No caption', placeholder: !editor.form.body, to: sectionPath('body') }
  if (isNew.value) return [{ id: 'new-post', items: [body] }]
  const action = editor.form.callToAction
  return [{ id: 'post', items: [
    { id: 'photo', label: 'Photos and video', summary: mediaSummary(), placeholder: !editor.form.media.length, to: sectionPath('photo') },
    { id: 'headline', label: 'Headline', summary: editor.form.title || 'No headline', placeholder: !editor.form.title, to: sectionPath('headline') },
    body,
    { id: 'action', label: 'Link button', summary: action ? `${action.label} → ${action.url}` : 'No button', placeholder: !action, to: sectionPath('action') },
    { id: 'location', label: 'Location', summary: locationSummary(), to: sectionPath('location') },
    { id: 'publishing', label: 'Where it is published', summary: publishingSummary(), to: sectionPath('publishing') },
  ] }]
})
const openSections = computed(() => navigationGroups.value.flatMap(group => group.items.map(item => item.id)))
watchEffect(() => {
  if (!isNew.value && !post.value) return
  if (detailKey.value && !openSections.value.includes(detailKey.value)) showError(createError({ statusCode: 404, statusMessage: 'Page not found' }))
})

// ── Save / cancel ───────────────────────────────────────
const sectionValid = computed(() => {
  if (editorKey.value !== 'action') return true
  const action = editor.form.callToAction
  return !action || (Boolean(action.label.trim()) && Boolean(action.url.trim()))
})
const { createActionLabel, saveLabel, saveDisabled: walkSaveDisabled, save: saveCurrentEditor, startOrCreate } = useCreateWalk<SectionKey>({
  recordPath: postPath,
  isNew,
  openKey: editorKey,
  labels: sectionLabels,
  // A draft may be empty: nothing is required to create one.
  order: ['body'],
  missing: () => false,
  noun: 'post',
  saving: editor.saving,
  existingBlocked: () => !sectionValid.value,
  commit,
})

const saveDisabled = computed(() => Boolean(loadError.value) || walkSaveDisabled.value)

async function commit() {
  if (loadError.value) return
  if (isNew.value) {
    const created = await editor.save(null, draft.value.idempotency_key)
    if (!created?.id) return
    const { article_id: _articleId, ...query } = route.query
    const path = postPath.value.replace(/\/new$/, `/${String(created.id)}`)
    await navigateTo(router.resolve({ path: route.query.channel === 'facebook' ? `${path}/publishing` : path, query }).fullPath, { replace: true })
    clearNuxtState(draftKey)
    return
  }
  if (await editor.save(postId.value)) await level.close()
}

function revert() {
  if (isNew.value) {
    draft.value = initialDraft()
    restoreDraft()
  }
  if (post.value) editor.loadFrom(post.value)
}

const viewUrl = computed(() => {
  const record = post.value
  if (!record) return null
  // Both are absolute on the site's own domain; the dashboard is another host.
  return record.status === 'published' ? record.canonical_url : record.preview_url
})

const organizationLocalizationSettingsPath = computed(() => `/dashboard/${route.params.orgSlug}/website/localization`)
const postLocalizationFields = computed(() => [
  { key: 'title', label: 'Title', source: post.value?.title },
  { key: 'summary', label: 'Caption', source: post.value?.body, multiline: true, rows: 6 },
  ...(isRecord(post.value?.call_to_action) ? [{ key: 'metadata.call_to_action.label', label: 'Link button label', source: post.value.call_to_action.label }] : []),
])
function localizedPostPath(locale: string): string {
  const slug = post.value?.slug
  if (typeof slug !== 'string' || !slug) throw new Error('The post slug is unavailable.')
  return `/${locale}/posts/${slug}`
}

useSeoMeta({ title: () => `${isNew.value ? 'New post' : editor.form.title || 'Post'} | Krabiclaw Dashboard`, robots: 'noindex, nofollow' })
provide(postEditorKey, { editor, organizationLocations, organizationId, postId, isNew, post, loadError, sectionLabels, saveLabel, saveDisabled, revert, save: saveCurrentEditor })
</script>
