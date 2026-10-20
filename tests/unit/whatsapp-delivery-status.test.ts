import test from 'node:test'
import assert from 'node:assert/strict'

import { buildWhatsAppTemplatePayload } from '../../server/utils/whatsapp.ts'
import { compareDeliveryStatus } from '../../server/domain/guest-threads/deliveries.ts'

test('dashboard WhatsApp button paths preserve full guest-thread routes', () => {
  const fullUrl = 'https://staging.krabiclaw.com/dashboard/krabi-team/messages/thread%2Fwith%20spaces'

  const payload = buildWhatsAppTemplatePayload('new_reservation', {
    guest_name: 'Alex',
    date: 'Tue, Jul 14, 2026',
    time: '7:00 PM',
    guests: '2',
    phone: '+15551234567',
    email: 'alex@example.com',
    context: 'Location: Ao Nang',
    requests: 'Window seat',
    reply_path: fullUrl,
  })

  const button = payload.components.find(component => component.type === 'button')
  assert.equal(button?.parameters[0]?.text, 'krabi-team/messages/thread%2Fwith%20spaces')
  assert.doesNotMatch(button?.parameters[0]?.text ?? '', /\?thread=/)
})

test('null current status always advances', () => {
  assert.equal(compareDeliveryStatus(null, 'accepted'), true)
  assert.equal(compareDeliveryStatus(null, 'sent'), true)
  assert.equal(compareDeliveryStatus(null, 'delivered'), true)
  assert.equal(compareDeliveryStatus(null, 'read'), true)
  assert.equal(compareDeliveryStatus(null, 'failed'), true)
})

test('forward progress through the normal lifecycle advances', () => {
  assert.equal(compareDeliveryStatus('accepted', 'sent'), true)
  assert.equal(compareDeliveryStatus('sent', 'delivered'), true)
  assert.equal(compareDeliveryStatus('delivered', 'read'), true)
  assert.equal(compareDeliveryStatus('accepted', 'read'), true)
})

test('same-status replay does not advance (idempotent no-op)', () => {
  assert.equal(compareDeliveryStatus('accepted', 'accepted'), false)
  assert.equal(compareDeliveryStatus('sent', 'sent'), false)
  assert.equal(compareDeliveryStatus('delivered', 'delivered'), false)
  assert.equal(compareDeliveryStatus('read', 'read'), false)
})

test('out-of-order regression to an earlier stage does not advance', () => {
  assert.equal(compareDeliveryStatus('delivered', 'sent'), false)
  assert.equal(compareDeliveryStatus('read', 'delivered'), false)
  assert.equal(compareDeliveryStatus('read', 'accepted'), false)
})

test('failed after delivered/read does not clobber the recorded success', () => {
  assert.equal(compareDeliveryStatus('delivered', 'failed'), false)
  assert.equal(compareDeliveryStatus('read', 'failed'), false)
})

test('failed is recorded when no later success stage is present', () => {
  assert.equal(compareDeliveryStatus('accepted', 'failed'), true)
  assert.equal(compareDeliveryStatus('sent', 'failed'), true)
})

test('failed is terminal: nothing overwrites an already-recorded failure', () => {
  assert.equal(compareDeliveryStatus('failed', 'sent'), false)
  assert.equal(compareDeliveryStatus('failed', 'delivered'), false)
  assert.equal(compareDeliveryStatus('failed', 'read'), false)
  assert.equal(compareDeliveryStatus('failed', 'accepted'), false)
})

test('failed replay against failed is a harmless idempotent no-op', () => {
  assert.equal(compareDeliveryStatus('failed', 'failed'), false)
})
