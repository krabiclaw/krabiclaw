import test from 'node:test'
import assert from 'node:assert/strict'
import {
  deliveryFailureTitle,
  isDeliveryFailure,
} from '../../lib/components/workspace/messages/guest-thread-client.ts'
import type { GuestThreadDeliveryFailureViewModel } from '../../server/domain/guest-threads/types.ts'

test('deliveryFailureTitle clarifies host alerts from guest conversation deliveries', () => {
  const hostAlertWithRecipient: GuestThreadDeliveryFailureViewModel = {
    id: 'delivery-1',
    channel: 'email',
    purpose: 'owner_alert',
    recipient: 'np9gfypzgf@privaterelay.appleid.com',
    error: 'Resend bounced',
    status: 'failed',
    createdAt: '2026-10-30T09:50:25.676Z',
  }
  assert.equal(
    deliveryFailureTitle(hostAlertWithRecipient),
    'Host email alert could not be delivered to np9gfypzgf@privaterelay.appleid.com',
  )

  const hostAlertWithoutRecipient: GuestThreadDeliveryFailureViewModel = {
    ...hostAlertWithRecipient,
    channel: 'push',
    recipient: null,
  }
  assert.equal(
    deliveryFailureTitle(hostAlertWithoutRecipient),
    'Host push alert could not be delivered',
  )

  const guestAcknowledgement: GuestThreadDeliveryFailureViewModel = {
    id: 'delivery-2',
    channel: 'email',
    purpose: 'guest_acknowledgement',
    recipient: 'guest@example.com',
    error: 'Mailbox full',
    status: 'failed',
    createdAt: '2026-10-30T09:50:25.676Z',
  }
  assert.equal(
    deliveryFailureTitle(guestAcknowledgement),
    'Guest acknowledgement could not be delivered to guest@example.com',
  )

  const memberReplyAirbnb: GuestThreadDeliveryFailureViewModel = {
    id: 'delivery-3',
    channel: 'airbnb',
    purpose: 'member_reply',
    recipient: null,
    error: 'Provider error',
    status: 'failed',
    createdAt: '2026-10-30T09:50:25.676Z',
  }
  assert.equal(
    deliveryFailureTitle(memberReplyAirbnb),
    'Reply could not be delivered on Airbnb',
  )

  const memberReplyEmail: GuestThreadDeliveryFailureViewModel = {
    ...memberReplyAirbnb,
    channel: 'email',
  }
  assert.equal(
    deliveryFailureTitle(memberReplyEmail),
    'Reply could not be delivered on email',
  )

  const statusUpdate: GuestThreadDeliveryFailureViewModel = {
    id: 'delivery-4',
    channel: 'email',
    purpose: 'status_update',
    recipient: null,
    error: 'Domain error',
    status: 'failed',
    createdAt: '2026-10-30T09:50:25.676Z',
  }
  assert.equal(
    deliveryFailureTitle(statusUpdate),
    'Status update could not be delivered on email',
  )

  const scheduledMessage: GuestThreadDeliveryFailureViewModel = {
    id: 'delivery-5',
    channel: 'airbnb',
    purpose: 'scheduled_message',
    recipient: null,
    error: 'Provider error',
    status: 'failed',
    createdAt: '2026-10-30T09:50:25.676Z',
  }
  assert.equal(
    deliveryFailureTitle(scheduledMessage),
    'Scheduled message could not be delivered on Airbnb',
  )

  const uncertainStatus: GuestThreadDeliveryFailureViewModel = {
    ...memberReplyAirbnb,
    status: 'uncertain',
  }
  assert.equal(
    deliveryFailureTitle(uncertainStatus),
    'Reply needs review: send outcome unknown',
  )
})

test('isDeliveryFailure validates typed failure records with nullable recipient', () => {
  assert.equal(isDeliveryFailure({
    id: 'delivery-1',
    channel: 'email',
    purpose: 'owner_alert',
    recipient: 'host@example.com',
    error: 'Failed',
    status: 'failed',
    createdAt: '2026-10-30T09:50:25.676Z',
  }), true)

  assert.equal(isDeliveryFailure({
    id: 'delivery-2',
    channel: 'airbnb',
    purpose: 'member_reply',
    recipient: null,
    error: null,
    status: 'uncertain',
    createdAt: '2026-10-30T09:50:25.676Z',
  }), true)

  assert.equal(isDeliveryFailure({
    id: 'delivery-3',
    channel: 'unknown',
    purpose: 'member_reply',
    recipient: null,
    error: null,
    status: 'failed',
    createdAt: '2026-10-30T09:50:25.676Z',
  }), false)

  assert.equal(isDeliveryFailure(null), false)
  assert.equal(isDeliveryFailure({}), false)
})
