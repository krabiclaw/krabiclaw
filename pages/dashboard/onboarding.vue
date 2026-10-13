<template>
  <div class="flex size-full min-h-0 flex-col overflow-hidden bg-muted text-highlighted">
    <div class="grid min-h-0 flex-1 overflow-hidden lg:grid-cols-[minmax(24rem,45%)_1fr]">
      <!-- The step column. One question at a time, its own header and footer. -->
      <div class="flex min-h-0 flex-col border-r border-default bg-default">
        <div v-if="currentStep" class="flex shrink-0 items-center px-6 py-3">
          <UButton to="/dashboard" color="neutral" variant="outline" size="sm" label="Save & exit" />
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          <p v-if="restoreError" class="py-16 text-sm text-error" role="alert">{{ getErrorMessage(restoreError, 'Your saved answers could not be loaded.') }}</p>
          <NuxtPage v-else />
        </div>

        <div v-if="currentStep && !restoreError" class="shrink-0 border-t border-default px-6 py-4">
          <p v-if="draft.error.value" class="mb-3 text-sm text-error">{{ draft.error.value }}</p>
          <div class="flex items-center justify-between gap-4">
            <UButton variant="link" color="neutral" label="Back" @click="goBack" />
            <UButton
              :label="nextLabel"
              :loading="draft.busy.value"
              :disabled="!canAdvance"
              @click="goNext"
            />
          </div>
        </div>
      </div>

      <OnboardingPreviewPane
        v-if="!isMobilePreviewViewport"
        class="hidden lg:flex"
        :iframe-src="iframeSrc"
        :organization-locations="previewLocations"
        :selected-location-id="selectedLocationId"
        selected-page="home"
        :organization-status="organizationStatus"
        :organization-domain="organizationDomain"
        :vertical="state.vertical"
        :empty-visual-url="preDraftVisual.url"
        :empty-visual-alt="preDraftVisual.alt"
        home-only
        @select-location="selectedLocationId = $event"
      />
    </div>

    <USlideover
      v-if="isMobilePreviewViewport"
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
          :vertical="state.vertical"
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
  onboardingStep,
  onboardingStepPath,
  startOnboardingFlow,
  useOnboardingSteps,
} from '~/composables/useOnboardingFlow'
import { useOnboardingDraft } from '~/composables/useOnboardingDraft'

// This route creates a new site, so it has no org or site of its own yet: there
// is no orgSlug segment, so the dashboard layout requests no context, and it
// declares no tabs, so the layout renders the shared header without them.
definePageMeta({ layout: 'dashboard', tabs: false })

const route = useRoute()
const router = useRouter()
const config = useRuntimeConfig()
const state = startOnboardingFlow('new-site')
const draft = useOnboardingDraft()
const { indexOf, nextOf, previousOf, resumeStep } = useOnboardingSteps()

const currentStep = computed(() => onboardingStep(String(route.params.step ?? ''), 'new-site'))
const previousStep = computed(() => currentStep.value ? previousOf(currentStep.value.id) : null)
const nextStep = computed(() => currentStep.value ? nextOf(currentStep.value.id) : null)
const nextLabel = computed(() => currentStep.value?.nextLabel?.(state.value)
  ?? (currentStep.value?.optional && !currentStep.value.complete(state.value) ? 'Skip for now' : 'Next'))
const canAdvance = computed(() => {
  const step = currentStep.value
  if (!step) return false
  return step.intro || step.optional || step.complete(state.value)
})

// ─── Entering the flow ────────────────────────────────────────────────────────
// The answers live in useState, which a page load starts empty, so every entry
// point reads the saved draft back before a step renders: the welcome screen, a
// step reloaded mid-flow, a step URL opened cold. This component is the parent
// route — step-to-step navigation keeps it mounted — so the draft is fetched
// once per page load and never again while the flow runs.
const requested = currentStep.value
// Starting from an empty form would save blanks over the draft, so a draft
// that cannot be read stops the flow here.
const { error: restoreError } = await useAsyncData('onboarding-draft', () => draft.restore())
if (!restoreError.value) {
  if (route.params.step && !requested) {
    // Not a step at all.
    await navigateTo('/dashboard/onboarding', { replace: true })
  } else if (requested) {
    // A step the owner has not reached, or one that no longer applies to the
    // answers they gave, is not theirs to land on: an empty form there would
    // save blanks over the draft. Send them to the step the draft stopped at.
    // Only the requested URL is judged; once the flow is running, Next decides
    // where it goes.
    const resume = resumeStep.value
    if (indexOf(requested.id) === -1 || indexOf(requested.id) > indexOf(resume.id)) {
      await navigateTo(onboardingStepPath(resume.id), { replace: true })
    }
  }
}

