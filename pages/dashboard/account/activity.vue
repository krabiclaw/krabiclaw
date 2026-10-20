<template>
  <!--
    Airbnb's Trips below the fold: what already happened and what was bought.
    Today owns what is still ahead; cancellations sit behind one row at the
    bottom, as Airbnb's "Canceled reservations" does. A row on Menu, so it
    renders beside Menu and Back returns there.
  -->
  <DashboardIndexPanel id="account-activity" title="Past activity" column="reading">
    <UAlert v-if="error" color="error" title="Past activity could not be loaded" :description="getErrorMessage(error, 'Activity request failed.')" />
    <div v-else-if="data" class="space-y-10 pb-6">
      <section v-for="section in sections" :key="section.label">
        <h2 class="mb-4 flex items-center gap-4 text-sm text-muted after:h-px after:flex-1 after:bg-border">{{ section.label }}</h2>
        <div class="space-y-4"><AccountActivityCard v-for="item in section.items" :key="`${item.kind}:${item.id}`" :item="item" /></div>
      </section>
      <UEmpty v-if="!sections.length && !cancelled.length" icon="i-lucide-history" title="No past activity yet" />
      <UCard
        v-if="cancelled.length"
        :as="NuxtLink"
        :to="`${level.path.value}/cancelled`"
        variant="subtle"
        class="block no-underline transition-colors hover:bg-elevated"
        :ui="{ body: 'flex items-center gap-4' }"
        data-testid="account-activity-cancelled"
      >
        <UIcon name="i-lucide-calendar-x" class="size-6 text-highlighted" />
        <span class="flex-1 text-base font-semibold text-highlighted">Cancelled</span>
        <UIcon name="i-lucide-chevron-right" class="size-5 text-muted" />
      </UCard>
    </div>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import { NuxtLink } from '#components'
import AccountActivityCard from '~/components/dashboard/AccountActivityCard.vue'
import type { AccountActivityItem } from '~/shared/account-activity'
definePageMeta({ layout: 'dashboard', tab: 'menu', back: 'menu' })
useSeoMeta({ title: 'Past activity | KrabiClaw', robots: 'noindex, nofollow' })
const level = useRouteLevel()
const { data, error } = await useAccountActivity()
const now = Date.now()
const isVisit = (item: AccountActivityItem) => item.kind === 'booking' || item.kind === 'reservation' || item.kind === 'stay'
const cancelled = computed(() => (data.value?.activities ?? []).filter(item => isVisit(item) && item.status === 'cancelled'))
const sections = computed(() => {
  const items = data.value?.activities ?? []
  return [
    { label: 'Past', items: items.filter(item => isVisit(item) && item.status !== 'cancelled' && item.endsAt && Date.parse(item.endsAt) < now) },
    { label: 'Purchases', items: items.filter(item => !isVisit(item)) },
  ].filter(section => section.items.length)
})
</script>
