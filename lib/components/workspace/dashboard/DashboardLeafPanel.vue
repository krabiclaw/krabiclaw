<template>
  <UDrawer
    v-if="!pane"
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
    @update:open="updateDrawer"
    @animation-end="finishAnimation"
  >
    <template #content>
      <div ref="drawerTarget" class="flex min-h-0 flex-1 flex-col" />
    </template>
  </UDrawer>

  <!-- Moving the panel preserves its fields, form state and draft across lg. -->
  <Teleport :to="drawerTarget ?? 'body'" :disabled="pane || !drawerTarget">
  <UDashboardPanel :id="id" :class="!pane && !drawerTarget ? 'invisible' : undefined" :ui="{ root: 'min-h-0 lg:min-h-full pb-[env(safe-area-inset-bottom)] lg:pb-0' }">
    <template #header>
      <!--
        Below lg the leaf is a sheet, as Airbnb's field sheets are: ✕, its title
        small and centred, an action on the right. Beside its index it is a pane:
        the title large, as every level's, and nothing to close.
      -->
      <div class="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 pb-2 pt-4 sm:pt-6 lg:flex" :class="dashboardGutterClass">
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
        <h1 class="flex min-w-0 items-center justify-center gap-3 truncate text-base font-semibold text-highlighted lg:flex-1 lg:justify-start lg:text-[32px] lg:leading-tight">
          <UIcon v-if="icon" :name="icon" class="size-5 shrink-0 lg:size-8" />
          {{ title }}
        </h1>
        <!-- An action that belongs to the whole leaf — adding a domain — is a round button beside the title. -->
        <div class="flex items-center justify-self-end gap-2 [&_[data-slot=base]]:h-10 [&_[data-slot=base]]:min-w-10 [&_[data-slot=base]]:justify-center [&_[data-slot=base]]:rounded-full">
          <slot name="right" />
        </div>
      </div>
    </template>

    <template #body>
      <!-- One column width for every leaf: fields do not stretch to the pane. -->
      <div class="w-full" :class="dashboardColumnWidths.leaf">
        <!-- The one place a leaf explains itself. A field never carries a sentence. -->
        <p v-if="lead" class="mb-8 text-base text-muted">{{ lead }}</p>

        <UAlert
          v-if="error || dismissError"
          class="mb-6"
          color="error"
          variant="soft"
          icon="i-lucide-triangle-alert"
          :description="dismissError || error"
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
import { isNavigationFailure } from 'vue-router'
import { dashboardColumnWidths, dashboardGutterClass, dashboardLeafParentKey } from './dashboardPanelContext'
import { getErrorMessage } from '~/utils/errors'

/*
  A leaf: one thing, its own column, Cancel and Save in the panel's footer —
  Airbnb's editor-leaf shape, and below lg a drawer over the list it
  came from. Every leaf in the dashboard is this component with a field in the
  slot, so the header, the error and the footer are written
  once rather than re-drawn per screen.

  Cancel is the leaf's own Back: a push to the level that contains it, which is
  the route record above this one — or, for a step of a record being made,
  where that record's index goes Back to, so the making is left whole.

  Beside its index — two columns, `lg` — the leaf has no Close and no Cancel:
  the index's Back is the way out and Save is the only control, which is what
  Airbnb's editor does at its two-column width (measured 2026-09-21). Both
  exist only where the leaf is a sheet covering the list it came from.
*/
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
}>(), { saving: false, disabled: false, error: '', saveLabel: 'Save', footer: true })

const emit = defineEmits<{ save: []; cancel: [] }>()

const level = useRouteLevel()
const router = useRouter()
const pane = useDashboardPane()
const drawerOpen = ref(true)
const drawerTarget = useTemplateRef<HTMLDivElement>('drawerTarget')
const closeButton = useTemplateRef('closeButton')
const dismissError = ref('')
let dismissal: { from: string; to: string } | null = null

// Only the nearest index is the backdrop; other route ancestors keep yielding.
const parent = inject(dashboardLeafParentKey, null)
const invoker = import.meta.client && document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null

watch(drawerTarget, async (target) => {
  if (!target) return
  await nextTick()
  if (!pane.value && drawerOpen.value) closeButton.value?.$el.focus({ preventScroll: true })
})

// Every dismissal discards the parent's retained draft, then follows the same
// route parent as Cancel. Save keeps the behavior defined by the owning editor.
function cancel() {
  if (props.saving || dismissal) return
  dismissal = { from: router.currentRoute.value.fullPath, to: parent?.exit() ?? level.to.value ?? '/dashboard' }
  dismissError.value = ''
  emit('cancel')
  if (pane.value) return finishDismissal()
  drawerOpen.value = false
}

function updateDrawer(open: boolean) {
  if (!open) void cancel()
}

function finishAnimation(open: boolean) {
  if (!open) void finishDismissal()
}

async function finishDismissal() {
  const pending = dismissal
  dismissal = null
  if (!pending || router.currentRoute.value.fullPath !== pending.from) return
  try {
    const result = await navigateTo(pending.to)
    if (isNavigationFailure(result)) throw result
    await nextTick()
    if (invoker?.isConnected) invoker.focus({ preventScroll: true })
    if (document.activeElement !== invoker) parent?.focus()
  } catch (error) {
    dismissError.value = getErrorMessage(error, 'The editor could not be closed')
    drawerOpen.value = true
  }
}

// A resize moves the existing editor. Complete an already requested dismissal
// before its drawer disappears, and ignore its later animation callback.
watch(pane, (wide) => {
  if (wide && dismissal) void finishDismissal()
  drawerOpen.value = true
})
</script>
