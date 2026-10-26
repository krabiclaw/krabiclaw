import type { ComputedRef, InjectionKey } from 'vue'

/**
 * The widths an explicitly standalone level may take instead of the frame.
 * A page names which one it is and never a size: a single-concern screen, or a
 * list of records read top to bottom. Paired panels use their full inner width.
 * A grid, a table, a calendar or a chart names none and takes the frame, as
 * Airbnb's listings, calendar and insights do.
 *
 * Editing content starts at the panel's gutter, the same edge as the top nav.
 * A record summary centres its bounded column inside its own pane. Below `lg`
 * a level is the whole screen or a drawer and
 * uses all of it; from `lg` a standalone column stops a line running on.
 */
export const dashboardColumnWidths = {
  leaf: 'lg:max-w-xl',
  reading: 'lg:max-w-3xl',
  record: 'lg:mx-auto lg:max-w-xl',
} as const

export type DashboardColumn = keyof typeof dashboardColumnWidths

/**
 * Nuxt UI's panel gutter, which its navbar and body already use and the top
 * nav matches. A panel's footer sits inside it, and a level that scrolls itself
 * (`fill`) pads its own rows with it.
 */
export const dashboardGutterClass = 'px-4 sm:px-6'

/** A level's one title, as every leaf, column index and tab root heads its body. */
export const dashboardTitleClass = 'text-2xl font-semibold text-highlighted lg:text-[32px] lg:leading-tight'

/**
 * The id of the element in an index panel's navbar that holds the list's
 * controls. One rule for every list screen: the navbar carries Back, the
 * title, and what you can do to the list — Edit, Add — and the body carries
 * the list itself. A list editor mounted inside an index panel teleports its
 * controls here; one mounted anywhere else keeps them inline.
 */
export const dashboardPanelActionsKey: InjectionKey<ComputedRef<string>> = Symbol('dashboard-panel-actions')

/**
 * The nearest index stays behind a leaf drawer and receives focus on return.
 * An index making a record names `exit`: dismissing one of its steps leaves the
 * making, for where the index's own Back goes, rather than returning to it.
 */
export const dashboardLeafParentKey: InjectionKey<{ focus: () => void; exit: () => string | null }> = Symbol('dashboard-leaf-parent')

/** An owning ancestor's fullscreen overlay keeps focus while its leaf retains its draft. */
export const dashboardOverlayOpenKey: InjectionKey<ComputedRef<boolean>> = Symbol('dashboard-overlay-open')
