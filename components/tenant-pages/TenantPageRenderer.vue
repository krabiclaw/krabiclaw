<template>
  <article
    data-tenant-page
    :data-template="template"
    class="text-default"
    :class="[readingColumn ? 'py-16' : undefined, platformHome ? 'kc-platform-home' : undefined, template === 'platform' && page.recipe === 'products' ? 'kc-products-page' : undefined, template === 'platform' && page.path === '/pricing' ? 'kc-pricing-editorial' : undefined]"
  >
    <!--
      A template's own component names its band; the wrapper only names one for
      the markup below, or both would appear on the same section.
    -->
    <!--
      A hero section: the hero and every block after it up to a divider share the
      hero's band, and the divider is the shield its bottom edge is cut to. With
      a picture hero the shield cuts the picture. Any other run of blocks is not
      wrapped, and a divider outside a hero section is a plain break.
    -->
    <HeroSection v-for="group in blockGroups" :key="group.key" :section="group.heroSection">
    <section v-for="block in group.blocks" :key="block.id" :data-block-type="block.type" :data-parity-section="presentationOf(block) ? undefined : sectionKey(block)"
      class="tenant-page-block"
      :class="!presentationOf(block) ? 'mx-auto max-w-7xl px-4 sm:px-6 lg:px-8' : undefined"
      :aria-hidden="group.heroSection && block.type === 'divider' ? 'true' : undefined"
    >
      <!--
        A template that draws this block its own way draws it; otherwise the
        markup below is the presentation. See utils/tenant-page-presentation.ts.
      -->
      <component :is="presentationOf(block)" v-if="presentationOf(block)" :block="block" :page="page" />
      <TenantPageRichTextBlock v-else-if="block.type === 'heading' || block.type === 'markdown'" :block="block" />

      <template v-else-if="block.type === 'image'">
        <figure v-if="blockMedia(block, 'media')" class="my-12">
          <MediaPreview
            v-if="blockMedia(block, 'media')?.kind === 'video'"
            :item="{ url: blockMedia(block, 'media')!.public_url!, kind: 'video', poster: blockMedia(block, 'media')!.thumbnail_url ?? undefined }"
            :fill="false"
            class="rounded-2xl shadow-lg"
          />
          <img v-else :src="blockMedia(block, 'media')!.public_url!" :alt="blockMedia(block, 'media')!.alt_text ?? ''" class="w-full rounded-2xl object-cover shadow-lg">
          <figcaption v-if="text(block.data.caption)" class="mt-3 text-center text-sm text-muted">{{ text(block.data.caption) }}</figcaption>
        </figure>
      </template>

      <figure v-else-if="block.type === 'video'" class="my-12">
        <ContentVideoEmbed :url="block.data.url" :title="text(block.data.title)" class="rounded-2xl shadow-lg" />
        <figcaption v-if="text(block.data.caption)" class="mt-3 text-center text-sm text-muted">{{ text(block.data.caption) }}</figcaption>
      </figure>

      <template v-else-if="block.type === 'gallery'">
        <p v-if="text(block.data.caption)" class="mb-4 text-center text-sm text-muted">{{ text(block.data.caption) }}</p>
        <div v-if="galleryImages(block).length" class="my-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <figure v-for="image in galleryImages(block)" :key="image.id || image.url">
            <div v-if="image.kind === 'video'" class="aspect-4/3 w-full overflow-hidden rounded-2xl">
              <MediaPreview :item="{ url: image.url, kind: 'video', poster: image.thumbnailUrl ?? undefined, alt: image.alt }" />
            </div>
            <img v-else :src="image.url" :alt="image.alt ?? ''" class="aspect-[4/3] w-full rounded-2xl object-cover">
            <figcaption v-if="image.caption" class="mt-2 text-sm text-muted">{{ image.caption }}</figcaption>
          </figure>
        </div>
      </template>

      <template v-else-if="block.type === 'how_to'">
        <section class="my-12">
          <h2 v-if="text(block.data.title)" class="mb-6 text-2xl font-semibold">{{ text(block.data.title) }}</h2>
          <p v-if="text(block.data.description)" class="mb-6 text-muted">{{ text(block.data.description) }}</p>
          <ol class="list-decimal space-y-4 pl-6">
            <li v-for="(step, index) in (block.data.steps as TenantPageHowToStep[])" :key="index">
              <p class="font-semibold">{{ step.name }}</p>
              <p v-if="step.text" class="text-muted">{{ step.text }}</p>
            </li>
          </ol>
        </section>
      </template>

      <template v-else-if="block.type === 'divider'">
        <hr v-if="!group.heroSection" class="my-12 border-default">
      </template>

      <template v-else-if="block.type === 'cta' || block.type === 'contact_cta' || block.type === 'booking_cta'">
        <section v-if="text(block.data.title) || text(block.data.description) || text(block.data.label)" class="my-12 rounded-3xl bg-elevated p-8 sm:p-12">
          <h2 v-if="text(block.data.title)" class="text-3xl font-semibold">{{ text(block.data.title) }}</h2>
          <p v-if="text(block.data.description)" class="mt-3 max-w-2xl text-muted">{{ text(block.data.description) }}</p>
          <TenantPageButton v-if="text(block.data.label) && text(block.data.url)" class="mt-6" :label="text(block.data.label)" :url="text(block.data.url)" />
        </section>
      </template>

      <template v-else-if="block.type === 'callout'">
        <aside v-if="text(block.data.title) || text(block.data.body)" class="my-10 rounded-2xl border border-primary/30 bg-primary/5 p-6">
          <h2 v-if="text(block.data.title)" class="text-xl font-semibold">{{ text(block.data.title) }}</h2>
          <div v-if="text(block.data.body)" class="prose mt-2 max-w-none whitespace-pre-wrap text-muted">{{ sanitize(text(block.data.body)) }}</div>
          <div v-if="buttons(block).length" class="mt-5 flex flex-wrap gap-3">
            <TenantPageButton v-for="button in buttons(block)" :key="button.url + button.label" :label="button.label" :url="button.url" />
          </div>
        </aside>
      </template>

      <template v-else-if="block.type === 'button_group'">
        <div v-if="buttons(block).length" class="my-8 flex flex-wrap gap-3">
          <TenantPageButton v-for="button in buttons(block)" :key="button.url + button.label" :label="button.label" :url="button.url" />
        </div>
      </template>

      <template v-else-if="block.type === 'feature_grid' && calculatorRows(block).length">
        <TenantPagePricingCalculator :rows="calculatorRows(block)" :note="calculatorNote(block)" />
      </template>

      <template v-else-if="block.type === 'feature_grid' || block.type === 'testimonial_grid' || block.type === 'product_grid' || block.type === 'location_grid' || block.type === 'page_grid'">
        <section class="my-12">
          <h2 v-if="gridTitle(block)" class="mb-6 text-2xl font-semibold">{{ gridTitle(block) }}</h2>
          <div class="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
            <article v-for="(item, index) in gridItems(block)" :key="item.id || item.title || index" class="rounded-2xl border border-default bg-default p-6 shadow-sm">
              <img v-if="gridItemImage(item)" :src="gridItemImage(item)!.url" :alt="gridItemImage(item)!.alt" class="mb-5 aspect-[4/3] w-full rounded-xl object-cover">
              <p v-if="item.value" class="text-3xl font-bold text-primary">{{ item.value }}</p>
              <h3 v-if="item.title" class="text-lg font-semibold">{{ item.title }}</h3>
              <span v-if="item.featured" class="mt-2 inline-flex rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">{{ t('site.posts.featured') }}</span>
              <p v-if="item.description || item.address" class="mt-2 text-sm leading-6 text-muted">{{ item.description }}<br v-if="item.description && item.address">{{ item.address }}</p>
              <TenantPageButton v-if="item.url && itemLabel(item)" class="mt-4" :label="itemLabel(item)" :url="item.url" />
            </article>
          </div>
          <p v-if="!gridItems(block).length" class="rounded-2xl border border-dashed border-default p-6 text-sm text-muted">This section has no published items yet.</p>
        </section>
      </template>

      <template v-else-if="block.type === 'team_grid'">
        <section class="my-12">
          <h2 v-if="text(block.data.title)" class="text-2xl font-semibold">{{ text(block.data.title) }}</h2>
          <p v-if="text(block.data.description)" class="mt-2 text-muted">{{ text(block.data.description) }}</p>
          <div class="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            <article v-for="(person, index) in teamItems(block)" :key="person.name || index" class="rounded-2xl border border-default bg-default p-6 shadow-sm">
              <img v-if="person.image" :src="person.image.url" :alt="person.name" class="mb-5 aspect-square w-full rounded-xl object-cover">
              <h3 class="text-lg font-semibold">{{ person.name }}</h3>
              <p v-if="person.role" class="text-sm text-muted">{{ person.role }}</p>
              <p v-if="person.bio" class="mt-2 text-sm leading-6 text-muted">{{ person.bio }}</p>
              <TenantPageButton v-if="person.url" class="mt-4" :label="person.name" :url="person.url" />
            </article>
          </div>
        </section>
      </template>

      <template v-else-if="block.type === 'donation_choices'">
        <section class="my-12">
          <h2 v-if="text(block.data.title)" class="text-2xl font-semibold">{{ text(block.data.title) }}</h2>
          <p v-if="text(block.data.description)" class="mt-2 text-muted">{{ text(block.data.description) }}</p>
          <div class="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            <article v-for="(item, index) in donationItems(block)" :key="item.id || item.title || index" class="rounded-2xl border border-default p-6">
              <p v-if="item.amount" class="text-3xl font-bold text-primary">{{ item.amount }}</p>
              <h3 class="mt-2 font-semibold">{{ item.title }}</h3>
              <p v-if="item.description" class="mt-2 text-sm text-muted">{{ item.description }}</p>
              <TenantPageButton v-if="text(block.data.destination) && item.amount" class="mt-5" :label="`Donate ${item.amount}`" :url="text(block.data.destination)" />
            </article>
            <article v-if="text(block.data.destination)" class="rounded-2xl border border-default p-6">
              <h3 class="font-semibold">Custom Amount</h3>
              <p class="mt-2 text-sm text-muted">Choose your own donation amount</p>
              <TenantPageButton class="mt-5" label="Donate custom amount" :url="text(block.data.destination)" />
            </article>
          </div>
          <p v-if="!donationItems(block).length" class="rounded-2xl border border-dashed border-default p-6 text-sm text-muted">Donation choices are not configured.</p>
        </section>
      </template>
    </section>
    </HeroSection>
  </article>
