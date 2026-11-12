<template>
  <!--
    Every organization this account belongs to. A row puts you in it — Better
    Auth's active organization, then its dashboard — with no screen between.
    Deleting is the list's own edit state, offered on the rows Better Auth lets
    this account delete; a new organization starts here.
  -->
  <DashboardIndexPanel id="account-organizations" title="Organizations">
    <UAlert v-if="marksError" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="getErrorMessage(marksError, 'Organization details could not be loaded.')" />
    <UAlert v-if="permissionError" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="permissionError" />
    <DashboardListEditor
      v-model:editing="editing"
      title="Organizations"
      :items="items"
      empty-title="No organizations yet"
      empty-icon="i-lucide-building-2"
      add-label="New organization"
      :read-only="!deletable.size"
      @add="startOrganization"
      @remove="openDelete"
    >
      <template #item="{ item }">
        <!-- The organization the session is already in is a link; any other tells Better Auth first. -->
        <component
          :is="item.to ? 'span' : 'button'"
          :type="item.to ? undefined : 'button'"
          :disabled="item.to ? undefined : editing"
          class="flex w-full items-center gap-4 text-left"
          :data-testid="`account-organization-${item.id}`"
          @click="enter(item)"
        >
          <UAvatar :src="item.image ?? undefined" :alt="item.title" icon="i-lucide-building-2" size="lg" />
          <span class="min-w-0">
            <span class="block truncate text-sm font-medium text-highlighted">{{ item.title }}</span>
            <span v-if="item.description" class="block truncate text-sm text-muted">{{ item.description }}</span>
          </span>
        </component>
      </template>
    </DashboardListEditor>
    <UButton v-if="!deletable.size" class="mt-6" color="neutral" variant="soft" icon="i-lucide-plus" :label="createAction.label" :to="createAction.to" />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import DashboardListEditor from '~/components/dashboard/DashboardListEditor.vue'
import { dashboardScopeHeaderModelKey } from '~/lib/components/workspace/dashboard/dashboardScopeHeaderContext'
import { useOrganizationDeletePermission } from '~/composables/useOrganizationDeletePermission'
import { organizationRoleLabel } from '~/utils/organization-access'
import { getVerticalLabel } from '~/utils/vertical-copy'

definePageMeta({ layout: 'dashboard' })

const level = useRouteLevel()
const model = inject(dashboardScopeHeaderModelKey)!
const editing = ref(false)
const organizations = computed(() => model.value.peers.filter((peer): peer is typeof peer & { id: string } => Boolean(peer.id)))
const { deletable, permissionError } = await useOrganizationDeletePermission(computed(() => organizations.value.map(organization => organization.id)))
// Each organization's mark, as Airbnb's listing rows carry their picture, and what it is to this account: `Vacation rental · Owner`.
type OrganizationMark = { id: string; image_url: string | null; vertical: string; role: string }
const isOrganizationList = (value: unknown): value is { organizations: OrganizationMark[] } => isRecord(value) && Array.isArray(value.organizations) && value.organizations.every(row => isRecord(row) && typeof row.id === 'string' && (row.image_url === null || typeof row.image_url === 'string') && typeof row.vertical === 'string' && typeof row.role === 'string')
const { data: marksData, error: marksError } = await useAsyncData('account-organizations', () => applicationFetch<{ organizations: OrganizationMark[] }>('/api/account/organizations', { validate: isOrganizationList }))
const marks = computed(() => new Map((marksData.value?.organizations ?? []).map(row => [row.id, row])))
const items = computed(() => organizations.value.map(organization => ({
  id: organization.id,
  title: organization.label,
  image: marks.value.get(organization.id)?.image_url ?? null,
  description: describe(marks.value.get(organization.id)),
  to: organization.to,
  select: () => organization.onSelect?.(),
  removable: deletable.value.has(organization.id),
})))
const createAction = computed(() => {
  const action = model.value.createAction
  if (!action) throw createError({ statusCode: 500, statusMessage: 'The dashboard scope offers no way to start an organization.' })
  return action
})

function describe(mark: OrganizationMark | undefined) {
  return mark ? `${getVerticalLabel(mark.vertical)} · ${organizationRoleLabel(mark.role)}` : null
}

type Row = (typeof items.value)[number]
function enter(row: Row) {
  if (!row.to && !editing.value) row.select()
}
async function startOrganization() {
  await navigateTo(createAction.value.to)
}
async function openDelete(row: Row) {
  await navigateTo(`${level.path.value}/${encodeURIComponent(row.id)}/delete`)
}
</script>
