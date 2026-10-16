<template>
  <DashboardLeafPanel
    id="product-stay"
    :title="p.sectionLabels.stay"
    lead="Where the place is, when guests arrive and leave, and how many it sleeps."
    :saving="p.saving.value"
    :disabled="p.saveDisabled.value"
    :save-label="p.saveLabel.value"
    :error="p.loadError.value || p.saveError.value || ''"
    @cancel="p.revert"
    @save="p.save"
  >
    <div v-if="p.isNew.value || (p.product.value && !p.loadError.value)" class="space-y-6">
      <!-- A place to stay is at one location for good: its address, time zone and team. -->
      <UFormField label="Location" :description="p.isNew.value ? 'Where guests stay. This cannot be changed later.' : 'A place to stay keeps its location.'" required>
        <p v-if="p.organizationLocationsError.value" role="alert" class="text-error">{{ p.organizationLocationsError.value }}</p>
        <USelect v-else v-model="p.form.stay_location_id" :items="locationItems" :disabled="!p.isNew.value" placeholder="Choose a location" class="w-full" />
      </UFormField>
      <div class="grid gap-6 sm:grid-cols-2">
        <UFormField label="Check-in from" required>
          <UInput v-model="p.form.check_in_time" type="time" class="w-full" />
        </UFormField>
        <UFormField label="Checkout by" required>
          <UInput v-model="p.form.check_out_time" type="time" class="w-full" />
        </UFormField>
        <UFormField label="Sleeps" description="The most guests, adults and children." required>
          <UInput v-model="p.form.max_guests" inputmode="numeric" pattern="[0-9]*" class="w-full" />
        </UFormField>
        <UFormField label="Minimum nights" required>
          <UInput v-model="p.form.min_nights" inputmode="numeric" pattern="[0-9]*" class="w-full" />
        </UFormField>
      </div>
      <UFormField label="Looked after by" description="Members of this team see this place’s stays and turnovers.">
        <UAlert
          v-if="membersError"
          color="error"
          variant="soft"
          :description="getErrorMessage(membersError, 'Teams could not be loaded.')"
          :actions="[{ label: 'Try again', color: 'neutral', variant: 'soft', onClick: () => refreshMembers() }]"
        />
        <USelect v-else-if="teamItems" v-model="teamSelection" :items="teamItems" class="w-full" />
        <p v-else class="text-muted">Loading teams…</p>
      </UFormField>
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { getErrorMessage } from '~/utils/errors'

definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
const { data: members, error: membersError, refresh: refreshMembers } = await useMemberSchedulingList(() => p.organizationId)
const locationItems = computed(() => p.organizationLocations.value.map(location => ({ label: location.title, value: location.id })))
/** The select's own value for no team: a select item cannot be empty, and the form holds null. */
const UNASSIGNED = 'unassigned'
const teamSelection = computed({
  get: () => p.form.stay_team_id ?? UNASSIGNED,
  set: (value: string) => { p.form.stay_team_id = value === UNASSIGNED ? null : value },
})
// Null until the organization's teams have been read; an organization with no teams offers only owners and admins.
const teamItems = computed(() => members.value
  ? [{ label: 'Owners and admins only', value: UNASSIGNED }, ...members.value.teams.map(team => ({ label: team.name, value: team.id }))]
  : null)
</script>
