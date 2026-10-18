<template>
  <section
    v-if="items.length"
    :id="isPlatform ? undefined : 'faq'"
    class="kc-faq"
    :class="{ 'kc-faq--platform': isPlatform, 'kc-faq--pricing': isPlatform && page.path === '/pricing', 'kc-faq--service': !isPlatform && isService }"
    :aria-label="heading"
    :data-parity-section="isPlatform ? 'faq' : 'qa'"
  >
    <div class="kc-faq__inner">
      <header class="kc-faq__heading">
        <template v-if="isPlatform">
          <p v-if="eyebrow" class="kc-faq__eyebrow">{{ eyebrow }}</p>
          <h2>{{ heading }}</h2>
        </template>
        <TenantSectionHeading v-else :title="heading" accent="questions" :eyebrow="eyebrow" />
      </header>
      <div class="kc-faq__questions">
        <details v-for="item in items" :key="item.id" :name="accordionName" class="kc-faq__item">
          <summary>
            <span>{{ item.question }}</span>
            <UIcon name="i-lucide-chevron-down" class="kc-faq__chevron" aria-hidden="true" />
          </summary>
          <TenantPageMarkdown v-if="item.answer" :content="item.answer" class="kc-faq__answer prose max-w-none" />
        </details>
      </div>
    </div>
    <img
      v-if="decorationUrl"
      :src="decorationUrl"
      alt=""
      width="800"
      height="800"
      loading="lazy"
      class="kc-faq__decoration"
    >
  </section>
</template>

<script setup lang="ts">
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { TenantPageBlock } from '~/utils/tenant-page-blocks'
import { blockText, blockTextOrNull, blockRecords, blockMedia } from '~/utils/tenant-page-block-data'

const props = defineProps<{ block: TenantPageBlock; page: PublicTenantPage }>()
const { organization } = useTenantOrganization()

const isPlatform = computed(() => organization.template.slug === 'platform')
const isService = computed(() => organization.template?.slug === 'blawby' || organization.vertical === 'service')
const accordionName = useId()
const decorationUrl = computed(() => blockMedia(props.block, 'decoration')[0]?.public_url ?? null)
const eyebrow = computed(() => blockTextOrNull(props.block.data.label))
const items = computed(() => blockRecords(props.block.data.items).map(item => ({
  id: blockText(item.id),
  question: blockText(item.title),
  answer: blockTextOrNull(item.description),
})).filter(item => item.id && item.question))
const heading = computed(() => blockText(props.block.data.title) || 'Frequently asked questions')
</script>

<style scoped>
.kc-faq { position: relative; overflow: hidden; padding: clamp(4rem, 7vw, 7rem) 1.5rem; color: var(--ui-text-highlighted); }
.kc-faq__inner { position: relative; z-index: 1; max-width: 58rem; margin-inline: auto; }
.kc-faq__heading { margin-bottom: clamp(2rem, 4vw, 3rem); }
.kc-faq--platform h2 { margin: 0; font-size: clamp(2.25rem, 4vw, 3.5rem); font-weight: 400; line-height: 1.08; letter-spacing: -.045em; }
.kc-faq__eyebrow { margin: 0 0 1rem; color: var(--ui-primary); font-size: .75rem; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; }
.kc-faq__item { border-bottom: 1px solid var(--ui-border); }
.kc-faq__item:first-child { border-top: 1px solid var(--ui-border); }
.kc-faq summary { display: flex; align-items: center; justify-content: space-between; gap: 1.5rem; min-height: 4.5rem; padding: 1.25rem 0; font-size: 1rem; font-weight: 600; line-height: 1.5; list-style: none; cursor: pointer; }
.kc-faq summary::-webkit-details-marker { display: none; }
.kc-faq summary:focus-visible { outline: 2px solid var(--ui-primary); outline-offset: 5px; border-radius: .25rem; }
.kc-faq__chevron { flex-shrink: 0; width: 1.25rem; height: 1.25rem; transition: transform 200ms ease; }
.kc-faq__item[open] .kc-faq__chevron { transform: rotate(180deg); }
.kc-faq__answer { max-width: 70ch; padding: 0 2.75rem 1.5rem 0; color: var(--ui-text-muted); font-size: 1rem; line-height: 1.75; }
.kc-faq__answer :deep(:first-child) { margin-top: 0; }
.kc-faq__answer :deep(:last-child) { margin-bottom: 0; }
.kc-faq__answer :deep(a) { color: var(--ui-primary); text-underline-offset: .2em; }
.kc-faq__decoration { position: absolute; top: 0; right: 0; width: 33%; opacity: .2; object-fit: contain; pointer-events: none; }
.kc-faq--service { background: var(--blawby-accent-200); }
.kc-faq--pricing { background: #f9f8f4; --ui-text-highlighted: #252b43; --ui-text-muted: #646878; --ui-border: #d6d8de; }
@media (max-width: 640px) {
  .kc-faq { padding-inline: 1.25rem; }
  .kc-faq summary { gap: 1rem; }
  .kc-faq__answer { padding-right: 0; }
}
@media (prefers-reduced-motion: reduce) { .kc-faq__chevron { transition: none; } }
</style>
