<template>
  <OnboardingStepScreen v-if="step" :step="step" @advance="emit('advance')" />
</template>

<script setup lang="ts">
import OnboardingStepScreen from '~/lib/components/workspace/onboarding/OnboardingStepScreen.vue'
import { onboardingStep } from '~/composables/useOnboardingFlow'

definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const emit = defineEmits<{ advance: [] }>()
const step = computed(() => onboardingStep(String(route.params.step ?? ''), 'new-site'))
</script>
