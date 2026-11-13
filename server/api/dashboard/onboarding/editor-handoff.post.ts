import { defineHandler, HTTPError } from 'nitro'
import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { createAuth } from '~/server/utils/auth'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { productEditorPath } from '~/server/utils/dashboard-links'
import { assertOrganizationWideAccess, memberAccessPrincipal } from '~/server/utils/member-access'
import { getProduct } from '~/server/utils/product-management'
import { validatedInternalPath } from '~/shared/auth/return-target'

export default defineHandler(async (event) => {
  const invalid = () => new HTTPError({ statusCode: 400, message: 'Choose a saved offering to open.', data: { code: 'INVALID_EDITOR_DESTINATION' } })
  const authorization = event.req.headers.get('authorization') ?? ''
  if (!/^Bearer [^\s]+$/i.test(authorization) || event.req.headers.has('cookie')) {
    throw new HTTPError({ statusCode: 401, message: 'Sign in to open the editor.', data: { code: 'UNAUTHORIZED' } })
  }
  const body = await readRequiredBody<{ path?: unknown }>(event)
  const path = validatedInternalPath(body?.path)
  if (!path) throw invalid()
  const target = new URL(path, event.url.origin)
  const match = /^\/dashboard\/([a-z0-9-]+)\/products\/([a-zA-Z0-9-]+)$/.exec(target.pathname)
  if (!match || target.hash || [...target.searchParams.keys()].some(key => key !== 'location_id')) throw invalid()
  const { db, env, organization, userId, session } = await getDashboardMemberContext(event, { organizationSlug: match[1]! })
  if (session.user.isAnonymous || session.session.impersonatedBy) {
    throw new HTTPError({ statusCode: 403, message: 'Sign in with your own account to open the editor.', data: { code: 'EDITOR_HANDOFF_REQUIRES_OWN_ACCOUNT' } })
  }
  await assertOrganizationWideAccess(db, memberAccessPrincipal(organization, { env, event }))
  const product = await getProduct(db, organization.id, match[2]!)
  const locationId = target.searchParams.get('location_id')
  if (locationId && !product.locations.some(location => location.location_id === locationId)) throw invalid()
  const redirect = productEditorPath(organization.slug, product.id, locationId)
  if (redirect !== path) throw invalid()
  const { token } = await createAuth(env).api.generateOneTimeToken({ headers: event.req.headers })
  const url = new URL('/onboarding-editor', event.url.origin)
  url.hash = new URLSearchParams({ token, redirect, user: userId }).toString()
  return jsonResponse({ url: url.toString() }, { headers: { 'cache-control': 'no-store' } })
})
