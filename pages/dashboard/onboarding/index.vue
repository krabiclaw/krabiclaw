<template>
  <div class="flex min-h-0 flex-col gap-8 py-6" :data-onboarding-hydrated="hydrated ? 'true' : 'false'">
    <div>
      <h1 class="text-3xl font-extrabold leading-tight tracking-tight text-highlighted">
        It's easy to get started on KrabiClaw
      </h1>
    </div>

    <ol class="flex flex-col">
      <li
        v-for="(point, index) in POINTS"
        :key="point.title"
        class="flex gap-5 border-b border-default py-5 first:pt-0 last:border-b-0"
      >
        <span class="text-lg font-medium text-highlighted">{{ index + 1 }}</span>
        <span class="min-w-0 flex-1">
          <span class="block text-lg font-semibold text-highlighted">{{ point.title }}</span>
          <span class="mt-1 block text-sm text-toned">{{ point.body }}</span>
        </span>
        <UIcon :name="point.icon" class="size-8 shrink-0 text-muted" />
      </li>
    </ol>

    <UButton
      class="self-start"
      :label="resuming ? 'Pick up where you left off' : 'Get started'"
      @click="start"
    />
  </div>
</template>

<script setup lang="ts">

definePageMeta({ layout: 'dashboard' })
import { onboardingStepPath, useOnboardingState, useOnboardingSteps } from '~/composables/useOnboardingFlow'

const router = useRouter()
const state = useOnboardingState()
const { resumeStep } = useOnboardingSteps()
const hydrated = ref(false)

// The shell restored the draft before this screen rendered, so an owner with an
// unfinished draft already has their answers in hand: a draft id is the one
// thing only a saved draft puts there.
const resuming = computed(() => state.value.draftId !== null)

const POINTS = [
  {
    title: 'Tell us about your business',
    body: 'What kind of business it is, and your Google Maps listing if you have one.',
    icon: 'i-lucide-store',
  },
  {
    title: 'Make it yours',
    body: 'Your address and hours, what you offer, and a colour and photo — we fill in what Google already knows.',
    icon: 'i-lucide-palette',
  },
  {
    title: 'Publish',
    body: 'Check the preview and go live on your included site address. You can keep editing any time.',
    icon: 'i-lucide-rocket',
  },
]

onMounted(() => {
  hydrated.value = true
})

// An owner with an unfinished draft is not starting: the button takes them to
// the step they stopped at rather than back through the answers they gave.
async function start() {
  await router.push(onboardingStepPath(resuming.value ? resumeStep.value.id : 'type'))
}
</script>
