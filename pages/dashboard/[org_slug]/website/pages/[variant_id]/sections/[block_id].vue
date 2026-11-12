<template>
  <TenantPageBlockEditorPage :organization-id="organizationId" :page-id="pageId" :block-id="blockId" />
</template>

<script setup lang="ts">
import { useTenantPageId } from '~/components/dashboard/TenantPageEditorPage.vue'
import TenantPageBlockEditorPage from '~/components/dashboard/TenantPageBlockEditorPage.vue'

definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const pageId = useTenantPageId()
const blockId = computed(() => String(route.params.block_id ?? ''))
const organizationId = useDashboardOrganizationId()
</script>
