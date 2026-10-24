<template>
  <DashboardListEditor
    read-only
    title="Reviews"
    :items="listItems"
    :error="error ? getErrorMessage(error, 'Reviews request failed') : null"
    empty-title="No reviews yet"
    empty-icon="i-lucide-star"
  >
    <template #item="{ item }">
      <div class="flex flex-wrap items-center gap-2">
        <strong class="text-sm text-highlighted">{{ item.row.author_name }}</strong>
        <UBadge color="warning" variant="soft">{{ item.row.rating }} stars</UBadge>
        <UBadge :color="STATUS_COLORS[item.row.status]" variant="soft">{{ REVIEW_STATUS_LABELS[item.row.status] }}</UBadge>
        <UBadge v-if="item.row.collection_method !== null && item.row.collection_method !== 'migration'" color="neutral" variant="subtle">{{ COLLECTION_METHOD_LABELS[item.row.collection_method] }}</UBadge>
      </div>
      <p v-if="item.row.title" class="mt-2 text-sm font-semibold text-highlighted">{{ item.row.title }}</p>
      <p class="mt-1 line-clamp-2 text-sm text-muted">{{ item.row.content }}</p>
    </template>
  </DashboardListEditor>
</template>

<script setup lang="ts">
import DashboardListEditor from '~/components/dashboard/DashboardListEditor.vue'
import { getErrorMessage } from '~/utils/errors'
import {
  COLLECTION_METHOD_LABELS,
  REVIEW_STATUS_LABELS,
  isTestimonialsResponse,
  type OrganizationTestimonial,
  type TestimonialStatus,
} from '~/utils/testimonials'

/** Set when this list is a location's reviews rather than the site's. */
// The location the URL scopes this to with `?location_id=`, or none for the whole site.
const locationScope = useLocationScope()
const route = useRoute()
const router = useRouter()

const STATUS_COLORS: Record<TestimonialStatus, 'warning' | 'success' | 'neutral'> = { pending: 'warning', approved: 'success', rejected: 'neutral' }

const dashboardApi = useDashboardApi()
const level = useRouteLevel()
const organizationId = await useDashboardOrganizationId()

const { data, error } = await useAsyncData(
  () => locationScope.value ? `dashboard-location-reviews-${organizationId}-${locationScope.value}` : `dashboard-organization-reviews-${organizationId}`,
  () => dashboardApi<{ reviews: OrganizationTestimonial[] }>(
    `/api/editor/organizations/${organizationId}/reviews`,
    { query: locationScope.value ? { location_id: locationScope.value } : undefined, validate: isTestimonialsResponse },
  ),
)

const testimonials = computed(() => data.value?.reviews ?? [])
// A review is a record, so its row links to its own level, as a question's does.
const listItems = computed(() => testimonials.value.map(row => ({ id: row.id, title: row.author_name, to: router.resolve({ path: `${level.path.value}/reviews/${row.id}`, query: route.query }).fullPath, row })))
</script>
