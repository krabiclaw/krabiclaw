<template>
  <!-- The article is the writing canvas; its metadata opens from its header. -->
  <DashboardIndexPanel :id="panelId" title="Article">
    <template #right>
      <UButton label="Save" :loading="saveState === 'saving'" :disabled="saving || !contentDirty || !form.title.trim() || saveState === 'conflict'" @click="saveCanvas" />
      <UTooltip text="Preview">
        <UButton ref="previewButton" color="neutral" variant="ghost" icon="i-lucide-eye" aria-label="Preview" :to="previewPath" :disabled="saving || !previewUrl" class="size-10 rounded-full" data-testid="article-preview" />
      </UTooltip>
      <UDropdownMenu :items="settingsActions" :disabled="saving">
        <UButton color="neutral" variant="ghost" icon="i-lucide-ellipsis" aria-label="Article settings" :disabled="saving" class="size-10 rounded-full" />
      </UDropdownMenu>
      <slot v-if="post" name="actions" :post="post" :saving="saving" />
    </template>

    <!-- Inert while a write is in flight: the ids that come back are matched to the blocks that were sent. -->
    <div class="space-y-8" :inert="saving">
      <p v-if="actionError" role="alert" class="rounded-lg border border-error/30 bg-error/10 px-4 py-2 text-sm text-error">{{ actionError }}</p>

      <UAlert v-if="loadError" color="error" variant="soft" :description="loadError" />
      <template v-else>
      <p class="text-xs" :class="saveState === 'failed' || saveState === 'conflict' ? 'text-error' : 'text-muted'" role="status">{{ saveLabel }}</p>
      <div class="overflow-hidden rounded-lg bg-[var(--editor-canvas,#fff)] text-[var(--editor-ink,#1f2937)]" :style="editorCanvasStyle">
        <div class="mx-auto max-w-4xl px-4 py-10 sm:px-6 sm:py-14 lg:px-8">
          <BlogArticleRenderer
            v-model:title="form.title"
            :excerpt="form.excerpt || null"
            :blocks="blocks"
            :template="templateName"
            editable
            :show-meta="false"
            @update:block="updateBlock"
            @insert-block="handleInsertBlock"
            @insert-block-type="handleInsertBlockType"
            @move-block="moveBlock"
            @merge-block="handleMergeBlock"
            @split-insert="handleSplitInsert"
          >
            <template #cover-empty>
              <button type="button" class="mb-8 flex aspect-video w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-current/30 text-sm opacity-70 transition hover:border-current/60 hover:opacity-100" @click="addCover">
                <UIcon name="i-lucide-image-plus" class="size-4" />
                Add a cover photo
              </button>
            </template>
            <template #image-editor="{ block, index }">
              <component
                :is="mediaPickerComponent"
                :organization-id="organizationId"
                :model-value="block.media?.find(item => item.slot === 'media')?.asset_id || ''"
                accept="image"
                @change="changeImage(index, $event)"
              />
              <!--
                Alt text is not asked for here. It describes the picture, so it
                belongs to the media asset and is edited once in the media
                library — not re-entered at every place the asset is used.
              -->
              <UInput class="mt-2 w-full" :model-value="String(block.data.caption || '')" placeholder="Caption" @update:model-value="value => setBlockData(index, 'caption', value)" />
            </template>
          </BlogArticleRenderer>
        </div>
      </div>

      </template>
    </div>
  </DashboardIndexPanel>
  <DashboardContentPreview v-model:open="previewOpen" title="Article preview" :content-title="post?.title ?? ''" :src="previewUrl" :public-url="publicUrl" :viewport="previewViewport" :error="previewFailure" @update:viewport="changePreviewViewport" @after:leave="restorePreviewFocus" />
</template>

<script lang="ts">
import type { Component, ComputedRef, InjectionKey, Reactive, Ref } from 'vue'
import type { DashboardArticleCategory } from '~/composables/useArticleCategories'

const SETTINGS_SECTIONS = ['category', 'excerpt', 'publishing'] as const
type SettingsSection = typeof SETTINGS_SECTIONS[number]

