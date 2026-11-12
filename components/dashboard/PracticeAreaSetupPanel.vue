<template>
  <UDashboardPanel id="guided-practice-area" :ui="{ root: 'min-h-0 bg-default', body: 'p-0 sm:p-0' }">
    <template #header>
      <div v-if="!hideExit" class="flex justify-end px-6 py-4 sm:px-10">
        <UButton color="neutral" variant="outline" class="rounded-full" :disabled="exitDisabled || saving" @click="$emit('exit')">
          {{ exitLabel }}
        </UButton>
      </div>
    </template>
    <template #body>
      <form id="first-practice-area-form" class="mx-auto w-full max-w-[40rem] px-6 pb-6 pt-4 sm:px-8 sm:pt-5 lg:pt-[clamp(2.5rem,calc(26dvh-7rem),10.5rem)]" @submit.prevent="$emit('next')">
        <h1 class="text-3xl font-semibold leading-tight text-highlighted sm:text-4xl">{{ title }}</h1>
        <p v-if="detail" class="mt-2 text-muted">{{ detail }}</p>
        <fieldset class="mt-6 min-w-0" :disabled="saving">
          <slot />
        </fieldset>
        <UAlert v-if="error" color="error" variant="soft" class="mt-5" :description="error" />
      </form>
    </template>
    <template #footer>
      <div class="flex items-center justify-between border-t border-default bg-default px-6 py-4 sm:px-10">
        <UButton :to="saving ? undefined : backTo" :disabled="saving || !backTo" color="neutral" variant="link" class="underline">
          {{ backLabel }}
        </UButton>
        <UButton type="submit" form="first-practice-area-form" color="neutral" size="lg" class="px-6" :loading="saving" :disabled="nextDisabled">
          {{ nextLabel }}
        </UButton>
      </div>
    </template>
  </UDashboardPanel>
</template>

<script setup lang="ts">
defineProps<{
  title: string
  detail?: string
  backTo?: string
  backLabel: string
  nextLabel: string
  exitLabel: string
  saving: boolean
  nextDisabled?: boolean
  exitDisabled?: boolean
  hideExit?: boolean
  error?: string | null
}>()
defineEmits<{ next: []; exit: [] }>()
</script>
