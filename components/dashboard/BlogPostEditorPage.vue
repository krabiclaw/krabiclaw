<template>
  <!-- A post being made gives its headline first; the article is written once it exists. -->
  <DashboardIndexPanel v-if="isNew" id="organization-blog-new" :title="newTitle" :create="firstStep">
    <UAlert v-if="createFailure" color="error" variant="soft" :description="createFailure" />
    <EditorNavigationList :groups="createGroups" :active-item="level.child.value" />
  </DashboardIndexPanel>

  <UAlert
    v-else-if="loadError"
    color="error"
    variant="soft"
    icon="i-lucide-triangle-alert"
    title="Post could not be loaded"
    :description="loadError"
  />

  <BlogPostEditor
    v-else-if="postResource"
    :repository="repository"
    :initial-post="postResource.post"
    :organization-id="organizationId"
    :back-url="blogPath"
    back-label="Blog"
    panel-id="organization-blog-post"
    :media-picker-component="MediaPicker"
  >
    <template #actions>
      <DashboardResourceLocalization
        :organization-id="organizationId"
        resource-type="content_document"
        :resource-id="postId"
        resource-label="post"
        :fields="blogLocalizationFields"
        :load-values="loadBlogLocalization"
        :save-values="saveBlogLocalization"
        :language-settings-path="organizationLocalizationSettingsPath"
      />
    </template>
  </BlogPostEditor>
</template>

<script lang="ts">
import type { InjectionKey, Ref } from 'vue'

/** The headline a post is made with, for its one create leaf. */
export interface BlogPostCreateEditor {
  draft: Ref<{ title: string; idempotency_key: string }>
  saving: Ref<boolean>
  error: Ref<string | null>
  saveLabel: Ref<string | undefined>
  saveDisabled: Ref<boolean>
  save: () => Promise<void>
  revert: () => void
}

export const blogPostCreateKey = Symbol('blog-post-create') as InjectionKey<BlogPostCreateEditor>
</script>

<script setup lang="ts">
import { isNavigationFailure } from 'vue-router'
import EditorNavigationList from '~/components/dashboard/EditorNavigationList.vue'
import DashboardResourceLocalization from '~/components/dashboard/DashboardResourceLocalization.vue'
import { tenantBlogRepository } from '~/lib/components/workspace/blog/tenantBlogRepository'
import { isBlogPostResponse } from '~/lib/components/workspace/blog/blog-response-contracts'
import BlogPostEditor from '~/lib/components/workspace/blog/BlogPostEditor.vue'
import MediaPicker from '~/lib/components/workspace/media/MediaPicker.vue'
import type { BlogEditorBlock, BlogPost } from '~/lib/components/workspace/blog/types'
import { blankBlogLocalizedText, blogLocalizedTextFields, initialBlogEditorBlocks, writeBlogLocalizedText, type BlogLocalizedFieldPath } from '~/utils/blog-editor'
import { getErrorMessage, isNotFoundError } from '~/utils/errors'

// One post. Rendered by `blog.vue`, which owns the frame — this level draws its
// own panel and navbar because it is the outermost level on screen.
const route = useRoute()
const orgSlug = route.params.orgSlug as string
const organizationId = await useDashboardOrganizationId()
const postId = String(route.params.postId || '')
if (!postId) throw createError({ statusCode: 400, statusMessage: 'Post ID is required' })

const blogPath = `/dashboard/${orgSlug}/website/blog`
const organizationLocalizationSettingsPath = `/dashboard/${orgSlug}/website/localization`
const level = useRouteLevel()
const isNew = postId === 'new'
const repository = tenantBlogRepository({ organizationId, orgSlug })

