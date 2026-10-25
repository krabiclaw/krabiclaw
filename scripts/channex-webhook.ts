/**
 * Verifies, and with --apply registers, KrabiClaw's webhook in the Channex
 * account an environment calls: callback <BETTER_AUTH_URL>/api/integrations/channex/webhook,
 * the events the handler takes, and CHANNEX_WEBHOOK_SECRET in
 * x-channex-webhook-secret. Repeating it over a matching webhook changes nothing.
 *
 *   CHANNEX_API_KEY=<key> CHANNEX_WEBHOOK_SECRET=<secret> \
 *     corepack yarn channex:webhook --env production [--property <uuid> ...] [--apply]
 *
 * Without --property it is the account's global webhook; each --property is
 * that property's own, which Channex delivers to instead of the global one.
 * The Channex base URL and the callback origin are the environment's
 * wrangler.toml vars, so the account is the one the deployed Worker calls.
 * The key and secret are read from the process environment: Cloudflare
 * secrets cannot be read back, and the secret must be the one the Worker holds.
 *
 * Exits non-zero when a webhook is missing or differs and --apply was not given.
 */
import { parseArgs } from 'node:util'
import { unstable_readConfig } from 'wrangler'
import { ensureChannexWebhook } from '../server/integrations/channex/webhooks.ts'

const { values } = parseArgs({ options: {
  env: { type: 'string' },
  property: { type: 'string', multiple: true, default: [] },
  apply: { type: 'boolean', default: false },
}, strict: true })
if (values.env !== 'production' && values.env !== 'staging') throw new Error('Pass --env production or --env staging.')

const config = unstable_readConfig({ config: 'wrangler.toml', env: values.env === 'production' ? undefined : values.env }, { hideWarnings: true })
const baseUrl = config.vars.CHANNEX_BASE_URL
const origin = config.vars.BETTER_AUTH_URL
if (typeof baseUrl !== 'string' || !baseUrl) throw new Error(`wrangler.toml has no CHANNEX_BASE_URL for ${values.env}`)
if (typeof origin !== 'string' || !origin) throw new Error(`wrangler.toml has no BETTER_AUTH_URL for ${values.env}`)
const apiKey = process.env.CHANNEX_API_KEY?.trim()
const secret = process.env.CHANNEX_WEBHOOK_SECRET?.trim()
if (!apiKey) throw new Error(`CHANNEX_API_KEY is required: the key of the Channex account at ${baseUrl}`)
if (!secret) throw new Error(`CHANNEX_WEBHOOK_SECRET is required: the secret the ${values.env} Worker holds`)

const env = { CHANNEX_BASE_URL: baseUrl, CHANNEX_API_KEY: apiKey }
let outstanding = 0
for (const propertyId of values.property.length ? values.property : [null]) {
  const result = await ensureChannexWebhook(env, { origin, secret, propertyId }, values.apply)
  if (result.action === 'would_create' || result.action === 'would_update') outstanding += 1
  console.log(`${baseUrl} ${propertyId ?? 'global'} → ${origin}: ${result.action}${result.id ? ` ${result.id}` : ''}`)
  for (const difference of result.differences) console.log(`  ${difference}`)
}
process.exitCode = outstanding ? 1 : 0
