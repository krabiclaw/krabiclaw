<template>
  <div class="flex size-full min-h-0 flex-col overflow-hidden bg-muted text-highlighted">
    <div class="grid min-h-0 flex-1 overflow-hidden" :class="{ 'lg:grid-cols-[minmax(24rem,45%)_1fr]': !isWelcome }">
      <!-- The step column. One question at a time, its own header and footer. -->
      <div class="relative flex min-h-0 flex-col bg-default" :class="isWelcome ? 'overflow-y-auto' : 'border-r border-default'">
        <UButton
          v-if="isWelcome && currentStep"
          class="absolute end-4 top-4 z-10 rounded-full sm:end-6 sm:top-6"
          icon="i-lucide-x"
          variant="soft"
          color="neutral"
          :aria-label="canSave || state.draftId ? 'Save & exit' : 'Exit'"
          :title="canSave || state.draftId ? 'Save & exit' : 'Exit'"
          :loading="exiting"
          :disabled="busy || (Boolean(state.draftId) && !canSave)"
          @click="saveAndExit"
        />
        <div v-if="currentStep && !isWelcome" class="flex shrink-0 items-center py-3" :class="dashboardGutterClass">
          <UButton
            color="neutral"
            variant="outline"
            size="sm"
            :label="canSave || state.draftId ? 'Save & exit' : 'Exit'"
            :loading="exiting"
            :disabled="Boolean(restoreError) || busy || (Boolean(state.draftId) && !canSave)"
            @click="saveAndExit"
          />
        </div>

        <div :class="isWelcome ? 'shrink-0' : [dashboardGutterClass, 'min-h-0 flex-1 overflow-y-auto pb-6']" :inert="busy">
          <p v-if="restoreError" class="py-16 text-sm text-error" role="alert">{{ getErrorMessage(restoreError, 'Your saved answers could not be loaded.') }}</p>
          <template v-else>
            <NuxtPage v-if="currentStep" :step="currentStep" @advance="goNext" @uploading="uploading = $event" />
            <UCheckbox v-if="currentStep?.id === 'review' && state.vertical === 'lodging'" v-model="migrateHostaway" class="pb-6" label="Move existing stays from Hostaway after creating my site" />
          </template>
        </div>

        <div v-if="currentStep && !restoreError" class="shrink-0" :class="isWelcome ? 'mx-auto w-full max-w-sm px-5 pb-8' : [dashboardGutterClass, 'border-t border-default py-3']">
          <p v-if="!canSave && !isWelcome" class="mb-3 text-sm text-muted">
            {{ state.draftId ? 'Finish the required details to save your changes.' : 'Your answers have not been saved yet.' }}
          </p>
          <p v-if="draft.error.value || flowError" class="mb-3 text-sm text-error" role="alert">{{ draft.error.value || flowError }}</p>
          <div class="flex items-center justify-between gap-4">
            <UButton v-if="!isWelcome" variant="link" color="neutral" label="Back" :disabled="busy" @click="goBack" />
            <UButton
              :class="{ 'w-full justify-center': isWelcome }"
              :size="isWelcome ? 'lg' : undefined"
              :label="nextLabel"
              :loading="advancing || draft.busy.value"
              :disabled="!canAdvance || busy"
              @click="goNext"
            />
          </div>
        </div>
      </div>

      <OnboardingPreviewPane
        v-if="!isWelcome && !isMobilePreviewViewport"
        class="hidden lg:flex"
        :iframe-src="iframeSrc"
        :organization-locations="previewLocations"
        :selected-location-id="selectedLocationId"
        selected-page="home"
        :organization-status="organizationStatus"
        :organization-domain="organizationDomain"
        :vertical="state.vertical ?? undefined"
        :empty-visual-url="preDraftVisual.url"
        :empty-visual-alt="preDraftVisual.alt"
        home-only
        @select-location="selectedLocationId = $event"
      />
    </div>

    <USlideover
      v-if="!isWelcome && isMobilePreviewViewport"
      v-model:open="mobilePreviewOpenForViewport"
      title="Site preview"
      description="Close to keep answering."
      side="bottom"
      :ui="{ content: 'h-[82vh] overflow-hidden rounded-t-2xl', body: 'flex min-h-0 p-0 sm:p-0' }"
    >
      <template #body>
        <OnboardingPreviewPane
          class="min-h-0 flex-1"
          :iframe-src="iframeSrc"
          :organization-locations="previewLocations"
          :selected-location-id="selectedLocationId"
          selected-page="home"
          :organization-status="organizationStatus"
          :organization-domain="organizationDomain"
          :vertical="state.vertical ?? undefined"
          :empty-visual-url="preDraftVisual.url"
          :empty-visual-alt="preDraftVisual.alt"
          home-only
          @select-location="selectedLocationId = $event"
        />
      </template>
    </USlideover>
  </div>
</template>

