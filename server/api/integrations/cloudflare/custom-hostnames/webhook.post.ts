import { defineHandler } from 'nitro'
import { readBody } from 'nitro/h3'
import { queryFirst } from '~/server/db'
import { publishEvent } from '~/server/events'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { CLOUDFLARE_HOSTNAMES_CALLER, validateInternalRequest } from '~/server/utils/internal-secret'
import { customHostnameZone } from '~/server/utils/domains'
import { readRecord, readString } from '~/server/utils/type-guards'

export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  const authorization = await validateInternalRequest(event, env, CLOUDFLARE_HOSTNAMES_CALLER)
  if (!authorization.ok) return jsonResponse({ error: authorization.error }, { status: authorization.status })

  const body: unknown = await readBody(event)
  const payload = readRecord(body, 'metadata') ? body : readRecord(body, 'data')
  const metadata = readRecord(payload, 'metadata')
  const notification = readRecord(metadata, 'event')
  if (readString(notification, 'type') !== 'ssl.custom_hostname_certificate.deployment.succeeded') return new Response(null, { status: 204 })

  const zone = readString(readRecord(metadata, 'zone'), 'id')
  if (!env.CF_ACCOUNT_ID || !env.CF_ZONE_ID) return jsonResponse({ error: 'Cloudflare account and zone must be configured' }, { status: 503 })
  if (readString(readRecord(metadata, 'account'), 'id') !== env.CF_ACCOUNT_ID
    || (zone !== env.CF_ZONE_ID && zone !== customHostnameZone(env))) return jsonResponse({ error: 'Unexpected Cloudflare account or zone' }, { status: 403 })

  const data = readRecord(payload, 'data')
  const providerId = readString(data, 'id')
  const hostname = readString(data, 'hostname')
  // Cloudflare can report detached certificates without a hostname identity.
  if (!providerId || !hostname) return new Response(null, { status: 204 })
  const domain = await queryFirst<{ id: string; organization_id: string; dns_target: string | null }>(env.DB, `
    SELECT id, organization_id, dns_target FROM organization_domains
    WHERE domain = ? AND cloudflare_hostname_id = ? AND type = 'custom' AND desired_state = 'active'
      AND status NOT IN ('disabled', 'deleted')
  `, [hostname, providerId])
  if (!domain || zone !== customHostnameZone(env, domain.dns_target)) return new Response(null, { status: 204 })

  await publishEvent(env, {
    type: 'domain.check_requested', organization_id: domain.organization_id,
    domains: [{ id: domain.id, cloudflare_hostname_id: providerId }],
  })
  return new Response(null, { status: 202 })
})
