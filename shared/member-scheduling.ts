export interface WorkingHours { weekday: number; start: string; end: string }
export interface SchedulingInterval { start: string; end: string }
export interface PublicProvider { name: string; photo_url: string | null; bio: string | null }
export const MEMBER_BUSY_SCOPES = ['https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.events.freebusy'] as const
export const BUSY_FRESHNESS_MS = 120_000
/** How the team names a member (`m` joined to user `u` and member_scheduling `ms`): the public name set for them, else their account. */
export const MEMBER_NAME_SQL = `COALESCE(NULLIF(ms.public_name,''), u.name, u.email)`
