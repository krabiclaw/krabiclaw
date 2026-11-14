<template>
  <GuidedSetupShell
    id="website-onboarding"
    :title="isWelcome ? undefined : currentStep?.title"
    :detail="currentStep?.detail"
    :wide="currentStep?.id === 'booking'"
    :centered="currentStep?.id === 'booking'"
    :full="isWelcome && !restoreError"
    :position="position"
    :total="plan?.steps.length"
    :next-label="currentStep?.nextLabel"
    :back-label="plan?.backLabel"
    :exit-label="plan?.exitLabel ?? 'Exit'"
    :busy="busy"
    :disabled="!currentStep?.canAdvance"
    @next="goNext"
    @back="goBack"
    @exit="saveAndExit"
  >
    <p v-if="restoreError" class="py-6 text-sm text-error" role="alert">{{ getErrorMessage(restoreError, 'Your saved answers could not be loaded.') }}</p>
    <NuxtPage v-else-if="currentStep" :step="currentStep" />
    <p v-if="draft.error.value || flowError" class="mt-4 text-sm text-error" role="alert">{{ draft.error.value || flowError }}</p>
  </GuidedSetupShell>
</template>

<script setup lang="ts">
import GuidedSetupShell from '~/components/dashboard/GuidedSetupShell.vue'
import { onboardingReturnTarget, onboardingStepPath, useOnboardingPlan, useOnboardingState } from '~/composables/useOnboardingFlow'
import { useOnboardingDraft } from '~/composables/useOnboardingDraft'
import { WEBSITE_ONBOARDING_EXIT_PATH, type OnboardingStepId } from '~/shared/onboarding-flow'

definePageMeta({ layout: 'dashboard', tabs: false })

const route = useRoute()
const router = useRouter()
const { organization } = useDashboardMenu()
const returnTo = computed(() => {
  const target = onboardingReturnTarget(route.query.returnTo)
  return target && router.resolve(target).matched.some(record => record.meta.layout === 'dashboard') ? target : undefined
})
const stepPath = (step: OnboardingStepId) => onboardingStepPath(step, returnTo.value)
const state = useOnboardingState()
const draft = useOnboardingDraft()
const plan = useOnboardingPlan()
const advancing = ref(false)
const flowError = ref<string | null>(null)
const busy = computed(() => draft.busy.value || advancing.value)
onBeforeRouteLeave(() => !draft.busy.value)
onBeforeRouteUpdate(() => !draft.busy.value)

const requestedId = computed(() => String(route.params.step ?? 'type'))
const position = computed(() => plan.value?.steps.findIndex(step => step.id === requestedId.value) ?? -1)
const currentStep = computed(() => plan.value?.steps[position.value])
const isWelcome = computed(() => requestedId.value === 'type')

const nuxtApp = useNuxtApp()
const { data: initialPlan, error: restoreError } = await useAsyncData('onboarding-flow', async () => {
  await draft.restore()
  return nuxtApp.runWithContext(() => draft.readFlow({ ...draft.flowAnswers.value, pausedStep: state.value.pausedStep }))
})
plan.value = initialPlan.value ?? null

if (plan.value) {
  const resume = plan.value.steps.findIndex(step => step.id === plan.value?.resumeStep)
  if (position.value === -1 || position.value > resume || (!route.params.step && state.value.draftId && resume > 0)) {
    await navigateTo(stepPath(plan.value.resumeStep), { replace: true })
  }
}

// A second read on Next makes navigation depend on the latest server answer.
watch(draft.flowAnswers, (answers, _, onCleanup) => {
  const request = new AbortController()
  const timer = setTimeout(async () => {
    try {
      plan.value = await draft.readFlow(answers, request.signal)
      flowError.value = null
    } catch (error) {
      if (!request.signal.aborted) flowError.value = getErrorMessage(error, 'Could not check your answers.')
    }
  }, 120)
  onCleanup(() => {
    clearTimeout(timer)
    request.abort()
  })
})

async function goBack() {
  if (busy.value) return
  const previous = plan.value?.steps[position.value - 1]
  if (previous) await router.push(stepPath(previous.id))
}

async function goNext() {
  if (busy.value) return
  const startingRoute = router.currentRoute.value
  const stepId = requestedId.value
  advancing.value = true
  try {
    const flow = await draft.readFlow()
    if (router.currentRoute.value !== startingRoute) return
    plan.value = flow
    flowError.value = null
    const index = flow.steps.findIndex(step => step.id === stepId)
    const step = flow.steps[index]
    if (!step?.canAdvance) return

    if (step.action === 'commit') {
      if (!flow.canFinish) {
        await router.push(stepPath(flow.resumeStep))
        return
      }
      if (!await saveOrReopenBusiness(flow) || !await draft.activate()) return
      const created = state.value.created
      if (!created) throw new Error('The private website could not be read.')
      await router.push(created.next_url)
      return
    }

    const next = flow.steps[index + 1]
    if (!next) return
    if (next.id === 'timezone') state.value.timezoneStepVisited = true
    await router.push(stepPath(next.id))
  } catch (error) {
    flowError.value = getErrorMessage(error, 'Could not continue setup.')
  } finally {
    advancing.value = false
  }
}

async function saveAndExit() {
  if (busy.value) return
  advancing.value = true
  try {
    if (!restoreError.value) {
      const flow = await draft.readFlow()
      plan.value = flow
      if (flow.canSave && !await saveOrReopenBusiness(flow, currentStep.value?.id)) return
    }
    await router.replace(returnTo.value ?? (organization.value ? `/dashboard/${encodeURIComponent(organization.value.slug)}` : WEBSITE_ONBOARDING_EXIT_PATH))
  } catch (error) {
    flowError.value = getErrorMessage(error, 'Could not exit setup.')
  } finally {
    advancing.value = false
  }
}

async function saveOrReopenBusiness(flow: NonNullable<typeof plan.value>, step?: NonNullable<typeof currentStep.value>['id']) {
  if (await draft.save(flow, step)) return true
  if (draft.subdomainConflict.value) {
    plan.value = await draft.readFlow()
    await router.push(stepPath('business'))
  }
  return false
}

watch(requestedId, () => {
  draft.error.value = null
  if (!currentStep.value && plan.value) void router.replace(stepPath(plan.value.resumeStep))
})
</script>
