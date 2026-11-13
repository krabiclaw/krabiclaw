<template>
  <OnboardingStepScreen :step="step" />
</template>

<script setup lang="ts">
import OnboardingStepScreen from '~/lib/components/workspace/onboarding/OnboardingStepScreen.vue'
import type { OnboardingStep } from '~/shared/onboarding-flow'

definePageMeta({ layout: 'dashboard' })
defineProps<{ step: OnboardingStep }>()
</script>
