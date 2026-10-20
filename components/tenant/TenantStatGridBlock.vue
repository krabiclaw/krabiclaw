<template>
  <section v-if="statistics.length" class="bg-elevated py-16" data-parity-section="impact">
    <div class="tenant-container">
      <div class="mx-auto max-w-4xl">
        <div class="mb-12 text-center">
          <h2 class="tenant-display mb-6 text-3xl font-bold text-highlighted sm:text-4xl">{{ title }}</h2>
          <p v-if="description" class="mb-4 text-lg leading-8 text-muted">{{ description }}</p>
          <p v-if="additionalDescription" class="text-lg leading-8 text-muted">{{ additionalDescription }}</p>
        </div>
        <div class="rounded-xl border border-default bg-muted/40 shadow-sm sm:grid sm:grid-cols-3 sm:gap-8 sm:px-8 sm:py-8">
          <div v-for="statistic in statistics" :key="statistic.label" class="p-6 text-center sm:p-8">
            <p class="text-5xl font-bold text-primary">{{ statistic.value }}</p>
            <p class="mt-2 text-sm font-medium text-muted">{{ statistic.label }}</p>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { TenantPageBlock } from '~/utils/tenant-page-blocks'
import { blockText, blockTextOrNull, blockRecords } from '~/utils/tenant-page-block-data'

const props = defineProps<{ block: TenantPageBlock; page: PublicTenantPage }>()

const title = computed(() => blockText(props.block.data.title))
const description = computed(() => blockTextOrNull(props.block.data.description))
const additionalDescription = computed(() => blockTextOrNull(props.block.data.additionalDescription))
const statistics = computed(() => blockRecords(props.block.data.items)
  .map(item => ({ value: blockText(item.value), label: blockText(item.title) }))
  .filter(stat => stat.value && stat.label))
</script>
