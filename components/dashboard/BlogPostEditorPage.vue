<template>
  <UAlert
    v-if="loadError"
    color="error"
    variant="soft"
    icon="i-lucide-triangle-alert"
    title="Article could not be loaded"
    :description="loadError"
  />

  <BlogPostEditor
    v-else-if="isNew || postResource"
    :repository="repository"
    :initial-post="postResource?.post ?? null"
    :organization-id="organizationId"
    panel-id="organization-blog-post"
    :media-picker-component="MediaPicker"
  >
    <template #actions="{ post: savedPost, saving }">
      <DashboardResourceLocalization
        v-if="!isNew"
        :organization-id="organizationId"
        resource-type="content_document"
        :resource-id="postId"
        :resource-label="savedPost.title"
        :fields="blogLocalizationFields(savedPost)"
        :load-values="locale => loadBlogLocalization(locale, savedPost)"
        :save-values="(locale, values) => saveBlogLocalization(locale, values, savedPost)"
        :language-settings-path="organizationLocalizationSettingsPath"
        :disabled="saving"
      />
    </template>
  </BlogPostEditor>
</template>

<script setup lang="ts">
import DashboardResourceLocalization from '~/components/dashboard/DashboardResourceLocalization.vue'
import { tenantBlogRepository } from '~/lib/components/workspace/blog/tenantBlogRepository'
import { isBlogPostResponse } from '~/lib/components/workspace/blog/blog-response-contracts'
import BlogPostEditor from '~/lib/components/workspace/blog/BlogPostEditor.vue'
import MediaPicker from '~/lib/components/workspace/media/MediaPicker.vue'
import type { BlogEditorBlock, BlogPost } from '~/lib/components/workspace/blog/types'
import { blankBlogLocalizedText, blogLocalizedTextFields, writeBlogLocalizedText, type BlogLocalizedFieldPath } from '~/utils/blog-editor'
import { getErrorMessage, isNotFoundError } from '~/utils/errors'

// One post. Rendered by `blog.vue`, which owns the frame — this level draws its
// own panel and navbar because it is the outermost level on screen.
const route = useRoute()
const orgSlug = route.params.orgSlug as string
const organizationId = await useDashboardOrganizationId()
const postId = String(route.params.postId || '')
if (!postId) throw createError({ statusCode: 400, statusMessage: 'Post ID is required' })

const organizationLocalizationSettingsPath = `/dashboard/${orgSlug}/website/localization`
const level = useRouteLevel()
const isNew = postId === 'new'
const repository = tenantBlogRepository({ organizationId, orgSlug })

// New articles use the same writing canvas; only saved articles have metadata leaves.
watchEffect(() => {
  if (isNew && level.child.value) showError(createError({ statusCode: 404, statusMessage: 'Page not found' }))
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
    showError(createError({ statusCode: 404, statusMessage: 'Article not found' }))
  }
})
const loadError = computed(() => (postError.value && !isNotFoundError(postError.value)
  ? getErrorMessage(postError.value, 'Failed to load this article')
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

function blogLocalizationFields(post: BlogPost) {
  const fields: Array<{ key: string; label: string; source: string | null | undefined; multiline?: boolean; rows?: number }> = [
    { key: 'title', label: 'Title', source: post.title },
    { key: 'summary', label: 'Excerpt', source: post.excerpt, multiline: true, rows: 4 },
  ]
  post.content_document?.blocks.forEach((block, blockIndex) => {
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
}

function blankTranslationBlocks(post: BlogPost): BlogEditorBlock[] {
  if (!post.content_document) throw new Error('Blog content document is missing')
  return post.content_document.blocks.map(blankBlogLocalizedText)
}

async function loadBlogLocalization(locale: string, sourcePost: BlogPost): Promise<Record<string, unknown>> {
  const generation = ++blogLocalizationLoadGeneration
  let blocks = blankTranslationBlocks(sourcePost)
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

async function saveBlogLocalization(locale: string, submitted: Record<string, unknown>, sourcePost: BlogPost): Promise<void> {
  const state = blogLocalizationState
  if (!state || state.locale !== locale) throw new Error('Choose the language again before saving.')
  const blocks = structuredClone(state.blocks)
  if (!sourcePost.content_document) throw new Error('Blog content document is missing')
  sourcePost.content_document.blocks.forEach((source, blockIndex) => {
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
    const value = submitted[key]
    values[key] = typeof value === 'string' && value.trim() ? value : null
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

useSeoMeta({ title: () => `${isNew ? 'New article' : postResource.value?.post.title || 'Article'} | KrabiClaw Dashboard`, robots: 'noindex, nofollow' })
</script>
