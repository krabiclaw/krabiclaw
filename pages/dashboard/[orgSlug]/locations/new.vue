<template>
  <DashboardIndexPanel id="location-new" title="Add a location" :ui="{ body: 'p-0 sm:p-0 gap-0' }">
    <div
      class="grid min-h-0 flex-1 overflow-hidden"
      style="grid-template-columns: minmax(24rem, 45%) 1fr; grid-template-rows: minmax(0, 1fr)"
    >
      <!-- The step column, the same screens the new-site flow walks. -->
      <div class="flex min-h-0 flex-col border-r border-default bg-default">
        <div v-if="created" class="flex min-h-0 flex-1 flex-col justify-center gap-4 px-6">
          <h1 class="text-2xl font-bold leading-snug text-highlighted">Location added</h1>
          <p class="text-[15px] leading-relaxed text-toned">
            <strong class="text-highlighted">{{ state.details.name }}</strong> is on your site now, and the preview
            beside this is showing it.
          </p>
          <UButton
            class="self-start"
            label="Back to dashboard"
            :to="`/dashboard/${orgSlug}`"
          />
        </div>

        <!-- The plan pays for the locations the site has; one more is added to it first, through Stripe's confirmation. -->
        <div v-else-if="locations && locations.used >= locations.covered" data-location-limit class="flex min-h-0 flex-1 flex-col justify-center gap-4 px-6">
          <h1 class="text-2xl font-bold leading-snug text-highlighted">
            {{ onPaidPlan ? 'Add a location to your plan' : 'Choose a plan for more locations' }}
          </h1>
          <p class="text-[15px] leading-relaxed text-toned">
            <template v-if="onPaidPlan">
              Your plan covers {{ locations.covered }} locations and your site has {{ locations.used }}.
              {{ INCLUDED_LOCATIONS }} locations are included, then {{ locationPrice }}.
              Stripe shows what changes on your bill before you confirm.
            </template>
            <template v-else>
              Basic includes {{ INCLUDED_LOCATIONS }} locations. Growth and Commerce include {{ INCLUDED_LOCATIONS }},
              then {{ locationPrice }}.
            </template>
          </p>
          <p v-if="limitError" class="text-sm text-error">{{ limitError }}</p>
          <UButton
            v-if="onPaidPlan"
            class="self-start"
            label="Add a location to your plan"
            :loading="limitBusy"
            @click="addLocationToPlan"
          />
          <UButton
            v-else
            class="self-start"
            label="Choose a plan"
            :to="`/dashboard/${orgSlug}/payments?tab=plan`"
          />
        </div>

        <template v-else-if="currentStep">
          <div class="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
            <OnboardingStepScreen :step="currentStep" @advance="goNext" />
          </div>

          <div class="shrink-0 border-t border-default px-6 py-4">
            <p v-if="draft.error.value" class="mb-3 text-sm text-error">{{ draft.error.value }}</p>
            <div class="flex items-center justify-between gap-4">
              <UButton
                variant="link"
                color="neutral"
                label="Back"
                :disabled="!previousStep"
                @click="goBack"
              />
              <UButton
                :label="nextLabel"
                :loading="draft.busy.value"
                :disabled="!canAdvance"
                @click="goNext"
              />
            </div>
          </div>
        </template>
      </div>
      <OnboardingPreviewPane
        :iframe-src="iframeSrc"
        :organization-locations="organizationLocations"
        :selected-location-id="selectedLocationId"
        :selected-page="selectedPreviewPage"
        :organization-status="computedOrganizationStatus"
        :organization-domain="organizationDomain"
        :vertical="previewVertical"
        @select-page="onSelectPage"
        @select-location="onSelectLocation"
      />
    </div>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import OnboardingStepScreen from '~/lib/components/workspace/onboarding/OnboardingStepScreen.vue'
import {
  onboardingStep,
  startOnboardingFlow,
  useOnboardingSteps,
  type OnboardingStepId,
} from '~/composables/useOnboardingFlow'
import { useOnboardingDraft } from '~/composables/useOnboardingDraft'
import { normalizeVertical, type OrganizationVertical } from '~/utils/vertical-copy'
import { additionalLocationPrice, INCLUDED_LOCATIONS, isKnownRecurringPlan } from '~/shared/billing-model'
import { isLocationCount } from '~/composables/useOrganizationSubscription'

// Adding a location is a tile's worth of work reached from Locations, which is
// where Back goes.
definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const config = useRuntimeConfig()

const orgSlug = route.params.orgSlug as string

const dashboard = useDashboardOrganization()
const dashboardApi = useDashboardApi()
const { setPlanLocations } = useOrganizationSubscription()

type LocationBilling = { plan: string; billingInterval?: 'month' | 'year'; locations: { used: number; covered: number } }
const isLocationBilling = (value: unknown): value is { success: true; billing: LocationBilling } =>
  isRecord(value) && value.success === true && isRecord(value.billing) && typeof value.billing.plan === 'string' && isLocationCount(value.billing.locations)