// ── A post being made ───────────────────────────────────
const blankDraft = () => ({ title: '', idempotency_key: crypto.randomUUID() })
const draftKey = `blog-create:${organizationId}`
const draft = useState(draftKey, blankDraft)
const creating = ref(false)
const createFailure = ref<string | null>(null)
const createGroups = computed(() => [{ id: 'new-article', items: [{
  id: 'headline', label: 'Headline', summary: draft.value.title || 'No headline',
  placeholder: !draft.value.title, to: `${level.path.value}/headline`,
}] }])
const { title: newTitle, firstStep, saveLabel, saveDisabled, save } = useCreateWalk({
  recordPath: level.path, isNew: computed(() => isNew), openKey: computed(() => 'headline' as const),
  labels: { headline: 'Headline' }, order: ['headline'], missing: () => !draft.value.title.trim(),
  noun: 'post', saving: creating, commit: createPost,
})
async function createPost() {
  creating.value = true
  createFailure.value = null
  try {
    const post = await repository.create({ title: draft.value.title.trim(), content_blocks: initialBlogEditorBlocks(), idempotency_key: draft.value.idempotency_key })
    const navigation = await navigateTo(repository.editUrl(post.id), { replace: true })
    if (isNavigationFailure(navigation)) throw navigation
    clearNuxtState(draftKey)
  } catch (cause) {
    createFailure.value = getErrorMessage(cause, 'Failed to create the post.')
  } finally {
    creating.value = false
  }
}
provide(blogPostCreateKey, { draft, saving: creating, error: createFailure, saveLabel, saveDisabled, save, revert: () => { draft.value = blankDraft() } })
// Only the headline is asked before a post exists, and an existing post's headline is its document's.
watchEffect(() => {
  const child = level.child.value
  if (child && (isNew ? child !== 'headline' : child === 'headline')) showError(createError({ statusCode: 404, statusMessage: 'Page not found' }))
})

// ── An existing post ────────────────────────────────────
const { data: postResource, error: postError } = await useAsyncData(
  `dashboard-blog-post:${organizationId}:${postId}`,
  () => isNew ? Promise.resolve(null) : dashboardFetch<{ post: BlogPost }>(
    `/api/editor/organizations/${organizationId}/blog/${postId}`,
    { orgSlug },
    { validate: isBlogPostResponse },
  ),
)

// A post that is not there is not a page. A request that failed is a state this
// surface shows, because the post may well still exist.
watchEffect(() => {
  if (postError.value && isNotFoundError(postError.value)) {
    showError(createError({ statusCode: 404, statusMessage: 'Post not found' }))
  }
})
const loadError = computed(() => (postError.value && !isNotFoundError(postError.value)
  ? getErrorMessage(postError.value, 'Failed to load this post')
  : null))

const dashboardApi = useDashboardApi()
type BlogTranslationResponse = { localization: Record<string, unknown> & { metadata: Record<string, unknown>; updated_at: string; content_blocks: BlogEditorBlock[] } }
interface BlogLocalizationState {
  locale: string
  blocks: BlogEditorBlock[]
  documentUpdatedAt: string | null
  values: Record<string, unknown>
}
let blogLocalizationState: BlogLocalizationState | null = null
let blogLocalizationLoadGeneration = 0

function isBlogTranslationResponse(value: unknown): value is BlogTranslationResponse {
  return isRecord(value) && isRecord(value.localization) && typeof value.localization.updated_at === 'string'
    && isRecord(value.localization.metadata) && Array.isArray(value.localization.content_blocks)
}

function blogBlockFieldKey(blockIndex: number, path: BlogLocalizedFieldPath): string {
  return `content:${blockIndex}:${path.join('.')}`
}

const sourceBlogBlocks = computed(() => (postResource.value?.post.content_document?.blocks ?? []) as BlogEditorBlock[])
const blogLocalizationFields = computed(() => {
  const post = postResource.value?.post
  const fields: Array<{ key: string; label: string; source: string | null | undefined; multiline?: boolean; rows?: number }> = [
    { key: 'title', label: 'Title', source: post?.title },
    { key: 'summary', label: 'Excerpt', source: post?.excerpt, multiline: true, rows: 4 },
  ]
  sourceBlogBlocks.value.forEach((block, blockIndex) => {
    blogLocalizedTextFields(block).forEach((field) => {
      fields.push({
        key: blogBlockFieldKey(blockIndex, field.path),
        label: `Article ${blockIndex + 1} · ${field.label}`,
        source: field.value,
        multiline: true,
        rows: field.rows,
      })
    })
  })
  return fields
})

