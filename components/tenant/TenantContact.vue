<template>
  <TenantPageRenderer v-if="page" :page="page" template="blawby" />
</template>

<script setup lang="ts">
import type { BlawbyDocumentPayload } from '~/utils/blawby-document-contract'

const document = inject<Ref<BlawbyDocumentPayload> | null>('blawby-document', null)
if (!document) throw createError({ statusCode: 500, statusMessage: 'Tenant layout did not provide the requested page' })
const activeLocale = useState<string>('public-locale', () => 'en')
const routeData = computed(() => document.value.route)
const page = computed(() => routeData.value.page)
if (routeData.value.recipe !== 'contact' || !page.value || page.value.locale !== activeLocale.value
  || resolveTenantLocalePath(page.value.path, [activeLocale.value]).sourcePath !== '/contact') {
  throw createError({ statusCode: 500, statusMessage: 'Tenant layout did not provide the requested page' })
}

// A page about the business: its image is the organization's.
const { name: organizationName, social_image: socialImage } = useTenantOrganization().organization
useSocialMetadata(() => page.value && ({
  path: '/contact',
  socialImage,
  title: `${page.value.title} | ${organizationName}`,
  description: page.value.summary || '',
  breadcrumbs: [
    { name: 'Home', url: '/' },
    { name: page.value.title, url: '/contact' },
  ],
  contentBlocks: page.value.blocks,
  professionalService: {
    recipe: 'contact',
  },
}))
</script>
