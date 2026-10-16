<template>
  <!--
    Under a shield the row starts below its point: the shield's box is its
    straight sides only (56 of 160 units on a 1920-wide drawing), and the point
    overlays whatever comes next, which drew over these buttons on /donate.
  -->
  <div v-if="buttons.length" :class="followsShield ? 'pt-[calc(104/1920*100%_+_1.5rem)]' : 'mt-4'" class="mb-8 flex flex-wrap justify-center gap-4 px-4" data-parity-section="articles-more">
    <BlawbyButton v-for="button in buttons" :key="button.url" :to="route(button.url)">{{ button.label }}</BlawbyButton>
  </div>
</template>

<script setup lang="ts">
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { TenantPageBlock } from '~/utils/tenant-page-blocks'
import { blockText, blockRecords, isInternalRoute } from '~/utils/tenant-page-block-data'

/** A row of links the page carries, in the order it carries them. */
const props = defineProps<{ block: TenantPageBlock; page: PublicTenantPage }>()
const { localePath } = useI18n()

/** An internal route takes the visitor's locale; an absolute URL is left alone. */
function route(url: string) {
  return isInternalRoute(url) ? localePath(url) : url
}

const followsShield = computed(() => {
  const index = props.page.blocks.findIndex(item => item.id === props.block.id)
  return index > 0 && props.page.blocks[index - 1]!.type === 'divider'
})

const buttons = computed(() => blockRecords(props.block.data.buttons)
  .map(button => ({ label: blockText(button.label), url: blockText(button.url) }))
  .filter(button => button.label && button.url))
</script>
