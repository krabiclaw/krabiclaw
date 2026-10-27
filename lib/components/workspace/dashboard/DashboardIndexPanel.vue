<template>
  <UDashboardPanel
    :id="id"
    data-dashboard-index
    :class="level.mode.value === 'yield' ? 'hidden' : undefined"
    :data-yield="level.mode.value === 'yield' ? '' : undefined"
    :default-size="pair ? (pairedSize ?? 50) : undefined"
    :ui="panelUi"
  >
    <template #header>
      <!--
        One row heads every level, as Airbnb's do: Back when there is somewhere
        to go back to, the title, and what you can do to the level on the right.
        On a phone a pushed level's title starts the next line, under Back; from
        lg Back sits beside it. A control that names what the whole level shows —
        Today's range — takes the title's place, and the title is announced only.
      -->
      <div class="shrink-0 items-center gap-x-3" :class="[dashboardGutterClass, column === 'record' ? 'grid min-h-16 grid-cols-[2.5rem_minmax(0,1fr)_2.5rem] py-3' : 'flex flex-wrap gap-y-4 pb-2 pt-4 sm:pt-6']">
        <slot name="leading"><DashboardNavbarLeading v-if="column !== 'record'" /></slot>
        <div v-if="$slots.center" class="flex min-w-0 flex-1 items-center">
          <h1 class="sr-only">{{ title }}</h1>
          <slot name="center" />
        </div>
        <div v-else class="min-w-0" :class="column === 'record' ? 'col-start-2 row-start-1 text-center' : ['flex-1', level.to.value ? 'max-lg:order-last max-lg:basis-full' : undefined]">
          <h1 :class="column === 'record' ? 'text-base font-semibold text-highlighted' : dashboardTitleClass">{{ title }}</h1>
          <p v-if="lead" class="mt-2 text-base text-muted">{{ lead }}</p>
        </div>
        <!-- Every action is the same round 40px button, whatever size a page asked for. A list editor's controls land in the span (dashboardPanelActionsKey). -->
        <div class="flex shrink-0 items-center gap-2 [&_[data-slot=base]]:h-10 [&_[data-slot=base]]:min-w-10 [&_[data-slot=base]]:justify-center [&_[data-slot=base]]:rounded-full" :class="column === 'record' ? 'col-start-3 row-start-1 justify-end' : 'ms-auto'">
          <slot name="right" />
          <span :id="actionsId" class="flex items-center gap-2 empty:hidden" />
        </div>
      </div>
    </template>

    <template #body>
      <!-- Alone it uses the frame, as Airbnb's listing grid does; beside a child it is a column. -->
      <div class="w-full" :class="[width, column === 'record' && $slots.footer ? 'pb-28' : undefined, fill ? 'flex min-h-0 flex-1 flex-col' : undefined]">
        <slot />
      </div>
    </template>

    <!-- A list whose order is itself a draft — sections, links — commits from here. -->
    <template v-if="$slots.footer" #footer>
      <div class="shrink-0" :class="[dashboardGutterClass, footerClass ?? (column === 'record' ? 'pointer-events-none absolute inset-x-0 bottom-10 z-10' : 'border-t border-default py-3')]">
        <div class="w-full" :class="width">
          <slot name="footer" />
        </div>
      </div>
    </template>
  </UDashboardPanel>

  <NuxtPage />
</template>

<script setup lang="ts">
/*
  An index: a level whose rows link to its children. It is the whole screen
  with nothing open, the left column once a child is, and it steps aside when a
  grandchild owns both columns — Nuxt UI's own two-panel idiom, decided here
  from the route tree so no page carries a breakpoint.

  Pairing and auto-selection are separate. Beside its parent the index is a
  column because the route tree nests it there, whatever its rows are.
  `autoOpen` only answers whether it may choose one of its own children on
  arrival: an index of deterministic settings or fields names its first one, the
  way a listing editor lands on its first section; a list of records names none.
  Below the pane width the index is the screen and nothing is chosen for the
  tenant — except a record being made (`create`), which opens its first step at
  every width. `replace`, so Back still leaves the index. A level in a mode named by
  its URL's `editMode`, such as its translations, is that mode's screen, and
  choosing a child would leave the mode; it opens one when the mode closes.
*/
import type { RouteLocationRaw } from 'vue-router'
import { dashboardColumnWidths, dashboardPanelActionsKey, dashboardLeafParentKey, dashboardGutterClass, dashboardTitleClass, type DashboardColumn } from './dashboardPanelContext'

