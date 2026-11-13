import { defineHandler, HTTPError } from 'nitro'
import { getQuery, readBody } from 'nitro/h3'
import { z } from 'zod'
import { offeringSetupAnswer, type OfferingSetupResponse } from '~/shared/offering-setup'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { firstExperienceSetup } from '~/server/utils/experience-setup'
import { firstMenuSetup } from '~/server/utils/first-menu-setup'
import { firstPracticeAreaSetup } from '~/server/utils/practice-area-setup'
import { assertOrganizationWideAccess, assertRoleAllows, memberAccessPrincipal } from '~/server/utils/member-access'

const scope = z.object({ location_id: z.string().min(1).optional(), product_id: z.string().min(1).optional(), step: z.string().min(1).optional() })

export default defineHandler(async (event): Promise<OfferingSetupResponse> => {
  const { db, env, organization, userId } = await getDashboardMemberContext(event)
  if (organization.onboarding_status !== 'active' || organization.status === 'suspended') {
    throw new HTTPError({ statusCode: 404, statusMessage: 'Offering setup is unavailable for this website' })
  }
  if (event.req.method !== 'GET' && event.req.method !== 'POST') throw new HTTPError({ statusCode: 405, statusMessage: 'Method not allowed' })
  const query = scope.safeParse(getQuery(event))
  if (!query.success) throw new HTTPError({ statusCode: 400, statusMessage: 'Invalid offering setup location or step' })
  const submission = event.req.method === 'POST' ? offeringSetupAnswer.safeParse(await readBody(event)) : null
  if (submission && !submission.success) throw new HTTPError({ statusCode: 400, statusMessage: 'Invalid offering setup answer' })
  const answer = submission?.data ?? null
  const requested = query.data.step ?? answer?.step
  const principal = memberAccessPrincipal(organization, { env, event })
  await assertOrganizationWideAccess(db, principal)
  await assertRoleAllows({ ...principal, permissions: { products: [answer ? 'create' : 'read'] } })
  if (answer) await assertRoleAllows({ ...principal, permissions: { products: ['update'] } })
  const context = { db, env, organizationId: organization.id, orgSlug: organization.slug, actorId: userId, principal }
  switch (organization.vertical) {
    case 'restaurant': return firstMenuSetup(context, query.data.location_id, requested, answer)
    case 'experience': return firstExperienceSetup(context, requested, answer)
    case 'service': return firstPracticeAreaSetup(context, query.data.product_id, requested, answer)
    default: throw new HTTPError({ statusCode: 404, statusMessage: 'Offering setup is unavailable for this business type' })
  }
})
