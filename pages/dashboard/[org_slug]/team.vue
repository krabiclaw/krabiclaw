<template>
  <!-- The team. Inviting someone is a leaf below. -->
  <DashboardIndexPanel id="organization-members" title="Team">
    <OrganizationMembersList />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import OrganizationMembersList from '~/components/dashboard/OrganizationMembersList.vue'

definePageMeta({ layout: 'dashboard', tab: 'menu', back: 'menu' })

useSeoMeta({ title: 'Team | KrabiClaw Dashboard', robots: 'noindex, nofollow' })
</script>
