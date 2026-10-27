// A booking opens beneath Today or its calendar context. The same detail
// subtree keeps its parent beside it on desktop and returns to that parent on
// mobile. Its Back and active tab come from that route tree, not history.

export interface PageNode {
  name?: string
  path: string
  file?: string
  meta?: Record<string, unknown>
  children?: PageNode[]
}

const BOOKING_PATH = '/dashboard/:orgSlug()/bookings/:bookingType()/:bookingId()'
const TODAY_PATH = '/dashboard/:orgSlug()'
const CALENDAR_PATH = '/dashboard/:orgSlug()/calendar'
const DAY_PATH = `${CALENDAR_PATH}/:day()`
// The account's own record lives under Past activity. Today opens it at
// `/dashboard/account/bookings` beneath Today, and its calendar day mounts
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
  const today = nodeAt(pages, TODAY_PATH)
  const calendar = nodeAt(pages, CALENDAR_PATH)
  const day = nodeAt(pages, DAY_PATH)
  if (!booking || !today || !calendar || !day) throw new Error('The booking, Today, calendar and calendar day pages were not all found; bookings cannot open in their context')
  const clone = renamed(booking, 'dashboard-orgSlug-bookings', 'dashboard-orgSlug-calendar-day')
  clone.path = ':bookingType()/:bookingId()'
  day.children = [...(day.children ?? []), clone]
  // A home's occupied night opens its stay directly: its parent is the nightly
  // Calendar, rather than an agenda day whose state belongs to a location.
  const night = renamed(booking, 'dashboard-orgSlug-bookings', 'dashboard-orgSlug-calendar-night')
  night.path = ':bookingType(stay)/:bookingId()'
  calendar.children = [...(calendar.children ?? []), night]
  const bookingIndex = pages.indexOf(booking)
  if (bookingIndex === -1) throw new Error('The booking subtree must be a root before it is mounted beneath Today')
  pages.splice(bookingIndex, 1)
  booking.path = 'bookings/:bookingType()/:bookingId()'
  today.children = [...(today.children ?? []), booking]

  const record = nodeAt(pages, ACCOUNT_RECORD_PATH)
  const accountDay = nodeAt(pages, ACCOUNT_DAY_PATH)
  const accountToday = nodeAt(pages, '/dashboard/account')
  if (!record || !accountDay || !accountToday) throw new Error('The account activity record, Today and calendar day pages were not all found; account bookings cannot open in their context')
  const accountClone = renamed(record, 'dashboard-account-activity', 'dashboard-account-calendar-day')
  accountClone.path = ':kind()/:id()'
  accountDay.children = [...(accountDay.children ?? []), accountClone]
  const accountBooking = renamed(record, 'dashboard-account-activity', 'dashboard-account-bookings')
  accountBooking.path = ACCOUNT_BOOKING_PATH.slice('/dashboard/account/'.length)
  accountToday.children = [...(accountToday.children ?? []), accountBooking]
}
