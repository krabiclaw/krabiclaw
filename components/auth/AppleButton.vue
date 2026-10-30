<template>
  <UButton color="neutral" variant="outline" size="lg" block :ui="{ base: 'justify-start' }" :loading="loading" :disabled="disabled" @click="$emit('activate')">
    <AuthAppleMark class="size-5 shrink-0" />
    {{ label }}
    <UBadge v-if="lastUsed" color="primary" variant="soft" size="sm" class="ml-auto shrink-0">Last used</UBadge>
  </UButton>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ label?: string; lastUsed?: boolean; loading?: boolean; disabled?: boolean }>(), {
  label: 'Continue with Apple',
  lastUsed: false,
  loading: false,
  disabled: false,
})
defineEmits<{ activate: [] }>()
</script>
