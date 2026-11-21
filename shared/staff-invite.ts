import { z } from 'zod'
import { isOrganizationRole } from '~/utils/organization-access'

const choice = z.object({ value: z.enum(['tasks', 'calendar', 'calendar_and_messaging', 'operations']), label: z.string() })
const role = z.object({
  value: z.string().refine(isOrganizationRole),
  label: z.string(),
  description: z.string(),
  access: z.array(choice),
})
export const staffInviteScreen = z.object({
  organization_id: z.string(),
  title: z.string(),
  email_label: z.string(),
  role_label: z.string(),
  listing_label: z.string(),
  no_access_label: z.string(),
  save_label: z.string(),
  resend_label: z.string(),
  roles: z.array(role).min(1),
  listings: z.array(z.object({ listing_id: z.string(), label: z.string() })),
})
