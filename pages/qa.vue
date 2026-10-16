<template>
  <div class="min-h-screen bg-default text-default">
    <header class="mx-auto max-w-7xl px-4 pt-16 pb-12 sm:px-6 lg:px-8">
      <p class="saya-kicker mb-6">{{ t('saya.qa.title') }}</p>
      <h1 class="saya-display-md text-default"><em class="saya-italic">{{ t('saya.qa_page.title') }}</em></h1>
      <p class="mt-5 max-w-xl text-sm leading-relaxed text-muted">{{ t('saya.qa_page.intro') }}</p>

      <!-- Multi-location pills -->
      <div v-if="locations.length > 1" class="mt-8 flex flex-wrap gap-3">
        <NuxtLink
          v-for="loc in locations"
          :key="loc.id"
          :to="localePath(`/locations/${loc.slug}/qa`)"
          class="inline-flex items-center gap-2 rounded-full border border-default px-5 py-2.5 text-sm text-muted no-underline transition hover:bg-muted hover:text-default"
        >
          <SayaIcon name="map-pin" class="size-3.5 opacity-70" />
          {{ loc.title }}
        </NuxtLink>
      </div>
    </header>
    <LazySayaQA :qa="qaList" :show-title="false" />
  </div>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'saya' })

const { organization } = useTenantOrganization()
const { localePath, t } = useI18n()

const { qaList, locations, sections } = await usePublicPageData()
// A section with nothing on it is not a page; the navigation hides it by the same flag.
if (sections.value?.qa === false) throw createError({ statusCode: 404 })
const organizationName = organization.name

useSocialMetadata(() => ({
  path: '/qa',
  title: `${t('saya.qa.title')} | ${organizationName}`,
  description: t('saya.qa_page.meta_description', { organization: organizationName }),
  label: t('saya.qa.title'),
  socialImage: organization.social_image,
  breadcrumbs: [
    { name: t('saya.qa.title'), url: '/qa' },
  ],
  faqItems: Array.isArray(qaList.value)
    ? qaList.value
        .filter((item): item is { question: unknown; answer: unknown } => Boolean(item && typeof item === 'object' && 'question' in item && 'answer' in item && item.question && item.answer))
        .map(item => ({
          question: String(item.question),
          answer: String(item.answer),
        }))
    : undefined,
}))
</script>