async function goBack() {
  const target = previousStep.value
  await router.push(target ? onboardingStepPath(target.id) : '/dashboard/onboarding')
}

async function goNext() {
  const step = currentStep.value
  if (!step || !canAdvance.value) return

  // The first save creates the site, so it waits for the currency and the clock the site cannot exist without.
  if (!['type', 'language', 'business', 'location', 'hours'].includes(step.id) && !await draft.save()) return

  if (step.action === 'commit') {
    if (!await draft.activate()) return
    const created = state.value.created
    await router.push(created?.orgSlug ? `/dashboard/${created.orgSlug}` : '/dashboard')
    return
  }

  const target = nextStep.value
  if (target) await router.push(onboardingStepPath(target.id))
}

// ─── Preview ──────────────────────────────────────────────────────────────────
const selectedLocationId = ref<string | null>(null)
const previewReloadToken = ref(0)
const mobilePreviewOpen = ref(false)
const hasAutoOpenedMobilePreview = ref(false)
const isMobilePreviewViewport = ref(false)

const organizationOriginFor = (subdomain: string) => tenantOrganizationOrigin({
  platformDomain: String(config.public.platformDomain),
  freeOrganizationDomain: String(config.public.freeOrganizationDomain),
  subdomain,
})

const previewLocations = computed(() => state.value.preview
  ? [{ id: state.value.preview.organizationId, slug: state.value.preview.subdomainCandidate, title: state.value.preview.draftName }]
  : [])

const organizationDomain = computed(() => {
  const slug = state.value.created?.organizationSlug ?? state.value.preview?.subdomainCandidate
  return slug ? organizationOriginFor(slug).replace(/^https?:\/\//, '') : ''
})

// The preview is the site itself, on its own subdomain: the same host, the same
// templates and the same navigation the public gets. Before activation the site
// is pending, so the first load carries its preview token — the tenant host
// turns that into a preview cookie for the rest of the visit.
const iframeSrc = computed(() => {
  const slug = state.value.created?.organizationSlug ?? state.value.preview?.subdomainCandidate
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
  welcome: {
    url: 'https://imagedelivery.net/Frxyb2_d_vGyiaXhS5xqCg/65141776-f50d-4a1e-e223-774747d55000/w=800',
    alt: 'Start building your business website',
  },
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
// illustration rather than an empty column. The welcome screen has no step, and
// a step with no illustration of its own keeps showing the last one instead of
// blanking mid-flow.
const lastVisual = ref(PRE_DRAFT_VISUALS.welcome!)
watchEffect(() => {
  const visual = PRE_DRAFT_VISUALS[currentStep.value?.id ?? 'welcome']
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

let stopViewportListener: (() => void) | null = null

onMounted(() => {
  const query = window.matchMedia('(max-width: 1023.98px)')
  const update = () => {
    isMobilePreviewViewport.value = query.matches
    if (!query.matches) mobilePreviewOpen.value = false
  }
  update()
  query.addEventListener('change', update)
  stopViewportListener = () => query.removeEventListener('change', update)

  if (route.query.payment === 'cancelled') {
    draft.error.value = 'Payment cancelled. Your subscription was not completed.'
    void router.replace({ query: { ...route.query, payment: undefined } })
  }
})

onUnmounted(() => {
  stopViewportListener?.()
  stopViewportListener = null
})

// Step order changes with the answers (the products step does not exist for a
// service business), so a step that no longer applies redirects to the one
// that does.
//
// A failed save belongs to the step it was attempted on. The message used to
// outlive the step and follow the owner around the flow, so a save that failed
// on one screen was still being reported at the bottom of the next one — which
// is what made a 500 on the products step look like Back itself was broken.
watch([currentStep, () => indexOf(currentStep.value?.id ?? 'type')], async ([step], [previous]) => {
  if ((step as typeof currentStep.value)?.id !== (previous as typeof currentStep.value)?.id) draft.error.value = null
  if (route.params.step && !currentStep.value) await router.replace('/dashboard/onboarding')
})
</script>
