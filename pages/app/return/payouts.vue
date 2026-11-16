<template>
  <div class="space-y-6 rounded-lg border border-default bg-default p-6">
    <h1 class="text-xl font-semibold">Back to KrabiClaw</h1>
    <UAlert v-if="!target" color="error" variant="soft" description="This payouts return is not one the KrabiClaw app started." />
    <UButton v-else :to="target" external block>Return to the KrabiClaw app</UButton>
  </div>
</template>

<script setup lang="ts">
// Stripe-hosted payouts onboarding started in the iPhone app returns here
// (`outcome` done or refresh), and this hands the host back to the app.
definePageMeta({ layout: 'access', auth: false })
useSeoMeta({ title: 'Return to the KrabiClaw app | KrabiClaw', robots: 'noindex, nofollow' })
const route = useRoute()
const target = computed(() => route.query.outcome === 'done' || route.query.outcome === 'refresh' ? `krabiclaw://payouts/${route.query.outcome}` : null)
onMounted(() => {
  if (target.value) window.location.replace(target.value)
})
</script>
