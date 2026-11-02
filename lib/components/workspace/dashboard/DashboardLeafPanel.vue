<template>
  <UDrawer
    v-if="!pane && !overlayOpen"
    :open="drawerOpen"
    :title="title"
    :description="lead"
    :dismissible="!saving"
    no-body-styles
    handle-only
    :ui="{
      overlay: 'bg-black/40',
      content: 'h-[calc(100dvh-6rem)] max-h-[calc(100dvh-6rem)] rounded-t-2xl overflow-hidden',
    }"
    @update:open="(open) => { if (!open) cancel() }"
  >
    <template #content>
      <div ref="drawerTarget" class="flex min-h-0 flex-1 flex-col" />
    </template>
  </UDrawer>

  <!-- Moving the panel preserves its fields, form state and draft across lg. -->
  <Teleport :to="drawerTarget ?? pendingDrawerTarget" :disabled="pane">
  <UDashboardPanel :id="id" :class="!pane && !drawerTarget ? 'invisible' : undefined" :ui="{ root: 'min-h-0 lg:min-h-full pb-[env(safe-area-inset-bottom)] lg:pb-0' }">
    <template #header>
      <!--
        Below lg the leaf is a sheet, as Airbnb's field sheets are: ✕, its title
        small and centred, an action on the right. Beside its index it is a pane:
        the title large, as every level's, and nothing to close.
      -->
      <div class="grid shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 pb-2 pt-4 sm:pt-6 lg:flex" :class="dashboardGutterClass">
        <UButton
          ref="closeButton"
          icon="i-lucide-x"
          aria-label="Close"
          color="neutral"
          variant="soft"
          square
          class="size-10 justify-center justify-self-start rounded-full lg:hidden"
          data-testid="dashboard-navbar-close"
          :to="level.to.value ?? undefined"
          :disabled="saving"
          @click.prevent="cancel"
        />
        <!-- The sheet's title is small and centred; the pane's is every level's (dashboardTitleClass at lg). -->
        <h1 class="flex min-w-0 items-center justify-center gap-3 text-center text-base font-semibold text-highlighted lg:flex-1 lg:justify-start lg:text-start lg:text-[32px] lg:leading-tight">
          <UIcon v-if="icon" :name="icon" class="size-5 shrink-0 lg:size-8" />
          <span class="min-w-0 break-words">{{ title }}</span>
        </h1>
        <!-- An action that belongs to the whole leaf — adding a domain — is a round button beside the title. -->
        <div class="flex items-center justify-self-end gap-2 [&_[data-slot=base]]:h-10 [&_[data-slot=base]]:min-w-10 [&_[data-slot=base]]:justify-center [&_[data-slot=base]]:rounded-full">
          <slot name="right" />
        </div>
      </div>
    </template>

    <template #body>
      <!-- The panel owns the column; fields use its full inner gutter width. -->
      <div class="w-full">
        <!-- The one place a leaf explains itself. A field never carries a sentence. -->
        <p v-if="lead" class="mb-8 text-base text-muted">{{ lead }}</p>

        <UAlert
          v-if="error"
          class="mb-6"
          color="error"
          variant="soft"
          icon="i-lucide-triangle-alert"
          :description="error"
        />

        <slot />
      </div>
    </template>

    <!-- A leaf whose controls act at once — connect, schedule, publish — has nothing to Save. -->
    <template v-if="footer" #footer>
      <div class="shrink-0 border-t border-default py-3" :class="dashboardGutterClass">
        <DashboardPanelFooter
          :save-label="saveLabel"
          :loading="saving"
          :disabled="disabled"
          :desktop-cancel="desktopCancel"
          leaf
          @cancel="cancel"
          @save="$emit('save')"
        />
      </div>
    </template>
  </UDashboardPanel>
  </Teleport>
</template>

<script setup lang="ts">
import { dashboardGutterClass, dashboardLeafParentKey, dashboardOverlayOpenKey } from './dashboardPanelContext'

const props = withDefaults(defineProps<{
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
  /** Keep the explicit Cancel action beside a focused lodging editor. */
  desktopCancel?: boolean
}>(), { saving: false, disabled: false, error: '', saveLabel: 'Save', footer: true })

const emit = defineEmits<{ save: []; cancel: [] }>()

const router = useRouter()
const level = useRouteLevel()
const pane = useDashboardPane()
const overlayOpen = inject(dashboardOverlayOpenKey, null)
const drawerOpen = ref(true)
const drawerTarget = useTemplateRef<HTMLDivElement>('drawerTarget')
const pendingDrawerTarget = import.meta.client ? document.createElement('div') : 'body'
const parent = inject(dashboardLeafParentKey, null)
let cancelled = false

function cancel() {
  if (props.saving || cancelled) return
  cancelled = true
  emit('cancel')
  drawerOpen.value = false
  const exitTo = parent?.exit()
  if (exitTo) {
    const historyBack = import.meta.client ? window.history.state?.back : null
    const target = router.resolve(exitTo).fullPath
    if (typeof historyBack === 'string' && router.resolve(historyBack).fullPath === target) {
      router.back()
    } else {
      void navigateTo(exitTo, { replace: true })
    }
  } else {
    level.close()
  }
}

// Discard unsaved changes when navigating away without an explicit dismissal (e.g. Android back gesture).
onBeforeUnmount(() => {
  if (!props.saving && !cancelled) {
    emit('cancel')
  }
})
</script>