</template>

<script setup lang="ts">
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { TenantPageBlock, TenantPageHowToStep } from '~/utils/tenant-page-blocks'
import { h, type Component, type FunctionalComponent } from 'vue'
import type { PublicTemplateSlug } from '~/utils/template-registry'
import { tenantPageBlockPresentation } from '~/utils/tenant-page-presentation'
import { overviewProseBlockId } from '~/utils/tenant-page-block-data'
import { resolveSocialImageUrl } from '~/utils/social-metadata'
import ContentVideoEmbed from '~/components/content/ContentVideoEmbed.vue'
import MediaPreview, { provideMediaPreviews } from '~/components/MediaPreview.vue'

const props = defineProps<{ page: PublicTenantPage }>()
provideMediaPreviews(ref(false))

const { template: resolvedTemplate } = useTenantOrganization().organization
const template = computed<PublicTemplateSlug>(() => resolvedTemplate.slug)
const platformHome = computed(() => template.value === 'platform' && props.page.path === '/')

function presentationOf(block: TenantPageBlock): Component | null {
  return tenantPageBlockPresentation(template.value, block.type)
}
import { loadDomPurify } from '~/utils/dom-purify-loader'
import { sanitizeHtmlForSsr } from '~/utils/markdown'

const DOMPurify = import.meta.client ? await loadDomPurify() : { sanitize: sanitizeHtmlForSsr }
const { t } = useI18n()
/**
 * The page's blocks, in the order the page carries them — less the one the
 * service overview draws inside its own column, which would otherwise appear
 * twice: once beside the pictures and once in a band below them.
 */
