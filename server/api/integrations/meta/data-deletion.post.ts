import { defineHandler } from 'nitro';
import { readBody } from 'nitro/h3';
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { signJWT } from 'better-auth/crypto'
import { eraseMetaSubjectData } from '~/server/utils/integration-release'
import { configuredMetaApps, META_DELETION_PURPOSE, META_DELETION_STATUS_SECONDS, verifyMetaSignedRequest } from '~/server/utils/meta-graph'

/**
 * Meta's data-deletion callback.
 *
 * It erases what KrabiClaw holds about one verified Meta person in one Meta
 * app: the publication receipts naming them and their linked account, even
 * after the connection is gone. The tenant's own posts, including ones
 * published to that Page, stay; only their link to it goes.
 *
 * It deletes Meta's data, not the customer. A KrabiClaw workspace is deleted
 * by its owner through Better Auth's organization deletion; a request from
 * Meta about one person's Instagram account is not that, and must never
 * become that.
 *
 * The confirmation code is a JWT Better Auth signs with its own secret, naming
 * the verified app and subject, so the status URL re-checks the real remaining
 * state and cannot be pointed at another person. A cleanup
 * that fails answers 500, and Meta's retry resumes it.
 */
export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  const apps = configuredMetaApps(env)
  if (!apps.length || !env.BETTER_AUTH_SECRET) return jsonResponse({ error: 'Meta integration is not configured' }, { status: 500 })

  const body = await readBody<{ signed_request?: string }>(event)
  const signedRequest = body?.signed_request
  if (!signedRequest) return jsonResponse({ error: 'signed_request is required' }, { status: 400 })

  const subject = await verifyMetaSignedRequest(signedRequest, apps)
  if (!subject) return jsonResponse({ error: 'Invalid signed request' }, { status: 401 })

  const erased = await eraseMetaSubjectData(env, subject)
  const confirmationCode = await signJWT({
    purpose: META_DELETION_PURPOSE, channel: subject.channel, providerAppId: subject.providerAppId, providerSubjectId: subject.providerSubjectId,
  }, env.BETTER_AUTH_SECRET, META_DELETION_STATUS_SECONDS)
  const statusUrl = new URL('/api/integrations/meta/data-deletion', event.url.origin)
  statusUrl.searchParams.set('code', confirmationCode)
  return jsonResponse({ url: statusUrl.toString(), confirmation_code: confirmationCode, ...erased })
})
