#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { spawnYarn } from './utils/spawn-yarn.mjs'

function required(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

const quote = value => `'${value.replace(/'/g, "''")}'`
const recipientHash = value => createHash('sha256').update(value.toLowerCase().trim()).digest('hex')

function read(sql) {
  const result = spawnYarn(['wrangler', 'd1', 'execute', 'DB', '--remote', '--json', '--command', sql], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error('Production canary database read failed', { cause: result.stderr || result.stdout })
  const [response] = JSON.parse(result.stdout)
  if (!response?.success || !Array.isArray(response.results)) throw new Error('Unexpected production canary database response')
  return response.results
}

async function request(url, expectedStatus, options) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20_000), ...options })
  const body = await response.json()
  if (response.status !== expectedStatus) {
    throw new Error(`${url.pathname}: expected ${expectedStatus}, received ${response.status}: ${body.code ?? body.error ?? 'unknown error'}`)
  }
  return body
}

async function main() {
  const organization = required('CANARY_ORG_ID')
  const email = required('CANARY_NOTIFICATION_EMAIL')
  const phone = required('CANARY_NOTIFICATION_PHONE_E164')
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new Error('The canary phone must be in E.164 format')

  // Resolve the public origin from the explicitly configured canary organization.
  // The platform/auth base URL is not necessarily the tenant that accepts bookings.
  const [target] = read(`
    SELECT d.domain,
      EXISTS (SELECT 1 FROM member m JOIN user u ON u.id = m.userId
        WHERE m.organizationId = o.id AND m.role IN ('owner','admin')
          AND u.phoneNumberVerified = 1 AND u.phoneNumber = ${quote(phone)}) AS verified_phone
    FROM organization o JOIN organization_domains d
      ON d.organization_id = o.id AND d.role = 'canonical' AND d.status = 'active'
    WHERE o.id = ${quote(organization)} AND o.status = 'active'
  `)
  if (!target?.domain || !target.verified_phone) throw new Error('The canary workspace or its verified WhatsApp recipient could not be resolved')
  const origin = new URL(`https://${target.domain}`)
  // The canary books a table: a booking of the location's table product, which a party of two books without paying.
  const tables = read(`
    SELECT p.slug, pl.location_id FROM products p
      JOIN product_booking_configs c ON c.product_id = p.id AND c.organization_id = p.organization_id
      JOIN product_publications pub ON pub.product_id = p.id AND pub.organization_id = p.organization_id AND pub.published = 1
      JOIN product_locations pl ON pl.product_id = p.id AND pl.organization_id = p.organization_id AND pl.active = 1 AND pl.published = 1
     WHERE p.organization_id = ${quote(organization)} AND p.kind = 'table' AND p.active = 1
       AND (c.online_payment_required = 0 OR c.payment_min_party_size > 2) ORDER BY p.slug, pl.location_id
  `)
  let available
  for (const { slug, location_id } of tables) {
    const url = new URL(`/api/public/products/${encodeURIComponent(slug)}/sessions`, origin)
    url.search = new URLSearchParams({ location_id }).toString()
    const { sessions } = await request(url, 200)
    const session = sessions.find(session => !session.is_full && (session.remaining === null || session.remaining >= 2)
      && Date.parse(session.starts_at) > Date.now() + 7 * 86_400_000)
    if (session) { available = { slug, session_id: session.id }; break }
  }
  if (!available) throw new Error('The canary workspace has no table a party of two can book without paying')

  const post = (path, body, status) => request(new URL(path, origin), status, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const key = randomUUID()
  const name = `Notification canary ${key.slice(0, 8)}`
  const contact = await post('/api/public/contact', { name, email, message: 'Dedicated notification delivery check.' }, 201)
  const reservation = await post(`/api/public/products/${encodeURIComponent(available.slug)}/book`, {
    session_id: available.session_id, party_size: 2, guest_name: name, guest_email: email, guest_phone: phone, idempotency_key: key,
  }, 201)
  if (!reservation.request_id || !reservation.cancellation_token) throw new Error('The canary table booking did not return its cancellation capability')
  const cancelled = await request(new URL(`/api/public/booking-requests/${encodeURIComponent(reservation.request_id)}/cancel`, origin), 200, {
    method: 'POST', headers: { authorization: `Bearer ${reservation.cancellation_token}` },
  })
  if (cancelled.success !== true || cancelled.kind !== 'booking') throw new Error('The canary table booking did not confirm cancellation')
  if (!contact.request_id) throw new Error('The canary contact did not return its request ID')

  const requiredReceipts = [
    ['contact_email', contact.request_id, 'email', 'resend', 'guest_acknowledgement', 'contact_customer_received', email],
    ['reservation_email', reservation.request_id, 'email', 'resend', 'guest_acknowledgement', 'booking_customer_received', email],
    ['reservation_whatsapp', reservation.request_id, 'whatsapp', 'meta', 'owner_alert', 'new_reservation', phone],
    ['cancellation_email', reservation.request_id, 'email', 'resend', 'status_update', 'booking_customer_cancelled', email],
    ['cancellation_whatsapp', reservation.request_id, 'whatsapp', 'meta', 'owner_alert', 'reservation_cancelled', phone],
  ]
  const deadline = Date.now() + 45_000
  let missing
  do {
    const rows = read(`
      SELECT d.id, m.conversation_id AS request_id, d.channel, d.provider, d.purpose, d.status, d.provider_message_id
      FROM guest_thread_deliveries d JOIN messages m ON m.id = d.message_id
      WHERE m.organization_id = ${quote(organization)} AND m.conversation_id IN (${quote(contact.request_id)}, ${quote(reservation.request_id)})
    `)
    const evidence = Object.fromEntries(requiredReceipts.map(([label, requestId, channel, provider, purpose, template, recipient]) => {
      const suffix = `:${purpose}:${channel}:${template}:${recipientHash(recipient)}`
      return [label, rows.find(row => row.request_id === requestId && row.provider === provider
        && ['accepted', 'sent', 'delivered', 'read'].includes(row.status)
        && row.provider_message_id && row.id.endsWith(suffix))?.provider_message_id]
    }))
    missing = Object.keys(evidence).filter(label => !evidence[label])
    if (!missing.length) {
      console.log(JSON.stringify({ status: 'pass', contact_id: contact.request_id, reservation_id: reservation.request_id, provider_message_ids: evidence }, null, 2))
      return
    }
    await new Promise(resolve => setTimeout(resolve, 1500))
  } while (Date.now() < deadline)
  throw new Error(`No provider acceptance receipt for: ${missing.join(', ')}`)
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