const renderedBlocks = computed(() => {
  const absorbed = template.value === 'platform' ? null : overviewProseBlockId(props.page)
  return absorbed ? props.page.blocks.filter(block => block.id !== absorbed) : props.page.blocks
})

/**
 * The page's blocks in runs: a hero section — the first hero through the next
 * divider, with no other hero between — and the single blocks around it.
 */
// Only a hero section is an element of its own; any other block stays a direct
// child of the article, so the page's own sibling selectors still reach it.
const HeroSection: FunctionalComponent<{ section: boolean }> = (sectionProps, { slots }) => sectionProps.section
  ? h('div', { class: 'tenant-shield-edge relative bg-[var(--tenant-band)]', 'data-hero-section': '' }, slots.default?.())
  : slots.default?.()
HeroSection.props = ['section']
const blockGroups = computed(() => {
  const blocks = renderedBlocks.value
  const hero = template.value === 'platform' ? -1 : blocks.findIndex(block => block.type === 'hero')
  const divider = hero < 0 ? -1 : blocks.findIndex((block, index) => index > hero && block.type === 'divider')
  const closes = divider > hero && !blocks.slice(hero + 1, divider).some(block => block.type === 'hero')
  const single = (block: TenantPageBlock) => ({ key: block.id, heroSection: false, blocks: [block] })
  if (!closes) return blocks.map(single)
  return [
    ...blocks.slice(0, hero).map(single),
    { key: `hero-section-${blocks[hero]!.id}`, heroSection: true, blocks: blocks.slice(hero, divider + 1) },
    ...blocks.slice(divider + 1).map(single),
  ]
})

