<template>
  <DashboardLeafPanel
    id="product-team"
    :title="p.sectionLabels.team"
    lead="Members of this team see this place’s stays and turnovers."
    :saving="p.saving.value"
    :disabled="p.saveDisabled.value"
    :save-label="p.saveLabel.value"
    :error="p.loadError.value || p.saveError.value || ''"
    @cancel="p.revert"
    @save="p.save"
  >
    <div v-if="p.isNew.value || p.product.value" class="space-y-6">
      <UAlert
        v-if="membersError"
        color="error"
        variant="soft"
        :description="getErrorMessage(membersError, 'Teams could not be loaded.')"
        :actions="[{ label: 'Try again', color: 'neutral', variant: 'soft', onClick: () => refreshMembers() }]"
      />
      <URadioGroup
        v-else-if="teamOptions.length"
        v-model="teamSelection"
        :items="teamOptions"
        variant="card"
        class="w-full"
      />
      <p v-else class="text-muted">Loading teams…</p>
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { getErrorMessage } from '~/utils/errors'

definePageMeta({ layout: 'dashboard' })

const p = inject(productEditorKey)!
const { data: members, error: membersError, refresh: refreshMembers } = await useMemberSchedulingList(() => p.organizationId)

const UNASSIGNED = 'unassigned'

const teamSelection = computed({
  get: () => p.form.stay_team_id ?? UNASSIGNED,
  set: (value: string) => {
    const unassigned = value === UNASSIGNED
    p.form.stay_team_id = unassigned ? null : value
    if (unassigned) p.form.stay_member_id = null
  },
})

const teamOptions = computed(() => {
  if (!members.value) return []
  return [
    {
      value: UNASSIGNED,
      label: 'Owners and admins only',
      description: 'All organization owners and admins manage stays and turnovers for this home.',
    },
    ...members.value.teams.map(team => ({
      value: team.id,
      label: team.name,
      description: `Members of ${team.name} see this place’s stays and turnovers.`,
    })),
  ]
})
</script>
