<template>
  <UContainer v-if="checkoutReturn" class="py-10">
    <UAlert v-if="error" color="error" title="Purchase could not be verified" :description="error" />
    <p v-else class="text-muted">Verifying your purchase…</p>
  </UContainer>
</template>

<script setup lang="ts">
import { isAccountActivityPath } from '~/shared/account-activity'
definePageMeta({ layout: 'standalone' })
useResponseHeader('cache-control').value = 'private, no-store'
useSeoMeta({ title: 'Activity | KrabiClaw', robots: 'noindex, nofollow' })
const route = useRoute()
const checkoutReturn = typeof route.query.payment_id === 'string' && typeof route.query.purchase_claim === 'string'
const error = ref('')
const destination = '/dashboard/account'
if (!checkoutReturn) await navigateTo({ path: destination, query: route.query }, { redirectCode: 302, replace: true })
onMounted(async () => {
  if (!checkoutReturn) return
  try {
    const result = await applicationFetch<{ payment_id: string; claimed: true; activity_path: string }>('/api/account/checkout-return', {
      method: 'POST', body: { payment_id: route.query.payment_id, purchase_claim: route.query.purchase_claim },
      validate: (value): value is { payment_id: string; claimed: true; activity_path: string } => isRecord(value)
        && value.payment_id === route.query.payment_id && value.claimed === true
        && isAccountActivityPath(value.activity_path),
    })
    const query = { ...route.query }
    delete query.payment_id
    delete query.purchase_claim
    await navigateTo({ path: result.activity_path, query }, { replace: true })
  } catch (failure) {
    error.value = getErrorMessage(failure, 'Could not verify your Stripe purchase')
  }
})
</script>
