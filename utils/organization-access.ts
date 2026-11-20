import { createAccessControl } from 'better-auth/plugins/access'
import { adminAc, defaultStatements, ownerAc } from 'better-auth/plugins/organization/access'

const statements = {
  ...defaultStatements,
  scheduling: ['own'],
  organization: ['read', 'update', 'delete'],
  members: ['read', 'invite', 'update', 'remove'],
  invitations: ['read', 'create', 'cancel'],
  locations: ['read', 'create', 'update', 'delete', 'assigned'],
  content: ['read', 'create', 'update', 'delete', 'publish'],
  media: ['read', 'create', 'update', 'delete'],
  blog: ['read', 'create', 'update', 'delete', 'publish'],
  products: ['read', 'create', 'update', 'delete', 'assigned'],
  menu: ['read'],
  analytics: ['read'],
  domains: ['read', 'create', 'update', 'delete'],
  payments: ['read', 'refund', 'disputes', 'payouts', 'integration'],
  billing: ['read', 'update'],
  settings: ['read', 'update'],
  integrations: ['read', 'create', 'update', 'delete'],
  operations: ['read', 'reply', 'update', 'assigned', 'listing_reply', 'listing_update', 'listing_calendar'],
  // Stored work: managers do everything; a member reads and completes the tasks
  // given to them, their team, or the homes they look after (server/domain/tasks.ts).
  task: ['read', 'create', 'assign', 'update', 'complete', 'claim'],
} as const

export const organizationAccessControl = createAccessControl(statements)

/**
 * A permission request against the statements above: `{ locations: ['read'] }`.
 *
 * Typed from `statements` so a resource or action this matrix does not declare
 * is a compile error rather than a check that silently answers false.
 */
export type OrganizationPermissions = {
  [Resource in keyof typeof statements]?: Array<(typeof statements)[Resource][number]>
}

const adminStatements = {
  ...adminAc.statements,
  scheduling: ['own'],
  organization: ['read', 'update'],
  members: ['read', 'invite', 'update', 'remove'],
  invitations: ['read', 'create', 'cancel'],
  locations: ['read', 'create', 'update', 'delete'],
  content: ['read', 'create', 'update', 'delete', 'publish'],
  media: ['read', 'create', 'update', 'delete'],
  blog: ['read', 'create', 'update', 'delete', 'publish'],
  products: ['read', 'create', 'update', 'delete'],
  operations: ['read', 'reply', 'update'],
  task: ['read', 'create', 'assign', 'update', 'complete', 'claim'],
  analytics: ['read'],
  domains: ['read', 'create', 'update', 'delete'],
  payments: ['read', 'refund', 'disputes', 'payouts', 'integration'],
  billing: ['read'],
  settings: ['read', 'update'],
  integrations: ['read', 'create', 'update', 'delete'],
} as const

export const listingAccessLevels = {
  tasks: 'Tasks',
  calendar: 'Calendar',
  calendar_and_messaging: 'Calendar and messaging',
  operations: 'Operations',
} as const
export type ListingAccess = keyof typeof listingAccessLevels
export type StoredListingAccess = ListingAccess | 'messaging'

const staff = { task: ['read', 'complete', 'claim'] } as const
const manager = {
  ...staff,
  scheduling: ['own'],
  locations: ['read'],
  products: ['read'],
  operations: ['read', 'reply', 'update'],
  task: ['read', 'create', 'assign', 'update', 'complete'],
} as const

export const organizationRoles = {
  member: organizationAccessControl.newRole({
    ...staff,
    scheduling: ['own'],
    products: ['assigned'],
    locations: ['assigned'],
    operations: ['assigned', 'listing_calendar', 'listing_reply', 'listing_update'],
  }),
  owner: organizationAccessControl.newRole({
    ...adminStatements,
    ...ownerAc.statements,
    organization: ['read', 'update', 'delete'],
    billing: ['read', 'update'],
  }),
  admin: organizationAccessControl.newRole(adminStatements),
  property_manager: organizationAccessControl.newRole(manager),
  cleaner: organizationAccessControl.newRole(staff),
  maintenance: organizationAccessControl.newRole(staff),
  restaurant_manager: organizationAccessControl.newRole(manager),
  kitchen: organizationAccessControl.newRole({ ...staff, menu: ['read'] }),
  host: organizationAccessControl.newRole({ ...staff, operations: ['listing_calendar', 'listing_reply', 'listing_update'] }),
  attorney: organizationAccessControl.newRole({
    ...staff, scheduling: ['own'], products: ['assigned'], locations: ['assigned'],
    operations: ['assigned', 'listing_calendar', 'listing_reply', 'listing_update'],
  }),
  paralegal: organizationAccessControl.newRole({ ...staff, operations: ['listing_calendar', 'listing_reply'] }),
}