/** The post's draft and what its leaves show beside their one field. */
export interface BlogEditor {
  form: Reactive<{ title: string; collection: ArticleCollection; category_id: string; excerpt: string; visibility: 'listed' | 'unlisted' }>
  post: Ref<BlogPost | null>
  loadError: Ref<string>
  actionError: Ref<string>
  saving: ComputedRef<boolean>
  saveDisabled: ComputedRef<boolean>
  collectionOptions: Array<{ label: string; value: ArticleCollection }>
  /** The post's collection's categories, the Category leaf's choices. */
  categories: Ref<DashboardArticleCategory[] | undefined>
  categoriesError: Ref<unknown>
  resolvedExcerpt: ComputedRef<string>
  revert: () => void
  save: () => Promise<void>
}

export const blogEditorKey = Symbol('blog-editor') as InjectionKey<BlogEditor>
</script>

<script setup lang="ts">
import BlogArticleRenderer from '~/components/blog/BlogArticleRenderer.vue'
import DashboardContentPreview from '~/components/dashboard/DashboardContentPreview.vue'
import { ARTICLE_COLLECTIONS, ARTICLE_COLLECTION_SLUGS } from '~/utils/article-collections'
import { youTubeVideoId } from '~/shared/youtube-video'
import type { BlogLifecycleState, BlogPostRepository, BlogPost, BlogEditorBlock, BlogPostUpdateInput } from './types'
import { cloneEditorBlocks, generatedExcerpt, initialBlogEditorBlocks } from '~/utils/blog-editor'
import { getErrorMessage } from '~/utils/errors'

const props = withDefaults(defineProps<{ repository: BlogPostRepository; initialPost: BlogPost; organizationId: string; panelId?: string; mediaPickerComponent: Component }>(), {
  panelId: 'blog-post-editor',
})
const route = useRoute()
const postId = computed(() => String(route.params.postId || ''))
const post = ref<BlogPost | null>(null)
const persistedPostId = computed(() => post.value?.id || postId.value)
const blocks = ref<BlogEditorBlock[]>(initialBlogEditorBlocks())
const loadError = ref('')
const saveState = ref<'saved' | 'saving' | 'failed' | 'conflict'>('saved')
const actionError = ref('')
const publishing = ref(false)
const savingExplicitly = ref(false)
const savedSignature = ref('')
const contentDirty = computed(() => JSON.stringify(buildSavePayload()) !== savedSignature.value)
let serverPostUpdatedAt: string | undefined

/** This post's own URL, which its rows hang off. */
const level = useRouteLevel()
const postPath = level.path
const section = computed<SettingsSection | null>(() => {
  const segment = level.child.value
  return segment && SETTINGS_SECTIONS.some(key => key === segment) ? segment as SettingsSection : null
})

const form = reactive({ title: '', collection: 'blog' as ArticleCollection, category_id: '', excerpt: '', visibility: 'listed' as 'listed' | 'unlisted' })
const saving = computed(() => savingExplicitly.value || publishing.value || saveState.value === 'saving')
const saveDisabled = computed(() => saving.value || Boolean(loadError.value) || !form.title.trim() || saveState.value === 'conflict'
  || (section.value === 'publishing' && post.value?.status !== 'published' && (!isArticleValid() || !form.category_id))
  || (!contentDirty.value && !(section.value === 'publishing' && post.value?.status !== 'published')))
