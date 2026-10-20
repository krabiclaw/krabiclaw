<template>
  <section id="consultations" class="py-10 sm:py-14 scroll-mt-32" :aria-label="t('booking.choose_consultation')">
    <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
      <UFormField :label="t('booking.service')" class="max-w-xl">
        <USelect v-model.nullable="selectedId" :items="items" value-key="id" label-key="title" :portal="false" :ui="{ content: 'z-50' }" class="w-full min-w-0" />
      </UFormField>
      <div v-if="selectedService" class="mt-8 flex items-start gap-5">
        <img v-if="thumbnail" :src="thumbnail" :alt="blockText(cover?.alt_text)" class="size-24 shrink-0 rounded-xl object-cover sm:size-32">
        <div class="max-w-3xl">
          <h2 class="blawby-display text-2xl text-default sm:text-3xl">{{ selectedOffer?.product.name ?? selectedService.name }}</h2>
          <p v-if="selectedOffer?.product.description || selectedService.description" class="mt-3 leading-7 text-muted">{{ selectedOffer?.product.description ?? selectedService.description }}</p>
          <NuxtLink v-if="selectedService.page" :to="localePath(selectedService.page.path)" class="mt-3 inline-block text-sm font-medium text-primary underline underline-offset-4">{{ t('booking.service_details') }}</NuxtLink>
        </div>
      </div>
      <p v-else role="status" class="mt-5 text-muted">{{ t('booking.no_services') }}</p>
      <p v-if="selectedService && !selectedOffer" role="status" class="mt-6 text-muted">{{ t('booking.service_unavailable') }} <NuxtLink :to="localePath('/contact')" class="text-primary underline">{{ t('booking.contact_schedule') }}</NuxtLink></p>
    </div>
    <ProductDetailPage v-if="selectedOffer" :key="`${selectedOffer.product.id}:${selectedOffer.location?.id ?? 'online'}:${Boolean(selectedOffer.scopeRequired)}`" compact :organization-id="organizationId" :organization-name="organizationName" vertical="service" :product="selectedOffer.product" :booking="selectedOffer.booking" :location="selectedOffer.location" :locations="selectedOffer.locations" :online-available="selectedOffer.onlineAvailable" :scope-required="selectedOffer.scopeRequired" :sessions="selectedOffer.sessions" :currency="selectedOffer.currency" :collection-name="t('blawby.footer.services')" :presentation="presentation" :reviews="[]" :collection-siblings="[]" :stay-checkout-available="selectedOffer.stayCheckoutAvailable" />
  </section>
</template>
<script setup lang="ts">
import ProductDetailPage from '~/components/products/ProductDetailPage.vue'
import { blockText } from '~/utils/tenant-page-block-data'
import { requireProductPresentation } from '~/utils/product-presentation'
const { data, organizationId, organizationName } = await useConsultationProducts()
if (!data.value) throw createError({ statusCode: 500, statusMessage: 'Consultation services were not returned' })
const { locale, localePath, t } = useI18n()
const route = useRoute()
const products = computed(() => data.value!.products.filter(product => product.kind === 'service' && product.active && (product.booking || product.order_url)))
const items = computed(() => products.value.map(product => ({ id: product.id, title: product.name })))
// Changing the visible service remounts the shared controller so an option or
// time from another service cannot persist into the next request.
const selectedId = computed({
  get: () => {
    const serviceId = route.query.service_id
    if (serviceId === undefined) return items.value[0]?.id ?? null
    if (typeof serviceId !== 'string' || !items.value.some(item => item.id === serviceId)) throw createError({ statusCode: 404, statusMessage: 'Consultation service not found' })
    return serviceId
  },
  set: (serviceId: string | null) => {
    const query = { ...route.query }
    delete query.location_id
    return navigateTo({ path: route.path, query: { ...query, service_id: serviceId ?? undefined } }, { replace: true })
  },
})
const selectedService = computed(() => products.value.find(product => product.id === selectedId.value) ?? null)
const offer = await usePublicPageProduct(computed(() => selectedService.value?.page?.path ?? ''), locale, computed(() => selectedService.value?.page ? selectedService.value.id : null))
const selectedOffer = computed(() => offer.value?.product.id === selectedService.value?.id ? offer.value : null)
const cover = computed(() => selectedOffer.value?.product.image ?? selectedService.value?.image)
const thumbnail = computed(() => blockText(cover.value?.public_url))
const presentation = requireProductPresentation('service')
</script>
