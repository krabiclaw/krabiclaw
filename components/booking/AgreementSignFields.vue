<template>
  <div class="space-y-4">
    <UFormField :label="t('agreement.full_name')" required>
      <UInput v-model="name" autocomplete="name" :disabled="disabled" class="w-full" data-testid="agreement-name" />
    </UFormField>
    <div>
      <p class="text-xs font-semibold text-muted">{{ t('agreement.your_signature') }}</p>
      <!-- The adopted signature: the typed name in a handwriting face, never drawn. -->
      <p class="mt-1.5 flex min-h-16 items-end border-b border-inverted px-1 pb-1.5 text-4xl leading-none text-highlighted" style="font-family: 'Snell Roundhand', 'Segoe Script', 'Brush Script MT', cursive" aria-hidden="true">
        {{ name.trim() || ' ' }}
      </p>
    </div>
    <UCheckbox v-model="consent" :disabled="disabled" :label="t('agreement.consent', { document: document.toLowerCase() })" data-testid="agreement-consent" />
  </div>
</template>

<script setup lang="ts">
/** The typed name and consent that sign an agreement, in the booking flow and on a booking alike. */
defineProps<{ document: string; disabled?: boolean }>()
const name = defineModel<string>('name', { required: true })
const consent = defineModel<boolean>('consent', { required: true })
const { t } = useI18n()
</script>
