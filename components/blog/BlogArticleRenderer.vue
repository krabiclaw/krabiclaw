<template>
  <article ref="rootEl" class="blog-article min-w-0" :data-template="template">
    <header v-if="showHeader" class="blog-article-header mb-10">
      <!-- The category is the site's navigation, so the article does not repeat it. -->
      <textarea v-if="editable" :value="title" rows="1" class="field-sizing-content w-full resize-none overflow-hidden border-0 bg-transparent p-0 text-4xl font-bold leading-tight text-inherit outline-none sm:text-5xl" aria-label="Post title" placeholder="Post title" @input="$emit('update:title', ($event.target as HTMLTextAreaElement).value)" @keydown.enter.prevent />
      <h1 v-else class="text-4xl font-bold leading-tight sm:text-5xl">{{ title }}</h1>
      <p v-if="excerpt" class="mt-5 text-xl leading-relaxed opacity-75">{{ excerpt }}</p>
      <!--
        Who wrote it, then one date and the read time, on one line. The date is
        the latest edition's: an update replaces the publication date rather
        than sitting beside it. The site's own name is not repeated on its own site.
      -->
      <div v-if="showMeta && (authorName || authorImage || publishedAt || $slots.author || $slots.share)" class="mt-7 flex flex-wrap items-center justify-between gap-4 border-y border-current/15 py-4">
        <slot name="author">
          <div class="flex items-center gap-3">
            <img v-if="authorImage" :src="authorImage" :alt="authorName || 'Author'" class="size-11 shrink-0 rounded-full object-cover">
            <span v-else class="grid size-11 shrink-0 place-items-center rounded-full bg-current/10 text-sm font-semibold">{{ authorInitials }}</span>
            <div>
              <p v-if="authorName" class="font-semibold">{{ authorName }}</p>
              <p class="flex flex-wrap items-center gap-x-2 text-sm opacity-65">
                <time v-if="revisedAt" :datetime="revisedAt">{{ t('saya.posts.updated_on', { date: formatDate(revisedAt) }) }}</time>
                <time v-else-if="publishedAt" :datetime="publishedAt">{{ formatDate(publishedAt) }}</time>
                <span v-if="revisedAt || publishedAt" aria-hidden="true">·</span>
                <span>{{ t('saya.posts.read_time', { count: readMinutes }) }}</span>
              </p>
            </div>
          </div>
        </slot>
        <slot name="share" />
      </div>
    </header>

    <!--
      The cover is the article's leading image block — rendered below in the
      hero position — so an article that opens with text has no cover, and there
      is no second place a picture could be duplicated from. While editing, the
      slot offers to add one.
    -->
    <slot v-if="editable && !hasCover" name="cover-empty" />

    <slot name="before-content" />

    <div class="space-y-4">
      <template v-for="(block, index) in blocks" :key="block.id || index">
        <section :data-block-index="index" :tabindex="editable && !hasTextCaret(block) ? 0 : undefined" class="group relative outline-none" @focusin="focusedIndex = index" @focusout="releaseFocus(index, $event)" @keydown="handleStructuralKey(index, block, $event)">
          <!--
            One control, on the block the caret is in, and only while that block
            is empty. Every block used to carry four buttons — up, down, delete,
            insert — so a nine-block post rendered thirty-seven of them at once
            and the page read as a control panel with prose in it. Moving and
            deleting are keys now; this is the only thing left on the canvas.
          -->
          <div v-if="editable && showInserter(index, block)" class="mb-2 sm:absolute sm:right-full sm:top-0 sm:mb-0 sm:mr-2">
            <button
              class="flex size-8 shrink-0 items-center justify-center rounded-full border border-current/30 text-current/60 transition hover:border-current/60 hover:text-current"
              :aria-label="inserterIndex === index ? 'Close the insert menu' : 'Insert an image, video, question list, how-to, call to action, or divider'"
              :aria-expanded="inserterIndex === index"
              @click="toggleInserter(index)"
            >
              <UIcon name="i-lucide-plus" class="size-4 transition-transform" :class="inserterIndex === index && 'rotate-45'" />
            </button>
          </div>
          <div v-if="editable && focusedIndex === index && !hasTextCaret(block)" class="mb-2 sm:absolute sm:right-full sm:top-10 sm:mb-0 sm:mr-2">
            <button
              class="flex size-8 shrink-0 items-center justify-center rounded-full border border-current/30 text-current/60 transition hover:border-current/60 hover:text-current"
              aria-label="Remove block"
              @click="$emit('merge-block', index, index === 0 ? 'forward' : 'back')"
            >
              <UIcon name="i-lucide-trash-2" class="size-4" />
            </button>
          </div>
          <div v-if="editable && inserterIndex === index" class="mb-2 flex flex-wrap items-center gap-2">
            <button
              v-for="item in inserterItems"
              :key="item.type"
              class="flex size-8 shrink-0 items-center justify-center rounded-full border border-current/30 text-current/70 transition hover:border-current/60 hover:text-current"
              :aria-label="item.label"
              :title="item.label"
              @click="insertHere(index, item.type)"
            >
              <UIcon :name="item.icon" class="size-4" />
            </button>
          </div>
        <!--
          Lazy: this is the only path from a public article to the rich-text
          editor, and `editable` is false there. As a static import it still
          shipped the whole TipTap graph — ~684 KB, roughly doubling the JS on
          /blog, /docs and /article — to render nothing.
        -->
        <LazyRichTextEditor
          v-if="editable && block.type === 'markdown'"
          :model-value="textValue(block)"
          :mode="block.data.editor_mode === 'source' ? 'source' : 'rich'"
          class="text-base leading-7"
          @update:model-value="value => updateMarkdown(index, block, value)"
          @split-insert="payload => $emit('split-insert', index, payload)"
        />
        <textarea
          v-else-if="editable && block.type === 'heading'"
          :value="textValue(block)"
          aria-label="Heading"
          class="field-sizing-content min-h-12 w-full resize-none overflow-hidden border-0 bg-transparent p-0 text-lg leading-8 text-inherit outline-none"
          :class="'text-2xl font-semibold sm:text-3xl'"
          @input="updateText(index, block, $event)"
        />
        <!-- eslint-disable vue/no-v-html -->
        <div v-else-if="block.type === 'markdown'" class="prose prose-lg max-w-none" v-html="renderMarkdown(String(block.data.markdown || ''), index)" />
        <!-- eslint-enable vue/no-v-html -->
        <component :is="`h${Math.max(2, Math.min(6, block.level || 2))}`" v-else-if="block.type === 'heading'" :id="`${headingAnchor(String(block.data.text || ''))}-${index}`" class="scroll-mt-28 text-2xl font-semibold">
          {{ block.data.text }}
        </component>
        <!-- The leading image block is the article's cover: same footprint as the old hero, and the share card derives from it. -->
        <figure v-else-if="block.type === 'image'" class="space-y-3" :data-cover="index === 0 ? '' : undefined">
          <video v-if="blockMedia(block)[0]?.kind === 'video' && blockMedia(block)[0]?.public_url" :src="String(blockMedia(block)[0]?.public_url)" :poster="blockMedia(block)[0]?.thumbnail_url || undefined" autoplay muted loop playsinline :class="index === 0 ? 'aspect-video w-full rounded-2xl object-cover' : 'max-h-[70vh] w-full object-cover'" />
          <img v-else-if="blockMedia(block)[0]?.public_url" :src="String(blockMedia(block)[0]?.public_url)" :alt="String(blockMedia(block)[0]?.alt_text ?? '')" :class="index === 0 ? 'aspect-video w-full rounded-2xl object-cover' : 'max-h-[70vh] w-full object-cover'">
          <div v-else class="flex min-h-48 items-center justify-center bg-black/5 text-sm opacity-70">{{ index === 0 ? 'Choose a cover photo' : 'Choose an image' }}</div>
          <figcaption v-if="block.data.caption" class="text-center text-sm opacity-70">{{ block.data.caption }}</figcaption>
          <slot v-if="editable" name="image-editor" :block="block" :index="index" />
        </figure>
        <figure v-else-if="block.type === 'video'" class="space-y-3">
          <ContentVideoEmbed v-if="!editable || youTubeVideoId(block.data.url)" :url="block.data.url" :title="String(block.data.title || '')" class="rounded-2xl" />
          <div v-else class="flex aspect-video items-center justify-center rounded-2xl bg-black/5 text-sm opacity-70">Paste a YouTube link</div>
          <figcaption v-if="block.data.caption && !editable" class="text-center text-sm opacity-70">{{ block.data.caption }}</figcaption>
          <div v-if="editable" class="grid gap-2 sm:grid-cols-2">
            <UInput :model-value="String(block.data.url || '')" placeholder="YouTube link" class="w-full sm:col-span-2" @update:model-value="value => updateBlockData(index, 'url', String(value))" />
            <UInput :model-value="String(block.data.title || '')" placeholder="Video title" class="w-full" @update:model-value="value => updateBlockData(index, 'title', String(value))" />
            <UInput :model-value="String(block.data.upload_date || '')" placeholder="Upload date (YYYY-MM-DD)" class="w-full" @update:model-value="value => updateBlockData(index, 'upload_date', String(value))" />
            <UInput :model-value="String(block.data.caption || '')" placeholder="Caption" class="w-full sm:col-span-2" @update:model-value="value => updateBlockData(index, 'caption', String(value))" />
          </div>
        </figure>
        <UAlert v-else-if="block.type === 'faq' && editable" color="neutral" variant="soft" title="Questions come from Q&amp;A" description="This block lists the published Q&amp;A records for this article. Add or edit questions in the site's Q&amp;A manager." />
        <dl v-else-if="block.type === 'faq' && isRenderable(block) && faqItems(block).length" class="space-y-5">
          <div v-for="(item, itemIndex) in faqItems(block)" :key="itemIndex">
            <dt class="font-semibold">Q: {{ item.title }}</dt>
            <dd class="mt-1 opacity-80">A: {{ item.description }}</dd>
          </div>
        </dl>
        <div v-else-if="block.type === 'how_to' && editable" class="space-y-2">
          <div v-for="(step, stepIndex) in howToSteps(block)" :key="stepIndex" class="flex items-center gap-2">
            <span class="w-5 shrink-0 text-right text-sm opacity-60">{{ stepIndex + 1 }}.</span>
            <div class="flex-1 space-y-2">
              <UInput :model-value="step.name" placeholder="Step name" aria-label="Step name" class="w-full" @update:model-value="value => updateHowToStep(index, stepIndex, 'name', String(value))" />
              <UTextarea :model-value="step.text ?? undefined" placeholder="Instructions (optional)" aria-label="Step instructions" class="w-full" :rows="2" autoresize @update:model-value="value => updateHowToStep(index, stepIndex, 'text', String(value))" />
            </div>
            <UButton icon="i-lucide-x" color="neutral" variant="ghost" size="xs" aria-label="Remove step" @click="removeHowToStep(index, stepIndex)" />
          </div>
          <UButton icon="i-lucide-plus" color="neutral" variant="soft" size="sm" @click="addHowToStep(index)">Add step</UButton>
        </div>
        <ol v-else-if="block.type === 'how_to' && isRenderable(block)" class="list-decimal space-y-2 pl-6 text-lg leading-8">
          <li v-for="(step, stepIndex) in (block.data.steps as TenantPageHowToStep[])" :key="stepIndex">
            <p class="font-semibold">{{ step.name }}</p>
            <p v-if="step.text">{{ step.text }}</p>
          </li>
        </ol>
        <div v-else-if="block.type === 'gallery'" class="grid gap-4 sm:grid-cols-2">
          <figure v-for="(item, itemIndex) in galleryItems(block)" :key="item.asset_id || itemIndex" class="space-y-2">
            <img v-if="item.public_url || item.thumbnail_url" :src="String(item.public_url || item.thumbnail_url)" :alt="String(item.alt_text || '')" class="aspect-video w-full rounded-lg object-cover">
            <figcaption v-if="item.caption" class="text-sm opacity-70">{{ item.caption }}</figcaption>
          </figure>
        </div>
        <ContentAiAssistanceSection v-else-if="block.type === 'ai_assistance' && aiAssistanceProps(block)" v-bind="aiAssistanceProps(block)!" />
        <aside v-else-if="block.type === 'callout'" class="rounded-xl border border-current/15 bg-current/5 p-5">
          <h3 v-if="block.data.title" class="mb-2 font-semibold">{{ block.data.title }}</h3>
          <!--
            A callout's body is `body`, and it is literal text. This read
            `data.markdown || data.text`, and no stored callout has either key,
            so every callout in the blog rendered as an empty box.
          -->
          <div v-if="block.data.body" class="prose max-w-none whitespace-pre-wrap">{{ block.data.body }}</div>
        </aside>
        <div v-else-if="block.type === 'cta' && editable" class="space-y-2 rounded-xl border border-dashed border-current/25 p-4">
          <UInput :model-value="String(block.data.title || '')" placeholder="What do you want the reader to do?" class="w-full" @update:model-value="value => updateBlockData(index, 'title', String(value))" />
          <UTextarea :model-value="String(block.data.description || '')" :rows="2" placeholder="Supporting line (optional)" class="w-full" @update:model-value="value => updateBlockData(index, 'description', String(value))" />
          <div class="grid gap-2 sm:grid-cols-2">
            <UInput :model-value="String(block.data.label || '')" placeholder="Button text" class="w-full" @update:model-value="value => updateBlockData(index, 'label', String(value))" />
            <UInput :model-value="String(block.data.url || '')" placeholder="https://" class="w-full" @update:model-value="value => updateBlockData(index, 'url', String(value))" />
          </div>
        </div>
        <div v-else-if="block.type === 'cta'" class="rounded-xl border border-current/15 p-6 text-center">
          <a v-if="blockMedia(block)[0]?.public_url && safeUrl(block.data.url)" :href="safeUrl(block.data.url)!" class="mb-4 block">
            <img :src="blockMedia(block)[0]!.public_url || ''" :alt="String(blockMedia(block)[0]!.alt_text ?? '')" class="mx-auto max-h-[28rem] w-full object-contain">
          </a>
          <h3 v-if="block.data.title" class="text-xl font-semibold">{{ block.data.title }}</h3>
          <p v-if="block.data.description" class="mt-2 opacity-75">{{ block.data.description }}</p>
          <a v-if="safeUrl(block.data.url)" :href="safeUrl(block.data.url)!" class="mt-4 inline-flex rounded-lg bg-current px-4 py-2 font-semibold text-white no-underline"><span class="mix-blend-difference">{{ block.data.label || 'Learn more' }}</span></a>
        </div>
        <hr v-else-if="block.type === 'divider'" class="border-current opacity-20">
        <div v-else-if="editable" class="rounded-lg border border-dashed border-current/20 p-4 text-sm opacity-70">
          {{ block.type.replaceAll('_', ' ') }} block
        </div>
        </section>
      </template>
    </div>
    <slot name="footer" />
  </article>
