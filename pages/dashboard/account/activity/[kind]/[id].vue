<template>
  <BookingDetails :booking-type="kind === 'stay' ? 'booking' : kind" :booking-id="id" :editor-path="level.path.value" personal-scope />
</template>

<script setup lang="ts">
import BookingDetails from '~/components/dashboard/BookingDetails.vue'
import { isAccountActivityKind } from '~/shared/account-activity'

definePageMeta({ layout: 'dashboard', key: route => `${route.params.kind ?? 'booking'}:${route.params.id ?? route.params.conversation_id}` })
useSeoMeta({ title: 'Activity details | KrabiClaw', robots: 'noindex, nofollow' })

const route = useRoute()
const level = useRouteLevel()
const rawKind = route.params.conversation_id === undefined ? route.params.kind : 'booking'
const id = String(route.params.id ?? route.params.conversation_id ?? '')
if (!isAccountActivityKind(rawKind) || !id) throw createError({ statusCode: 404, statusMessage: 'Activity not found.', fatal: true })
const kind = rawKind
</script>