/**
 * A page this renderer draws by itself reads as one column of prose and needs
 * the space around it. A page whose template draws bands does not: each band
 * carries its own, and the outer padding left a gap above the first one.
 */
const readingColumn = computed(() => template.value !== 'platform' && !renderedBlocks.value.some(presentationOf))

type GridItem = { id?: string; title?: string; description?: string; address?: string; value?: string; featured?: boolean; media?: Array<{ slot?: string; public_url?: string | null; thumbnail_url?: string | null; alt_text?: string | null; kind?: string | null }>; label?: string; labelKey?: string; url?: string; amount?: string }

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function sanitize(value: string): string {
  return DOMPurify.sanitize(value)
}

/**
 * The name this band carries for tests and parity checks: the block's type.
 * It used to read `data.section`, so a band was named by a key the document
 * held only because two hand-written renderers needed it to tell blocks apart.
 */
function sectionKey(block: TenantPageBlock): string {
  return block.type
}

function galleryImages(block: TenantPageBlock): Array<{ id?: string; url: string; alt?: string; caption?: string; kind?: string | null; thumbnailUrl?: string | null }> {
  return block.media
    .filter(item => item.slot === 'gallery' && item.public_url)
    .map(item => ({ id: item.asset_id, url: item.public_url!, alt: item.alt_text ?? undefined, kind: item.kind, thumbnailUrl: item.thumbnail_url }))
}

function blockMedia(block: TenantPageBlock, slot: string) {
  return block.media.find(item => item.slot === slot && item.public_url) ?? null
}

/**
 * One item shape. `name`, `summary`, `body`, `cta_label` and `cta_url` were
 * also accepted here — spellings no writer produces and the block registry
 * does not declare, kept in case some row somewhere used them.
 *
 * `media` is whatever the item arrived with: a referenced page, product or
 * location carries its own resolved image, and the server puts it here.
 */
function asItems(value: unknown): GridItem[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item))).map(item => ({
    id: text(item.id) || undefined,
    title: text(item.title) || undefined,
    description: text(item.description) || undefined,
    address: text(item.address) || undefined,
    value: text(item.value) || undefined,
    featured: item.featured === true,
    media: Array.isArray(item.media) ? item.media as GridItem['media'] : [],
    label: text(item.label) || undefined,
    labelKey: text(item.labelKey) || undefined,
    url: text(item.url) || undefined,
    amount: item.amount == null ? undefined : String(item.amount),
  }))
}

function gridTitle(block: TenantPageBlock): string {
  const title = text(block.data.title)
  if (title || block.type !== 'product_grid') return title
  const items = asItems(block.data.items)
  return items.length && items.every(item => item.featured) ? t('site.posts.featured') : ''
}