</template>

<script setup lang="ts">
import type { BlogEditorBlock } from '~/lib/components/workspace/blog/types'
import ContentAiAssistanceSection from '~/components/content/ContentAiAssistanceSection.vue'
import ContentVideoEmbed from '~/components/content/ContentVideoEmbed.vue'
import { youTubeVideoId } from '~/shared/youtube-video'
import { headingAnchor, renderMarkdownToHtml, sanitizeHtmlForSsr } from '~/utils/markdown'
import { sanitizeUrl } from '~/utils/sanitize'
import { loadDomPurify } from '~/utils/dom-purify-loader'
import { formatTimestamp } from '~/utils/timezone'
import type { TenantPageHowToStep } from '~/utils/tenant-page-blocks'

const props = withDefaults(defineProps<{
  title: string
  blocks: BlogEditorBlock[]
  excerpt?: string | null
  publishedAt?: string | null
  updatedAt?: string | null
  authorName?: string | null
  authorImage?: string | null
  organizationName?: string | null
  editable?: boolean
  template?: 'saya' | 'blawby' | 'platform' | string
  showHeader?: boolean
  showMeta?: boolean
}>(), {
  excerpt: null, publishedAt: null, updatedAt: null, authorName: null, authorImage: null, organizationName: null,
  editable: false, template: 'saya', showHeader: true, showMeta: true,
})
const emit = defineEmits<{ 'update:title': [value: string]; 'update:block': [index: number, block: BlogEditorBlock]; 'insert-block': [index: number, cursorPosition: number]; 'insert-block-type': [index: number, type: string]; 'move-block': [index: number, delta: -1 | 1]; 'merge-block': [index: number, direction: 'back' | 'forward']; 'split-insert': [index: number, payload: { after: string; blockType: 'image' | 'faq' | 'how_to'; editorMode: 'rich' | 'source' }] }>()
const authorInitials = computed(() => String(props.authorName || props.organizationName || 'A').split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase())
const hasCover = computed(() => props.blocks[0]?.type === 'image')
const { t, locale } = useI18n()
function formatDate(value: string) { return formatTimestamp(value, locale.value, 'UTC', { dateStyle: 'medium' }) }
// At two hundred words a minute, from the words a reader reads.
const readMinutes = computed(() => {
  const words = props.blocks
    .map(block => block.type === 'heading' ? block.data.text : block.data.markdown)
    .filter(value => typeof value === 'string')
    .join(' ').trim().split(/\s+/).filter(Boolean).length
  return Math.max(1, Math.ceil(words / 200))
})
// A save moments after publishing is the same edition; only a later one is an update.
const revisedAt = computed(() => {
  if (!props.updatedAt || !props.publishedAt) return null
  const updated = new Date(props.updatedAt).getTime()
  const published = new Date(props.publishedAt).getTime()
  if (Number.isNaN(updated) || Number.isNaN(published)) return null
  return Math.abs(updated - published) > 60_000 ? props.updatedAt : null
})
const focusedIndex = ref<number | null>(null)
const inserterIndex = ref<number | null>(null)
const inserterItems = [
  { type: 'image', label: 'Image', icon: 'i-lucide-image' },
  { type: 'video', label: 'Video', icon: 'i-lucide-video' },
  { type: 'faq', label: 'FAQ', icon: 'i-lucide-circle-help' },
  { type: 'how_to', label: 'How-To', icon: 'i-lucide-list-ordered' },
  { type: 'cta', label: 'Call to action', icon: 'i-lucide-megaphone' },
  { type: 'divider', label: 'Divider', icon: 'i-lucide-minus' },
] as const

