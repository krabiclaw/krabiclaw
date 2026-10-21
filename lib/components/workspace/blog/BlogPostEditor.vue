<template>
  <!--
    A blog post is read the way every other record is: the thing itself first,
    then the rows that describe it. The canvas takes the place a product's
    photograph takes on its index — it does not take the place of the index. Each
    row is a leaf below this level.
  -->
  <DashboardIndexPanel :id="panelId" :title="form.title || 'Untitled post'">
    <template #right>
      <slot name="actions" />
    </template>

    <!-- Inert while a write is in flight: the ids that come back are matched to the blocks that were sent. -->
    <div class="space-y-8" :inert="publishing || saveState === 'saving'">
      <p v-if="actionError" role="alert" class="rounded-lg border border-error/30 bg-error/10 px-4 py-2 text-sm text-error">{{ actionError }}</p>

      <UAlert v-if="loadError" color="error" variant="soft" :description="loadError" />

      <template v-else>
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

      <!--
        The article commits on Save, like every other editor. It used to write
        the whole document after every burst of typing — a write nothing else
        in the product performs, and the one that kept replacing the canvas
        under the writer.
      -->
      <div class="flex items-center justify-between gap-4 px-1">
        <span class="text-xs" :class="saveState === 'failed' || saveState === 'conflict' ? 'text-error' : 'text-muted'">{{ saveLabel }}</span>
        <UButton label="Save" :loading="saveState === 'saving'" :disabled="!contentDirty || saveState === 'conflict'" @click="saveArticle" />
      </div>
        <EditorNavigationList :groups="settingsGroups" :active-item="section" />
      </template>
    </div>
  </DashboardIndexPanel>
</template>

<script lang="ts">
import type { Component, ComputedRef, InjectionKey, Reactive, Ref } from 'vue'
import type { DashboardArticleCategory } from '~/composables/useArticleCategories'

export type SettingsSection = 'category' | 'excerpt' | 'publishing' | 'share' | 'url'
export const SETTINGS_SECTIONS: SettingsSection[] = ['category', 'excerpt', 'publishing', 'share', 'url']
export const SETTINGS_LABELS: Record<SettingsSection, string> = {
  category: 'Category', excerpt: 'Excerpt', publishing: 'Visibility',
  share: 'Share preview', url: 'URL',
}

/** The post's draft and what its leaves show beside their one field. */
export interface BlogEditor {
  form: Reactive<{ title: string; collection: ArticleCollection; category_id: string; excerpt: string; slug: string; visibility: 'listed' | 'unlisted'; redirect_old_slug: boolean }>
  post: Ref<BlogPost | null>
  loadError: Ref<string>
  actionError: Ref<string>
  saving: ComputedRef<boolean>
  collectionOptions: Array<{ label: string; value: ArticleCollection }>
  /** The post's collection's categories, the Category leaf's choices. */
  categories: Ref<DashboardArticleCategory[] | undefined>
  categoriesError: Ref<unknown>
  generatedSlug: ComputedRef<string>
  resolvedExcerpt: ComputedRef<string>
  resolvedPrimaryImageUrl: ComputedRef<string | null>
  resolvedPrimaryVideoUrl: ComputedRef<string | null>
  slugResetRequested: Ref<boolean>
  resetSlugOverride: () => void
  revert: () => void
  save: () => Promise<void>
}

export const blogEditorKey = Symbol('blog-editor') as InjectionKey<BlogEditor>
</script>

<script setup lang="ts">
import BlogArticleRenderer from '~/components/blog/BlogArticleRenderer.vue'
import EditorNavigationList, { type EditorNavigationGroup } from '~/components/dashboard/EditorNavigationList.vue'
import { ARTICLE_COLLECTIONS, ARTICLE_COLLECTION_SLUGS } from '~/utils/article-collections'
import { youTubeVideoId } from '~/shared/youtube-video'
import type { BlogLifecycleState, BlogPostRepository, BlogPost, BlogEditorBlock, BlogPostUpdateInput } from './types'
import { cloneEditorBlocks, generatedExcerpt, initialBlogEditorBlocks, normalizeBlogSlug } from '~/utils/blog-editor'
import { getErrorMessage } from '~/utils/errors'
import { resolveSocialImageUrl } from '~/utils/social-metadata'

