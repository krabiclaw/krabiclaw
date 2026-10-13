<template>
  <UDashboardPanel
    :id="id"
    :class="level.mode.value === 'yield' ? 'hidden' : pair ? 'hidden lg:flex' : undefined"
    :data-yield="level.mode.value === 'yield' ? '' : undefined"
    :default-size="pair ? 50 : undefined"
    :ui="ui"
  >
    <template #header>
      <UDashboardNavbar :title="column ? undefined : title" :toggle="false" :ui="navbarUi">
        <template #leading>
          <DashboardNavbarLeading />
        </template>
        <!-- A control that names what the whole level is showing — Today's range — belongs beside the title, not in the body. -->
        <template v-if="$slots.center" #default>
          <slot name="center" />
        </template>
        <!-- The list's controls land here (dashboardPanelActionsKey), after whatever the page itself puts on the right. -->
        <template #right>
          <slot name="right" />
          <span :id="actionsId" class="flex items-center gap-1.5 empty:hidden" />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <!-- Alone it uses the frame, as Airbnb's listing grid does; beside a child it is a column. -->
      <div class="mx-auto w-full" :class="[column ? 'max-w-xl' : pair ? 'max-w-2xl' : undefined, fill ? 'flex min-h-0 flex-1 flex-col' : undefined]">
        <!-- A column's title heads the column, as a leaf's does, so the two start on one line. -->
        <template v-if="column">
          <h1 class="text-2xl font-semibold text-highlighted lg:text-[32px] lg:leading-tight">{{ title }}</h1>
          <p v-if="lead" class="mt-2 text-base text-muted">{{ lead }}</p>
          <div class="mt-8">
            <slot />
          </div>
        </template>
        <slot v-else />
      </div>
    </template>

    <!-- A list whose order is itself a draft — sections, links — commits from here. -->
    <template v-if="$slots.footer" #footer>
      <slot name="footer" />
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
  tenant. `replace`, so Back still leaves the index. A level in a mode named by
  its URL's `editMode`, such as its translations, is that mode's screen, and
  choosing a child would leave the mode; it opens one when the mode closes.
*/
import type { RouteLocationRaw } from 'vue-router'
import { dashboardPanelActionsKey } from './dashboardPanelContext'

const props = defineProps<{
  id: string
  title: string
  autoOpen?: RouteLocationRaw | null
  ui?: { root?: string; body?: string }
  /** For a level whose navbar carries its own control, such as Today's range. */
  navbarUi?: Record<string, string>
  /** The level is exactly the panel's height and scrolls inside itself: a conversation with its composer at the foot. */
  fill?: boolean
  /** The level keeps a leaf's column at every width — a menu, the catalog's entries — rather than using the frame. */
  column?: boolean
  /** A column's one muted sentence under its title, as a leaf's `lead`. */
  lead?: string
}>()

const level = useRouteLevel()
const pair = computed(() => level.mode.value === 'pair')
// Read through the instance: vue-tsc cannot type `props.id` here (TS2590), and the id is a plain string.
const instance = getCurrentInstance()
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
    watch((): [RouteLocationRaw | null | undefined, boolean, RouteLevelMode, unknown] => [props.autoOpen, pane.value, level.mode.value, route.query.editMode], ([target, wide, mode, editMode]) => {
      if (!target || !wide || mode !== 'index' || editMode) return
      // Only an arrival opens a child: the router is at this index's own URL.
      // An index on its way out still reads the route it rendered for, which
      // may be its bare URL; opening from there pulled the tenant back into the
      // screen they had just left.
      if (router.currentRoute.value.path !== level.path.value) return
      // An index whose rows are still loading offers itself as the first row; its own URL opens nothing.
      if (router.resolve(target).path === level.path.value) return
      void navigateTo(target, { replace: true })
    }, { immediate: true })
  })
})
</script>
