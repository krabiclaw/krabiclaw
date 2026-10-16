<template>
  <UButton
    v-if="to"
    :to="to"
    icon="i-lucide-bell"
    color="neutral"
    variant="ghost"
    square
    class="relative"
    :aria-label="unavailable ? 'Notifications unavailable' : 'Notifications'"
    data-testid="dashboard-notification-bell"
  >
    <span
      v-if="!unavailable && unreadCount > 0"
      class="absolute -right-0.5 -top-0.5 h-4 min-w-4 rounded-full bg-error px-1 text-center text-xs font-semibold leading-4 text-white"
    >{{ unreadCount > 99 ? '99+' : unreadCount }}</span>
    <UIcon v-if="unavailable" name="i-lucide-circle-alert" class="absolute -right-1 -top-1 size-3 text-warning" />
  </UButton>
</template>

<script setup lang="ts">
defineProps<{ to: string | null }>()

const { unreadCount, unavailable } = useNotificationUnreadCount()
</script>
