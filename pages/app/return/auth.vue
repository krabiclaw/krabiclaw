<template>
  <div class="space-y-6 rounded-lg border border-default bg-default p-6">
    <h1 class="text-xl font-semibold">Back to KrabiClaw</h1>
    <UAlert v-if="!target" color="error" variant="soft" description="This sign-in return was not started by the KrabiClaw app." />
    <UButton v-else :to="target" external block>Return to the KrabiClaw app</UButton>
  </div>
</template>

<script setup lang="ts">
// Social authentication started in the iPhone app returns here, and hands the host back to the app.
definePageMeta({ layout: 'access', auth: false })
useSeoMeta({ title: 'Return to the KrabiClaw app | KrabiClaw', robots: 'noindex, nofollow' })
const route = useRoute()
const sessionCookie = useCookie('better-auth.session_token')
const target = computed(() => {
  if (route.query.error) {
    return `krabiclaw://auth-callback?error=${encodeURIComponent(String(route.query.error))}`
  }
  const token = typeof route.query.token === 'string' ? route.query.token : sessionCookie.value
  if (token) {
    return `krabiclaw://auth-callback?token=${encodeURIComponent(token)}`
  }
  return null
})

onMounted(() => {
  if (target.value) window.location.replace(target.value)
})
</script>
