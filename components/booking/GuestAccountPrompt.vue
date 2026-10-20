<template>
  <!--
    A guest's interaction belongs to this business's site; the account that
    gathers every business's bookings, messages and receipts is on the platform,
    where the email they used joins its records to it once verified.
  -->
  <aside class="border-t border-default pt-8 text-left">
    <p class="mb-3 font-semibold text-default">{{ t('guest_account.title') }}</p>
    <p class="text-sm leading-relaxed text-muted">{{ email ? t('guest_account.body_email', { email }) : t('guest_account.body') }}</p>
    <div class="mt-6 flex flex-wrap items-center gap-4">
      <UButton :to="guestAccountUrl(platformDomain, '/signup', email)" external :label="t('guest_account.create')" />
      <ULink :to="guestAccountUrl(platformDomain, '/login', email)" external class="text-sm text-muted underline">{{ t('guest_account.sign_in') }}</ULink>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { guestAccountUrl } from '~/shared/guest-account'

defineProps<{ email?: string | null }>()
const { t } = useI18n()
const platformDomain = useRuntimeConfig().public.platformDomain
</script>
