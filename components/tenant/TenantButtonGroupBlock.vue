<template>
  <div v-if="buttons.length" class="mb-8 mt-4 flex flex-wrap justify-center gap-4 px-4" data-parity-section="articles-more">
    <TenantButton v-for="button in buttons" :key="button.url" :to="route(button.url)">{{ button.label }}</TenantButton>
  </div>
</template>

<script setup lang="ts">
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { TenantPageBlock } from '~/utils/tenant-page-blocks'
import { blockText, blockRecords, isInternalRoute } from '~/utils/tenant-page-block-data'

const props = defineProps<{ block: TenantPageBlock; page: PublicTenantPage }>()
const { localePath } = useI18n()

function route(url: string) {
  return isInternalRoute(url) ? localePath(url) : url
}

const buttons = computed(() => blockRecords(props.block.data.buttons)
  .map(button => ({ label: blockText(button.label), url: blockText(button.url) }))
  .filter(button => button.label && button.url))
</script>