const { data: billingResponse, error: billingError } = await useAsyncData(
  `location-new-billing:${String(route.params.orgSlug || '')}`,
  () => dashboardApi('/api/billing/status', { validate: isLocationBilling }),
)
if (billingError.value) throw billingError.value
const locations = computed(() => billingResponse.value?.billing.locations ?? null)
const onPaidPlan = computed(() => isKnownRecurringPlan(billingResponse.value?.billing.plan))
const locationPrice = computed(() => additionalLocationPrice(billingResponse.value?.billing.billingInterval))
const limitBusy = ref(false)
const limitError = ref('')
async function addLocationToPlan() {
  const organizationId = dashboard.organization.value?.id
  if (!organizationId || !locations.value || limitBusy.value) return
  limitBusy.value = true
  limitError.value = ''
  try {
    await setPlanLocations(organizationId, locations.value.used + 1)
  } catch (error) {
    limitError.value = getErrorMessage(error, 'The location could not be added to your plan')
  } finally {
    limitBusy.value = false
  }
}
const organizationData = computed(() => dashboard.organization.value as ApiRecord | null)
const previewVertical = computed<OrganizationVertical>(() => normalizeVertical(organizationData.value?.vertical as string | undefined) as OrganizationVertical)
const organizationLocations = computed(() => dashboard.locations.value)
const selectedLocationId = ref<string | null>(null)
const selectedPreviewPage = ref('home')
const previewReloadToken = ref(0)

const platformHostname = computed(() => {
  const domain = config.public.freeOrganizationDomain as string
  return domain.replace(/^https?:\/\//, '')
})

const organizationDomain = computed(() =>
  organizationData.value?.subdomain ? `${organizationData.value.subdomain}.${platformHostname.value}` : ''
)

// The preview is the live site on its own host, so this pane shows exactly
// what a visitor sees.
const organizationPreviewBaseUrl = computed(() => organizationData.value?.subdomain
  ? tenantOrganizationOrigin({
      platformDomain: String(config.public.platformDomain),
      freeOrganizationDomain: String(config.public.freeOrganizationDomain),
      subdomain: organizationData.value.subdomain,
    })
  : '')

const selectedLocation = computed(() =>
  organizationLocations.value.find(l => l.id === selectedLocationId.value) ?? null
)

const locationScopedPages = new Set(['location', 'menu'])
const currentPageIsLocationScoped = computed(() => locationScopedPages.has(selectedPreviewPage.value))

const previewPagePath = computed(() => {
  if (!selectedLocation.value) return selectedPreviewPage.value === 'home' ? '/' : `/${selectedPreviewPage.value}`
  if (selectedPreviewPage.value === 'location') return `/locations/${selectedLocation.value.slug}`
  if (selectedPreviewPage.value === 'menu') return `/locations/${selectedLocation.value.slug}/menu`
  return selectedPreviewPage.value === 'home' ? '/' : `/${selectedPreviewPage.value}`
})

const iframeSrc = computed(() => {
  if (!organizationPreviewBaseUrl.value) return ''
  if (currentPageIsLocationScoped.value && !selectedLocation.value) return ''
  const subPath = previewPagePath.value === '/' ? '' : previewPagePath.value
  const url = new URL(organizationPreviewBaseUrl.value + subPath)
  url.searchParams.set('preview', 'true')
  if (currentPageIsLocationScoped.value && selectedLocation.value) {
    url.searchParams.set('location', selectedLocation.value.slug)
  }
  if (previewReloadToken.value) url.searchParams.set('t', String(previewReloadToken.value))
  return url.toString()
})

const computedOrganizationStatus = computed((): 'setup' | 'progress' | 'ready' | 'live' =>
  organizationData.value?.status === 'active' ? 'live' : 'setup'
)

const onSelectPage = (page: string) => {
  selectedPreviewPage.value = page
}

const onSelectLocation = (id: string) => {
  selectedLocationId.value = id
}

// The location exists now: reload the site's locations and frame the new one.
const onLocationCreated = async (locationSlug: string | null) => {
  await dashboard.refresh()
  previewReloadToken.value = Date.now()

  const addedLocation = locationSlug ? organizationLocations.value.find(l => l.slug === locationSlug) : null
  if (addedLocation) selectedLocationId.value = addedLocation.id
}

// Add-location walks the same step table as /dashboard/onboarding, minus the
// business type, the brand and the activation: the site already has all three.
// It is not routed — the whole walk is this one create level — so the step it is
// on is state rather than a URL segment.
const state = startOnboardingFlow('add-location')
const draft = useOnboardingDraft()
const { nextOf, previousOf } = useOnboardingSteps()
const currentStepId = ref<OnboardingStepId>('business')
const currentStep = computed(() => onboardingStep(currentStepId.value, 'add-location'))
const previousStep = computed(() => currentStep.value ? previousOf(currentStep.value.id) : null)
const created = computed(() => state.value.created !== null)
const nextLabel = computed(() => currentStep.value?.nextLabel?.(state.value)
  ?? (currentStep.value?.optional && !currentStep.value.complete(state.value) ? 'Skip for now' : 'Next'))
const canAdvance = computed(() => {
  const step = currentStep.value
  if (!step) return false
  return step.optional || step.complete(state.value)
})

function goBack() {
  const target = previousStep.value
  if (target) currentStepId.value = target.id
}

// There is no draft here: nothing is written until the last step, which adds
// the location to the site this route is already on.
async function goNext() {
  const step = currentStep.value
  if (!step || !canAdvance.value) return

  if (step.action === 'commit') {
    if (!await draft.addLocation()) return
    await onLocationCreated(state.value.created?.locationSlug ?? null)
    return
  }

  const target = nextOf(step.id)
  if (target) currentStepId.value = target.id
}


</script>
