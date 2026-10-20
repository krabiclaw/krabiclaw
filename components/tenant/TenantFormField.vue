<template>
  <div>
    <label :for="id" class="mb-1.5 block text-sm font-medium text-default">
      {{ label }}<span v-if="required" aria-hidden="true" class="ml-0.5 text-red-500">*</span>
    </label>
    <slot :id="id" :described-by="describedBy" :invalid="!!error" />
    <p v-if="description && !error" class="mt-1.5 text-xs text-muted">{{ description }}</p>
    <p v-if="error" :id="errorId" class="mt-1.5 text-xs text-red-500" role="alert">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  label: string
  name: string
  required?: boolean
  error?: string | null
  description?: string | null
}>()

const instanceId = useId()
const id = computed(() => `field-${instanceId}-${props.name}`)
const errorId = computed(() => `field-${instanceId}-${props.name}-error`)
const describedBy = computed(() => (props.error ? errorId.value : undefined))
</script>