const props = defineProps<{
  id: string
  title: string
  autoOpen?: RouteLocationRaw | null
  /**
   * A record being made: its first step, opened on arrival at every width, as
   * Airbnb's flows open on their first question. Dismissing a step leaves the
   * making for where Back goes; the list behind it is never a stop.
   */
  create?: RouteLocationRaw | null
  /** The level is exactly the panel's height and scrolls inside itself, padding its own rows with the gutter: a conversation with its composer at the foot. */
  fill?: boolean
  /** The level is a column at every width rather than the frame: a menu, a statement, a calendar. */
  column?: DashboardColumn
  /** Native DashboardPanel percentage when this index sits beside its child. */
  pairedSize?: number
  /** The record's persistent action may float over its scrollable summaries. */
  footerClass?: string
  /** The level's one muted sentence under its title, as a leaf's `lead`. */
  lead?: string
}>()

const level = useRouteLevel()
// A level that scrolls itself pads its own rows, so the body gives up its padding.
const panelUi = computed((): { body?: string } => {
  const fill: boolean = props.fill
  if (props.column === 'record') return { body: 'p-6 sm:p-6' }
  return { body: fill ? 'p-0 sm:p-0 gap-0' : undefined }
})
const pair = computed(() => level.mode.value === 'pair')
// Paired panels own their width; an explicit column caps a standalone screen.
const width = computed((): string | undefined => {
  const column: DashboardColumn | undefined = props.column
  if (pair.value && column !== 'record') return undefined
  return column ? dashboardColumnWidths[column] : undefined
})
// Read through the instance: vue-tsc cannot type `props.id` here (TS2590), and the id is a plain string.
const instance = getCurrentInstance()
provide(dashboardLeafParentKey, {
  focus: () => {
    const heading = document.getElementById(`dashboard-panel-${String(instance?.props.id ?? '')}`)?.querySelector<HTMLElement>('h1')
    if (heading) {
      heading.tabIndex = -1
      heading.focus({ preventScroll: true })
    }
  },
  exit: () => (instance?.props.create ? level.to.value : null),
})
// Not prefixed `dashboard-panel-`: that prefix names panes, and this is a slot inside one.
const actionsId = computed(() => `${String(instance?.props.id ?? '')}-list-actions`)
provide(dashboardPanelActionsKey, actionsId)

const pane = useDashboardPane()
const route = useRoute()
const router = useRouter()
const scope = getCurrentScope()
if (!scope) throw createError({ statusCode: 500, statusMessage: 'Dashboard pane scope is unavailable.', fatal: true })
// Every arrival at the bare index opens the child again — Back from deeper
// included. Opening it makes this level a pair, which is what stops the watch.
// Initial auto-navigation waits for Nuxt to finish hydrating the route's panes.
onNuxtReady(() => {
  if (!scope.active) return
  scope.run(() => {
    // A record being made opens its step at every width; any other index chooses only beside its child.
    watch((): [RouteLocationRaw | null | undefined, boolean, RouteLevelMode, unknown, string] => [props.create ?? (pane.value ? props.autoOpen : null), pane.value, level.mode.value, route.query.editMode, route.fullPath], ([target, , mode, editMode]) => {
      if (!target || mode !== 'index' || editMode) return
      // Only an arrival opens a child: the router is at this index's own URL.
      // An index on its way out still reads the route it rendered for, which
      // may be its bare URL; opening from there pulled the tenant back into the
      // screen they had just left.
      // A query change can select another tab or scope at this same path;
      // wait for Nuxt's rendered route before opening that context's rows.
      if (router.currentRoute.value.path !== level.path.value || router.currentRoute.value.fullPath !== route.fullPath) return
      // An index whose rows are still loading offers itself as the first row; its own URL opens nothing.
      if (router.resolve(target).path === level.path.value) return
      void navigateTo(target, { replace: true })
    // The parent derives autoOpen from this route's tab and scope. Wait for
    // those props to render before choosing a row from the arriving index.
    }, { immediate: true, flush: 'post' })
  })
})
</script>