/**
 * Does this block own its items, or does it reference resources?
 *
 * A reference grid names pages, products or locations and the server resolves
 * each one's own image; an authored grid's items are written in the block and
 * their images are its own placements. Which of the two decides where an
 * item's image comes from — it is one question with one answer per block, not
 * a search for whichever media turns up.
 */
function referencesResources(block: TenantPageBlock): boolean {
  if (block.type === 'page_grid' || block.type === 'product_grid' || block.type === 'location_grid') return true
  return text(block.data.source) !== '' && text(block.data.source) !== 'manual'
}

function itemLabel(item: GridItem): string {
  return item.labelKey ? t(item.labelKey) : item.label || ''
}

/**
 * The one image an item carries — the referenced resource's own, or the
 * block's placement at `items.<index>.image`, decided above by which kind of
 * grid this is. There is no search across slots and no "whichever asset came
 * first": the item has that image or it has none.
 */
function gridItemImage(item: GridItem): { url: string; alt: string } | null {
  const asset = (item.media ?? [])[0]
  if (!asset) return null
  const url = resolveSocialImageUrl(asset)
  return url ? { url, alt: asset.alt_text ?? '' } : null
}


function gridItems(block: TenantPageBlock): GridItem[] {
  const items = asItems(block.data.items)
  if (referencesResources(block)) return items
  return items.map((item, index) => ({
    ...item,
    media: block.media.filter(asset => asset.slot === `items.${index}.image`),
  }))
}

/** The people a team_grid names, each with the image in its own slot. */
function teamItems(block: TenantPageBlock) {
  const people = Array.isArray(block.data.items) ? block.data.items : []
  return people
    .filter((person): person is Record<string, unknown> => Boolean(person && typeof person === 'object' && !Array.isArray(person)))
    .map((person, index) => {
      const asset = block.media.find(item => item.slot === `items.${index}.image` && item.public_url)
      return {
        name: [text(person.first_name), text(person.last_name)].filter(Boolean).join(' '),
        role: text(person.title),
        bio: text(person.bio),
        url: text(person.url),
        image: asset?.public_url ? { url: asset.public_url } : null,
      }
    })
    .filter(person => person.name)
}

function donationItems(block: TenantPageBlock): GridItem[] {
  return asItems(block.data.tiers)
}

function buttons(block: TenantPageBlock): Array<{ label: string; url: string }> {
  if (!Array.isArray(block.data.buttons)) return []
  return block.data.buttons.filter((button): button is Record<string, unknown> => Boolean(button && typeof button === 'object')).map(button => ({ label: text(button.label), url: text(button.url) })).filter(button => button.label && button.url)
}

function calculatorRows(block: TenantPageBlock): unknown[][] {
  const calculator = block.data.calculator
  if (!calculator || typeof calculator !== 'object' || Array.isArray(calculator)) return []
  const rows = (calculator as Record<string, unknown>).rows
  return Array.isArray(rows) ? rows.filter(Array.isArray) as unknown[][] : []
}

function calculatorNote(block: TenantPageBlock): string | undefined {
  const calculator = block.data.calculator
  if (!calculator || typeof calculator !== 'object' || Array.isArray(calculator)) return undefined
  const note = (calculator as Record<string, unknown>).note
  return typeof note === 'string' ? note : undefined
}
</script>

<style scoped>
@reference "../../assets/css/base.css";

.kc-platform-home :deep(.kc-showcase__inner),
.kc-platform-home :deep(.kc-steps__inner),
.kc-platform-home :deep(.kc-reach__inner),
.kc-platform-home :deep(.kc-social__inner),
.kc-platform-home :deep(.kc-picture-cards__inner) {
  @apply mx-auto w-full max-w-304 px-6;
}

.kc-platform-home :deep(.kc-media-feature) {
  @apply mx-auto max-w-304 px-6;
}

.kc-platform-home :deep(.kc-media-feature__card) {
  width: 100%;
}
</style>

<style scoped>
.kc-pricing-editorial > [data-block-type="heading"] { background: #f9f8f4; max-width: none; padding: 4rem 1.5rem 1rem; }
.kc-pricing-editorial > [data-block-type="heading"] :deep(h2) { max-width: 62rem; margin: auto; color: #252b43; font-size: clamp(2rem, 3.5vw, 3rem); font-weight: 600; }
</style>
