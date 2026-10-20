<template>
  <!-- A transaction is a record the business already has a screen for: the visit it paid for, or the purchase itself. -->
  <div />
</template>

<script setup lang="ts">
definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const api = useDashboardApi()
const paymentId = String(route.params.paymentId || '')
const base = `/dashboard/${route.params.orgSlug}/bookings`
// Raised, not thrown: a nested page's setup throw leaves a blank screen (DESIGN.md).
if (!paymentId) showError(createError({ statusCode: 404, statusMessage: 'Transaction not found' }))
else {
  try {
    const detail = await api<{ visit: { kind: 'booking' | 'reservation'; request_id: string } | null; order: unknown }>('/api/dashboard/payments', {
      query: { payment_id: paymentId },
      validate: (value: unknown): value is { visit: { kind: 'booking' | 'reservation'; request_id: string } | null; order: unknown } => isRecord(value) && 'order' in value && (value.visit === null || isRecord(value.visit) && (value.visit.kind === 'booking' || value.visit.kind === 'reservation') && typeof value.visit.request_id === 'string'),
    })
    await navigateTo(detail.visit ? `${base}/${detail.visit.kind}/${encodeURIComponent(detail.visit.request_id)}` : `${base}/${detail.order ? 'order' : 'payment'}/${encodeURIComponent(paymentId)}`, { replace: true })
  } catch (cause) {
    const status = isRecord(cause) && typeof cause.statusCode === 'number' ? cause.statusCode : 500
    showError(createError({ statusCode: status, statusMessage: getErrorMessage(cause, 'Transaction could not be loaded') }))
  }
}
</script>
