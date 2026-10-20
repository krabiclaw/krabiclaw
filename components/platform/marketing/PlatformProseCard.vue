<template>
  <div class="rounded-3xl border border-default bg-elevated/40 p-8 sm:p-12 space-y-6 backdrop-blur-md" data-parity-section="prose">
    <h2 v-if="title" class="text-2xl sm:text-3xl font-bold text-default m-0">{{ title }}</h2>
    <TenantPageMarkdown :content="content" class="prose space-y-6 text-base text-muted leading-relaxed [&>p]:m-0" />
  </div>
</template>

<script setup lang="ts">
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { TenantPageBlock } from '~/utils/tenant-page-blocks'
import { blockText, blockTextOrNull } from '~/utils/tenant-page-block-data'
/** A heading and a few paragraphs in a glass card — the About page's "dilemma" section. */
const props = defineProps<{ block: TenantPageBlock; page: PublicTenantPage }>()

const title = computed(() => blockTextOrNull(props.block.data.title))
const content = computed(() => blockText(props.block.data.markdown))
</script>
