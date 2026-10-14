<template>
  <!-- A chat app, not a page with a chat in it: the shell owns the viewport so
       the composer sits at the bottom of the screen rather than below the fold. -->
  <div class="flex h-dvh flex-col bg-default text-default">
    <PlatformHeader class="shrink-0" />

    <ClientOnly>
      <HelpChowBotConversation>
        <template #intro>
          <PlatformHelpHero />
        </template>
      </HelpChowBotConversation>

      <template #fallback>
        <main class="min-h-0 flex-1 overflow-y-auto">
          <div class="mx-auto w-full max-w-3xl px-4 sm:px-6">
            <PlatformHelpHero />
          </div>
        </main>
      </template>
    </ClientOnly>
  </div>
</template>

<script setup lang="ts">
import HelpChowBotConversation from '~/components/conversation/HelpChowBotConversation.vue'
import PlatformHelpHero from '~/components/platform/PlatformHelpHero.vue'
import { PUBLIC_SUPPORT_FAQ_ENTRIES } from '~/utils/public-support'

definePageMeta({ layout: 'standalone' })

// A page about the business: its image is the organization's.
const { social_image: organizationSocialImage, template: organizationTemplate } = useTenantOrganization().organization
if (organizationTemplate.slug !== 'platform') throw createError({ statusCode: 404, statusMessage: 'Page not found', fatal: true })
useSocialMetadata({
  path: '/help',
  socialImage: organizationSocialImage,
  title: 'Support',
  description: 'Get help with Krabiclaw, browse docs and product updates, or open a support request through ChowBot support.',
  breadcrumbs: [
    { name: 'Home', url: '/' },
    { name: 'Support', url: '/help' },
  ],
  faqItems: PUBLIC_SUPPORT_FAQ_ENTRIES.map(item => ({
    question: item.title,
    answer: item.answer,
  })),
})
</script>
