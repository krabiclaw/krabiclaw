<template>
  <div class="flex min-h-0 flex-col gap-8 py-6" :data-onboarding-hydrated="hydrated ? 'true' : 'false'">
    <div class="space-y-3">
      <p class="text-sm font-medium text-muted">{{ resuming ? 'Your organization' : 'Welcome to KrabiClaw' }}</p>
      <h1 :class="dashboardTitleClass">
        {{ resuming ? state.details.name : 'Make a home for your business' }}
      </h1>
      <p class="text-base text-muted">{{ resuming ? 'Your saved setup is ready when you are.' : 'Start with the basics, add your own touch, and see your website take shape.' }}</p>
    </div>

    <ol class="flex flex-col">
      <li
        v-for="point in POINTS"
        :key="point.title"
        class="flex items-start gap-4 border-b border-default py-6 first:pt-0 last:border-b-0"
      >
        <span class="grid size-12 shrink-0 place-items-center rounded-2xl bg-elevated text-highlighted" aria-hidden="true">
          <UIcon :name="point.icon" class="size-6" />
        </span>
        <span class="min-w-0 flex-1">
          <span class="block text-lg font-semibold text-highlighted">{{ point.title }}</span>
          <span class="mt-2 block text-sm leading-relaxed text-muted">{{ point.body }}</span>
        </span>
      </li>
    </ol>

    <UButton
      class="self-start"
      :label="resuming ? 'Pick up where you left off' : 'Get started'"
      trailing-icon="i-lucide-arrow-right"
      @click="start"
    />
  </div>
</template>

<script setup lang="ts">

definePageMeta({ layout: 'dashboard' })
import { dashboardTitleClass } from '~/lib/components/workspace/dashboard/dashboardPanelContext'
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
    body: 'Start with a name and the basics, or import your Google Maps listing.',
    icon: 'i-lucide-store',
  },
  {
    title: 'Make it yours',
    body: 'Choose your colours, font and photos. The preview shows your real website as you go.',
    icon: 'i-lucide-palette',
  },
  {
    title: 'Take a look, then publish',
    body: 'Review your website before it goes live. You can keep editing after you publish.',
    icon: 'i-lucide-sprout',
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
