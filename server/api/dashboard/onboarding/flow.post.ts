import { defineHandler, HTTPError } from 'nitro'
import { isAPIError } from 'better-auth/api'
import { readBody } from 'nitro/h3'
import { cloudflareEnv } from '~/server/utils/api-response'
import { createAuth, getAuthSession } from '~/server/utils/auth'
import { onboardingAnswers, onboardingFlow, proposedOnboardingSubdomain } from '~/server/utils/onboarding-flow'
import { isOnboardingSubdomain } from '~/server/utils/onboarding-drafts'
import { isSystemSubdomainSpent, platformHostname } from '~/server/utils/domains'

export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  const session = await getAuthSession(event, env)
  if (!session?.user.id) throw new HTTPError({ statusCode: 401, statusMessage: 'Authentication required' })

  const answers = onboardingAnswers.safeParse(await readBody(event))
  if (!answers.success) throw new HTTPError({ statusCode: 400, statusMessage: 'Invalid onboarding answers' })
  if (!env.DB) throw new HTTPError({ statusCode: 503, statusMessage: 'Database not available' })

  const slug = proposedOnboardingSubdomain(answers.data)
  let subdomainTaken = false
  if (answers.data.name.trim() && !answers.data.savedSubdomain && isOnboardingSubdomain(slug)) {
    try {
      await createAuth(env).api.checkOrganizationSlug({ body: { slug } })
      subdomainTaken = await isSystemSubdomainSpent(env, env.DB, slug)
    } catch (error) {
      if (!isAPIError(error) || error.body?.code !== 'ORGANIZATION_SLUG_ALREADY_TAKEN') throw error
      subdomainTaken = true
    }
  }
  const domain = platformHostname(env)
  return onboardingFlow(answers.data, { includedDomain: domain.includes('.') && !domain.includes(':') ? domain : undefined, subdomainTaken })
})
