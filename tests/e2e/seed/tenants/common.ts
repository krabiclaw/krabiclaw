import type { SeedClient } from '../client.ts'
import type { SeedTenant } from '../manifest.ts'

type Location = { id: string; slug: string; title: string }
export type Tool = <T = Record<string, unknown>>(name: string, args: Record<string, unknown>) => Promise<T>

export const toolFor = (owner: SeedClient, tenant: SeedTenant): Tool => (name, args) => owner.tool(tenant.organizationId, name, args)

export const everyDay = (open: number, close: number, days = [0, 1, 2, 3, 4, 5, 6]) => ({
  periods: days.map(day => ({ open: { day, hour: open, minute: 0 }, close: { day, hour: close, minute: 0 } })),
})

/** Sunday 00:00 with no close: open at every hour, so a seeded time is never outside the hours. */
export const alwaysOpen = () => ({ periods: [{ open: { day: 0, hour: 0, minute: 0 } }] })

export async function seedLocation(tool: Tool, tenant: SeedTenant, key: string, input: {
  title: string; email: string; phone: string; hours: ReturnType<typeof everyDay> | ReturnType<typeof alwaysOpen>
  address: { regionCode: string; addressLines: string[]; locality: string; administrativeArea?: string; postalCode?: string }
}) {
  const { location } = await tool<{ location: Location }>('create_location', { title: input.title, timezone: tenant.timezone, idempotency_key: `seed-${tenant.key}-${key}` })
  await tool('update_location', { location_id: location.id, status: 'active', email: input.email, phone: input.phone, address: input.address, opening_hours: input.hours })
  const { location: saved } = await tool<{ location: Location }>('get_location', { location_id: location.id })
  if (!saved.slug) throw new Error(`Location ${input.title} has no slug`)
  tenant.locations[key] = { id: saved.id, slug: saved.slug, title: saved.title, timezone: tenant.timezone }
  return saved
}

export async function seedMedia(owner: SeedClient, tenant: SeedTenant, key: string, file: string, altText: string) {
  tenant.media[key] = await owner.upload(tenant.organizationId, file, { altText })
  return tenant.media[key]!
}

/** A published host or attorney profile; guests see it beside what the member provides. */
export async function publishProfile(tool: Tool, memberId: string, publicName: string, publicBio: string) {
  const { profile } = await tool<{ profile: { updated_at: string } | null }>('get_member_public_profile', { member_id: memberId })
  await tool('update_member_public_profile', { member_id: memberId, expected_updated_at: profile?.updated_at ?? null, public_name: publicName, public_bio: publicBio, public_approved: true })
}

/** Working hours in the member's own clock; provider-scheduled offerings are booked inside them. */
export async function setWorkingHours(tool: Tool, memberId: string, timezone: string, weekdays: number[], start: string, end: string) {
  const { scheduling } = await tool<{ scheduling: { updated_at: string } | null }>('get_member_scheduling', { member_id: memberId })
  await tool('set_member_scheduling', {
    member_id: memberId, expected_updated_at: scheduling?.updated_at ?? null, timezone,
    weekly: weekdays.map(weekday => ({ weekday, start, end })), time_off: [],
  })
}

export function recordProduct(tenant: SeedTenant, key: string, product: { id: string; slug: string; name: string; kind: string }) {
  tenant.products[key] = { id: product.id, slug: product.slug, name: product.name, kind: product.kind }
  return product
}
