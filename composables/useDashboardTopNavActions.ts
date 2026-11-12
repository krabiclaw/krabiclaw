import type { MaybeRefOrGetter } from 'vue'

/**
 * Page-level controls in the dashboard header, beside the account avatar.
 *
 * A page cannot fill a slot on the header: the layout renders the header and
 * <NuxtPage> as siblings, so there is no parent-child line to pass one down.
 * A page registers here instead and the header renders what is registered,
 * which keeps the control's state and handler with the page that owns them.
 *
 * Registration is keyed and client-only. Keyed, because two pages briefly
 * overlap during a route change and an unkeyed list renders both — the second
 * registration of a key replaces the first rather than sitting next to it.
 * Client-only, because this module's state is shared by every request on the
 * server; the header renders it inside <ClientOnly> for the same reason.
 */
export interface DashboardTopNavAction {
  key: string
  icon: string
  ariaLabel: string
  /** Responsive visibility, e.g. 'lg:hidden' for a control the desktop layout already shows. */
  class?: string
  onSelect: () => void
}

const registered = shallowRef<DashboardTopNavAction[]>([])

/** Read side, for the header. */
export function useDashboardTopNavActions() {
  return readonly(registered)
}

/** Write side, for a page. Pass null to register nothing yet. */
export function useDashboardTopNavAction(action: MaybeRefOrGetter<DashboardTopNavAction | null>) {
  if (import.meta.server) return

  // Identity, not key: during a route change the arriving page can register
  // the same key before the leaving page disposes, and releasing by key would
  // delete the new page's action.
  let registeredAction: DashboardTopNavAction | null = null

  const release = () => {
    if (!registeredAction) return
    registered.value = registered.value.filter(entry => entry !== registeredAction)
    registeredAction = null
  }

  watch(() => toValue(action), (next) => {
    if (!next) {
      release()
      return
    }
    if (registeredAction && registeredAction.key !== next.key) release()
    registeredAction = next
    registered.value = [...registered.value.filter(entry => entry.key !== next.key), next]
  }, { immediate: true })

  onScopeDispose(release)
}
