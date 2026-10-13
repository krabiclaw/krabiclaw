<template>
  <!-- A decision that cannot be undone, asked in the dashboard's own dialog rather than the browser's. -->
  <DashboardListItemDialog :title="title" :show-actions="false">
    <p class="text-sm leading-relaxed text-muted">{{ description }}</p>
    <div class="flex items-center justify-between gap-4 pt-1">
      <UButton :label="cancelLabel" color="neutral" variant="ghost" @click="$emit('close', false)" />
      <UButton :label="confirmLabel" color="error" @click="$emit('close', true)" />
    </div>
  </DashboardListItemDialog>
</template>

<script setup lang="ts">
/*
  Opened through Nuxt UI's useOverlay: `await overlay.create(DashboardConfirmDialog).open({...})`
  resolves with the choice the close event carries.
*/
import DashboardListItemDialog from '~/components/dashboard/DashboardListItemDialog.vue'

defineProps<{ title: string; description: string; confirmLabel: string; cancelLabel: string }>()
defineEmits<{ close: [confirmed: boolean] }>()
</script>
