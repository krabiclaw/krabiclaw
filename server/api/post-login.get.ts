import { HTTPError, defineHandler  } from 'nitro';

// GET /api/post-login — server-side redirect after OAuth / sign-in.
import { getQuery, redirect } from 'nitro/h3';
import { cloudflareEnv } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { resolvePostLoginRoute } from '~/server/utils/post-login-routing'
import { activateSessionOrganization } from '~/server/utils/session-organization'
import { isNewSalePlan } from '~/shared/billing-model'
import { buildLoginUrl, buildPostLoginUrl, isDashboardAppPath, resolveDashboardAppTarget, validatedInternalPath } from '~/shared/auth/return-target'

export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  const db = env.DB

  const plan = getQuery(event).plan
  if (plan !== undefined && !isNewSalePlan(plan)) {
    throw new HTTPError({ statusCode: 400, message: 'Unknown checkout plan' })
  }
  const session = await getAuthSession(event, env)
  const redirectTarget = validatedInternalPath(getQuery(event).redirect)

  if (!session?.user?.id) {
    const returnTarget = redirectTarget ?? (plan ? buildPostLoginUrl({ plan }) : undefined)
    return redirect(buildLoginUrl(returnTarget ? { redirect: returnTarget } : {}), 302)
  }

  if (redirectTarget && !isDashboardAppPath(redirectTarget)) return redirect(redirectTarget, 302)

  if (!db) {
    throw new HTTPError({ statusCode: 503, message: 'Database not available' })
  }

  try {
    const sessionRecord = session.session as typeof session.session & { activeOrganizationId?: string | null }
    const route = await resolvePostLoginRoute(env, {
      userId: session.user.id,
      activeOrganizationId: typeof sessionRecord.activeOrganizationId === 'string' ? sessionRecord.activeOrganizationId : null,
    })

    // One organization is activated here rather than on arrival: this handler
    // holds the authenticated request headers, and routing first would leave
    // the session with no active organization for the account pages to read.
    if (route.kind === 'activate') {
      await activateSessionOrganization(event, env, route.organizationId)
    }

    if (plan) {
      if (route.kind === 'onboard') {
        throw new HTTPError({ statusCode: 409, message: 'An organization is required before choosing a billing plan' })
      }
      // The chooser carries the plan and returns through here, so the billing
      // destination is decided in exactly one place.
      if (route.kind === 'choose') {
        const chooseParams = new URLSearchParams()
        chooseParams.set('plan', plan)
        if (redirectTarget) chooseParams.set('redirect', redirectTarget)
        return redirect(`${route.destination}?${chooseParams}`, 302)
      }
      return redirect(`${route.destination}/payments?tab=plan&plan=${encodeURIComponent(plan)}`, 302)
    }

    if (route.kind === 'onboard') {
      return redirect(route.destination, 302)
    }

    if (route.kind === 'choose') {
      const chooseRedirect = redirectTarget ? `?redirect=${encodeURIComponent(redirectTarget)}` : ''
      return redirect(`${route.destination}${chooseRedirect}`, 302)
    }

    if (redirectTarget && isDashboardAppPath(redirectTarget)) {
      return redirect(resolveDashboardAppTarget(route.destination, redirectTarget), 302)
    }

    return redirect(route.destination, 302)
  } catch (error) {
    if (error instanceof HTTPError) throw error
    console.error('Failed to resolve organization slug in post-login:', error)
    throw new HTTPError({ statusCode: 500, message: 'Failed to resolve dashboard destination' })
  }
})