const templateName = computed(() => post.value?.editor_template || 'tenant')
const collectionOptions = ARTICLE_COLLECTION_SLUGS.map(slug => ({ label: ARTICLE_COLLECTIONS[slug].label, value: slug }))
if (!props.organizationId) throw new Error('The blog editor needs the organization it edits')
// The page awaits the post before this editor exists; the draft is seeded from it
// before its collection's categories are read.
watch(() => props.initialPost, (loaded) => {
  try {
    applyLoadedPost(loaded)
    loadError.value = ''
  } catch (error) {
    loadError.value = getErrorMessage(error, 'Failed to load article.')
  }
}, { immediate: true })
const { data: categories, error: categoriesError } = await useArticleCategories(props.organizationId, () => form.collection)
// The canvas wears the site's light palette. Dashboard controls read Nuxt UI
// tokens, so they are bridged to it while the canvas is active.
const editorCanvasStyle = computed(() => {
  const colors = post.value?.editor_colors
  if (!colors) return { '--editor-canvas': 'var(--ui-bg-elevated)', '--editor-ink': 'var(--ui-text)' }
  return {
    '--editor-canvas': colors.ground, '--editor-ink': colors.text,
    '--ui-primary': colors.action, '--ui-bg': colors.ground, '--ui-bg-elevated': colors.surface,
    '--ui-text': colors.text, '--ui-text-highlighted': colors.text, '--ui-text-muted': colors.muted, '--ui-text-dimmed': colors.muted,
  }
})
const resolvedExcerpt = computed(() => generatedExcerpt(blocks.value))
const settingsActions = computed(() => [
  { label: `Category · ${categories.value?.find(category => category.id === form.category_id)?.name ?? 'Not set'}`, icon: 'i-lucide-folder', to: `${postPath.value}/category` },
  { label: 'Excerpt', icon: 'i-lucide-text', to: `${postPath.value}/excerpt` },
  { label: `Visibility · ${post.value?.status === 'published' ? form.visibility === 'listed' ? 'Published' : 'Unlisted' : 'Draft'}`, icon: 'i-lucide-eye', to: `${postPath.value}/publishing` },
])
const dashboard = useDashboardOrganization()
const publicUrl = computed(() => post.value?.public_url && dashboard.organization.value?.public_url
  ? new URL(post.value.public_url, dashboard.organization.value.public_url).toString() : null)
const previewUrl = computed(() => publicUrl.value || (post.value?.preview_url && dashboard.organization.value?.public_url
  ? new URL(post.value.preview_url, dashboard.organization.value.public_url).toString() : null))
const { previewButton, previewPath, previewOpen, previewViewport, previewFailure, changePreviewViewport, restorePreviewFocus } = useDashboardContentPreview(
  computed(() => loadError.value || (!previewUrl.value ? 'The saved article could not be loaded for preview.' : '')),
)
const saveLabel = computed(() => {
  if (saveState.value === 'saving') return 'Saving…'
  if (saveState.value === 'failed') return 'Save failed'
  if (saveState.value === 'conflict') return 'Conflict — reload to reconcile'
  return contentDirty.value ? 'Unsaved changes' : 'Saved'
})
type InserterBlockType = 'image' | 'video' | 'faq' | 'how_to' | 'cta' | 'divider'

/**
 * Writes the article as the canvas holds it and takes back what the canvas
 * cannot know: the server's copy of the post and the ids of blocks saved for
 * the first time.
 */
async function saveArticle() {
  if (!post.value || !contentDirty.value) return post.value
  // A started video block is written with the rest, so it has to be finished first:
  // the server refuses the whole document for one video without a link or a title.
  assertVideosComplete()
  actionError.value = ''
  saveState.value = 'saving'
  const payload = buildSavePayload()
  try {
    const updated = await props.repository.update(persistedPostId.value, { ...payload, expected_updated_at: serverPostUpdatedAt })
    syncServerVersion(updated)
    post.value = updated
    if (!updated.content_document) throw new Error('The saved article content document is missing.')
    adoptServerBlockIds(payload.content_blocks ?? [], updated.content_document.blocks)
    savedSignature.value = JSON.stringify(payload)
    saveState.value = 'saved'
    return updated
  } catch (error: unknown) {
    const status = Number((error as { statusCode?: number; status?: number })?.statusCode ?? (error as { status?: number })?.status)
    saveState.value = status === 409 ? 'conflict' : 'failed'
    throw error
  }
}

async function saveCanvas() {
  try {
    await saveArticle()
  } catch (cause) {
    actionError.value = getErrorMessage(cause, 'Failed to save the article.')
  }
}

/**
 * The canvas is the document; a save confirms it. It used to be replaced by the
 * server's copy after every save, and every block became a new object — so the
 * picker open on an image block was unmounted mid-choice, which read as "the
 * picker just goes away". Only the id of a block saved for the first time is
 * taken from the server. Blocks the payload did not carry (an image still
 * waiting for its picture, a video for its link) are left exactly as they are.
 */
