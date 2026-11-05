# Notification testing

KrabiClaw has two distinct records:

- `notifications` is the dashboard acknowledgement feed. A notification is unread for a user until the corresponding `notification_reads` row exists.
- `guest_thread_deliveries` records external email or WhatsApp outcomes for guest-thread entries. It is not a dashboard feed.

Do not infer an external send from a dashboard notification, or an unread item from a delivery receipt.

## Email purpose

Every notification message declares its email purpose and a factual reason for
sending, which appears in both HTML and plain text. Purpose is separate from
the category's channel preferences: an optional booking alert is still a
transactional email. Guest confirmations and payment receipts use their actual
booking, message or billing category and go directly to the transaction's
contact without consulting owner notification preferences.

Transactional messages omit unsubscribe links and mailing-list headers. Guest
transactional messages also omit signup prompts. Authentic booking, property
and location images remain alongside tenant logos, transaction details,
attachments and relevant actions. A message without a supplied image renders
no hero image.
Subscribed review alerts and promotional review requests and product news retain
unsubscribe controls. Product News continues to use Resend's native Broadcast
and Topic unsubscribe lifecycle.

`yarn lint:email-previews` verifies all catalog messages through the canonical
renderer, including the reason in both bodies, purpose-specific footer controls,
and the exact supplied hero image URL without inventing an absent image. The
existing `resend-native-d1.test.ts` and
`guest-delivery-d1.test.ts` integration tests exercise SDK request headers,
required opt-out configuration, and persisted cancellation/replay behavior.
These checks do not establish Gmail inbox-tab placement; that requires
inspection of an actually delivered message.

## Email conversation continuity

Guest confirmations, status updates, scheduled messages and dashboard replies
share the existing receipt-backed email dispatcher. It records the complete
outbound request before dispatch in `guest_thread_deliveries.email_json` and
stores Resend's actual RFC Message-ID in `email_message_id`. The provider API
UUID remains in `provider_message_id`; the two identities are not interchangeable.

Resend initially returns queued email with no RFC Message-ID. The dispatcher
waits for assignment through the official SDK. If readback fails, the saved API
UUID resumes that readback without another send. Verified Resend webhooks also
record the actual RFC ID. A send with an unknown provider outcome cannot be
retried beyond Resend's documented 24-hour idempotency window without review.

Native inbound email records its parsed subject, Message-ID and reply references
on the immutable guest entry. The content hash used to deduplicate email without
a Message-ID is never used as an RFC identity. Malformed provided Message-IDs
are rejected at ingress. Replies select ancestry only within the same request
and recipient; owner copies and another recipient's messages are excluded.
SMTP replies retain the subject with one `Re:` prefix and send `In-Reply-To`
and `References`. Event-specific headings, tenant images and attachments stay
in the body. Retrying a delivery reuses its frozen sender, recipient, subject,
body and references even if another message or a brand edit arrives meanwhile.

The existing Resend integration tests verify exact SDK headers and the full
confirmation/guest/staff sequence against real local D1. The native MIME ingress
journey verifies routing, stored metadata, duplicate protection and staff replies
through the built Worker. The opt-in native transport test uses only Resend's
`delivered@resend.dev` simulation address and independently reads the actual
provider IDs and subjects. It does not inspect a real Gmail or Outlook inbox.
The configured Resend API key must permit both sending and retrieving sent email.

## Review invitation retries

An ended visit gets one initial invitation. A retry resumes that invitation;
metadata readback, inbox publication or final success persistence failing after
Resend acceptance must not issue a new link or another email. `first_sent_at`
marks completed application work, not proof that no earlier send was accepted.
`send_count` counts completed initial invitations, not physical provider sends.

The existing receipt owns the frozen email and Resend identity. The request now
also retains its token at creation: the receipt cannot recover a token when work
fails before the email snapshot exists, and its hash cannot be reversed. The
nullable `review_requests.token` column solves that concrete retry gap without a
second invitation store. Existing pending requests recover only a recorded email
token matching their stored hash; an unmailed request can retain a new token.
An inconsistent recorded invitation fails visibly instead of invalidating its
emailed link. The token is private application data, like the existing email
snapshot, and is never returned in review API responses.

Retries preserve the original expiry, token, invitation entry and receipt key.
Provider acceptance resumes metadata readback even after the 24-hour idempotency
window. An unknown send outcome past that window still requires provider review;
automation must not mint a fresh key to bypass the dispatcher guard. Failures
remain reported and incomplete work remains eligible for automation retry.

A retry is neither a reminder nor a reissue. The current automation sends one
initial invitation and implements no reminder schedule. This change leaves the
existing cancellation/no-show revocation, submission and 30-day invitation
window intact; it does not add a new resend policy or revive revoked links.

`guest-reviews-d1.test.ts` runs the actual automation, review APIs, dispatcher,
local D1 and a local Durable Object. Its controlled Resend transport proves one
accepted email and a usable original link across metadata failure, publication
failure, final write failure and concurrency, plus recovery of rejected sends.
No customer email is sent by these tests.

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
