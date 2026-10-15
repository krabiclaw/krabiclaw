import type { ComputedRef, InjectionKey, Ref } from 'vue'

/**
 * The widths a level's content may take instead of the frame. A page names
 * which one it is and never a size: a leaf and anything edited like one, a page
 * read top to bottom, and a grid that needs the room.
 */
export const dashboardColumnWidths = {
  leaf: 'max-w-xl',
  reading: 'max-w-3xl',
  wide: 'max-w-5xl'
} as const

export type DashboardColumn = keyof typeof dashboardColumnWidths

/**
 * The id of the element in an index panel's navbar that holds the list's
 * controls. One rule for every list screen: the navbar carries Back, the
 * title, and what you can do to the list — Edit, Add — and the body carries
 * the list itself. A list editor mounted inside an index panel teleports its
 * controls here; one mounted anywhere else keeps them inline.
 */
export const dashboardPanelActionsKey: InjectionKey<ComputedRef<string>> = Symbol('dashboard-panel-actions')

/** The nearest index stays behind a leaf drawer and receives focus on return. */
export const dashboardLeafParentKey: InjectionKey<{ leaves: Ref<number>; focus: () => void }> = Symbol('dashboard-leaf-parent')
