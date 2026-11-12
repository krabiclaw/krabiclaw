import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { z } from 'zod'
import { experienceSetupStep } from '~/shared/experience-setup'
import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { readExperienceSetup, saveExperienceSetup, type ExperienceSetupContext } from '~/server/utils/experience-setup'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { assertRoleAllows } from '~/server/utils/member-access'

const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('open'), step: experienceSetupStep.optional() }),
  z.object({ action: z.enum(['next', 'exit']), step: experienceSetupStep, value: z.string().optional() }),
])

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) throw new HTTPError({ statusCode: 400, statusMessage: 'Organization ID is required' })
  const { db, env, session, organization } = await requireOrganizationAccess(event, organizationId)
  if (organization.vertical !== 'experience' || organization.onboarding_status !== 'active') {
    throw new HTTPError({ statusCode: 404, statusMessage: 'Experience setup is unavailable for this workspace' })
  }
  const parsed = requestSchema.safeParse(await readRequiredBody<unknown>(event))
  if (!parsed.success) throw new HTTPError({ statusCode: 400, statusMessage: 'Invalid experience setup request' })
  const body = parsed.data
  const context: ExperienceSetupContext = { db, env, organizationId, orgSlug: organization.slug, actorId: session.user.id }
  const permissions = body.action === 'open' ? 'read' : 'update'
  await assertRoleAllows({ ...organization.membership, permissions: { products: [permissions] } })
  if (body.action === 'open') return jsonResponse(await readExperienceSetup(context, body.step))
  if (body.step === 'title') await assertRoleAllows({ ...organization.membership, permissions: { products: ['create'] } })
  return jsonResponse({ to: await saveExperienceSetup(context, body) })
})
