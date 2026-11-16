import { isRecord } from '~/utils/api-clients'

export interface WorkingHours { weekday: number; start: string; end: string }
export interface SchedulingInterval { start: string; end: string }
export interface PublicProvider { name: string; photo_url: string | null; bio: string | null }
export function isPublicProvider(value: unknown): value is PublicProvider {
  return isRecord(value) && typeof value.name === 'string' && Boolean(value.name.trim())
    && (value.photo_url === null || typeof value.photo_url === 'string') && (value.bio === null || typeof value.bio === 'string')
}
export const MEMBER_BUSY_SCOPES = ['https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.events.freebusy'] as const
/** Only the approved, authored profile is public identity; SQL joins it as `ms`. */
export const PUBLISHED_PROFILE_SQL = `ms.public_approved=1 AND length(trim(ms.public_name))>0`
/** The same authored profile used on offerings, packed into a reservation's existing read. */
export const PUBLIC_PROVIDER_JSON_SQL = `json_object('name', ms.public_name, 'photo_url', ms.public_photo_url, 'bio', ms.public_bio)`
/** A reservation identifies its assigned account and displays its authored details when published. */
export const RESERVATION_HOST_SQL = `CASE WHEN ${PUBLISHED_PROFILE_SQL} THEN ${PUBLIC_PROVIDER_JSON_SQL}
  WHEN length(trim(u.name))>0 THEN json_object('name', u.name, 'photo_url', NULL, 'bio', NULL) END`
/** How the team names a member (`m` joined to user `u` and member_scheduling `ms`): the public name set for them, else their account. */
export const MEMBER_NAME_SQL = `COALESCE(NULLIF(ms.public_name,''), u.name, u.email)`
