<template>
  <!-- Google and Apple create an account from either screen, so sign-in and sign-up both say what continuing agrees to (App Store guideline 1.2). -->
  <p class="text-center text-xs text-muted">
    By continuing, you agree to our <NuxtLink :to="policyUrl('terms')" external target="_blank" class="underline">Terms of Service</NuxtLink>
    and <NuxtLink :to="policyUrl('privacy')" external target="_blank" class="underline">Privacy Policy</NuxtLink>.
  </p>
</template>

<script setup lang="ts">
// The account is Blawby's, so its policies are the platform's, whichever site serves this page.
const platformDomain = String(useRuntimeConfig().public.platformDomain)
const policyUrl = (slug: string) => new URL(`/policies/${slug}`, platformDomain).toString()
</script>
