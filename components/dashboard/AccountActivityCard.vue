<template>
  <!-- Airbnb's trip card: the place's picture, where, when, and who went. -->
  <UCard
    :as="NuxtLink"
    :to="`/dashboard/account/activity/${item.kind}/${encodeURIComponent(item.id)}`"
    variant="subtle"
    class="block no-underline transition-colors hover:bg-elevated"
    :ui="{ body: 'flex items-center gap-5' }"
    :data-testid="`account-activity-${item.kind}-${item.id}`"
  >
    <span class="flex size-24 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-elevated sm:size-28">
      <img v-if="item.imageUrl" :src="item.imageUrl" alt="" class="size-full object-cover" loading="lazy">
      <UIcon v-else :name="item.kind === 'order' ? 'i-lucide-shopping-bag' : item.kind === 'payment' ? 'i-lucide-receipt' : 'i-lucide-calendar-days'" class="size-8 text-dimmed" />
    </span>
    <span class="min-w-0 flex-1">
      <span class="block truncate text-lg font-semibold text-highlighted">{{ item.title }}</span>
      <span class="mt-1 block truncate text-base text-muted" :class="{ 'line-through': item.status === 'cancelled' }">{{ dateLabel }}</span>
      <span v-if="item.organizationName" class="mt-0.5 block truncate text-sm text-muted">{{ item.organizationName }}</span>
      <span class="mt-3 flex items-center gap-2">
        <UAvatar :src="session.data?.user.image || undefined" :alt="session.data?.user.name ?? ''" icon="i-lucide-user" size="sm" />
        <UBadge v-if="item.status === 'cancelled'" color="error" variant="subtle" size="sm" label="Cancelled" />
        <span v-else-if="item.kind === 'order' || item.kind === 'payment'" class="text-xs text-dimmed">{{ purchaseLabel(item.status) }}</span>
      </span>
    </span>
  </UCard>
</template>

<script setup lang="ts">
import { NuxtLink } from '#components'
import { authClient } from '~/lib/auth-client'
import type { AccountActivityItem } from '~/shared/account-activity'
import { formatTimestamp } from '~/utils/timezone'
import { paymentStateLabel } from '~/shared/payment-display'
const props = defineProps<{ item: AccountActivityItem }>()
const session = authClient.useSession()
// The list knows the payment's state word, not its amounts; the same vocabulary as the record screen.
const purchaseLabel = (state: string) => paymentStateLabel({ captured_amount: state === 'captured' || state === 'refunded' ? 1 : 0, refunded_amount: state === 'refunded' ? 1 : 0, state })
const dateLabel = computed(() => props.item.startsAt && props.item.timeZone
  ? formatTimestamp(props.item.startsAt, 'en', props.item.timeZone, { dateStyle: 'medium', timeStyle: 'short' })
  : `${props.item.kind === 'order' ? 'Ordered ' : ''}${formatTimestamp(props.item.createdAt, 'en', 'UTC', { dateStyle: 'medium' })}`)
</script>
