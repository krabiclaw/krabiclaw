// The reservation opens under its conversation. Staff with access to the record
// can also open it directly if they are not participants in the conversation.

export interface PageNode {
  name?: string
  path: string
  file?: string
  meta?: Record<string, unknown>
  children?: PageNode[]
}

const BOOKING_PATH = '/dashboard/:org_slug()/bookings/:booking_type()/:record_id()'
const CONVERSATION_PATH = '/dashboard/:org_slug()/messages/:conversation_id()'
const ACCOUNT_RECORD_PATH = '/dashboard/account/activity/:kind()/:id()'
const ACCOUNT_CONVERSATION_PATH = '/dashboard/account/messages/:conversation_id()'

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
  const conversation = nodeAt(pages, CONVERSATION_PATH)
  const record = nodeAt(pages, ACCOUNT_RECORD_PATH)
  const accountConversation = nodeAt(pages, ACCOUNT_CONVERSATION_PATH)
  if (!booking || !conversation || !record || !accountConversation) throw new Error('The booking and conversation pages could not be mounted')
  const canonical = renamed(booking, 'dashboard-org_slug-bookings-booking_type', 'dashboard-org_slug-bookings')
  canonical.path = '/dashboard/:org_slug()/bookings/:record_id()'
  booking.path = '/dashboard/:org_slug()/bookings/:booking_type(order|payment)/:record_id()'
  pages.push(canonical)

  const reservation = renamed(canonical, 'dashboard-org_slug-bookings', 'dashboard-org_slug-messages-conversation_id-reservation')
  reservation.path = 'reservation/:record_id()'
  reservation.meta = { ...reservation.meta, dashboardThirdPane: true }
  conversation.children = [...(conversation.children ?? []), reservation]
  canonical.meta = { ...canonical.meta, tab: 'today', back: 'dashboard-org_slug' }
  booking.meta = { ...booking.meta, tab: 'today', back: 'dashboard-org_slug' }

  const accountReservation = { ...record, name: 'dashboard-account-messages-conversation_id-reservation', path: 'reservation', meta: { ...record.meta, dashboardThirdPane: true } }
  accountConversation.children = [...(accountConversation.children ?? []), accountReservation]
}
