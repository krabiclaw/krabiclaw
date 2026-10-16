import { defineHandler } from 'nitro';
import { readBody } from 'nitro/h3';
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { deauthorizeMetaSubject } from '~/server/utils/integration-release'
import { configuredMetaApps, verifyMetaSignedRequest } from '~/server/utils/meta-graph'

/**
 * Meta's deauthorize callback: a protocol adapter and nothing else.
 *
 * Meta posts a signed request when someone removes a KrabiClaw app from their
 * Facebook or Instagram settings. Verifying the signature is the whole
 * authorization check, and which app's secret verified it says whose account
 * it names. What follows ends that person's connections; the website keeps its
 * posts, exactly as it would if the tenant had pressed Disconnect.
 */
export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  const apps = configuredMetaApps(env)
  if (!apps.length) return jsonResponse({ error: 'Meta integration is not configured' }, { status: 500 })

  const body = await readBody<{ signed_request?: string }>(event)
  const signedRequest = body?.signed_request
  if (!signedRequest) return jsonResponse({ error: 'signed_request is required' }, { status: 400 })

  const subject = await verifyMetaSignedRequest(signedRequest, apps)
  if (!subject) return jsonResponse({ error: 'Invalid signed request' }, { status: 401 })

  const results = await deauthorizeMetaSubject(env, subject)
  return jsonResponse({ success: true, released: results.filter(result => result.released).length })
})
