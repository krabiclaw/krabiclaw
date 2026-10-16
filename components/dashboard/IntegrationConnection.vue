<template>
  <!-- Nothing connected: the product's mark and the one way to connect it. -->
  <div v-if="!connection" class="flex flex-col items-center gap-8">
    <UIcon :name="logo" class="size-24" />
    <div class="w-full space-y-4 text-left">
      <slot />
    </div>
  </div>

  <div v-else class="space-y-8">
    <div class="flex flex-wrap items-center gap-4">
      <UAvatar :src="connection.image ?? undefined" :icon="logo" alt="" size="3xl" />
      <div class="min-w-0 flex-1">
        <p class="truncate font-semibold text-highlighted">{{ connection.name }}</p>
        <p class="mt-0.5 truncate text-sm text-muted">Connected on {{ connectedOn }}</p>
      </div>
      <UButton icon="i-lucide-link-2-off" color="error" variant="outline" :loading="disconnecting" @click="emit('disconnect')">Disconnect</UButton>
    </div>
  </div>
</template>

<script setup lang="ts">
// Each organization has one connection per provider. Disconnect before connecting again.
const props = defineProps<{
  logo: string
  connection: { name: string; image?: string | null; connectedAt: string } | null
  disconnecting?: boolean
}>()

const emit = defineEmits<{ disconnect: [] }>()

const connectedOn = computed(() => props.connection
  ? new Date(props.connection.connectedAt).toLocaleDateString(undefined, { dateStyle: 'medium' })
  : '')

</script>
