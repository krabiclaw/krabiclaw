<template>
  <!-- The team. Inviting someone is a leaf below. -->
  <DashboardIndexPanel id="organization-members" title="Team">
    <template #right>
      <UButton icon="i-lucide-plus" color="neutral" variant="soft" square class="rounded-full" aria-label="Invite a team member" :to="`${level.path.value}/invite`" />
    </template>
    <OrganizationMembersList />
    <UButton class="mt-8" color="neutral" variant="link" :to="`${level.path.value}/groups`">Booking teams</UButton>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import OrganizationMembersList from '~/components/dashboard/OrganizationMembersList.vue'

definePageMeta({ layout: 'dashboard', tab: 'menu', back: 'menu' })

const level = useRouteLevel()

useSeoMeta({ title: 'Team | KrabiClaw Dashboard', robots: 'noindex, nofollow' })
</script>
