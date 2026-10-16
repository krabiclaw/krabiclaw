# Notification testing

KrabiClaw has two distinct records:

- `notifications` is the dashboard acknowledgement feed. A notification is unread for a user until the corresponding `notification_reads` row exists.
- `guest_thread_deliveries` records external email or WhatsApp outcomes for guest-thread entries. It is not a dashboard feed.

Do not infer an external send from a dashboard notification, or an unread item from a delivery receipt.

## Local verification

Local development and preview use log-only delivery modes. A log-only send must still write a terminal `guest_thread_deliveries` receipt with a `log-only:` provider message ID when the send belongs to a guest thread.

Verify a guest submission through the real Worker boundary:

1. Submit a contact message, reservation, or experience booking.
2. Confirm that one guest thread and its opening entry exist.
3. Confirm that the owner dashboard notification references that thread and entry.
4. Confirm that configured owner channels and the guest acknowledgement have delivery receipts with stable idempotency keys.
5. Open the thread as a dashboard user and confirm that `notification_reads` records the acknowledgement for that user only.
6. Confirm that the organization WebSocket emits the typed invalidation and that disconnecting it shows the dashboard failure state.

For inbound replies, use the development inbound email or WhatsApp route. Repeating the same provider message ID must return the existing entry instead of appending another one.

The development email route does not prove the native MIME entrypoint. Also send
a raw multipart email through Wrangler's `/cdn-cgi/local/email` endpoint, using a
reply address signed with the disposable local `EMAIL_REPLY_SECRET`. Verify
Unicode text decoding, concurrent replay of its `Message-ID`, one persisted
guest entry, and rejection of an invalid reply token. This endpoint is supplied
by [Wrangler's local email runtime](https://developers.cloudflare.com/email-service/local-development/routing/),
not by an application forwarding route.

`yarn test:d1` exercises the committed baseline and delivery claim functions
against real local D1. It proves one concurrent claim, no ambiguous Meta retry,
bounded Resend retry, and protection from stale completion writes. It does not
contact either provider or prove their live webhook configuration.

## Production canary

Production delivery checks are an authorized release operation. Follow [release-and-outage-prevention.md](operations/release-and-outage-prevention.md) and use `yarn canary:notifications` only with the documented production credentials and approval. The canary reads guest delivery outcomes and emits its result as structured command output. Retain that output with the release evidence outside application D1.

Never use a canary to provision resources, change delivery modes, or repair data.