<script setup lang="ts">
import { tenantOrganizationOrigin } from '~/utils/tenant-organization-origin'
import { useDashboardTopNavAction } from '~/composables/useDashboardTopNavActions'
import {
  onboardingStepPath,
  useOnboardingState,
  useOnboardingPlan,
} from '~/composables/useOnboardingFlow'
import { useOnboardingDraft } from '~/composables/useOnboardingDraft'
import { dashboardGutterClass } from '~/lib/components/workspace/dashboard/dashboardPanelContext'

// This route creates a new site, so it has no org or site of its own yet: there
// is no orgSlug segment, so the dashboard layout requests no context, and it
// declares no tabs, so the layout renders the shared header without them.
definePageMeta({ layout: 'dashboard', tabs: false })

const route = useRoute()
const router = useRouter()
const config = useRuntimeConfig()
const state = useOnboardingState()
const draft = useOnboardingDraft()
const plan = useOnboardingPlan()
const advancing = ref(false)
const flowError = ref<string | null>(null)
const exiting = ref(false)
const migrateHostaway = ref(false)
const uploading = ref(false)
const busy = computed(() => draft.busy.value || advancing.value || exiting.value || uploading.value)
onBeforeRouteLeave(() => !draft.busy.value && !uploading.value)
onBeforeRouteUpdate(() => !draft.busy.value && !uploading.value)

const requestedId = computed(() => String(route.params.step ?? 'type'))
const currentStep = computed(() => plan.value?.steps.find(step => step.id === requestedId.value))
const isWelcome = computed(() => requestedId.value === 'type')
const canSave = computed(() => plan.value?.canSave === true)
const canAdvance = computed(() => currentStep.value?.canAdvance === true)
const nextLabel = computed(() => currentStep.value?.nextLabel)

// Restore the persisted answers before the server chooses the entry step.
const nuxtApp = useNuxtApp()
const { data: initialPlan, error: restoreError } = await useAsyncData('onboarding-flow', async () => {
  await draft.restore()
  return nuxtApp.runWithContext(() => draft.readFlow())
})
plan.value = initialPlan.value ?? null

if (plan.value) {
  const { steps, resumeStep } = plan.value
  const requested = steps.findIndex(step => step.id === requestedId.value)
  const resume = steps.findIndex(step => step.id === resumeStep)
  if (requested === -1 || requested > resume || (!route.params.step && state.value.draftId && resumeStep !== 'type')) {
    await navigateTo(onboardingStepPath(resumeStep), { replace: true })
  }
}

// Keep button state in sync with the server as the owner edits. Next checks
// the current answers even when a single-choice control advances immediately.
watch(draft.flowAnswers, (answers, _, onCleanup) => {
  const request = new AbortController()
  const timer = setTimeout(async () => {
    try {
      plan.value = await draft.readFlow(answers, request.signal)
      flowError.value = null
    } catch (error) {
      if (!request.signal.aborted) flowError.value = getErrorMessage(error, 'Could not check your answers.')
    }
  }, 160)
  onCleanup(() => {
    clearTimeout(timer)
    request.abort()
  })
})

async function goBack() {
  if (busy.value || !plan.value) return
  const index = plan.value.steps.findIndex(step => step.id === requestedId.value)
  const previous = plan.value.steps[index - 1]
  await router.push(previous ? onboardingStepPath(previous.id) : '/dashboard/onboarding')
}

async function goNext() {
  if (busy.value) return
  advancing.value = true
  try {
    const flow = await draft.readFlow()
    plan.value = flow
    flowError.value = null
    const index = flow.steps.findIndex(step => step.id === requestedId.value)
    const step = flow.steps[index]
    if (!step?.canAdvance || (step.save && !flow.canSave)) return
    if (!flow.steps.some(candidate => candidate.id === 'products')) state.value.products = []
    if (step.save && !await draft.save()) return

    if (step.action === 'commit') {
      if (!await draft.activate()) return
      const created = state.value.created
      const home = created && migrateHostaway.value && state.value.vertical === 'lodging'
        ? `/dashboard/${encodeURIComponent(created.organization_slug)}/integrations/hostaway-migration`
        : created?.next_url ?? '/dashboard'
      await router.push(home)
      return
    }

    const next = flow.steps[index + 1]
    if (next) await router.push(onboardingStepPath(next.id))
  } catch (error) {
    flowError.value = getErrorMessage(error, 'Could not continue setup.')
  } finally {
    advancing.value = false
  }
}

async function saveAndExit() {
  if (restoreError.value || busy.value || (state.value.draftId && !canSave.value)) return
  exiting.value = true
  try {
    const flow = await draft.readFlow()
    plan.value = flow
    if (state.value.draftId && !flow.canSave) return
    if (!flow.steps.some(step => step.id === 'products')) state.value.products = []
    if (flow.canSave && !await draft.save()) return
    await router.push('/dashboard')
  } catch (error) {
    flowError.value = getErrorMessage(error, 'Could not exit setup.')
  } finally {
    exiting.value = false
  }
}

