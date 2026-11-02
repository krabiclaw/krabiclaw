<template>
  <section class="bg-elevated px-6 pb-24 sm:pb-32" :aria-labelledby="headingId">
    <div class="mx-auto grid max-w-3xl gap-5 rounded-2xl border border-default bg-elevated p-8 shadow-sm sm:p-10">
      <h2 :id="headingId" class="tenant-display text-3xl font-bold text-highlighted">{{ title || t('forms.default_title') }}</h2>
      <p v-if="description" class="whitespace-pre-line text-base leading-7 text-muted">{{ description }}</p>
      <TenantInquiryForm :booking="booking" />
    </div>
  </section>
</template>

<script setup lang="ts">
import TenantInquiryForm from '~/components/tenant/TenantInquiryForm.vue'
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { TenantPageBlock } from '~/utils/tenant-page-blocks'

const props = defineProps<{ block: TenantPageBlock; page: PublicTenantPage }>()
const { t } = useI18n()
const headingId = useId()
const title = computed(() => typeof props.block.data.title === 'string' ? props.block.data.title.trim() : '')
const description = computed(() => typeof props.block.data.description === 'string' ? props.block.data.description.trim() : '')
// Hydrated by the page reader from the offering the block names; null when there is none to book.
const booking = computed(() => {
  const value = props.block.data.booking
  return isRecord(value) && typeof value.url === 'string' ? { url: value.url, label: typeof value.label === 'string' ? value.label : null } : null
})
</script>
