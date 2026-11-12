<template>
  <ProductEditorPage v-if="setup?.step" :practice-area-setup="setup.step" />
</template>

<script setup lang="ts">
import ProductEditorPage from '~/components/dashboard/ProductEditorPage.vue'
import type { FirstPracticeAreaSetup } from '~/server/api/dashboard/onboarding/first-practice-area.get'

definePageMeta({ layout: 'dashboard', tabs: false, key: route => route.path })

const api = useDashboardApi()
const { data: setup, error } = await useAsyncData(() => api('/api/dashboard/onboarding/first-practice-area', {
  validate: (value): value is FirstPracticeAreaSetup => {
    if (!isRecord(value)) return false
    if (typeof value.catalog_url === 'string') return true
    const step = value.step
    return isRecord(step) && typeof step.max_length === 'number'
      && ['title', 'detail', 'name_label', 'next_label', 'back_label', 'exit_label', 'today_url', 'continue_url'].every(key => typeof step[key] === 'string')
  },
}))

if (error.value) throw error.value
if (!setup.value) throw createError({ statusCode: 502, statusMessage: 'Practice area setup could not be loaded' })
if (setup.value.catalog_url) await navigateTo(setup.value.catalog_url, { replace: true })
</script>
