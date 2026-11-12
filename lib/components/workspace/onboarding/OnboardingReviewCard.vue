<template>
  <div class="flex flex-col gap-6">
    <ul class="flex flex-col">
      <li
        v-for="entry in ledger"
        :key="entry.label"
        class="flex items-center justify-between gap-4 border-b border-default py-3 first:pt-0 last:border-b-0"
      >
        <span class="min-w-0">
          <span class="block font-medium text-highlighted">{{ entry.label }}</span>
          <span class="mt-0.5 block truncate text-sm text-toned">{{ entry.value }}</span>
        </span>
      </li>
    </ul>

    <p v-if="state.preview" class="text-sm text-toned">
      Your site stays private until you publish it. <strong class="text-highlighted">{{ liveHost }}</strong>
    </p>
  </div>
</template>

<script setup lang="ts">
import { formatPhone } from '~/utils/phone'
import { useOnboardingState, useOnboardingPlan } from '~/composables/useOnboardingFlow'
import { useOnboardingDraft } from '~/composables/useOnboardingDraft'
import { tenantOrganizationOrigin } from '~/utils/tenant-organization-origin'

const state = useOnboardingState()
const { addressSummary } = useOnboardingDraft()
const config = useRuntimeConfig()

const liveHost = computed(() => {
  const subdomain = state.value.preview?.subdomainCandidate
  if (!subdomain) return ''
  return tenantOrganizationOrigin({
    platformDomain: String(config.public.platformDomain),
    freeOrganizationDomain: String(config.public.freeOrganizationDomain),
    subdomain,
  }).replace(/^https?:\/\//, '')
})

// The ledger follows the flow's applicability, so it never lists an unfinished
// products question that a law firm or lodging workspace was not asked.
const plan = useOnboardingPlan()
const productStep = computed(() => plan.value?.steps.find(step => step.id === 'products'))

// Add-location collects the place and nothing else: there is no menu and no
// brand on a location, so those rows are not part of that flow's ledger.
const ledger = computed(() => {
  const address = addressSummary()
  const hasHours = state.value.hours.hours !== null
  const place = [
    { label: 'Name', value: state.value.details.name || 'Not set', done: Boolean(state.value.details.name) },
    { label: 'Address', value: address || 'Not set', done: Boolean(address) },
    { label: 'Phone', value: state.value.details.phone ? formatPhone(state.value.details.phone) : 'Not set', done: Boolean(state.value.details.phone) },
    {
      label: 'Hours',
      value: hasHours ? `${state.value.hours.timezone}` : 'Not set',
      done: hasHours,
    },
  ]
  return [
    ...place,
    ...(productStep.value
      ? [{
          label: productStep.value.title,
          value: state.value.products.length
            ? `${state.value.products.length} ${state.value.products.length === 1 ? 'entry' : 'entries'}`
            : 'None yet',
          done: state.value.products.length > 0,
        }]
      : []),
    {
      label: 'Colour, photo and headline',
      value: state.value.brand.paletteStarter || state.value.brand.heroHeadline ? 'Set' : 'Not set',
      done: Boolean(state.value.brand.paletteStarter || state.value.brand.heroHeadline),
    },
  ].filter(entry => entry.done)
})
</script>
