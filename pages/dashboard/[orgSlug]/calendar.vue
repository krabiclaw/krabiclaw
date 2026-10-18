<template>
  <DashboardIndexPanel v-if="scopeError" id="night-calendar-error" title="Calendar">
    <UAlert color="error" variant="soft" title="The home could not be loaded" :description="scopeError" />
  </DashboardIndexPanel>
  <StayNightCalendar
    v-else-if="hasProductScope"
    :key="productId!"
    :product-id="productId!"
    :homes="homes?.homes ?? []"
    :manage="homes?.manage ?? false"
    :home-error="homesError ? getErrorMessage(homesError, 'The places to stay could not be loaded') : ''"
  />
  <CalendarPage v-else :nightly-homes="homes?.homes ?? []" :nightly-error="homesError ? getErrorMessage(homesError, 'The places to stay could not be loaded') : ''" />
</template>

<script setup lang="ts">
import CalendarPage from '~/components/dashboard/CalendarPage.vue'
import StayNightCalendar from '~/components/dashboard/StayNightCalendar.vue'
import type { StayHome } from '~/server/domain/stays'
import { getErrorMessage } from '~/utils/errors'
import { isValidTimezone } from '~/utils/timezone'

definePageMeta({ layout: 'dashboard', tab: 'calendar' })

const route = useRoute()
const api = useDashboardApi()
const hasProductScope = computed(() => Object.hasOwn(route.query, 'product_id'))
const productId = computed(() => typeof route.query.product_id === 'string' && route.query.product_id.trim() ? route.query.product_id : null)
const scopeError = computed(() => hasProductScope.value && !productId.value ? 'Choose a place to stay with one non-empty product_id.' : '')
type Homes = { homes: Pick<StayHome, 'product_id' | 'name' | 'timezone'>[]; manage: boolean }
const isHomes = (value: unknown): value is Homes => isRecord(value) && typeof value.manage === 'boolean' && Array.isArray(value.homes)
  && value.homes.every(home => isRecord(home) && typeof home.product_id === 'string' && typeof home.name === 'string' && typeof home.timezone === 'string' && isValidTimezone(home.timezone))
const { data: homes, error: homesError } = await useAsyncData(
  () => `calendar-homes:${String(route.params.orgSlug)}`,
  () => api('/api/dashboard/stay-homes', { validate: isHomes }),
)
</script>