/** An empty block the caret is in, or one whose menu is already open. */
function showInserter(index: number, block: BlogEditorBlock) {
  if (inserterIndex.value === index) return true
  return focusedIndex.value === index && isBlockEmpty(block)
}

function toggleInserter(index: number) {
  inserterIndex.value = inserterIndex.value === index ? null : index
}

function insertHere(index: number, type: string) {
  inserterIndex.value = null
  emit('insert-block-type', index, type)
}

/** Focus moving between the block and its own control is not leaving the block. */
function releaseFocus(index: number, event: FocusEvent) {
  const next = event.relatedTarget
  const section = event.currentTarget as HTMLElement | null
  if (next instanceof Node && section?.contains(next)) return
  if (focusedIndex.value === index) focusedIndex.value = null
  if (inserterIndex.value === index) inserterIndex.value = null
}

const rootEl = useTemplateRef<HTMLElement>('rootEl')

async function moveBlock(index: number, delta: -1 | 1) {
  const target = index + delta
  if (target < 0 || target > props.blocks.length - 1) return
  emit('move-block', index, delta)
  // The caret belongs to the block, not to the slot it was sitting in. Without
  // this a second press does nothing, because focus stayed behind on whatever
  // block moved into the old position.
  await nextTick()
  focusedIndex.value = target
  // Addressed by index rather than through a v-for ref array, whose order Vue
  // does not promise matches the blocks: it handed back the neighbour and the
  // caret landed one block off.
  const section = rootEl.value?.querySelector<HTMLElement>(`[data-block-index="${target}"]`)
  const editor = section?.querySelector<HTMLElement>('[contenteditable="true"], textarea')
  ;(editor ?? section)?.focus()
}