function adoptServerBlockIds(sent: BlogEditorBlock[], saved: BlogEditorBlock[]) {
  if (sent.length !== saved.length) throw new Error('The saved article blocks do not match the submitted article.')
  const unsentIds = new Map<number, string>()
  for (const [index, block] of sent.entries()) {
    const id = saved[index]?.id
    if (!id || (block.id && block.id !== id)) throw new Error('The saved article block identity does not match the submitted article.')
    if (!block.id) {
      block.id = id
      unsentIds.set(index, id)
    }
  }
  if (!unsentIds.size) return
  let sentIndex = 0
  for (const [index, block] of blocks.value.entries()) {
    if (!isSavable(block)) continue
    const id = unsentIds.get(sentIndex)
    if (id && !block.id) blocks.value[index] = { ...block, id }
    sentIndex++
  }
}

function applyLoadedPost(loaded: BlogPost) {
  if (!loaded.content_document) throw new Error('Blog content document is missing')
  syncServerVersion(loaded)
  post.value = loaded
  Object.assign(form, { title: loaded.title, collection: loaded.collection ?? 'blog', category_id: loaded.category?.id ?? '', excerpt: loaded.excerpt || '', visibility: loaded.visibility || 'listed' })
  blocks.value = cloneEditorBlocks(loaded.content_document.blocks || [])
  ensureTrailingTextBlock()
  savedSignature.value = JSON.stringify(buildSavePayload())
  saveState.value = 'saved'
}
/** Opens the article with an empty image block; choosing its picture makes it the cover. */
function addCover() {
  blocks.value.unshift({ type: 'image', data: { caption: '' }, media: [] })
}
/** What is written: an image block waiting for its picture, or a video block for its link, stays on the canvas and out of the document. */
function isSavable(block: BlogEditorBlock) {
  return block.type === 'image' ? Boolean(block.media?.length) : block.type === 'video' ? Boolean(block.data.url) : true
}
const INCOMPLETE_VIDEO = 'Finish the video block: it needs a YouTube link and a title.'
function assertVideosComplete() {
  const incomplete = blocks.value.some(block => block.type === 'video'
    && Object.values(block.data).some(value => String(value ?? '').trim())
    && (!youTubeVideoId(block.data.url) || !String(block.data.title ?? '').trim()))
  if (!incomplete) return
  actionError.value = INCOMPLETE_VIDEO
  saveState.value = 'failed'
  throw new Error(INCOMPLETE_VIDEO)
}
function savedBlocks() {
  return cloneEditorBlocks(toRaw(blocks.value)).filter(isSavable)
}
function buildSavePayload(): BlogPostUpdateInput {
  return { title: form.title, collection: form.collection, category_id: form.category_id || undefined, excerpt: form.excerpt || null, visibility: form.visibility, content_blocks: savedBlocks() }
}
function lifecycleVersionInput() {
  if (!serverPostUpdatedAt) throw new Error('Blog lifecycle version is unavailable. Reload the editor.')
  return { expected_updated_at: serverPostUpdatedAt }
}
function applyLifecycle(lifecycle: BlogLifecycleState) {
  if (!post.value?.content_document) throw new Error('Blog content document is missing')
  post.value = {
    ...post.value,
    status: lifecycle.status,
    published_at: lifecycle.published_at,
    first_published_at: post.value.first_published_at ?? lifecycle.published_at,
    updated_at: lifecycle.updated_at,
    content_document: {
      ...post.value.content_document,
      document: {
        ...post.value.content_document.document,
        updated_at: lifecycle.updated_at,
      },
    },
  }
  serverPostUpdatedAt = lifecycle.updated_at
}
function recordLifecycleError(error: unknown) {
  const status = Number((error as { statusCode?: number; status?: number })?.statusCode ?? (error as { status?: number })?.status)
  saveState.value = status === 409 ? 'conflict' : 'failed'
  actionError.value = getErrorMessage(error, 'Failed to change publishing status.')
}
async function saveSection() {
  if (!post.value || !persistedPostId.value) return
  actionError.value = ''
  savingExplicitly.value = true
  try {
    await saveArticle()
    // The publishing leaf's Save is what publishes. A post that is already
    // live has nothing left to publish, so only a draft goes through it.
    if (section.value === 'publishing' && post.value.status !== 'published') {
      await publish()
      // Stay on the leaf when it failed, so the reason is still on screen.
      if (actionError.value) return
    }
    await level.close()
  } catch (error: unknown) {
    actionError.value = getErrorMessage(error, 'Failed to save.')
  } finally {
    savingExplicitly.value = false
  }
}
async function publish() {
  actionError.value = ''
  publishing.value = true
  try {
    if (!isArticleValid()) throw new Error('Complete the title and article body before publishing.')
    assertVideosComplete()
    // Publish what is on the canvas: an unsaved article is written first, so
    // the lifecycle token it hands over is the one the save produced.
    await saveArticle()
    const lifecycle = await props.repository.publish(persistedPostId.value, lifecycleVersionInput())
    applyLifecycle(lifecycle)
    saveState.value = 'saved'
  } catch (error: unknown) {
    recordLifecycleError(error)
  } finally {
    publishing.value = false
  }
}
function isArticleValid() { return Boolean(form.title.trim() && serializeBody().trim()) }
function serializeBody() { return blocks.value.map(block => block.type === 'heading' ? `${'#'.repeat(Math.max(2, Math.min(6, block.level || 2)))} ${String(block.data.text || '')}` : block.type === 'markdown' ? String(block.data.markdown || '') : block.type === 'divider' ? '---' : `{{component type="${block.type}"}}`).filter(Boolean).join('\n\n') }
function updateBlock(index: number, block: BlogEditorBlock) { blocks.value[index] = block }
function setBlockData(index: number, key: string, value: unknown) { blocks.value[index] = { ...blocks.value[index]!, data: { ...blocks.value[index]!.data, [key]: value } } }
function handleInsertBlock(index: number, _cursorPosition: number) {
  const block = blocks.value[index]
  if (!block || (block.type !== 'markdown' && block.type !== 'heading')) return

  blocks.value.splice(index + 1, 0, { type: 'markdown', data: { markdown: '', editor_mode: 'rich' } })
}
// An image block's asset lives in the block's `media` array, never in `data` —
// the server rejects `data.asset_id` outright, so seeding those two keys made
// every freshly inserted image block unsavable. `changeImage` writes the chosen
// asset to `media`; only alt and caption belong here.
function structuralBlockData(type: string) {
  return type === 'faq' ? { source: 'page_qa' } : type === 'how_to' ? { steps: [{ name: '', text: '' }] } : type === 'image' ? { caption: '' } : type === 'video' ? { url: '', title: '', caption: '' } : type === 'cta' ? { title: '', description: null, label: null, url: null } : {}
}
// A non-text block (image/FAQ/how-to/divider/etc.) left as the last block in
// the post is a dead end — there's no textarea or rich editor to click into
// below it, so there's no way to keep writing. Every insert path must leave
// the array ending on a markdown/heading block.
function ensureTrailingTextBlock() {
  const last = blocks.value[blocks.value.length - 1]
  if (!last || (last.type !== 'markdown' && last.type !== 'heading')) {
    blocks.value.push({ type: 'markdown', data: { markdown: '', editor_mode: 'rich' } })
  }
}
function handleInsertBlockType(index: number, type: string) {
  const newBlock = { type: type as InserterBlockType, data: structuralBlockData(type) }
  const current = blocks.value[index]
  const currentIsEmptyText = Boolean(current && (current.type === 'markdown' || current.type === 'heading') && !String(current.data[current.type === 'heading' ? 'text' : 'markdown'] || '').trim())
  // Only overwrite the block in place when it's an empty starter block — otherwise this
  // would silently delete whatever the user had already written into it.
  if (currentIsEmptyText) blocks.value[index] = newBlock
  else blocks.value.splice(index + 1, 0, newBlock)
  ensureTrailingTextBlock()
}
function moveBlock(index: number, delta: -1 | 1) {
  const target = index + delta
  if (target < 0 || target >= blocks.value.length) return
  const [block] = blocks.value.splice(index, 1)
  if (block) blocks.value.splice(target, 0, block)
}
// Fired when the user picks Image/FAQ/How-To from the "/" menu mid-paragraph
// (see RichTextEditor.vue's splitAtCursorAndInsert). The rich editor has
// already truncated blocks[index] to just the "before" half via the normal
// update:modelValue flow by the time this fires — we only need to insert the
// new structural block, plus a fresh markdown block for whatever came after
// the cursor (skipped entirely if there was nothing after it).
function handleSplitInsert(index: number, payload: { after: string; blockType: 'image' | 'faq' | 'how_to'; editorMode: 'rich' | 'source' }) {
  const newBlocks: BlogEditorBlock[] = [{ type: payload.blockType, data: structuralBlockData(payload.blockType) }]
  if (payload.after.length > 0) newBlocks.push({ type: 'markdown', data: { markdown: payload.after, editor_mode: payload.editorMode } })
  blocks.value.splice(index + 1, 0, ...newBlocks)
  ensureTrailingTextBlock()
}
function handleMergeBlock(index: number, direction: 'back' | 'forward') {
  if (direction === 'back' && index > 0) {
    const currentBlock = blocks.value[index]
    const prevBlock = blocks.value[index - 1]
    if (prevBlock && currentBlock && prevBlock.type === 'markdown' && currentBlock.type === 'markdown') {
      const mergedText = String(prevBlock.data.markdown || '') + String(currentBlock.data.markdown || '')
      blocks.value[index - 1] = { ...prevBlock, data: { ...prevBlock.data, markdown: mergedText } }
      blocks.value.splice(index, 1)
    } else {
      blocks.value.splice(index, 1)
    }
  } else if (direction === 'forward' && index < blocks.value.length - 1) {
    const currentBlock = blocks.value[index]
    const nextBlock = blocks.value[index + 1]
    if (currentBlock && nextBlock && currentBlock.type === 'markdown' && nextBlock.type === 'markdown') {
      const mergedText = String(currentBlock.data.markdown || '') + String(nextBlock.data.markdown || '')
      blocks.value[index] = { ...currentBlock, data: { ...currentBlock.data, markdown: mergedText } }
      blocks.value.splice(index + 1, 1)
    } else {
      blocks.value.splice(index, 1)
    }
  }
  ensureTrailingTextBlock()
}
function changeImage(index: number, value: unknown) {
  const asset = value && typeof value === 'object'
    ? value as { asset_id?: unknown; public_url?: unknown; thumbnail_url?: unknown; kind?: unknown; alt_text?: unknown }
    : null
  const assetId = typeof asset?.asset_id === 'string' ? asset.asset_id : ''
  const publicUrl = typeof asset?.public_url === 'string' ? asset.public_url : null
  const thumbnailUrl = typeof asset?.thumbnail_url === 'string' ? asset.thumbnail_url : null
  const altText = typeof asset?.alt_text === 'string' ? asset.alt_text : null
  blocks.value[index] = {
    ...blocks.value[index]!,
    media: assetId ? [{ asset_id: assetId, slot: 'media', public_url: publicUrl, thumbnail_url: thumbnailUrl, kind: typeof asset?.kind === 'string' ? asset.kind : 'image', alt_text: altText }] : [],
  }
}

function syncServerVersion(value: BlogPost) { serverPostUpdatedAt = value.updated_at }

provide(blogEditorKey, {
  form,
  post,
  loadError,
  actionError,
  saving,
  saveDisabled,
  collectionOptions,
  categories,
  categoriesError,
  resolvedExcerpt,
  // Cancel discards this metadata concern, leaving the pending article intact.
  revert: () => {
    const saved = post.value
    if (!saved) return
    if (section.value === 'category') Object.assign(form, { collection: saved.collection ?? 'blog', category_id: saved.category?.id ?? '' })
    else if (section.value === 'excerpt') form.excerpt = saved.excerpt || ''
    else if (section.value === 'publishing') form.visibility = saved.visibility || 'listed'
  },
  save: saveSection,
})
</script>

