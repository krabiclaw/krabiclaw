<template>
  <OnboardingStepScreen :step="step" @advance="emit('advance')" @uploading="emit('uploading', $event)" />
</template>

<script setup lang="ts">
import OnboardingStepScreen from '~/lib/components/workspace/onboarding/OnboardingStepScreen.vue'
import type { OnboardingStep } from '~/shared/onboarding-flow'

definePageMeta({ layout: 'dashboard' })
defineProps<{ step: OnboardingStep }>()
const emit = defineEmits<{ advance: []; uploading: [value: boolean] }>()
</script>
