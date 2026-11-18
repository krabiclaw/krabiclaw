import { defineHandler } from 'nitro'
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { stayAccessFor } from '~/server/domain/stays'
import { scheduleVocabulary } from '~/utils/message-schedule-presentation'
import { SCHEDULE_LIMITS, type GuestMessageSchedule } from '~/server/domain/guest-message-schedule'
import { listMessageOfferings } from '~/server/domain/guest-messaging'

// The homes and bookable products (tables included) an automatic message can name.
export default defineHandler(async (event) => {
  const { db, env, organization } = await getDashboardMemberContext(event, {})
  const access = await stayAccessFor(memberAccessPrincipal(organization, { env, event }))
  const words = scheduleVocabulary(organization.vertical)
  const triggers: Array<{ id: GuestMessageSchedule['trigger']; label: string }> = [
    { id: 'booking_received', label: `5 minutes after ${words.received}` },
    { id: 'check_in', label: words.aroundCheckIn },
    { id: 'check_out', label: words.aroundCheckOut },
  ]
  const offsets = (unit: 'day' | 'hour', maximum: number, zero: string) =>
    Array.from({ length: 2 * maximum + 1 }, (_, index) => {
      const value = index - maximum
      const amount = Math.abs(value)
      return { value, label: value === 0 ? zero : `${amount} ${unit}${amount === 1 ? '' : 's'} ${value < 0 ? 'before' : 'after'}` }
    })
  return jsonResponse({
    ...await listMessageOfferings(db, access),
    triggers,
    can_manage: access.manage,
    offset_days: offsets('day', SCHEDULE_LIMITS.days, 'On the day'),
    offset_hours: offsets('hour', SCHEDULE_LIMITS.hours, 'At the event'),
    max_offerings: SCHEDULE_LIMITS.offerings,
  })
})
