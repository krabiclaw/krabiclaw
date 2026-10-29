<template>
  <!--
    The ask that ends onboarding and joining a team: a title, one line, and two
    buttons. The browser's permission prompt opens only from "Turn on
    notifications"; either answer moves on.
  -->
  <div class="flex flex-col gap-6">
    <div>
      <h1 :class="dashboardTitleClass">{{ title }}</h1>
      <p class="mt-3 text-base text-muted">{{ lede }}</p>
    </div>
    <UAlert v-if="failure" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="failure" />
    <div class="flex items-center justify-between gap-4 border-t border-default pt-4">
      <UButton label="Not now" color="neutral" variant="link" :disabled="enabling" @click="emit('done')" />
      <UButton label="Turn on notifications" size="xl" :loading="enabling" @click="turnOn" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { dashboardTitleClass } from '~/lib/components/workspace/dashboard/dashboardPanelContext'

defineProps<{ title: string; lede: string }>()
const emit = defineEmits<{ done: [] }>()

const pushSubscription = usePushSubscription()
const enabling = ref(false)
const failure = ref('')

async function turnOn() {
  enabling.value = true
  failure.value = ''
  try {
    // A refusal is the person's answer, not a failure: settings shows it as blocked.
    await pushSubscription.enable()
    emit('done')
  } catch (cause) {
    failure.value = cause instanceof Error ? cause.message : 'Could not turn on notifications.'
  } finally {
    enabling.value = false
  }
}
</script>