// ─── Preview ──────────────────────────────────────────────────────────────────
const selectedLocationId = ref<string | null>(null)
const previewReloadToken = ref(0)
const mobilePreviewOpen = ref(false)
const hasAutoOpenedMobilePreview = ref(false)
const pane = useDashboardPane()
const isMobilePreviewViewport = computed(() => !pane.value)
watch(pane, (wide) => { if (wide) mobilePreviewOpen.value = false })

const organizationOriginFor = (subdomain: string) => tenantOrganizationOrigin({
  platformDomain: String(config.public.platformDomain),
  freeOrganizationDomain: String(config.public.freeOrganizationDomain),
  subdomain,
})

const previewLocations = computed(() => state.value.preview
  ? [{ id: state.value.preview.organizationId, slug: state.value.preview.subdomainCandidate, title: state.value.preview.draftName }]
  : [])

const organizationDomain = computed(() => {
  const slug = state.value.created?.subdomain ?? state.value.preview?.subdomainCandidate
  return slug ? organizationOriginFor(slug).replace(/^https?:\/\//, '') : ''
})

// The preview is the site itself, on its own subdomain: the same host, the same
// templates and the same navigation the public gets. Before activation the site
// is pending, so the first load carries its preview token — the tenant host
// turns that into a preview cookie for the rest of the visit.
const iframeSrc = computed(() => {
  const slug = state.value.created?.subdomain ?? state.value.preview?.subdomainCandidate
  const origin = slug ? organizationOriginFor(slug) : ''
  if (!origin) return ''
  const url = new URL(`${origin}/`)
  if (!state.value.created && state.value.preview) {
    url.searchParams.set('preview_token', state.value.preview.previewToken)
  }
  if (previewReloadToken.value) url.searchParams.set('t', String(previewReloadToken.value))
  return url.toString()
})

const PRE_DRAFT_VISUALS: Record<string, { url: string; alt: string }> = {
  type: {
    url: 'https://imagedelivery.net/Frxyb2_d_vGyiaXhS5xqCg/48434034-9751-4d60-3c88-83c0dea5c600/w=800',
    alt: 'Choose your business type',
  },
  business: {
    url: 'https://imagedelivery.net/Frxyb2_d_vGyiaXhS5xqCg/85418a57-9b58-4657-e151-53738ac99100/w=800',
    alt: 'Find your business on Google Maps',
  },
}
// Preloading them makes each swap instant instead of a blank pane while the
// next image downloads.
useHead({
  link: Object.values(PRE_DRAFT_VISUALS).map(visual => ({ rel: 'preload', as: 'image', href: visual.url })),
})
// Until the first save there is no site to frame, so the pane carries an
// illustration. Steps without their own keep showing the previous one.
const lastVisual = ref(PRE_DRAFT_VISUALS.type!)
watchEffect(() => {
  const visual = PRE_DRAFT_VISUALS[requestedId.value]
  if (visual) lastVisual.value = visual
})
const preDraftVisual = computed(() => iframeSrc.value ? { url: '', alt: '' } : lastVisual.value)

const organizationStatus = computed((): 'setup' | 'progress' | 'live' => {
  if (state.value.created) return 'live'
  if (state.value.preview) return 'progress'
  return 'setup'
})

const mobilePreviewOpenForViewport = computed({
  get: () => isMobilePreviewViewport.value && mobilePreviewOpen.value,
  set: value => { mobilePreviewOpen.value = value },
})

// The pane reloads whenever a save changed the site behind it, and on mobile it
// shows itself the first time there is anything to see.
watch(() => state.value.preview?.previewToken, (token) => {
  if (!token) return
  previewReloadToken.value = Date.now()
  selectedLocationId.value = state.value.preview?.organizationId ?? null
  if (isMobilePreviewViewport.value && !hasAutoOpenedMobilePreview.value) {
    hasAutoOpenedMobilePreview.value = true
    mobilePreviewOpen.value = true
  }
})

useDashboardTopNavAction(() => state.value.preview
  ? {
      key: 'onboarding-preview',
      icon: 'i-lucide-eye',
      ariaLabel: 'Preview draft',
      class: 'lg:hidden',
      onSelect: () => {
        previewReloadToken.value = Date.now()
        if (isMobilePreviewViewport.value) mobilePreviewOpen.value = true
      },
    }
  : null)

onMounted(() => {
  if (route.query.payment === 'cancelled') {
    draft.error.value = 'Payment cancelled. Your subscription was not completed.'
    void router.replace({ query: { ...route.query, payment: undefined } })
  }
})

// Errors from a failed save belong to the screen where it was attempted.
watch(requestedId, () => {
  draft.error.value = null
  if (!currentStep.value && plan.value) void router.replace(onboardingStepPath(plan.value.resumeStep))
})
</script>