const props = withDefaults(defineProps<{ repository: BlogPostRepository; initialPost: BlogPost; postId?: string; organizationId?: string; backUrl?: string; backLabel?: string; panelId?: string; mediaPickerComponent: Component }>(), {
  postId: undefined, organizationId: '', backUrl: '/dashboard', backLabel: 'Posts', panelId: 'blog-post-editor',
})
const route = useRoute()
const postId = computed(() => props.postId || String(route.params.postId || ''))
const post = ref<BlogPost | null>(null)
const persistedPostId = computed(() => post.value?.id || postId.value)
const blocks = ref<BlogEditorBlock[]>(initialBlogEditorBlocks())
const loadError = ref('')
const saveState = ref<'saved' | 'saving' | 'failed' | 'conflict'>('saved')
const actionError = ref('')
const publishing = ref(false)
const savingExplicitly = ref(false)
const contentDirty = ref(false)
let applyingServerSnapshot = false
let serverPostUpdatedAt: string | undefined
const slugResetRequested = ref(false)

/** This post's own URL, which its rows hang off. */
const level = useRouteLevel()
const postPath = level.path
const section = computed<SettingsSection | null>(() => {
  const segment = level.child.value
  return segment && (SETTINGS_SECTIONS as string[]).includes(segment) ? segment as SettingsSection : null
})

const form = reactive({ title: '', collection: 'blog' as ArticleCollection, category_id: '', excerpt: '', slug: '', visibility: 'listed' as 'listed' | 'unlisted', redirect_old_slug: true })
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
    loadError.value = getErrorMessage(error, 'Failed to load post.')
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
const statusLabel = computed(() => {
  if (!post.value) return 'Not published'
  if (post.value.status === 'draft') return 'Draft'
  return 'Published'
})
const generatedSlug = computed(() => normalizeBlogSlug(form.title))
const resolvedExcerpt = computed(() => generatedExcerpt(blocks.value))
/**
 * The post's cover is its leading image block and nothing else. The post's
 * images are one set; the cover is the lead one; the share card derives from
 * it. There is no separate "photo" that could hold the same picture twice.
 */
const coverMedia = computed(() => {
  const lead = blocks.value[0]
  return lead?.type === 'image' ? lead.media?.find(item => item.slot === 'media') ?? null : null
})
const resolvedPrimaryImageUrl = computed<string | null>(() =>
  coverMedia.value?.kind === 'video' ? null : resolveSocialImageUrl(coverMedia.value))
/**
 * The settings index. Every row states what it currently holds, so the pane is
 * read by scanning values rather than by opening each leaf to find out — which
 * is the whole reason an index beats a stack of collapsed cards.
 *
 * `placeholder` renders the summary as absent rather than as a value, so an
 * empty Category reads as "Not set" in italics instead of looking like content.
 */
const settingsGroups = computed<EditorNavigationGroup[]>(() => {
  const unset = (value: string | null | undefined) => !value || !String(value).trim()
  const row = (id: SettingsSection, label: string, value: string | null | undefined, fallback = 'Not set') => ({
    id,
    label,
    to: `${postPath.value}/${id}`,
    summary: unset(value) ? fallback : String(value),
    placeholder: unset(value),
  })
  return [
    {
      id: 'about',
      label: 'About this post',
      items: [
        { ...row('category', `${ARTICLE_COLLECTIONS[form.collection].label} · Category`, categories.value?.find(category => category.id === form.category_id)?.name), icon: 'i-lucide-folder' },
        {
          id: 'excerpt',
          label: 'Excerpt',
          to: `${postPath.value}/excerpt`,
          summary: form.excerpt.trim() || resolvedExcerpt.value,
          placeholder: !form.excerpt.trim(),
        },
      ],
    },
    {
      id: 'publishing',
      label: 'Publishing',
      items: [
        { id: 'publishing', to: `${postPath.value}/publishing`, label: 'Visibility', icon: 'i-lucide-eye', summary: publishingSummary.value },
        row('url', 'URL', form.slug || generatedSlug.value, 'Generated from the headline'),
      ],
    },
    {
      id: 'sharing',
      label: 'Sharing',
      items: [
        {
          id: 'share',
          label: 'Share preview',
          lead: { image: resolvedPrimaryImageUrl.value, icon: 'i-lucide-share-2' },
          to: `${postPath.value}/share`,
          summary: resolvedPrimaryImageUrl.value || resolvedPrimaryVideoUrl.value ? 'Set' : 'No image yet',
          placeholder: !resolvedPrimaryImageUrl.value && !resolvedPrimaryVideoUrl.value,
        },
      ],
    },
  ]
})