function isBlockEmpty(block: BlogEditorBlock) {
  if (block.type === 'markdown' || block.type === 'heading') {
    const text = String(block.data[block.type === 'heading' ? 'text' : 'markdown'] || '')
    return !text.trim()
  }
  return false
}
const DOMPurify = import.meta.client ? await loadDomPurify() : { sanitize: sanitizeHtmlForSsr }
function renderMarkdown(value: string, index: number) { return DOMPurify.sanitize(renderMarkdownToHtml(value, index)) }
function textValue(block: BlogEditorBlock) { return String(block.data[block.type === 'heading' ? 'text' : 'markdown'] || '') }
function updateText(index: number, block: BlogEditorBlock, event: Event) {
  const key = block.type === 'heading' ? 'text' : 'markdown'
  emit('update:block', index, { ...block, data: { ...block.data, [key]: (event.target as HTMLTextAreaElement).value } })
}
function updateMarkdown(index: number, block: BlogEditorBlock, value: string) {
  emit('update:block', index, { ...block, data: { ...block.data, markdown: value } })
}
/** A block the writer types into, where the keyboard is the structural control. */
function hasTextCaret(block: BlogEditorBlock) {
  return block.type === 'markdown' || block.type === 'heading'
}

/**
 * The block's own editor, as opposed to a field inside a block that happens to
 * be built from inputs. Backspace in an empty FAQ answer must not delete the FAQ.
 */
