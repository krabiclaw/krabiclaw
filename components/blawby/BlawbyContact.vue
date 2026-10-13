<template>
  <!--
    The contact page, drawn block by block in the order the document holds
    them. Every section here — the shield, the cards, the form, the questions,
    the reviews, the prompt — was markup in a fixed order, selected out of
    `page.blocks` by type, so moving the prompt above the questions in the CMS
    changed nothing a visitor saw.
  -->
  <TenantPageRenderer v-if="page" :page="page" template="blawby" />
</template>

<script setup lang="ts">
import type { BlawbyDocumentPayload } from '~/utils/blawby-document-contract'

const document = inject<Ref<BlawbyDocumentPayload> | null>('blawby-document', null)
if (!document) throw createError({ statusCode: 500, statusMessage: 'Blawby layout did not provide the requested page' })
const activeLocale = useState<string>('public-locale', () => 'en')
const routeData = computed(() => document.value.route)
const page = computed(() => routeData.value.page)
if (routeData.value.recipe !== 'contact' || !page.value || page.value.locale !== activeLocale.value
  || resolveTenantLocalePath(page.value.path, [activeLocale.value]).sourcePath !== '/contact') {
  throw createError({ statusCode: 500, statusMessage: 'Blawby layout did not provide the requested page' })
}
const identity = computed(() => document.value.shell.identity)
const compliance = computed(() => document.value.shell.compliance)
const org = useBlawbyOrgIdentity(identity, compliance)

// A page about the business: its image is the organization's.
const { socialImage } = useTenantOrganization()
useSocialMetadata(() => ({
  path: '/contact',
  socialImage,
  title: `${page.value?.title || 'Contact'} | ${identity.value.name}`,
  description: page.value?.summary || '',
  brand: {
    organizationName: identity.value.name,
  },
  breadcrumbs: [
    { name: 'Home', url: '/' },
    { name: page.value?.title || 'Contact', url: '/contact' },
  ],
  faqItems: routeData.value.qa
    .map(item => ({ question: item.question.trim(), answer: item.answer?.trim() ?? '' }))
    .filter(item => item.question && item.answer),
  professionalService: {
    recipe: 'contact',
    org: org.value,
  },
}))
</script>