const publishingSummary = computed(() => {
  const visibility = form.visibility === 'unlisted' ? 'Unlisted' : 'Listed'
  if (post.value?.status === 'published') return `Published · ${visibility}`
  return `${statusLabel.value} · ${visibility}`
})


const resolvedPrimaryVideoUrl = computed<string | null>(() => {
  const candidate = coverMedia.value?.kind === 'video' ? coverMedia.value.public_url : null
  return typeof candidate === 'string' && candidate ? candidate : null
})
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
    applyingServerSnapshot = true
    post.value = updated
    form.slug = updated.slug || form.slug
    slugResetRequested.value = false
    if (updated.content_document?.blocks) adoptServerBlockIds(payload.content_blocks ?? [], updated.content_document.blocks)
    contentDirty.value = false
    saveState.value = 'saved'
    void nextTick(() => { applyingServerSnapshot = false })
    return updated
  } catch (error: unknown) {
    const status = Number((error as { statusCode?: number; status?: number })?.statusCode ?? (error as { status?: number })?.status)
    saveState.value = status === 409 ? 'conflict' : 'failed'
    throw error
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
  if (sent.length !== saved.length) return
  const unsentIds = new Map<number, string>()
  for (const [index, block] of sent.entries()) {
    if (!block.id && saved[index]?.id) unsentIds.set(index, saved[index]!.id)
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

// The headline and the body are the canvas; typing into either marks the
// article unsaved. A settings leaf marks itself when its Save is pressed.
watch([() => form.title, blocks], () => {
  if (applyingServerSnapshot) return
  markContentDirty()
}, { deep: true, flush: 'sync' })

function applyLoadedPost(loaded: BlogPost) {
  applyingServerSnapshot = true
  try {
    if (!loaded.content_document) throw new Error('Blog content document is missing')
    syncServerVersion(loaded)
    post.value = loaded
    Object.assign(form, { title: loaded.title, collection: loaded.collection ?? 'blog', category_id: loaded.category?.id ?? '', excerpt: loaded.excerpt || '', slug: loaded.slug || '', visibility: loaded.visibility || 'listed', redirect_old_slug: true })
    slugResetRequested.value = false
    blocks.value = cloneEditorBlocks(loaded.content_document.blocks || [])
    ensureTrailingTextBlock()
    contentDirty.value = false
  } finally {
    void nextTick(() => { applyingServerSnapshot = false })
  }
}
function markContentDirty() {
  if (saveState.value === 'conflict') return
  contentDirty.value = true
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
  return { title: form.title, collection: form.collection, category_id: form.category_id || undefined, excerpt: form.excerpt || null, slug: slugResetRequested.value ? null : form.slug !== post.value?.slug ? form.slug : undefined, reset_slug_override: slugResetRequested.value || undefined, redirect_old_slug: form.redirect_old_slug, visibility: form.visibility, content_blocks: savedBlocks() }
}
function lifecycleVersionInput() {
  if (!serverPostUpdatedAt) throw new Error('Blog lifecycle version is unavailable. Reload the editor.')
  return { expected_updated_at: serverPostUpdatedAt }
}
function applyLifecycle(lifecycle: BlogLifecycleState) {
  if (!post.value?.content_document) throw new Error('Blog content document is missing')
  applyingServerSnapshot = true
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
  applyingServerSnapshot = false
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
    // A settings leaf is not watched, so nothing has marked the draft dirty.
    // Saying so here is what lets `saveArticle` write it.
    markContentDirty()
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

function resetSlugOverride() { slugResetRequested.value = true; form.slug = generatedSlug.value }
function syncServerVersion(value: BlogPost) { serverPostUpdatedAt = value.updated_at }

provide(blogEditorKey, {
  form,
  post,
  loadError,
  actionError,
  saving: computed(() => savingExplicitly.value || publishing.value),
  collectionOptions,
  categories,
  categoriesError,
  generatedSlug,
  resolvedExcerpt,
  resolvedPrimaryImageUrl,
  resolvedPrimaryVideoUrl,
  slugResetRequested,
  resetSlugOverride,
  // A cancelled leaf puts the loaded post back before it closes.
  revert: () => { if (post.value) applyLoadedPost(post.value) },
  save: saveSection,
})
</script>

