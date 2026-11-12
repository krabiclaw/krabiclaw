<template>
  <DashboardIndexPanel id="organization-pages" title="Pages">
    <template #right>
      <UButton
        icon="i-lucide-plus"
        color="neutral"
        variant="soft"
        square
        aria-label="Add a page"
        :to="newPagePath"
      />
    </template>
    <TenantPageList />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import TenantPageList from '~/components/dashboard/TenantPageList.vue'

definePageMeta({ layout: 'dashboard' })

useSeoMeta({ title: 'Pages | KrabiClaw Dashboard', robots: 'noindex, nofollow' })

const level = useRouteLevel()
const newPagePath = computed(() => `${level.path.value}/new`)
</script>
