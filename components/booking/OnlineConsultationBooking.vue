<template>
  <section id="consultations" class="scroll-mt-32 pt-10 sm:pt-14" :aria-label="t('booking.choose_consultation')">
    <ProductCollectionPage v-if="consultations.length" :products="consultations" :collections="[]" :locations="[]" :currency="data!.currency" :presentation="presentation" vertical="service" :brand-name="organizationName" />
    <p v-else role="status" class="mx-auto max-w-7xl px-4 pb-14 text-muted sm:px-6 lg:px-8">{{ t('booking.no_services') }}</p>
  </section>
</template>
<script setup lang="ts">
import ProductCollectionPage from '~/components/products/ProductCollectionPage.vue'
import { requireProductPresentation } from '~/utils/product-presentation'
// Each consultation is booked on its own practice-area page, as an experience
// is on its own: this page lists them and links there.
const { data, organizationName } = await useConsultationProducts()
if (!data.value) throw createError({ statusCode: 500, statusMessage: 'Consultation services were not returned' })
const { t } = useI18n()
const consultations = computed(() => data.value!.products.filter(product => product.kind === 'service' && product.active && product.page && (product.booking || product.order_url)))
const presentation = requireProductPresentation('service')
</script>
