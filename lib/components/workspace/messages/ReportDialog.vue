<template>
  <UModal :open="open" :title="title" @update:open="value => { if (!value && !saving) emit('close') }">
    <template #body>
      <form class="space-y-4" @submit.prevent="submit">
        <p class="text-sm text-muted">{{ description }} KrabiClaw reviews every report within 24 hours.</p>
        <UFormField label="What is wrong?" name="report-reason" :error="error ?? undefined">
          <UTextarea v-model="reason" :rows="3" :maxlength="1000" :disabled="saving" class="w-full" />
        </UFormField>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" :disabled="saving" @click="emit('close')">Cancel</UButton>
          <UButton type="submit" color="error" :loading="saving" :disabled="!reason.trim()">{{ confirmLabel }}</UButton>
        </div>
      </form>
    </template>
  </UModal>
</template>

<script setup lang="ts">
// The reason a member gives when reporting someone or blocking a guest; the
// caller sends it with its own idempotency key.
const props = defineProps<{ open: boolean; title: string; description: string; confirmLabel: string; saving: boolean; error: string | null }>()
const emit = defineEmits<{ submit: [reason: string]; close: [] }>()
const reason = ref('')
watch(() => props.open, (open) => { if (open) reason.value = '' })
function submit() {
  if (reason.value.trim()) emit('submit', reason.value.trim())
}
</script>
