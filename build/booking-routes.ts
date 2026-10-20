// A booking opens under Today or its calendar day; a home's occupied night
// opens its stay directly under Calendar. Back is read from the route tree, not from history
// (useRouteLevel). One page can only sit in one tree, so the booking tree is
// mounted beneath its calendar parents: the same files, another set
// of records, the way the localized public aliases are.
//
// The root mount's exit and tab are decided here with the mounts, not in the
// page: under Today the booking is a root that exits to Today and lights it;
// under the calendar day its parent is its Back and the calendar root lights
// Calendar. A `meta` in the file would ride into both mounts.

export interface PageNode {
  name?: string
  path: string
  file?: string
  meta?: Record<string, unknown>
  children?: PageNode[]
}

const BOOKING_PATH = '/dashboard/:orgSlug()/bookings/:bookingType()/:bookingId()'
const CALENDAR_PATH = '/dashboard/:orgSlug()/calendar'
const DAY_PATH = `${CALENDAR_PATH}/:day()`
// The account's own record lives under Past activity. Today opens it at
// `/dashboard/account/bookings` with Back to Today, and its calendar day mounts
// it a third time, as the business's does.
const ACCOUNT_RECORD_PATH = '/dashboard/account/activity/:kind()/:id()'
const ACCOUNT_BOOKING_PATH = '/dashboard/account/bookings/:kind()/:id()'
const ACCOUNT_DAY_PATH = '/dashboard/account/calendar/:day()'

/** The node at a full path in Nuxt's nested page tree, whose children carry paths relative to their parent. */
export function nodeAt(nodes: readonly PageNode[], target: string, parent = ''): PageNode | undefined {
  for (const node of nodes) {
    const path = node.path.startsWith('/') ? node.path : `${parent}/${node.path}`
    if (path === target) return node
    const below = node.children ? nodeAt(node.children, target, path) : undefined
    if (below) return below
  }
  return undefined
}

/** A record with an `index.vue` child carries no name of its own; the names are on the children. */
export function renamed(node: PageNode, from: string, to: string): PageNode {
  return {
    ...node,
    name: node.name?.replace(from, to),
    children: node.children?.map(child => renamed(child, from, to)),
  }
}

export function mountBookingRoutes(pages: PageNode[]): void {
  const booking = nodeAt(pages, BOOKING_PATH)
  const calendar = nodeAt(pages, CALENDAR_PATH)
  const day = nodeAt(pages, DAY_PATH)
  if (!booking || !calendar || !day) throw new Error('The booking, calendar and calendar day pages were not all found; the calendar cannot open a booking')
  const clone = renamed(booking, 'dashboard-orgSlug-bookings', 'dashboard-orgSlug-calendar-day')
  clone.path = ':bookingType()/:bookingId()'
  day.children = [...(day.children ?? []), clone]
  // A home's occupied night opens its stay directly: its parent is the nightly
  // Calendar, rather than an agenda day whose state belongs to a location.
  const night = renamed(booking, 'dashboard-orgSlug-bookings', 'dashboard-orgSlug-calendar-night')
  night.path = ':bookingType(stay)/:bookingId()'
  calendar.children = [...(calendar.children ?? []), night]
  booking.meta = { ...booking.meta, tab: 'today', back: 'dashboard-orgSlug' }

  const record = nodeAt(pages, ACCOUNT_RECORD_PATH)
  const accountDay = nodeAt(pages, ACCOUNT_DAY_PATH)
  if (!record || !accountDay) throw new Error('The account activity record and calendar day pages were not both found; the account calendar cannot open a booking')
  const accountClone = renamed(record, 'dashboard-account-activity', 'dashboard-account-calendar-day')
  accountClone.path = ':kind()/:id()'
  accountDay.children = [...(accountDay.children ?? []), accountClone]
  const accountBooking = renamed(record, 'dashboard-account-activity', 'dashboard-account-bookings')
  accountBooking.path = ACCOUNT_BOOKING_PATH
  accountBooking.meta = { ...accountBooking.meta, tab: 'today', back: 'dashboard-account' }
  pages.push(accountBooking)
}