export type OrganizationRole = keyof typeof organizationRoles
type RoleCard = { label: string; description: string; vertical?: string; access: readonly ListingAccess[] }
const allAccess = ['tasks', 'calendar', 'calendar_and_messaging', 'operations'] as const
export const organizationRoleCards: Record<OrganizationRole, RoleCard> = {
  member: { label: 'General Staff', description: 'Work on assigned tasks and get access to selected listings.', access: allAccess },
  owner: { label: 'Owner', description: 'Manage the workspace, its team, and billing.', access: [] },
  admin: { label: 'Admin', description: 'Manage the workspace and its team.', access: [] },
  property_manager: { label: 'Property Manager', vertical: 'lodging', description: 'Manage bookings, calendars, guest messages, and tasks across the workspace.', access: [] },
  cleaner: { label: 'Cleaner', vertical: 'lodging', description: 'See assigned cleaning work and claim available jobs at selected homes.', access: ['tasks'] },
  maintenance: { label: 'Maintenance', description: 'See and finish the repair work assigned to you.', access: ['tasks'] },
  restaurant_manager: { label: 'Restaurant Manager', vertical: 'restaurant', description: 'Manage reservations, calendars, guest messages, and tasks across the workspace.', access: [] },
  kitchen: { label: 'Kitchen', vertical: 'restaurant', description: 'See the menu and work on assigned and available kitchen tasks.', access: ['tasks'] },
  host: { label: 'Host', vertical: 'restaurant', description: 'Handle table reservations and guest messages for selected tables.', access: allAccess },
  attorney: { label: 'Attorney', vertical: 'service', description: 'Manage your schedule and handle consultations and client intake for selected offerings.', access: allAccess },
  paralegal: { label: 'Paralegal', vertical: 'service', description: 'Prepare consultations, handle document tasks, and message clients where granted.', access: ['tasks', 'calendar', 'calendar_and_messaging'] },
}

export function isOrganizationRole(role: string): role is OrganizationRole {
  return Object.hasOwn(organizationRoles, role)
}

export function organizationRoleLabel(role: string): string {
  if (!isOrganizationRole(role)) throw new Error(`Unknown organization role: ${role}`)
  return role === 'member' ? 'Member' : organizationRoleCards[role].label
}

export function rolesForVertical(vertical: string | null): OrganizationRole[] {
  return (Object.keys(organizationRoles) as OrganizationRole[]).filter(role => {
    const card = organizationRoleCards[role]
    return !card.vertical || card.vertical === vertical
  })
}

export function rolesAllowing(permissions: OrganizationPermissions): OrganizationRole[] {
  return (Object.keys(organizationRoles) as OrganizationRole[]).filter(role =>
    organizationRoles[role].authorize(permissions).success)
}

/** SQL expressions and role names here come only from application code. */
export function roleMatchesSql(expression: string, roles: readonly OrganizationRole[]): string {
  return `EXISTS (SELECT 1 FROM json_each('${JSON.stringify(roles)}') allowed
    WHERE instr(',' || replace(${expression}, ' ', '') || ',', ',' || allowed.value || ',') > 0)`
}

export const workspaceGuestMessagingRoles = rolesAllowing({ operations: ['reply'] })
export const workspaceOperationsRoles = rolesAllowing({ operations: ['update'] })
export const workspaceManagementRoles = rolesAllowing({ settings: ['update'] })
export const assignedOperationsRoles = rolesAllowing({ operations: ['assigned'] })
export const listingCalendarRoles = rolesAllowing({ operations: ['listing_calendar'] })
export const listingMessagingRoles = rolesAllowing({ operations: ['listing_reply'] })
export const listingOperationsRoles = rolesAllowing({ operations: ['listing_update'] })
