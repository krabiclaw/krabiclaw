<template>
  <NuxtLayout :name="template.layout">
    <div class="min-h-screen bg-default text-default">
      <div class="mx-auto max-w-xl px-4 pb-24 pt-16 sm:px-6 lg:px-8">
        <div class="rounded-3xl border border-default bg-elevated p-10 text-center shadow-sm sm:p-12">
          <div class="mb-8 flex justify-center">
            <div class="flex size-20 items-center justify-center rounded-full bg-primary/10">
              <TenantIcon name="check-circle" class="size-12 text-primary" />
            </div>
          </div>

          <h1 class="tenant-display tenant-italic text-4xl text-default">{{ t('site.contact_page.got_it') }}</h1>
          <p class="mt-4 text-muted">{{ t('site.contact_page.reply_within') }}</p>

          <div class="mt-8 flex flex-col gap-3">
            <TenantButton to="/" variant="soft">{{ t('site.contact_page.back_home') }}</TenantButton>
            <TenantButton to="/contact" variant="ghost" size="md">{{ t('site.contact_page.send_another') }}</TenantButton>
          </div>
        </div>
        <GuestAccountPrompt class="mt-8" />
      </div>
    </div>
  </NuxtLayout>
</template>

<script setup lang="ts">
import GuestAccountPrompt from '~/components/booking/GuestAccountPrompt.vue'
definePageMeta({ layout: false })

const { t } = useI18n()
const { template } = useTenantOrganization().organization

// Always shows a generic success state rather than gating on the sessionStorage
// handoff — a missing handoff (private browsing, storage quota, etc.) doesn't
// mean the message wasn't actually sent, and this page has nothing to show
// beyond the generic copy either way.
useSocialMetadata(() => ({
  path: '/contact/confirmed',
  title: t('site.contact_page.confirmed_title'),
  description: 'Your message has been received.',
  socialImage: null,
  discoverability: 'private',
}))
</script>
