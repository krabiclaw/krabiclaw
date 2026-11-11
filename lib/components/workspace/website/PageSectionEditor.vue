<template>
  <TenantPageBlockEditorPage
    :organization-id="organizationId"
    :page-id="pageId"
    :block-id="blockId"
  />
</template>

<script setup lang="ts">
import TenantPageBlockEditorPage from '~/components/dashboard/TenantPageBlockEditorPage.vue'

defineProps<{
  organizationId: string
  pageId: string
  blockId: string
}>()
</script>
