<template>
  <!--
    A listing Airbnb left details out of: the host fills them in here, and the
    checklist sends them with the listing when its sync starts. Nothing is
    saved until then.
  -->
  <DashboardListItemDialog :title="listing.title" save-label="Done" :save-disabled="!complete" @update:open="open => { if (!open) emit('close', null) }" @save="done">
    <div class="space-y-1 text-sm text-muted">
      <p v-if="listing.subtitle">{{ listing.subtitle }}</p>
      <p>{{ details.maxGuests }} guests · {{ details.nightlyRate }} {{ details.currency }} / night</p>
    </div>
    <p class="text-sm text-muted">Airbnb didn’t include these details. Add them once; they’re saved when this listing starts syncing.</p>

    <section v-for="group in groups" :key="group.title" class="space-y-4">
      <h3 class="text-base font-semibold text-highlighted">{{ group.title }}</h3>
      <UFormField v-for="field in group.fields" :key="field" :label="DETAIL_FIELD_TITLES[field]">
        <USelectMenu v-if="field === 'timezone'" v-model="values.timezone" :items="timezones" value-key="value" placeholder="Choose" class="w-full" />
        <USelectMenu v-else-if="field === 'propertyType'" v-model="values.propertyType" :items="propertyTypes" value-key="value" placeholder="Choose" class="w-full" />
        <UInput v-else v-model="values[field]" :type="field === 'email' ? 'email' : field === 'phone' ? 'tel' : 'text'" :autocapitalize="field === 'email' ? 'none' : field === 'country' ? 'characters' : 'words'" class="w-full" />
      </UFormField>
    </section>

    <section class="space-y-2">
      <h3 class="text-base font-semibold text-highlighted">Check-in and checkout</h3>
      <template v-if="stayTimes">
        <p class="text-base text-highlighted">{{ stayTimes }}</p>
        <p class="text-sm text-muted">From Airbnb. Change them on Airbnb and they’ll follow.</p>
      </template>
      <UAlert v-else color="warning" variant="soft" icon="i-lucide-circle-alert" description="This listing has no check-in or checkout time on Airbnb. Set them there, then come back." />
    </section>
  </DashboardListItemDialog>
</template>

<script setup lang="ts">
import DashboardListItemDialog from '~/components/dashboard/DashboardListItemDialog.vue'
import { DETAIL_FIELD_TITLES, PROPERTY_TYPES, PROPERTY_TYPE_LABELS, type DetailField } from '~/shared/airbnb-import'
import { TIMEZONE_OPTIONS, timezoneLabel } from '~/utils/timezone'

/** GET …/airbnb/listings/:listingId, the part the form reads. */
export interface AirbnbListingDetails {
  currency: string
  maxGuests: number
  nightlyRate: string
  missingFields: DetailField[]
  checkInTime: string | null
  checkInEndTime: string | null
  checkOutTime: string | null
}

const props = defineProps<{
  listing: { title: string; subtitle: string | null }
  details: AirbnbListingDetails
  /** What the host entered before, when they come back to change it. */
  entered: Record<string, string>
}>()

/*
  Opened through useOverlay: resolves with the values entered, keyed by
  missing field, or null when the host closes without finishing.
*/
const emit = defineEmits<{ close: [values: Record<string, string> | null] }>()

// The overlay keeps one dialog mounted across opens, so the form is rebuilt for each listing it is given.
const values = ref<Record<string, string>>({})
watch(() => [props.details, props.entered] as const, ([details, entered]) => {
  values.value = Object.fromEntries(details.missingFields.map(field => [field, entered[field] ?? '']))
}, { immediate: true })

const LOCATION_FIELDS: DetailField[] = ['propertyType', 'country', 'state', 'city', 'address', 'zipCode', 'timezone']
const CONTACT_FIELDS: DetailField[] = ['email', 'phone']
const groups = computed(() => [
  { title: 'Location', fields: LOCATION_FIELDS.filter(field => props.details.missingFields.includes(field)) },
  { title: 'Contact', fields: CONTACT_FIELDS.filter(field => props.details.missingFields.includes(field)) },
].filter(group => group.fields.length))

const timezones = TIMEZONE_OPTIONS.map(zone => ({ value: zone, label: timezoneLabel(zone) }))
const propertyTypes = PROPERTY_TYPES.map(type => ({ value: type as string, label: PROPERTY_TYPE_LABELS[type] }))

/** Airbnb's times as the home will have them, or null when Airbnb is missing one. */
const stayTimes = computed(() => {
  const { checkInTime, checkInEndTime, checkOutTime } = props.details
  if (!checkInTime || !checkOutTime) return null
  return `Check-in ${checkInTime}${checkInEndTime ? `–${checkInEndTime}` : ' onwards'} · Checkout ${checkOutTime}`
})

const complete = computed(() => stayTimes.value !== null && props.details.missingFields.every(field => values.value[field]?.trim()))

function done() {
  emit('close', Object.fromEntries(props.details.missingFields.map(field => [field, values.value[field]!.trim()])))
}
</script>
