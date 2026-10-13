<template>
  <UDashboardPanel :id="id">
    <template #header>
      <!-- The bar carries only the way out; the title is the leaf's own, in the body. -->
      <UDashboardNavbar :toggle="false">
        <template #left>
          <UButton
            icon="i-lucide-x"
            aria-label="Close"
            color="neutral"
            variant="ghost"
            size="sm"
            square
            class="min-w-0 shrink-0 lg:hidden"
            data-testid="dashboard-navbar-close"
            :to="level.to.value ?? undefined"
          />
        </template>
        <!-- An action that belongs to the whole leaf — adding a domain — sits in the bar. -->
        <template v-if="$slots.right" #right>
          <slot name="right" />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <!-- One column width for every leaf: fields do not stretch to the pane. -->
      <div class="mx-auto w-full" :class="dashboardColumnWidths.leaf">
        <h1 class="flex items-center gap-3 text-2xl font-semibold text-highlighted lg:text-[32px] lg:leading-tight">
          <UIcon v-if="icon" :name="icon" class="size-8 shrink-0" />
          {{ title }}
        </h1>
        <!-- The one place a leaf explains itself. A field never carries a sentence. -->
        <p v-if="lead" class="mt-2 text-base text-muted">{{ lead }}</p>

        <UAlert
          v-if="error"
          class="mt-6"
          color="error"
          variant="soft"
          icon="i-lucide-triangle-alert"
          :description="error"
        />

        <div class="mt-8">
          <slot />
        </div>
      </div>
    </template>

    <!-- A leaf whose controls act at once — connect, schedule, publish — has nothing to Save. -->
    <template v-if="footer" #footer>
      <DashboardPanelFooter
        :save-label="saveLabel"
        :loading="saving"
        :disabled="disabled"
        leaf
        @cancel="cancel"
        @save="$emit('save')"
      />
    </template>
  </UDashboardPanel>
</template>

<script setup lang="ts">
import { dashboardColumnWidths } from './dashboardPanelContext'

/*
  A leaf: one thing, its own column, Cancel and Save in the panel's footer —
  Airbnb's editor-leaf shape, and on a phone the sheet that covers the list it
  came from. Every leaf in the dashboard is this component with a field in the
  slot, so the header, the error and the footer are written
  once rather than re-drawn per screen.

  Cancel is the leaf's own Back: a push to the level that contains it, which is
  the route record above this one.

  Beside its index — two columns, `lg` — the leaf has no Close and no Cancel:
  the index's Back is the way out and Save is the only control, which is what
  Airbnb's editor does at its two-column width (measured 2026-09-21). Both
  exist only where the leaf is a sheet covering the list it came from.
*/
withDefaults(defineProps<{
  id: string
  title: string
  /** A mark beside the title, for a leaf known by a logo. */
  icon?: string
  /** One muted sentence under the title: the only explanation a leaf carries. */
  lead?: string
  saving?: boolean
  disabled?: boolean
  error?: string
  saveLabel?: string | null
  /** Off for a leaf whose controls act at once and has nothing to Save. */
  footer?: boolean
}>(), { saving: false, disabled: false, error: '', saveLabel: 'Save', footer: true })

const emit = defineEmits<{ save: []; cancel: [] }>()

// Cancel is this leaf's Back: a push to the level that contains it. A leaf that
// holds a draft of its own listens for the event to discard it first.
const level = useRouteLevel()
function cancel() {
  emit('cancel')
  return navigateTo(level.to.value ?? '/dashboard')
}
</script>
