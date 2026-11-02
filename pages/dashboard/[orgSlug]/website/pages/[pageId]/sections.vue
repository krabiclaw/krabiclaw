<template>
  <TenantPageSections :organization-id="organizationId" :page-id="pageId" />
</template>

<script setup lang="ts">
import { useTenantPageId } from '~/components/dashboard/TenantPageEditorPage.vue'
import TenantPageSections from '~/components/dashboard/TenantPageSections.vue'

definePageMeta({ layout: 'dashboard' })

const pageId = useTenantPageId()
const organizationId = useDashboardOrganizationId()
</script>
