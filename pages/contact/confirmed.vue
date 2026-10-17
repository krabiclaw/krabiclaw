<template>
  <NuxtLayout :name="template.layout">
    <section v-if="template.slug === 'blawby'" class="mx-auto max-w-3xl px-4 py-24 text-center sm:px-6 lg:px-8">
      <div class="mx-auto flex size-16 items-center justify-center rounded-full bg-[var(--blawby-primary-100)] text-[var(--blawby-primary)]">
        <svg class="size-9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="m5 12 4 4L19 6" />
        </svg>
      </div>
      <h1 class="blawby-display mt-8 text-4xl font-bold text-[var(--blawby-primary)]">Message received</h1>
      <p class="mx-auto mt-4 max-w-xl leading-8 text-muted">Thank you for contacting us. Our team will review your message and reply as soon as possible.</p>
      <div class="mt-10 flex flex-wrap justify-center gap-3">
        <TenantButton to="/">Back home</TenantButton>
        <TenantButton to="/contact" variant="outline">Send another message</TenantButton>
      </div>
      <GuestAccountPrompt class="mx-auto mt-12 max-w-xl" />
    </section>

    <div v-else class="min-h-screen bg-default text-default">
      <div class="mx-auto max-w-xl px-4 pb-24 pt-16 sm:px-6 lg:px-8">
        <div class="rounded-3xl border border-default bg-elevated p-10 text-center shadow-sm sm:p-12">
          <div class="mb-8 flex justify-center">
            <div class="flex size-20 items-center justify-center rounded-full bg-primary/10">
              <TenantIcon name="check-circle" class="size-12 text-primary" />
            </div>
          </div>

          <h1 class="saya-display saya-italic text-4xl text-default">{{ t('saya.contact_page.got_it') }}</h1>
          <p class="mt-4 text-muted">{{ t('saya.contact_page.reply_within') }}</p>

          <div class="mt-8 flex flex-col gap-3">
            <TenantButton to="/" variant="soft">{{ t('saya.contact_page.back_home') }}</TenantButton>
            <TenantButton to="/contact" variant="ghost" size="md">{{ t('saya.contact_page.send_another') }}</TenantButton>
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
  title: template.slug === 'blawby' ? 'Message received' : t('saya.contact_page.confirmed_title'),
  description: 'Your message has been received.',
  socialImage: null,
  discoverability: 'private',
}))
</script>
