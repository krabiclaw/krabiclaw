<template>
  <!-- A transaction is a record the business already has a screen for: the visit it paid for, or the purchase itself. -->
  <div />
</template>

<script setup lang="ts">
definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const api = useDashboardApi()
const paymentId = String(route.params.payment_id || '')
// Raised, not thrown: a nested page's setup throw leaves a blank screen (DESIGN.md).
if (!paymentId) showError(createError({ statusCode: 404, statusMessage: 'Transaction not found' }))
else {
  try {
    const destination = await api<{ to: string }>('/api/dashboard/payments', {
      query: { view: 'destination', payment_id: paymentId },
      validate: (value: unknown): value is { to: string } => isRecord(value) && typeof value.to === 'string',
    })
    await navigateTo(destination.to, { replace: true })
  } catch (cause) {
    const status = isRecord(cause) && typeof cause.statusCode === 'number' ? cause.statusCode : 500
    showError(createError({ statusCode: status, statusMessage: getErrorMessage(cause, 'Transaction could not be loaded') }))
  }
}
</script>