function isPrimaryEditor(target: EventTarget | null, block: BlogEditorBlock) {
  if (!(target instanceof HTMLElement)) return false
  if (block.type === 'heading') return target.getAttribute('aria-label') === 'Heading'
  return target.isContentEditable || target.getAttribute('aria-label') === 'Article Markdown'
}

/**
 * Splitting, merging and reordering, from the keyboard. These were four buttons
 * on every block; the block a writer is typing in is the one they mean, so the
 * caret already says which block without anything being drawn to say it.
 */
function handleStructuralKey(index: number, block: BlogEditorBlock, event: KeyboardEvent) {
  if (!props.editable) return
  // An image or divider has no caret, so the block itself takes focus and the
  // keys act on it. A field inside a block is not the block: backspace in an
  // empty FAQ answer must not take the FAQ with it.
  const owns = hasTextCaret(block)
    ? isPrimaryEditor(event.target, block)
    : event.target === event.currentTarget
  if (!owns) return

  if ((event.metaKey || event.ctrlKey) && event.shiftKey) {
    const delta = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : null
    if (delta === null) return
    moveBlock(index, delta)
    event.preventDefault()
    return
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return

  // Enter splits, but only from a heading: the markdown editor owns its own
  // Enter, and takes a split through `split-insert` when the writer asks for one.
  if (event.key === 'Enter' && block.type === 'heading' && !event.shiftKey) {
    emit('insert-block', index, 0)
    event.preventDefault()
    return
  }
  // A text block is removed once it is empty, the way backspacing off the front
  // of a paragraph works anywhere. A block with no text is removed as a whole.
  if (hasTextCaret(block) && !isBlockEmpty(block)) return
  const direction = event.key === 'Backspace' ? 'back' : event.key === 'Delete' ? 'forward' : null
  if (direction === null) return
  emit('merge-block', index, direction)
  event.preventDefault()
}
// Q&A records are attached to the block by the server for the article's path; the editor never holds them.
function faqItems(block: BlogEditorBlock) { return Array.isArray(block.data.items) ? block.data.items as Array<{ title?: string; description?: string }> : [] }
function howToSteps(block: BlogEditorBlock) { return block.data.steps as TenantPageHowToStep[] }
/** One key of a block's data payload, for blocks edited field-by-field. */
function updateBlockData(index: number, key: string, value: string) {
  const block = props.blocks[index]
  if (!block) return
  emit('update:block', index, { ...block, data: { ...block.data, [key]: value || null } })
}
function updateHowToStep(index: number, stepIndex: number, field: 'name' | 'text', value: string) {
  const block = props.blocks[index]
  if (!block) return
  const steps = howToSteps(block).map((step, i) => i === stepIndex ? { ...step, [field]: value } : step)
  emit('update:block', index, { ...block, data: { ...block.data, steps } })
}
function addHowToStep(index: number) {
  const block = props.blocks[index]
  if (!block) return
  emit('update:block', index, { ...block, data: { ...block.data, steps: [...howToSteps(block), { name: '', text: '' }] } })
}
function removeHowToStep(index: number, stepIndex: number) {
  const block = props.blocks[index]
  if (!block) return
  const steps = howToSteps(block).filter((_, i) => i !== stepIndex)
  emit('update:block', index, { ...block, data: { ...block.data, steps } })
}
function isRenderable(block: BlogEditorBlock) { return block.data.status !== 'inactive' && block.data.render_enabled !== false }
function blockMedia(block: BlogEditorBlock) { return Array.isArray(block.media) ? block.media.filter(item => item.slot === 'media') : [] }
function galleryItems(block: BlogEditorBlock) { return Array.isArray(block.media) ? block.media.filter(item => item.slot === 'gallery') : [] }
function safeUrl(value: unknown) { return sanitizeUrl(typeof value === 'string' ? value : null) }
function aiAssistanceProps(block: BlogEditorBlock) {
  if (block.data.render_enabled === false || block.data.status === 'inactive') return null
  const prompts = Array.isArray(block.data.prompts) ? block.data.prompts : []
  const normalized = prompts.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const prompt = item as Record<string, unknown>
    if (typeof prompt.prompt !== 'string' || !prompt.prompt.trim()) return []
    return [{ title: typeof prompt.title === 'string' ? prompt.title : null, prompt: prompt.prompt, description: typeof prompt.description === 'string' ? prompt.description : null, copyLabel: typeof prompt.copy_label === 'string' ? prompt.copy_label : 'Copy prompt' }]
  })
  return normalized.length ? { label: typeof block.data.label === 'string' ? block.data.label : 'AI Assistance', intro: typeof block.data.intro === 'string' ? block.data.intro : null, collapsed: block.data.collapsed !== false, maxVisibleLines: typeof block.data.max_visible_lines === 'number' ? block.data.max_visible_lines : undefined, prompts: normalized } : null
}
</script>

<style scoped>
.blog-article[data-template="blawby"] { color: var(--ui-text); }
.blog-article[data-template="blawby"] .blog-article-header h1 { color: var(--blawby-primary, currentColor); }
.blog-article[data-template="saya"] { color: var(--ui-text, inherit); }
</style>
