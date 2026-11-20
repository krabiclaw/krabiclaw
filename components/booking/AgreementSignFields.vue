<template>
  <div class="space-y-4">
    <div>
      <label :for="`${id}-name`" class="mb-1 block text-sm font-medium text-default">{{ t('agreement.full_name') }}</label>
      <input :id="`${id}-name`" v-model="name" type="text" autocomplete="name" required minlength="2" maxlength="120" :disabled="disabled" data-testid="agreement-name"
        class="w-full rounded-lg border border-(--kc-field-border) bg-default px-3.5 py-2.5 text-base text-default focus:border-primary focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary">
    </div>
    <div>
      <p class="text-xs font-semibold text-muted">{{ t('agreement.your_signature') }}</p>
      <!-- The adopted signature: the typed name in a handwriting face, never drawn. -->
      <p class="mt-1.5 flex min-h-16 items-end border-b border-current px-1 pb-1.5 text-4xl leading-none text-default" style="font-family: 'Snell Roundhand', 'Segoe Script', 'Brush Script MT', cursive" aria-hidden="true">
        {{ name.trim() || ' ' }}
      </p>
    </div>
    <label class="flex items-start gap-3 text-sm leading-5 text-default">
      <input v-model="consent" type="checkbox" required :disabled="disabled" class="mt-0.5 size-5 shrink-0 accent-current" data-testid="agreement-consent">
      <span>{{ t('agreement.consent', { document: document.toLowerCase() }) }}</span>
    </label>
  </div>
</template>

<script setup lang="ts">
/** The typed name and consent that sign an agreement, in the booking flow and on a booking alike. */
defineProps<{ document: string; disabled?: boolean }>()
const name = defineModel<string>('name', { required: true })
const consent = defineModel<boolean>('consent', { required: true })
const { t } = useI18n()
const id = useId()
</script>
