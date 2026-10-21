<template>
  <div class="mb-6 flex items-center justify-between gap-4 rounded-lg border border-default bg-muted px-4 py-3.5">
    <div class="min-w-0">
      <div class="tenant-display tenant-italic whitespace-normal text-base">{{ mainLine }}</div>
      <div v-if="metaLine" class="mt-0.5 text-xs text-muted">{{ metaLine }}</div>
    </div>
    <button type="button" class="shrink-0 text-[11px] font-medium uppercase tracking-[0.2em] text-primary" @click="$emit('edit')">
      {{ editLabel || t('site.experience_detail.change') }}
    </button>
  </div>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  mainLine: string
  metaLine?: string
  editLabel?: string
}>(), {
  metaLine: '',
})
const { t } = useI18n()

defineEmits<{
  edit: []
}>()
</script>
