import { defineHandler, HTTPError } from 'nitro'
import { readBody } from 'nitro/h3'
import { cloudflareEnv } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { onboardingAnswers, onboardingFlow } from '~/server/utils/onboarding-flow'

export default defineHandler(async (event) => {
  const session = await getAuthSession(event, cloudflareEnv(event))
  if (!session?.user.id) throw new HTTPError({ statusCode: 401, statusMessage: 'Authentication required' })

  const answers = onboardingAnswers.safeParse(await readBody(event))
  if (!answers.success) throw new HTTPError({ statusCode: 400, statusMessage: 'Invalid onboarding answers' })
  return onboardingFlow(answers.data)
})
