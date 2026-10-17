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
        v-else-if="options.length"
        v-model="selection"
        :items="options"
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

const selection = computed({
  get: () => {
    if (p.form.stay_team_id) return `team:${p.form.stay_team_id}`
    if (p.form.stay_member_id) return `member:${p.form.stay_member_id}`
    return UNASSIGNED
  },
  set: (value: string) => {
    p.form.stay_team_id = value.startsWith('team:') ? value.slice(5) : null
    p.form.stay_member_id = value.startsWith('member:') ? value.slice(7) : null
  },
})

const options = computed(() => {
  if (!members.value) return []
  const items = [
    {
      value: UNASSIGNED,
      label: 'Owners and admins only',
      description: 'All organization owners and admins manage stays and turnovers for this home.',
    },
    ...members.value.teams.map(team => ({
      value: `team:${team.id}`,
      label: team.name,
      description: `Members of ${team.name} see this place’s stays and turnovers.`,
    })),
  ]
  if (p.form.stay_member_id) {
    const member = members.value.members.find(m => m.id === p.form.stay_member_id)
    if (member) {
      const name = member.name?.trim() || 'Assigned team member'
      items.push({
        value: `member:${member.id}`,
        label: name,
        description: `${name} looks after this place’s stays and turnovers.`,
      })
    }
  }
  return items
})
</script>
