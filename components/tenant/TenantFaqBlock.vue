<template>
  <section v-if="items.length" id="faq" class="relative overflow-hidden py-20 sm:py-28" data-parity-section="qa">
    <div class="tenant-container relative z-20">
      <TenantSectionHeading :title="heading" accent="questions" />
      <ul class="mx-auto mb-auto mt-16 grid max-w-2xl grid-cols-1 content-start gap-8 lg:max-w-none lg:grid-cols-3" role="list">
        <li v-for="(column, columnIndex) in columns" :key="columnIndex">
          <ul class="flex flex-col gap-y-8" role="list">
            <li v-for="item in column" :key="item.id">
              <article class="rounded-2xl border border-default bg-elevated p-6 shadow-sm">
                <h3 class="tenant-display text-lg font-bold leading-7 text-highlighted">{{ item.question }}</h3>
                <TenantRichText
                  :content="item.answer"
                  unstyled
                  class="prose prose-sm mt-4 max-w-none border-l-2 border-primary pl-4 text-sm text-default prose-p:my-1 prose-ul:my-1 prose-li:my-0"
                />
              </article>
            </li>
          </ul>
        </li>
      </ul>
    </div>
    <img v-if="decorationUrl" :src="decorationUrl" alt="" width="800" height="800" loading="lazy" class="absolute right-0 top-0 z-10 w-2/6 object-contain object-center opacity-30">
  </section>
</template>

<script setup lang="ts">
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { TenantPageBlock } from '~/utils/tenant-page-blocks'
import { blockText, blockTextOrNull, blockRecords, blockMedia } from '~/utils/tenant-page-block-data'

const props = defineProps<{ block: TenantPageBlock; page: PublicTenantPage }>()

const decorationUrl = computed(() => blockMedia(props.block, 'decoration')[0]?.public_url ?? null)

const items = computed(() => blockRecords(props.block.data.items).map(item => ({
  id: blockText(item.id),
  question: blockText(item.title),
  answer: blockTextOrNull(item.description),
  sort_order: 0,
})).filter(item => item.id && item.question))

const heading = computed(() => blockText(props.block.data.title) || 'Frequently asked questions')

const columns = computed(() => {
  const size = Math.ceil(items.value.length / 3)
  return Array.from({ length: 3 }, (_, index) => items.value.slice(index * size, (index + 1) * size))
})
</script>
