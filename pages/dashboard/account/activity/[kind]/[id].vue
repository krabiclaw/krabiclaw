<template>
  <!-- The account opens the same record screen the business does, for a visit and for a purchase alike. -->
  <BookingDetails :booking-type="kind" :booking-id="id" :editor-path="route.path" personal-scope />
</template>

<script setup lang="ts">
import BookingDetails from '~/components/dashboard/BookingDetails.vue'
import { isAccountActivityKind } from '~/shared/account-activity'

definePageMeta({ layout: 'dashboard', key: route => `${route.params.kind}:${route.params.id}` })
useSeoMeta({ title: 'Activity details | KrabiClaw', robots: 'noindex, nofollow' })

const route = useRoute()
const rawKind = route.params.kind
const id = String(route.params.id || '')
if (!isAccountActivityKind(rawKind) || !id) throw createError({ statusCode: 404, statusMessage: 'Activity not found.', fatal: true })
const kind = rawKind
</script>