function blankTranslationBlocks(): BlogEditorBlock[] {
  return sourceBlogBlocks.value.map(blankBlogLocalizedText)
}

async function loadBlogLocalization(locale: string): Promise<Record<string, unknown>> {
  const generation = ++blogLocalizationLoadGeneration
  let blocks = blankTranslationBlocks()
  let documentUpdatedAt: string | null = null
  let values: Record<string, unknown> = {}
  try {
    const response = await dashboardApi<BlogTranslationResponse>(
      `/api/editor/organizations/${organizationId}/localization/content_document/${postId}/${encodeURIComponent(locale)}`,
      { validate: isBlogTranslationResponse },
    )
    values = { ...response.localization }
    blocks = structuredClone(response.localization.content_blocks)
    documentUpdatedAt = response.localization.updated_at
  } catch (cause) {
    const statusCode = isRecord(cause) && typeof cause.statusCode === 'number' ? cause.statusCode : null
    if (statusCode !== 404) throw cause
  }
  blocks.forEach((block, blockIndex) => {
    blogLocalizedTextFields(block).forEach((field) => {
      values[blogBlockFieldKey(blockIndex, field.path)] = field.value
    })
  })
  if (generation !== blogLocalizationLoadGeneration) return {}
  blogLocalizationState = { locale, blocks, documentUpdatedAt, values: Object.fromEntries(['title', 'summary', 'seo_keywords', 'metadata'].filter(key => Object.hasOwn(values, key)).map(key => [key, structuredClone(values[key])])) }
  return values
}

async function saveBlogLocalization(locale: string, submitted: Record<string, unknown>): Promise<void> {
  const state = blogLocalizationState
  if (!state || state.locale !== locale) throw new Error('Choose the language again before saving.')
  const blocks = structuredClone(state.blocks)
  sourceBlogBlocks.value.forEach((source, blockIndex) => {
    const translated = blocks[blockIndex]
    if (!translated) throw new Error('The translated article structure is incomplete.')
    blogLocalizedTextFields(source).forEach((field) => {
      const value = submitted[blogBlockFieldKey(blockIndex, field.path)]
      if (field.value.trim() && (typeof value !== 'string' || !value.trim())) {
        throw new Error(`Translate ${field.label.toLowerCase()} in article section ${blockIndex + 1} before saving.`)
      }
      if (typeof value === 'string') writeBlogLocalizedText(translated.data, field.path, value)
    })
  })
  const values: Record<string, unknown> = structuredClone(state.values)
  for (const key of ['title', 'summary']) {
    if (Object.hasOwn(submitted, key)) values[key] = submitted[key]
  }
  const response = await dashboardApi<BlogTranslationResponse>(
    `/api/editor/organizations/${organizationId}/localization/content_document/${postId}/${encodeURIComponent(locale)}`,
    {
      method: 'PUT',
      body: {
        values,
        content_blocks: blocks,
        ...(state.documentUpdatedAt ? { expected_updated_at: state.documentUpdatedAt } : {}),
      },
      validate: isBlogTranslationResponse,
    },
  )
  blogLocalizationState = {
    locale,
    blocks: structuredClone(response.localization.content_blocks),
    documentUpdatedAt: response.localization.updated_at,
    values: Object.fromEntries(['title', 'summary', 'seo_keywords', 'metadata'].map(key => [key, structuredClone(response.localization[key])])),
  }
}

useSeoMeta({ title: () => `${isNew ? newTitle.value : postResource.value?.post.title || 'Post'} | KrabiClaw Dashboard`, robots: 'noindex, nofollow' })
</script>
